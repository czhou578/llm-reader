// The page segmenter (DESIGN.md 7.3, architecture.md 2.3). A pure function: pdf.js text items in, PageText out.
// It has no DOM dependency, so the browser and Node run the same code and get the same offsets.
import { SEGMENTER_VERSION, type PageText, type SkipSpan } from '../types.ts';
import { CharMapBuilder } from './charmap.ts';
import {
  buildLines,
  findGutter,
  linePieces,
  median,
  normalizeItems,
  orderLines,
  percentile,
  piecesText,
  type Frag,
  type Line,
  type Piece,
  type TextItemLike,
  type TextStyleLike,
} from './layout.ts';
import { splitSentences } from './sentences.ts';

export {
  NO_ITEM,
  itemEndToLogical,
  itemOffsetToLogical,
  offsetsToItemRanges,
  sourceCharsOf,
  type ItemRange,
} from './charmap.ts';
export { ABBREVIATIONS, endsWithAbbreviation, splitSentences } from './sentences.ts';
export { type TextItemLike, type TextStyleLike } from './layout.ts';
export * from './context.ts';

/**
 * The getTextContent() parameters that the pdf.js text layer uses. Use the same ones for the segmenter,
 * so item indexes and item strings match the text-layer spans.
 */
export const TEXT_CONTENT_PARAMS = { includeMarkedContent: true, disableNormalization: true } as const;

export interface SegmentProfile {
  /** Normalized header and footer lines (see furnitureKey) that repeat across the document. */
  headerFooterKeys?: string[];
}

export interface SegmentInput {
  page: number; // 0-based
  items: readonly TextItemLike[];
  styles: Record<string, TextStyleLike>;
  viewBox: readonly number[]; // [x0, y0, x1, y1] of the page in user space
  lang?: string;
  profile?: SegmentProfile;
}

export interface PageAnalysis {
  pageText: PageText;
  /** furnitureKey() of each one-line block in the top or bottom 10 % of the page, for a document profile. */
  bandKeys: string[];
}

const PAGE_NUMBER =
  /^[\s\-\u2013\u2014|\u00B7\u2022]*(?:(?:page|p\.|pg\.?)\s*)?(?:\d{1,4}|(?=[ivxlcdm])m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3}))(?:\s*(?:of|\/)\s*\d{1,4})?[\s\-\u2013\u2014|\u00B7\u2022]*$/i;
const TERMINAL_END = /[.?!:\u2026]["'\u201D\u2019\u00BB)\]]*$/u;
const SENTENCE_END = /[.?!:;\u2026]["'\u201D\u2019\u00BB)\]]*$/u;
const LOWER_START = /^\p{Ll}/u;
/** Left parts that keep their hyphen at a line end, because the hyphen is part of a compound. */
const KEEP_HYPHEN_LEFT = new Set(['self', 'well', 'all', 'half', 'quasi']);
/** Right parts that usually follow a compound hyphen ("Kubernetes-style", "data-driven"). */
const KEEP_HYPHEN_RIGHT = new Set([
  'style', 'based', 'like', 'level', 'wide', 'free', 'aware', 'specific', 'driven', 'oriented', 'friendly',
  'scale', 'safe', 'only', 'class', 'grade',
]);
const BULLET_START = /^[\u2022\u25E6\u25AA\u25AB\u2023\u2043\u25CF\u25CB\u25A0\u25A1\u2013\u2014*\u00B7]\s/u;
const WORD = /[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu;

/** Words seen inside lines of the page. They decide an unclear line-end hyphen. */
interface WordEvidence {
  plain: Set<string>;
  hyphenated: Set<string>;
}

function collectWords(lines: { text: string }[]): WordEvidence {
  const plain = new Set<string>();
  const hyphenated = new Set<string>();
  for (const line of lines) {
    for (const m of line.text.matchAll(WORD)) {
      const w = m[0].toLowerCase();
      if (w.includes('-')) hyphenated.add(w);
      else plain.add(w);
    }
  }
  return { plain, hyphenated };
}

/** The key that identifies a running header or footer: trimmed, lower case, digits as '#'. */
export function furnitureKey(text: string): string {
  return text.trim().toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ');
}

export function isPageNumberLine(text: string): boolean {
  return text.trim().length > 0 && PAGE_NUMBER.test(text);
}

interface TextLine extends Line {
  pieces: Piece[];
  text: string;
}

interface Block {
  kind: 'body' | 'furniture' | 'margin';
  lines: TextLine[];
}

type JoinRule = { dropLast: boolean; sep: string };

/** How line `a` joins line `b` inside a paragraph (step 6). */
function joinRule(a: string, b: string, words: WordEvidence): JoinRule {
  const last = a[a.length - 1] ?? '';
  if (last === '\u00AD') return { dropLast: true, sep: '' };
  if (last === '-' || last === '\u2010') {
    const before = a[a.length - 2] ?? '';
    if (!/\p{L}/u.test(before)) return { dropLast: false, sep: /\d/.test(before) ? '' : ' ' };
    if (!LOWER_START.test(b)) return { dropLast: false, sep: '' };
    const left = (/([\p{L}\p{N}-]+)[-\u2010]$/u.exec(a)?.[1] ?? '').toLowerCase();
    const right = (/^[\p{L}\p{N}]+/u.exec(b)?.[0] ?? '').toLowerCase();
    // Evidence from the same page comes first: "example" seen -> join; "data-driven" seen -> keep.
    if (words.plain.has(left + right)) return { dropLast: true, sep: '' };
    if (words.hyphenated.has(`${left}-${right}`)) return { dropLast: false, sep: '' };
    const keep = left.includes('-') || KEEP_HYPHEN_LEFT.has(left) || KEEP_HYPHEN_RIGHT.has(right);
    return { dropLast: !keep, sep: '' };
  }
  if (last === '\u2013' || last === '\u2014') return { dropLast: false, sep: '' };
  return { dropLast: false, sep: ' ' };
}

function dropLastChar(pieces: Piece[]): Piece[] {
  const out = pieces.map((p) => (p === null ? null : { ...p }));
  const last = out[out.length - 1];
  if (last) {
    last.end -= 1;
    if (last.end <= last.start) out.pop();
  }
  return out;
}

interface ColumnStats {
  left: number;
  width: number;
}

/** Step 5: split the ordered body lines into paragraphs. */
function splitParagraphs(lines: TextLine[], medianFs: number): TextLine[][] {
  const pitches: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1]!;
    const b = lines[i]!;
    const gap = a.y - b.y;
    if (a.col === b.col && gap > 0 && gap < 2.5 * Math.max(a.fs, b.fs)) pitches.push(gap);
  }
  const pitch = pitches.length > 0 ? median(pitches) : 1.2 * medianFs;
  const stats = new Map<number, ColumnStats>();
  for (const col of new Set(lines.map((l) => l.col))) {
    const ls = lines.filter((l) => l.col === col);
    const left = median(ls.map((l) => l.x0));
    stats.set(col, { left, width: Math.max(1, percentile(ls.map((l) => l.x1), 0.9) - left) });
  }

  const paragraphs: TextLine[][] = [];
  let current: TextLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i]!;
    const prev = current[current.length - 1];
    if (prev && startsParagraph(prev, cur, lines[i + 1], pitch, stats)) {
      paragraphs.push(current);
      current = [];
    }
    current.push(cur);
  }
  if (current.length > 0) paragraphs.push(current);
  return paragraphs;
}

function startsParagraph(
  prev: TextLine,
  cur: TextLine,
  next: TextLine | undefined,
  pitch: number,
  stats: Map<number, ColumnStats>,
): boolean {
  const fs = Math.max(prev.fs, cur.fs);
  if (Math.abs(prev.fs - cur.fs) > 0.15 * fs) return true; // a heading or a caption
  if (BULLET_START.test(cur.text)) return true;
  if ((prev.col === -1) !== (cur.col === -1)) return true;
  const sameColumn = prev.col === cur.col;
  if (sameColumn) {
    const gap = prev.y - cur.y;
    if (gap <= 0 || gap > 1.4 * pitch) return true;
  }
  const col = stats.get(cur.col) ?? { left: cur.x0, width: 1 };
  // First-line indent. A following line at the same indent means a block indent, not a new paragraph.
  // A line after a bullet line is a hanging indent, not a new paragraph.
  const indented = cur.x0 - col.left > 1.0 * cur.fs && cur.x0 - prev.x0 > 1.0 * cur.fs;
  const blockIndent = next !== undefined && next.col === cur.col && Math.abs(next.x0 - cur.x0) < 0.5 * cur.fs;
  const hanging = BULLET_START.test(prev.text);
  if (indented && !blockIndent && !hanging) return true;
  // A short last line that ends a sentence.
  const prevCol = stats.get(prev.col) ?? col;
  if (prev.x1 < prevCol.left + 0.8 * prevCol.width && TERMINAL_END.test(prev.text)) return true;
  return false;
}

function inBand(line: Line, viewBox: readonly number[]): 'top' | 'bottom' | null {
  const [, y0 = 0, , y1 = 792] = viewBox;
  const h = y1 - y0;
  if (line.y > y1 - 0.1 * h) return 'top';
  if (line.y < y0 + 0.1 * h) return 'bottom';
  return null;
}

/** Segment one page and also return the keys for a document profile. */
export function analyzePage(input: SegmentInput): PageAnalysis {
  const { page, items, styles, viewBox, lang = 'en', profile } = input;
  const headerKeys = new Set(profile?.headerFooterKeys ?? []);
  const { frags, rotated } = normalizeItems(items, styles);
  const medianFs = median(frags.map((f) => f.fs)) || 10;

  const toTextLine = (line: Line): TextLine => {
    const pieces = linePieces(line);
    return { ...line, pieces, text: piecesText(pieces) };
  };
  const rawLines = buildLines(frags, medianFs);
  const ordered = orderLines(rawLines, findGutter(rawLines, viewBox, medianFs))
    .map(toTextLine)
    .filter((l) => l.pieces.length > 0);

  // A page-number line in the top or bottom band always forms its own block.
  // This rule does not depend on the profile, so offsets stay stable when the profile changes.
  const blocks: Block[] = [];
  let run: TextLine[] = [];
  const flushRun = (): void => {
    for (const para of splitParagraphs(run, medianFs)) blocks.push({ kind: 'body', lines: para });
    run = [];
  };
  for (const line of ordered) {
    if (inBand(line, viewBox) && isPageNumberLine(line.text)) {
      flushRun();
      blocks.push({ kind: 'furniture', lines: [line] });
    } else {
      run.push(line);
    }
  }
  flushRun();

  // Classify body blocks that sit fully in the top or bottom band and match the profile.
  const bandKeys: string[] = [];
  for (const block of blocks) {
    if (block.kind !== 'body' || block.lines.length !== 1) continue;
    const line = block.lines[0]!;
    if (!inBand(line, viewBox)) continue;
    const key = furnitureKey(line.text);
    bandKeys.push(key);
    if (headerKeys.has(key)) block.kind = 'furniture';
  }
  for (const block of blocks) if (block.kind === 'furniture') bandKeys.push(furnitureKey(block.lines[0]!.text));

  // Rotated items go to the end as margin text.
  for (const f of rotated.sort((p: Frag, q: Frag) => p.item - q.item)) {
    const line: Line = { frags: [f], y: f.y, x0: f.x, x1: f.x + f.w, fs: f.fs, col: 0 };
    const tl = toTextLine(line);
    if (tl.pieces.length > 0) blocks.push({ kind: 'margin', lines: [tl] });
  }

  // Step 6: build the logical text and the char map.
  const words = collectWords(ordered);
  const out = new CharMapBuilder();
  const paragraphs: [number, number][] = [];
  const skipSpans: SkipSpan[] = [];
  for (const block of blocks) {
    if (out.text.length > 0) out.addSynthetic('\n\n');
    const start = out.text.length;
    block.lines.forEach((line, i) => {
      const next = block.lines[i + 1];
      const rule = next ? joinRule(line.text, next.text, words) : { dropLast: false, sep: '' };
      const pieces = rule.dropLast ? dropLastChar(line.pieces) : line.pieces;
      for (const p of pieces) {
        if (p === null) out.addSynthetic(' ');
        else out.addSource(p.item, p.str, p.start, p.end);
      }
      out.addSynthetic(rule.sep);
    });
    const end = out.text.length;
    if (block.kind === 'body') paragraphs.push([start, end]);
    else skipSpans.push({ start, end, kind: block.kind });
  }

  // Step 7: sentences inside each paragraph.
  const sentences: [number, number][] = [];
  for (const [a, b] of paragraphs) sentences.push(...splitSentences(out.text, a, b, lang));

  // Step 8: flags.
  const flags: NonNullable<PageText['flags']> = {};
  const visible = out.text.replace(/\s+/g, '');
  if (visible.length < 20) flags.lowText = true;
  const odd = visible.match(/[\uE000-\uF8FF\uFFFD\u0000-\u001F]/g)?.length ?? 0;
  if (visible.length > 0 && odd / visible.length > 0.2) flags.lowQuality = true;
  const lastPara = paragraphs[paragraphs.length - 1];
  if (lastPara && !SENTENCE_END.test(out.text.slice(lastPara[0], lastPara[1]))) flags.continuesOnNextPage = true;

  const pageText: PageText = {
    page,
    text: out.text,
    charMap: out.runs,
    paragraphs,
    sentences,
    skipSpans,
    segmenterVersion: SEGMENTER_VERSION,
  };
  if (Object.keys(flags).length > 0) pageText.flags = flags;
  return { pageText, bandKeys };
}

/** Segment one page into its logical text, paragraphs, sentences, and skip spans. */
export function segmentPage(input: SegmentInput): PageText {
  return analyzePage(input).pageText;
}

/** True when the last sentence of `prev` continues as the first paragraph of `next`. */
export function continuesInto(prev: PageText, next: PageText): boolean {
  if (!prev.flags?.continuesOnNextPage) return false;
  const first = next.paragraphs[0];
  return first !== undefined && LOWER_START.test(next.text.slice(first[0], first[1]));
}
