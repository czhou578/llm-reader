// alignSpans pairs text items with text-layer spans. Pure logic; no DOM.
import { describe, expect, it } from 'vitest';
import { alignSpans } from '../../src/web/viewer/spans.ts';

describe('alignSpans', () => {
  it('pairs one span per non-empty item and skips empty and marked-content items', () => {
    expect(alignSpans(['a', '', undefined, 'b', ' ', 'c'], ['a', 'b', ' ', 'c'])).toEqual([0, -1, -1, 1, 2, 3]);
  });

  it('leaves a hole for an item whose span is missing, and keeps the rest of the page', () => {
    // The span for "Pattern coverage test" is gone; later items still pair.
    expect(alignSpans(['x', 'Pattern coverage test', 'Every user story', 'y'], ['x', 'Every user story', 'y'])).toEqual([0, -1, 1, 2]);
  });

  it('skips an extra span within the lookahead', () => {
    expect(alignSpans(['a', 'b', 'c'], ['a', 'stray', 'b', 'c'])).toEqual([0, 2, 3]);
  });

  it('does not reach past the lookahead', () => {
    expect(alignSpans(['a', 'z'], ['a', '1', '2', '3', '4', 'z'], 3)).toEqual([0, -1]);
  });
});
