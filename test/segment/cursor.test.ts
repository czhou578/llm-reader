// The reading cursor moves over segmented pages. Pure logic; no DOM.
import { describe, expect, it } from 'vitest';
import type { PageText } from '../../src/shared/types.ts';
import * as cur from '../../src/web/viewer/cursor.ts';
import { segmentFixture } from './fixtures.ts';

async function pages(): Promise<PageText[]> {
  const p0 = await segmentFixture([
    { text: 'First paragraph has one sentence. And a second one.', y: 500 },
    { text: 'Second paragraph starts here and it runs on to the', y: 460 },
  ]);
  const p1 = await segmentFixture([
    { text: 'next page without a break. Then it ends.', y: 500 },
    { text: 'A last paragraph.', y: 460 },
  ]);
  return [{ ...p0.pageText, page: 0 }, { ...p1.pageText, page: 1 }];
}

function source(list: (PageText | undefined)[]): cur.TextSource {
  return { pageCount: list.length, text: (p) => list[p] };
}

function textOf(src: cur.TextSource, s: cur.CursorState): string {
  const r = cur.stateRange(src, s)!;
  const parts: string[] = [];
  for (let p = r.start.page; p <= r.end.page; p++) {
    const t = src.text(p)!.text;
    parts.push(t.slice(p === r.start.page ? r.start.offset : 0, p === r.end.page ? r.end.offset : t.length));
  }
  return parts.join(' | ');
}

describe('reading cursor', () => {
  it('moves by paragraph and sentence, and selects the first sentence from paragraph level', async () => {
    const src = source(await pages());
    const start: cur.CursorState = { level: 'paragraph', from: { page: 0, offset: 0 }, to: { page: 0, offset: 0 }, tint: false };
    const s1 = cur.nextSentence(src, start);
    expect(s1 && 'state' in s1 && textOf(src, s1.state)).toBe('First paragraph has one sentence.');
    const s2 = s1 && 'state' in s1 ? cur.nextSentence(src, s1.state) : null;
    expect(s2 && 'state' in s2 && textOf(src, s2.state)).toBe('And a second one.');
    const back = s2 && 'state' in s2 ? cur.prevSentence(src, s2.state) : null;
    expect(back && 'state' in back && textOf(src, back.state)).toBe('First paragraph has one sentence.');
  });

  it('extends and shrinks the selection', async () => {
    const src = source(await pages());
    const one: cur.CursorState = { level: 'sentence', from: { page: 0, offset: 0 }, to: { page: 0, offset: 0 }, tint: false };
    const ext = cur.extend(src, one);
    expect(ext && 'state' in ext && textOf(src, ext.state)).toBe('First paragraph has one sentence. And a second one.');
    const shr = ext && 'state' in ext ? cur.shrink(src, ext.state) : null;
    expect(shr && 'state' in shr && textOf(src, shr.state)).toBe('First paragraph has one sentence.');
    // With one sentence selected, shrink adds the previous sentence. There is none here.
    expect(cur.shrink(src, one)).toBeNull();
  });

  it('crosses a page break and joins a split sentence', async () => {
    const list = await pages();
    const src = source(list);
    const para = { page: 0, offset: list[0]!.paragraphs[1]![0] };
    const s = cur.nextSentence(src, { level: 'paragraph', from: para, to: para, tint: false });
    expect(s && 'state' in s && textOf(src, s.state)).toBe(
      'Second paragraph starts here and it runs on to the | next page without a break.',
    );
    const after = s && 'state' in s ? cur.nextSentence(src, s.state) : null;
    expect(after && 'state' in after && textOf(src, after.state)).toBe('Then it ends.');
  });

  it('asks for a page that is not segmented yet', async () => {
    const [p0] = await pages();
    const src = source([p0, undefined]);
    const last = { page: 0, offset: p0!.paragraphs[1]![0] };
    expect(cur.nextParagraph(src, { level: 'paragraph', from: last, to: last, tint: false })).toEqual({ need: 1 });
  });
});

describe('point and click placement', () => {
  it('places the cursor on the sentence or paragraph that contains an anchor', async () => {
    const src = source(await pages());
    const inSecond = { page: 0, offset: 'First paragraph has one sentence. And a se'.length };
    const s = cur.placeAt(src, 'sentence', inSecond)!;
    expect(textOf(src, s)).toBe('And a second one.');
    expect(s.level).toBe('sentence');
    const p = cur.placeAt(src, 'paragraph', inSecond)!;
    expect(textOf(src, p)).toBe('First paragraph has one sentence. And a second one.');
    expect(cur.placeAt(src, 'sentence', { page: 5, offset: 0 })).toBeNull();
  });

  it('extends a selection forward and backward to the sentence at an anchor', async () => {
    const src = source(await pages());
    const first = cur.placeAt(src, 'sentence', { page: 0, offset: 0 })!;
    const lastP0 = { page: 0, offset: src.text(0)!.text.indexOf('Second paragraph') + 3 };
    const fwd = cur.extendTo(src, first, lastP0)!;
    expect(textOf(src, fwd)).toContain('First paragraph');
    expect(textOf(src, fwd)).toContain('Second paragraph starts');
    // That sentence runs on to the next page, so the selection crosses the page break.
    expect(textOf(src, fwd)).toContain(' | next page without a break.');
    const second = cur.placeAt(src, 'sentence', { page: 0, offset: 40 })!;
    const back = cur.extendTo(src, second, { page: 0, offset: 2 })!;
    expect(textOf(src, back)).toBe('First paragraph has one sentence. And a second one.');
    expect(cur.extendTo(src, null, { page: 0, offset: 40 })).toEqual(second);
  });

  it('extends from a paragraph-level cursor as a sentence range', async () => {
    const src = source(await pages());
    const para: cur.CursorState = { level: 'paragraph', from: { page: 0, offset: 0 }, to: { page: 0, offset: 0 }, tint: false };
    const out = cur.extendTo(src, para, { page: 0, offset: 0 })!;
    expect(out.level).toBe('sentence');
    expect(textOf(src, out)).toBe('First paragraph has one sentence. And a second one.');
  });
});
