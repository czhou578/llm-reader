// Reading cursor moves (DESIGN.md 5.2, interaction.md 1.2 A). Pure functions over segmented pages; no DOM.
// The cursor holds logical offsets, not indexes, so a re-segmentation of skip spans does not move it.
import type { PageText, PassageAnchor } from '../../shared/types.ts';
import { continuesInto } from '../../shared/segment/index.ts';

export type Level = 'paragraph' | 'sentence';

export interface CursorState {
  level: Level;
  from: PassageAnchor; // start of the first unit
  to: PassageAnchor; // start of the last unit (inclusive)
  tint: boolean; // paragraph level: true when the paragraph is an explicit selection (toggleParagraph)
}

export interface TextSource {
  pageCount: number;
  text(page: number): PageText | undefined;
}

/** A move result: a new state, a page that must be segmented first, or null when the cursor cannot move. */
export type MoveResult = { state: CursorState } | { need: number } | null;

type Spans = readonly [number, number][];

/** Pages without units that a move skips before it gives up. */
const MAX_SKIP = 30;

export function unitsOf(pt: PageText, level: Level): Spans {
  return level === 'sentence' ? pt.sentences : pt.paragraphs;
}

function containing(list: Spans, offset: number): number {
  return list.findIndex(([s, e]) => offset >= s && offset < e);
}

function neighbor(list: Spans, offset: number, dir: 1 | -1): number {
  const i = containing(list, offset);
  if (i >= 0) return i + dir;
  if (dir > 0) {
    const j = list.findIndex(([s]) => s >= offset);
    return j < 0 ? list.length : j;
  }
  for (let j = list.length - 1; j >= 0; j--) if (list[j]![1] <= offset) return j;
  return -1;
}

export function sameAnchor(a: PassageAnchor, b: PassageAnchor): boolean {
  return a.page === b.page && a.offset === b.offset;
}

/** The [start, end) span of the unit that starts at or contains the anchor. */
export function unitSpan(src: TextSource, level: Level, a: PassageAnchor): [number, number] | null {
  const pt = src.text(a.page);
  if (!pt) return null;
  const list = unitsOf(pt, level);
  const i = containing(list, a.offset);
  return i >= 0 ? [list[i]![0], list[i]![1]] : null;
}

/** The start of the next (dir 1) or previous (dir -1) unit, across pages. */
export function step(
  src: TextSource,
  level: Level,
  a: PassageAnchor,
  dir: 1 | -1,
): { ok: PassageAnchor } | { need: number } | null {
  const pt = src.text(a.page);
  if (!pt) return { need: a.page };
  const list = unitsOf(pt, level);
  const j = neighbor(list, a.offset, dir);
  if (j >= 0 && j < list.length) return { ok: { page: a.page, offset: list[j]![0] } };
  for (let p = a.page + dir, n = 0; p >= 0 && p < src.pageCount && n < MAX_SKIP; p += dir, n++) {
    const t = src.text(p);
    if (!t) return { need: p };
    const l = unitsOf(t, level);
    if (l.length > 0) return { ok: { page: p, offset: dir > 0 ? l[0]![0] : l[l.length - 1]![0] } };
  }
  return null;
}

/** First unit of a page at or after `page`, for a cursor with no position yet. */
export function firstUnitFrom(src: TextSource, level: Level, page: number): { ok: PassageAnchor } | { need: number } | null {
  for (let p = page, n = 0; p < src.pageCount && n < MAX_SKIP; p++, n++) {
    const t = src.text(p);
    if (!t) return { need: p };
    const l = unitsOf(t, level);
    if (l.length > 0) return { ok: { page: p, offset: l[0]![0] } };
  }
  return null;
}

function paragraphOf(src: TextSource, a: PassageAnchor): [number, number] | null {
  return unitSpan(src, 'paragraph', a);
}

function sentencesIn(pt: PageText, para: [number, number]): Spans {
  return pt.sentences.filter(([s, e]) => s >= para[0] && e <= para[1]);
}

/**
 * A sentence or paragraph that a page break splits shows as one unit: add the piece on the other page.
 * The piece is added only when that page is segmented already.
 */
export function joinAcrossBreak(src: TextSource, s: CursorState): CursorState {
  let { from, to } = s;
  const toPt = src.text(to.page);
  const next = src.text(to.page + 1);
  if (toPt && next && continuesInto(toPt, next)) {
    const list = unitsOf(toPt, s.level);
    const nl = unitsOf(next, s.level);
    if (list.length > 0 && containing(list, to.offset) === list.length - 1 && nl.length > 0) {
      to = { page: to.page + 1, offset: nl[0]![0] };
    }
  }
  const fromPt = src.text(from.page);
  const prev = src.text(from.page - 1);
  if (fromPt && prev && continuesInto(prev, fromPt)) {
    const list = unitsOf(fromPt, s.level);
    const pl = unitsOf(prev, s.level);
    if (list.length > 0 && containing(list, from.offset) === 0 && pl.length > 0) {
      from = { page: from.page - 1, offset: pl[pl.length - 1]![0] };
    }
  }
  return { ...s, from, to };
}

function single(level: Level, a: PassageAnchor): CursorState {
  return { level, from: a, to: a, tint: false };
}

function paragraphStart(src: TextSource, a: PassageAnchor): PassageAnchor {
  const para = paragraphOf(src, a);
  return para ? { page: a.page, offset: para[0] } : a;
}

export function nextParagraph(src: TextSource, s: CursorState): MoveResult {
  const anchor = s.level === 'paragraph' ? s.to : paragraphStart(src, s.to);
  const r = step(src, 'paragraph', anchor, 1);
  if (!r) return null;
  if ('need' in r) return r;
  return { state: joinAcrossBreak(src, single('paragraph', r.ok)) };
}

export function prevParagraph(src: TextSource, s: CursorState): MoveResult {
  const anchor = s.level === 'paragraph' ? s.from : paragraphStart(src, s.from);
  const r = step(src, 'paragraph', anchor, -1);
  if (!r) return null;
  if ('need' in r) return r;
  return { state: joinAcrossBreak(src, single('paragraph', r.ok)) };
}

export function nextSentence(src: TextSource, s: CursorState): MoveResult {
  if (s.level === 'paragraph') {
    // From paragraph level, the first sentence key selects the first sentence of the paragraph.
    const pt = src.text(s.from.page);
    const para = paragraphOf(src, s.from);
    const first = pt && para ? sentencesIn(pt, para)[0] : undefined;
    if (first) return { state: joinAcrossBreak(src, single('sentence', { page: s.from.page, offset: first[0] })) };
  }
  const r = step(src, 'sentence', s.to, 1);
  if (!r) return null;
  if ('need' in r) return r;
  return { state: joinAcrossBreak(src, single('sentence', r.ok)) };
}

export function prevSentence(src: TextSource, s: CursorState): MoveResult {
  if (s.level === 'paragraph') {
    // From paragraph level, the previous-sentence key selects the last sentence of the paragraph.
    const pt = src.text(s.to.page);
    const para = paragraphOf(src, s.to);
    const list = pt && para ? sentencesIn(pt, para) : [];
    const last = list[list.length - 1];
    if (last) return { state: joinAcrossBreak(src, single('sentence', { page: s.to.page, offset: last[0] })) };
  }
  const r = step(src, 'sentence', s.from, -1);
  if (!r) return null;
  if ('need' in r) return r;
  return { state: joinAcrossBreak(src, single('sentence', r.ok)) };
}

/** The same selection as a sentence range. */
export function asSentences(src: TextSource, s: CursorState): CursorState {
  if (s.level === 'sentence') return s;
  const fromPt = src.text(s.from.page);
  const toPt = src.text(s.to.page);
  const fp = paragraphOf(src, s.from);
  const tp = paragraphOf(src, s.to);
  const first = fromPt && fp ? sentencesIn(fromPt, fp)[0] : undefined;
  const lastList = toPt && tp ? sentencesIn(toPt, tp) : [];
  const last = lastList[lastList.length - 1];
  return {
    level: 'sentence',
    from: first ? { page: s.from.page, offset: first[0] } : s.from,
    to: last ? { page: s.to.page, offset: last[0] } : s.to,
    tint: false,
  };
}

/** Add the next sentence to the selection. */
export function extend(src: TextSource, s: CursorState): MoveResult {
  const base = asSentences(src, s);
  const r = step(src, 'sentence', base.to, 1);
  if (!r) return null;
  if ('need' in r) return r;
  return { state: joinAcrossBreak(src, { ...base, to: r.ok }) };
}

/** Remove the last sentence, or add the previous one when only one sentence is selected. */
export function shrink(src: TextSource, s: CursorState): MoveResult {
  const base = asSentences(src, s);
  const one = sameAnchor(base.from, base.to);
  const r = step(src, 'sentence', one ? base.from : base.to, -1);
  if (!r) return null;
  if ('need' in r) return r;
  return { state: one ? { ...base, from: r.ok } : { ...base, to: r.ok } };
}

/** The logical range [start, end) that the state covers. */
export function stateRange(
  src: TextSource,
  s: CursorState,
): { start: PassageAnchor; end: PassageAnchor } | null {
  const first = unitSpan(src, s.level, s.from);
  const last = unitSpan(src, s.level, s.to);
  if (!first || !last) return null;
  return { start: { page: s.from.page, offset: first[0] }, end: { page: s.to.page, offset: last[1] } };
}

/** The sentence that contains the anchor, or the first sentence after it on the same page. */
export function sentenceAt(src: TextSource, a: PassageAnchor): PassageAnchor | null {
  const pt = src.text(a.page);
  if (!pt) return null;
  const i = containing(pt.sentences, a.offset);
  const j = i >= 0 ? i : pt.sentences.findIndex(([s]) => s >= a.offset);
  const span = pt.sentences[j];
  return span ? { page: a.page, offset: span[0] } : null;
}

/** The paragraph that contains the anchor, or the first paragraph after it on the same page. */
export function paragraphAt(src: TextSource, a: PassageAnchor): PassageAnchor | null {
  const pt = src.text(a.page);
  if (!pt) return null;
  const i = containing(pt.paragraphs, a.offset);
  const j = i >= 0 ? i : pt.paragraphs.findIndex(([s]) => s >= a.offset);
  const span = pt.paragraphs[j];
  return span ? { page: a.page, offset: span[0] } : null;
}

/** True when anchor a comes before anchor b in reading order. */
export function before(a: PassageAnchor, b: PassageAnchor): boolean {
  return a.page < b.page || (a.page === b.page && a.offset < b.offset);
}

/** The cursor on the unit that contains the anchor: a click or a key aimed with the pointer. */
export function placeAt(src: TextSource, level: Level, a: PassageAnchor): CursorState | null {
  const unit = level === 'sentence' ? sentenceAt(src, a) : paragraphAt(src, a);
  return unit ? joinAcrossBreak(src, { level, from: unit, to: unit, tint: false }) : null;
}

/** Grow the selection so it also covers the sentence that contains the anchor. With no selection, select that sentence. */
export function extendTo(src: TextSource, s: CursorState | null, a: PassageAnchor): CursorState | null {
  const target = sentenceAt(src, a);
  if (!target) return null;
  if (!s) return joinAcrossBreak(src, { level: 'sentence', from: target, to: target, tint: false });
  const base = asSentences(src, s);
  const from = before(target, base.from) ? target : base.from;
  const to = before(base.to, target) ? target : base.to;
  return joinAcrossBreak(src, { ...base, from, to });
}
