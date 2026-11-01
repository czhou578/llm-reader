// Pair PDF.js text items with text-layer spans, and drop the span maps of removed layers. Pure logic; no DOM.

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

/**
 * Remove the entries whose text layer is no longer in the document, and return their pages. pdf.js removes the text
 * layer of a page that leaves its page-view buffer. An entry that keeps it holds detached spans that nothing can use.
 */
export function dropDetached<T extends { layer: { isConnected: boolean } }>(maps: Map<number, T>): number[] {
  const dropped: number[] = [];
  for (const [page, map] of maps) {
    if (map.layer.isConnected) continue;
    maps.delete(page);
    dropped.push(page);
  }
  return dropped;
}
