// Builds the StagedSelection that the viewer hands to the shell.
import {
  SEGMENTER_VERSION,
  type PageText,
  type PassageAnchor,
  type PassageInput,
  type Rect,
  type StagedSelection,
} from '../../shared/types.ts';
import { continuesInto, quoteOf, surroundingText, textWithoutSkips } from '../../shared/segment/index.ts';
import type { PageStore } from './pages.ts';

export type RectsFor = (page: number, start: number, end: number) => Rect[];

export function buildStaged(
  store: PageStore,
  labels: string[] | null,
  start: PassageAnchor,
  end: PassageAnchor,
  kind: PassageInput['kind'],
  rectsFor: RectsFor,
): StagedSelection | null {
  const first = store.text(start.page);
  const last = store.text(end.page);
  if (!first || !last) return null;

  const parts: string[] = [];
  const raw: string[] = [];
  const rects: { page: number; rect: Rect }[] = [];
  let lowQuality = false;
  let prev: PageText | undefined;
  for (let p = start.page; p <= end.page; p++) {
    const pt = store.text(p);
    if (!pt) continue; // a middle page that is not segmented yet
    const a = p === start.page ? start.offset : 0;
    const b = p === end.page ? end.offset : pt.text.length;
    if (b <= a) continue;
    const piece = textWithoutSkips(pt, a, b);
    if (piece) {
      if (parts.length > 0) parts.push(prev && continuesInto(prev, pt) ? ' ' : '\n\n');
      parts.push(piece);
    }
    raw.push(pt.text.slice(a, b));
    for (const rect of rectsFor(p, a, b)) rects.push({ page: p, rect });
    if (pt.flags?.lowQuality) lowQuality = true;
    prev = pt;
  }
  // The text layer keeps ligatures as they are (disableNormalization); the LLM gets NFKC text.
  const text = parts.join('').normalize('NFKC');
  if (!text) return null;

  const sameEnd = start.page === end.page ? end.offset : first.text.length;
  const q = quoteOf(first.text, start.offset, sameEnd);
  const quote = {
    exact: raw.join(' '),
    prefix: q.prefix,
    suffix: start.page === end.page ? q.suffix : last.text.slice(end.offset, end.offset + 32),
  };
  const passage: PassageInput = {
    start,
    end,
    kind,
    text,
    quote,
    rects,
    segmenterVersion: SEGMENTER_VERSION,
  };
  if (lowQuality) passage.quality = 'low';

  const staged: StagedSelection = {
    passage,
    location: { page: start.page, pageLabel: labels?.[start.page] ?? String(start.page + 1), section: null },
    surrounding: surroundingText(first, start.offset, sameEnd, { before: 2, after: 1 }),
    pageText: first.text,
  };
  const prevText = store.text(start.page - 1)?.text;
  if (prevText !== undefined) staged.prevPageText = prevText;
  return staged;
}

/** Find a stored passage again when the offsets no longer match the quote (a new segmenter version). */
export function reanchor(store: PageStore, passage: PassageInput): { start: PassageAnchor; end: PassageAnchor } {
  const { start, end, quote } = passage;
  const pt = store.text(start.page);
  if (!pt || start.page !== end.page) return { start, end };
  if (pt.text.slice(start.offset, end.offset) === quote.exact) return { start, end };
  const hits: number[] = [];
  for (let i = pt.text.indexOf(quote.exact); i >= 0 && quote.exact; i = pt.text.indexOf(quote.exact, i + 1)) hits.push(i);
  if (hits.length === 0) return { start, end };
  const best = hits.reduce((x, y) => (Math.abs(y - start.offset) < Math.abs(x - start.offset) ? y : x));
  return { start: { page: start.page, offset: best }, end: { page: start.page, offset: best + quote.exact.length } };
}
