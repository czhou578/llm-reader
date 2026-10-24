import { describe, expect, it } from 'vitest';
import {
  MARK_CLOSE,
  MARK_OPEN,
  itemOffsetToLogical,
  offsetsToItemRanges,
  sourceCharsOf,
  surroundingText,
} from '../../src/shared/segment/index.ts';
import { segmentFixture, spanTexts } from './fixtures.ts';

// Helvetica 12 pt, 14 pt line pitch, left margin 40.
const PARA_A = [
  { text: 'The model is trained on an exam-', y: 500 },
  { text: 'ple set of documents. It learns the', y: 486 },
  { text: 'structure well. Then it stops.', y: 472 },
];
const PARA_B = [
  { text: 'A second paragraph starts here after', y: 440 },
  { text: 'a clear vertical gap. It has two lines.', y: 426 },
];

describe('segmentPage', () => {
  it('joins a hyphen at a line end and splits sentences', async () => {
    const { pageText } = await segmentFixture(PARA_A);
    expect(pageText.paragraphs).toHaveLength(1);
    expect(pageText.text).toBe(
      'The model is trained on an example set of documents. It learns the structure well. Then it stops.',
    );
    expect(spanTexts(pageText, pageText.sentences)).toEqual([
      'The model is trained on an example set of documents.',
      'It learns the structure well.',
      'Then it stops.',
    ]);
    // The dropped hyphen is a gap in the char map: no run covers it.
    const examItem = pageText.charMap.find((r) => !r.synthetic && pageText.text.slice(r.logicalStart).startsWith('The'));
    expect(examItem).toBeDefined();
    expect(examItem!.length).toBe('The model is trained on an exam'.length);
    expect(pageText.flags?.continuesOnNextPage).toBeUndefined();
  });

  it('keeps a real hyphen in a compound', async () => {
    const { pageText } = await segmentFixture([
      { text: 'This is a well-', y: 500 },
      { text: 'known result and a self-', y: 486 },
      { text: 'contained proof of it.', y: 472 },
    ]);
    expect(pageText.text).toBe('This is a well-known result and a self-contained proof of it.');
  });

  it('splits two paragraphs at a vertical gap', async () => {
    const { pageText } = await segmentFixture([...PARA_A, ...PARA_B]);
    expect(pageText.paragraphs).toHaveLength(2);
    const [, second] = spanTexts(pageText, pageText.paragraphs);
    expect(second).toBe('A second paragraph starts here after a clear vertical gap. It has two lines.');
    expect(pageText.sentences).toHaveLength(5);
  });

  it('splits paragraphs at a first-line indent', async () => {
    const { pageText } = await segmentFixture([
      { text: 'One paragraph ends on a full line of text here', y: 500 },
      { text: 'and goes on for a second line of text too', y: 486 },
      { text: 'New paragraph with an indent at the', y: 472, x: 64 },
      { text: 'start and a second line at the margin.', y: 458 },
    ]);
    expect(pageText.paragraphs).toHaveLength(2);
  });

  it('does not split sentences after e.g. and Fig.', async () => {
    const { pageText } = await segmentFixture([
      { text: 'Some methods, e.g. this one, work well.', y: 500 },
      { text: 'As Fig. 3 shows, the error drops. See', y: 486 },
      { text: 'Dr. Smith and J. Doe et al. Results vary.', y: 472 },
    ]);
    expect(spanTexts(pageText, pageText.sentences)).toEqual([
      'Some methods, e.g. this one, work well.',
      'As Fig. 3 shows, the error drops.',
      'See Dr. Smith and J. Doe et al. Results vary.',
    ]);
  });

  it('marks a lone page number at the bottom as a furniture skip span', async () => {
    const { pageText } = await segmentFixture([...PARA_A, { text: '17', x: 195, y: 30, size: 10 }]);
    expect(pageText.paragraphs).toHaveLength(1);
    expect(pageText.skipSpans).toHaveLength(1);
    const skip = pageText.skipSpans[0]!;
    expect(skip.kind).toBe('furniture');
    expect(pageText.text.slice(skip.start, skip.end)).toBe('17');
    // The cursor units do not include the footer.
    for (const [a, b] of pageText.sentences) expect(b <= skip.start || a >= skip.end).toBe(true);
  });

  it('marks a running header from the profile as furniture', async () => {
    const lines = [{ text: 'Chapter 2. Methods', y: 570, size: 9 }, ...PARA_A];
    const plain = await segmentFixture(lines);
    expect(plain.pageText.skipSpans).toHaveLength(0);
    const withProfile = await segmentFixture(lines, { profile: { headerFooterKeys: ['chapter #. methods'] } });
    expect(withProfile.pageText.skipSpans.map((s) => s.kind)).toEqual(['furniture']);
    // The profile changes the classification, not the offsets.
    expect(withProfile.pageText.text).toBe(plain.pageText.text);
  });

  it('sets continuesOnNextPage and lowText', async () => {
    const open = await segmentFixture([{ text: 'This sentence runs on to the next', y: 500 }]);
    expect(open.pageText.flags?.continuesOnNextPage).toBe(true);
    const tiny = await segmentFixture([{ text: 'Short.', y: 500 }]);
    expect(tiny.pageText.flags?.lowText).toBe(true);
  });

  it('reads two columns left column first', async () => {
    const left = ['Left column line one of', 'the text, and it goes', 'on to a third line and', 'ends here in a period.'];
    const right = ['Right column starts here', 'and has its own text in', 'four short lines that', 'end with a period too.'];
    const lines = [
      ...left.map((text, i) => ({ text, x: 40, y: 500 - 14 * i, size: 10 })),
      ...right.map((text, i) => ({ text, x: 320, y: 500 - 14 * i, size: 10 })),
    ];
    const { pageText } = await segmentFixture(lines, { width: 600 });
    expect(pageText.text.indexOf('Left column')).toBeLessThan(pageText.text.indexOf('Right column'));
    expect(pageText.text).toContain('ends here in a period.');
    expect(pageText.text).toContain('the text, and it goes on to a third line');
  });
});

describe('char map', () => {
  it('round-trips a sentence through item ranges', async () => {
    const { pageText, items } = await segmentFixture([...PARA_A, ...PARA_B]);
    for (const [a, b] of pageText.sentences) {
      const ranges = offsetsToItemRanges(pageText, a, b);
      const fromItems = ranges.map((r) => items[r.item]!.str!.slice(r.start, r.end)).join('');
      // The logical text without its synthetic characters equals the item text. The dropped hyphen is in neither.
      let logical = '';
      for (let i = a; i < b; i++) {
        const synthetic = pageText.charMap.some((r) => r.synthetic && i >= r.logicalStart && i < r.logicalStart + r.length);
        if (!synthetic) logical += pageText.text[i];
      }
      expect(fromItems).toBe(logical);
      expect(sourceCharsOf(pageText, a, b)).toBe(logical);
      // Each range start maps back to its logical offset.
      const first = ranges[0]!;
      expect(itemOffsetToLogical(pageText, first.item, first.start)).toBe(a);
    }
    // The first sentence crosses the hyphen: the item text has "exam" + "ple", the logical text "example".
    const [s0a, s0b] = pageText.sentences[0]!;
    const r0 = offsetsToItemRanges(pageText, s0a, s0b);
    expect(r0.map((r) => items[r.item]!.str!.slice(r.start, r.end))).toEqual([
      'The model is trained on an exam',
      'ple set of documents.',
    ]);
    // An offset on the dropped hyphen maps to the next logical position.
    const hyphenItem = r0[0]!.item;
    const hyphenAt = items[hyphenItem]!.str!.length - 1;
    expect(itemOffsetToLogical(pageText, hyphenItem, hyphenAt)).toBe(pageText.text.indexOf('ple set'));
  });
});

describe('surroundingText', () => {
  it('marks the span and includes the paragraph before', async () => {
    const { pageText } = await segmentFixture([...PARA_A, ...PARA_B]);
    const target = pageText.sentences[3]!; // "A second paragraph ... gap."
    const out = surroundingText(pageText, target[0], target[1], { before: 2, after: 1 });
    const paras = spanTexts(pageText, pageText.paragraphs);
    expect(out.startsWith(paras[0]!)).toBe(true);
    expect(out).toContain(`${MARK_OPEN}A second paragraph starts here after a clear vertical gap.${MARK_CLOSE} It has two lines.`);
    expect(out.split('\n\n')).toHaveLength(2);
  });
});

describe('splitSentences', () => {
  it('falls back to English for a bad language tag', async () => {
    const { splitSentences } = await import('../../src/shared/segment/index.ts');
    expect(splitSentences('One. Two.', 0, 9, 'not a tag!')).toEqual([
      [0, 4],
      [5, 9],
    ]);
  });
});
