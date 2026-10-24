// Pure rules for the ask loop (DESIGN.md 5.3). No DOM, no network: the unit tests import this file.
import type { PassageInput, PresetId, StagedSelection, Thread } from '../../shared/types.ts';

export type AskTarget = { kind: 'new' } | { kind: 'follow-up'; thread: Thread; number: number };

/** Two passages are the same when the start, the end, and the text are the same. */
export function samePassage(a: PassageInput, b: PassageInput): boolean {
  return (
    a.start.page === b.start.page &&
    a.start.offset === b.start.offset &&
    a.end.page === b.end.page &&
    a.end.offset === b.end.offset &&
    a.text === b.text
  );
}

/** The thread with the latest `createdAt`. The list from the server is oldest first, so ties go to the later entry. */
export function latestThread(threads: readonly Thread[]): Thread | null {
  let latest: Thread | null = null;
  for (const t of threads) if (!latest || t.createdAt >= latest.createdAt) latest = t;
  return latest;
}

/** The thread number that the UI shows ("#7"): the 1-based position in the oldest-first list. */
export function threadNumber(threads: readonly Thread[], id: string): number {
  return threads.findIndex((t) => t.id === id) + 1;
}

/** The follow-up rule: the staged passage equals the passage of the latest thread → follow-up, else a new thread. */
export function chooseTarget(staged: PassageInput | null, threads: readonly Thread[]): AskTarget {
  const latest = latestThread(threads);
  if (!staged || !latest || !samePassage(staged, latest.passage)) return { kind: 'new' };
  return { kind: 'follow-up', thread: latest, number: threadNumber(threads, latest.id) };
}

export function targetLabel(target: AskTarget): string {
  return target.kind === 'new' ? 'new thread' : `follow-up #${target.number}`;
}

/** A stable key for "the same preset on the same passage". */
export function passageKey(p: PassageInput): string {
  return `${p.start.page}:${p.start.offset}-${p.end.page}:${p.end.offset}:${p.text.length}`;
}

export interface SentPreset {
  preset: PresetId;
  key: string;
  at: number; // ms
}

export const DUPLICATE_WINDOW_MS = 2000;

/** The duplicate guard: the same preset on the same passage within two seconds is ignored. */
export function isDuplicate(last: SentPreset | null, next: SentPreset, windowMs = DUPLICATE_WINDOW_MS): boolean {
  return !!last && last.preset === next.preset && last.key === next.key && next.at - last.at < windowMs;
}

const LEVEL_LETTER: Record<PassageInput['kind'], string> = {
  sentence: 'S',
  paragraph: 'P',
  selection: 'M',
  region: 'R',
};

let sentenceSegmenter: Intl.Segmenter | null = null;

export function countSentences(text: string): number {
  sentenceSegmenter ??= new Intl.Segmenter('en', { granularity: 'sentence' });
  let n = 0;
  for (const seg of sentenceSegmenter.segment(text)) if (seg.segment.trim()) n++;
  return Math.max(n, text.trim() ? 1 : 0);
}

export function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

export function pageLabel(loc: { page: number; pageLabel?: string | null }): string {
  return `p. ${loc.pageLabel || loc.page + 1}`;
}

/** "S · 1 sentence · 24 words · p. 42" */
export function stagedSummary(staged: StagedSelection): string {
  const text = staged.passage.text;
  const sentences = countSentences(text);
  const words = countWords(text);
  return [
    LEVEL_LETTER[staged.passage.kind],
    `${sentences} ${sentences === 1 ? 'sentence' : 'sentences'}`,
    `${words} ${words === 1 ? 'word' : 'words'}`,
    pageLabel(staged.location),
  ].join(' · ');
}

export const PRESET_LABEL: Record<PresetId, string> = {
  explain: 'Explain',
  define: 'Define',
  ask: 'Ask',
};
