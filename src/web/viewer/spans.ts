// Pair PDF.js text items with text-layer spans. Pure logic; no DOM.

/**
 * Pair text items with text-layer spans by their text, in order. PDF.js makes one span per non-empty item, but a span
 * can be missing or changed after rendering. A short lookahead skips an extra span, and an item with no match stays a
 * hole (-1), so one odd span does not unmap the whole page. Returns the span index for each item, or -1.
 */
export function alignSpans(items: readonly (string | undefined)[], spans: readonly string[], lookahead = 3): number[] {
  const out = new Array<number>(items.length).fill(-1);
  let k = 0;
  for (let i = 0; i < items.length; i++) {
    const str = items[i];
    if (typeof str !== 'string' || str === '') continue;
    const end = Math.min(spans.length, k + lookahead + 1);
    for (let j = k; j < end; j++) {
      if (spans[j] === str) {
        out[i] = j;
        k = j + 1;
        break;
      }
    }
  }
  return out;
}
