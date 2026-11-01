// rangesWithoutSkips cuts the skip spans (headers, footers, footnotes) out of an offset range. Pure logic; no DOM.
import { describe, expect, it } from 'vitest';
import { rangesWithoutSkips, textWithoutSkips } from '../../src/shared/segment/context.ts';
import type { PageText } from '../../src/shared/types.ts';

function page(text: string, skips: [number, number][]): PageText {
  return {
    page: 0,
    text,
    charMap: [],
    paragraphs: [],
    sentences: [],
    skipSpans: skips.map(([start, end]) => ({ start, end, kind: 'furniture' as const })),
    segmenterVersion: 1,
  };
}

describe('rangesWithoutSkips', () => {
  const pt = page('body text\nRunning footer | 129\nmore body', [[10, 30]]);

  it('leaves out a footer that sits inside the range, so a cross-page passage gets no footer rect', () => {
    expect(rangesWithoutSkips(pt, 0, pt.text.length)).toEqual([
      [0, 10],
      [30, pt.text.length],
    ]);
    expect(textWithoutSkips(pt, 0, pt.text.length)).toBe('body text\n\nmore body');
  });

  it('keeps a range that does not touch a skip span', () => {
    expect(rangesWithoutSkips(pt, 0, 9)).toEqual([[0, 9]]);
    expect(rangesWithoutSkips(pt, 30, 39)).toEqual([[30, 39]]);
  });

  it('returns nothing for a range inside a skip span', () => {
    expect(rangesWithoutSkips(pt, 12, 20)).toEqual([]);
  });

  it('cuts a range that starts or ends inside a skip span to its visible part', () => {
    expect(rangesWithoutSkips(pt, 5, 20)).toEqual([[5, 10]]);
    expect(rangesWithoutSkips(pt, 20, 35)).toEqual([[30, 35]]);
  });
});
