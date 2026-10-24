import type { ChatMessage, Document, Location, OutlineItem, Passage, PresetId, StartRunRequest } from '../../shared/types.ts';
import type { StoredMessage } from '../db/repo.ts';
import { HttpError } from '../errors.ts';
import { DEFINE, EXPLAIN, SYSTEM_PROMPT, followUpPreset, followUpQuestion, freeAsk } from './prompts.ts';

// Phase 0 context builder (DESIGN.md 6.2-6.6): layers S, C, F, B, the raw previous page in place of D1, and A.
// Order: system, then one user turn with <document>, <reader>, <previous_page>, <surrounding_text>, <request>.
// Stable blocks go first, so the prefix stays byte-identical between asks on one document.

/** Rough token count until the provider reports usage. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const PASSAGE_HARD_CAP_TOKENS = 4000; // layer A hard cap; a longer selection is refused, never cut
const SURROUNDING_MAX_CHARS = 8000; // about 2,000 tokens
const PREV_PAGE_MAX_CHARS = 4000; // about 1,000 tokens
const CONTENTS_MAX_ITEMS = 60;
const EMPTY_ANSWER = '(No answer: the run was cancelled or failed before any text.)';

export interface BuildInput {
  doc: Document;
  readerProfile: string;
  passage: Passage;
  /** The thread location from turn 1; used for the page in a follow-up. */
  threadLocation: Location;
  request: StartRunRequest;
  /** Earlier messages of the thread, oldest first. Empty for a new ask. */
  prior: StoredMessage[];
}

export interface BuiltContext {
  system: string;
  messages: ChatMessage[];
  /** The exact text of the new user turn; stored so a follow-up can resend it byte for byte. */
  userPrompt: string;
  /** What the UI shows for the user message. */
  userContent: string;
  estimatedTokens: number;
  /** The context-used line without the token count; see formatContextUsed. */
  contextParts: string[];
  /** Mark the end of turn 1 for prompt caching (DESIGN.md 6.3). */
  cacheHints: { messageIndex: number }[];
}

export function formatContextUsed(parts: string[], tokens: number): string {
  return [...parts, `${tokens.toLocaleString('en-US')} tok`].join(' · ');
}

export function presetTemplate(preset: Exclude<PresetId, 'ask'>): string {
  return preset === 'explain' ? EXPLAIN : DEFINE;
}

function userContentFor(req: StartRunRequest): string {
  if (req.preset === 'ask') return req.question!.trim();
  return req.preset === 'explain' ? 'Explain' : 'Define';
}

export function printedPage(loc: Location): string {
  return loc.pageLabel?.trim() || String(loc.page + 1);
}

export function buildContext(input: BuildInput): BuiltContext {
  const { request } = input;
  if (request.preset === 'ask' && !request.question?.trim()) {
    throw new HttpError(400, 'bad_request', 'a question is required for the ask preset');
  }
  const turn1 = input.prior.find((m) => m.role === 'user' && m.prompt);
  return turn1 ? buildFollowUp(input, turn1) : buildNewAsk(input);
}

// ---------- new ask ----------

function buildNewAsk(input: BuildInput): BuiltContext {
  const { doc, passage, request } = input;
  const ctx = request.context;
  const loc = ctx.location;
  const passageText = passage.text.trim();
  if (estimateTokens(passageText) > PASSAGE_HARD_CAP_TOKENS) {
    throw new HttpError(
      413,
      'passage_too_long',
      `the selection is about ${estimateTokens(passageText).toLocaleString('en-US')} tokens; the cap is ${PASSAGE_HARD_CAP_TOKENS.toLocaleString('en-US')}. Narrow it.`,
    );
  }

  const blocks: string[] = [];
  blocks.push(`<document>\n${documentBlock(doc)}\n</document>`);
  if (input.readerProfile.trim()) blocks.push(`<reader>\n${input.readerProfile.trim()}\n</reader>`);
  const prev = ctx.prevPageText?.trim();
  if (prev) blocks.push(`<previous_page>\n${tail(prev, PREV_PAGE_MAX_CHARS)}\n</previous_page>`);
  const surrounding = ctx.surrounding?.trim();
  if (surrounding) {
    blocks.push(`<surrounding_text pages="${printedPage(loc)}">\n${trimAroundMark(surrounding, SURROUNDING_MAX_CHARS)}\n</surrounding_text>`);
  }
  const instruction = request.preset === 'ask' ? freeAsk(request.question!.trim()) : presetTemplate(request.preset);
  blocks.push(`<request>\n${locationLine(doc, loc)}\nselected passage:\n"""\n${passageText}\n"""\n${instruction}\n</request>`);
  const userPrompt = blocks.join('\n');

  const messages: ChatMessage[] = [{ role: 'user', content: userPrompt }];
  const parts = ['passage', `p. ${printedPage(loc)}`];
  const around = paragraphSpan(surrounding ?? '');
  if (around) parts.push(around);
  if (prev) parts.push('prev page');
  return {
    system: SYSTEM_PROMPT,
    messages,
    userPrompt,
    userContent: userContentFor(request),
    estimatedTokens: estimateTokens(SYSTEM_PROMPT + userPrompt),
    contextParts: parts,
    // Turn 1 is resent byte for byte by each follow-up, so mark it now for the cache write.
    cacheHints: [{ messageIndex: 0 }],
  };
}

function documentBlock(doc: Document): string {
  const lines = [`title: ${doc.title}`];
  if (doc.author) lines.push(`authors: ${doc.author}`);
  const contents = chapterTitles(doc.outline ?? []);
  if (contents.length) {
    lines.push('contents:');
    contents.forEach((t, i) => lines.push(`${i + 1}. ${t}`));
  }
  return lines.join('\n');
}

/** Chapter-level titles: the top level of the outline, or the level below when the top holds only a few parts. */
export function chapterTitles(outline: OutlineItem[]): string[] {
  const top = outline.filter((o) => o.title);
  let titles: string[];
  if (top.length > 0 && top.length < 4 && top.some((o) => o.children?.length)) {
    titles = top.flatMap((o) => [o.title, ...(o.children ?? []).filter((c) => c.title).map((c) => `${o.title} > ${c.title}`)]);
  } else {
    titles = top.map((o) => o.title);
  }
  return titles.slice(0, CONTENTS_MAX_ITEMS);
}

/** The outline path to the deepest heading at or before a page, e.g. "Part II > Ch. 7 > 7.3". */
export function sectionPath(outline: OutlineItem[], page: number): string | null {
  const path: string[] = [];
  let level = outline;
  for (;;) {
    let pick: OutlineItem | undefined;
    for (const item of level) if (item.page !== null && item.page <= page) pick = item;
    if (!pick) break;
    path.push(pick.title);
    if (!pick.children?.length) break;
    level = pick.children;
  }
  return path.length ? path.join(' > ') : null;
}

function locationLine(doc: Document, loc: Location): string {
  const section = loc.section?.trim() || sectionPath(doc.outline ?? [], loc.page);
  const label = loc.pageLabel?.trim();
  const page = label ? `page ${label} (PDF page ${loc.page + 1})` : `PDF page ${loc.page + 1}`;
  return `location: ${section ? `${section} — ` : ''}${page}`;
}

/** "±1 paragraph" or "-2/+1 paragraphs", counted around the ⟦ ⟧ mark in the surrounding text. */
function paragraphSpan(surrounding: string): string | null {
  const paras = surrounding.split(/\n\s*\n/).filter((p) => p.trim());
  if (paras.length < 2) return null;
  const idx = Math.max(0, paras.findIndex((p) => p.includes('⟦')));
  const before = idx;
  const after = paras.length - 1 - idx;
  if (before === after) return `±${before} paragraph${before === 1 ? '' : 's'}`;
  return `-${before}/+${after} paragraphs`;
}

function tail(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(text.length - max)}`;
}

/** Keep at most `max` chars, centered on the ⟦ ⟧ mark. */
function trimAroundMark(text: string, max: number): string {
  if (text.length <= max) return text;
  const start = text.indexOf('⟦');
  const end = text.indexOf('⟧');
  if (start < 0 || end < 0) return text.slice(0, max) + '…';
  const markLen = end - start + 1;
  const room = Math.max(0, max - markLen);
  // Earlier text sets up the referents, so give two thirds of the room to the text before the mark.
  let from = Math.max(0, start - Math.floor((room * 2) / 3));
  const to = Math.min(text.length, from + markLen + room);
  from = Math.max(0, to - max);
  return `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`;
}

// ---------- follow-up ----------

function buildFollowUp(input: BuildInput, turn1: StoredMessage): BuiltContext {
  const { request, prior } = input;
  const page = printedPage(input.threadLocation);
  const messages: ChatMessage[] = [];
  let turns = 0;
  // Pair each user turn with the assistant turn after it. Turn 1 always goes first, byte for byte.
  for (let i = 0; i < prior.length; i++) {
    const u = prior[i]!;
    if (u.role !== 'user' || !u.prompt) continue;
    const a = prior[i + 1]?.role === 'assistant' ? prior[i + 1]! : undefined;
    const answer = a?.content.trim() ? a.content : '';
    if (u.id === turn1.id) {
      messages.push({ role: 'user', content: u.prompt }, { role: 'assistant', content: answer || EMPTY_ANSWER });
    } else if (answer) {
      // A later turn with no answer adds nothing; drop it so user and assistant turns alternate.
      messages.push({ role: 'user', content: u.prompt }, { role: 'assistant', content: answer });
    } else {
      continue;
    }
    turns++;
  }
  const userPrompt =
    request.preset === 'ask'
      ? followUpQuestion(page, request.question!.trim())
      : followUpPreset(page, presetTemplate(request.preset));
  messages.push({ role: 'user', content: userPrompt });
  const all = SYSTEM_PROMPT + messages.map((m) => m.content).join('');
  return {
    system: SYSTEM_PROMPT,
    messages,
    userPrompt,
    userContent: userContentFor(request),
    estimatedTokens: estimateTokens(all),
    contextParts: ['follow-up', `turn ${turns + 1}`, `p. ${page}`],
    // Breakpoints: the system prompt (in the driver), the end of turn 1, and the end of the last answer.
    cacheHints: messages.length > 3 ? [{ messageIndex: 0 }, { messageIndex: messages.length - 2 }] : [{ messageIndex: 0 }],
  };
}
