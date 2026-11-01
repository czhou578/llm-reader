// Helpers that read a PageText: span lookup, quote selectors, and the surrounding-text block for the prompt.
import type { PageText } from '../types.ts';

export const MARK_OPEN = '⟦';
export const MARK_CLOSE = '⟧';

/** Index of the span that contains `offset`, else of the first span after it, else -1. */
export function spanIndexAt(spans: readonly [number, number][], offset: number): number {
  for (let i = 0; i < spans.length; i++) {
    if (offset < spans[i]![1]) return i;
  }
  return -1;
}

/** Index of the last span that starts at or before `offset`, else -1. */
export function spanIndexBefore(spans: readonly [number, number][], offset: number): number {
  let found = -1;
  for (let i = 0; i < spans.length; i++) if (spans[i]![0] <= offset) found = i;
  return found;
}

/** The parts of [start, end) that lie outside the skip spans (running headers, footers, footnotes), in order. */
export function rangesWithoutSkips(pageText: PageText, start: number, end: number): [number, number][] {
  const out: [number, number][] = [];
  let pos = start;
  const skips = [...pageText.skipSpans].sort((a, b) => a.start - b.start);
  for (const s of skips) {
    if (s.end <= pos || s.start >= end) continue;
    if (s.start > pos) out.push([pos, s.start]);
    pos = Math.max(pos, s.end);
  }
  if (pos < end) out.push([pos, end]);
  return out;
}

/** The paragraph or furniture text without its skip spans, for [start, end). */
export function textWithoutSkips(pageText: PageText, start: number, end: number): string {
  const out = rangesWithoutSkips(pageText, start, end)
    .map(([a, b]) => pageText.text.slice(a, b))
    .join('');
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/** A quote selector for [start, end) of `text`: the exact text and about `size` chars on each side. */
export function quoteOf(
  text: string,
  start: number,
  end: number,
  size = 32,
): { exact: string; prefix: string; suffix: string } {
  return {
    exact: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - size), start),
    suffix: text.slice(end, end + size),
  };
}

/**
 * The paragraphs around [start, end): the containing paragraph(s) plus `before` paragraphs before and `after`
 * paragraphs after, joined by blank lines. The span is marked as ⟦…⟧.
 */
export function surroundingText(
  pageText: PageText,
  start: number,
  end: number,
  opts: { before?: number; after?: number } = {},
): string {
  const before = opts.before ?? 2;
  const after = opts.after ?? 1;
  const paras = pageText.paragraphs;
  let first = -1;
  let last = -1;
  for (let i = 0; i < paras.length; i++) {
    const [a, b] = paras[i]!;
    if (b > start && a < end) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return `${MARK_OPEN}${pageText.text.slice(start, end).trim()}${MARK_CLOSE}`;
  const markStart = Math.max(start, paras[first]![0]);
  const markEnd = Math.min(end, paras[last]![1]);
  const parts: string[] = [];
  for (let i = Math.max(0, first - before); i <= Math.min(paras.length - 1, last + after); i++) {
    const [a, b] = paras[i]!;
    let s = pageText.text.slice(a, b);
    if (i === last) s = s.slice(0, markEnd - a) + MARK_CLOSE + s.slice(markEnd - a);
    if (i === first) s = s.slice(0, markStart - a) + MARK_OPEN + s.slice(markStart - a);
    parts.push(s);
  }
  return parts.join('\n\n');
}
