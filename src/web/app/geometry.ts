// Screen position of the staged passage, for the ask box.
import type { Rect } from '../../shared/types.ts';

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Converts the passage rects to one client box. Assumption: a rect is normalized to the page in PDF user space,
 * so y grows upward from the page bottom (shared/types.ts `Rect`). The page element is the PDF.js `.page` div with
 * `data-page-number` (1-based). Returns null when no page of the passage is in the DOM.
 */
export function passageClientBox(container: HTMLElement, rects: readonly { page: number; rect: Rect }[]): Box | null {
  let box: Box | null = null;
  for (const { page, rect } of rects) {
    const el = container.querySelector(`[data-page-number="${page + 1}"]`);
    if (!el) continue;
    const p = el.getBoundingClientRect();
    const r: Box = {
      left: p.left + rect[0] * p.width,
      right: p.left + rect[2] * p.width,
      top: p.top + (1 - rect[3]) * p.height,
      bottom: p.top + (1 - rect[1]) * p.height,
    };
    box = box
      ? { left: Math.min(box.left, r.left), top: Math.min(box.top, r.top), right: Math.max(box.right, r.right), bottom: Math.max(box.bottom, r.bottom) }
      : r;
  }
  return box;
}

export interface Placement {
  left: number;
  width: number;
  /** Set when the box goes below the passage. */
  top?: number;
  /** Set when the box goes above the passage (distance from the viewport bottom). */
  bottom?: number;
}

/**
 * The ask box goes just below the passage. When the passage is in the bottom third of the pane, it goes above.
 * Without a passage box it goes near the bottom of the pane.
 */
export function placeAskBox(passage: Box | null, pane: Box, viewportHeight: number, maxWidth = 620): Placement {
  const margin = 12;
  const width = Math.max(240, Math.min(maxWidth, pane.right - pane.left - 2 * margin));
  const anchorLeft = passage ? passage.left : pane.left + margin;
  const left = Math.max(pane.left + margin, Math.min(anchorLeft, pane.right - margin - width));
  if (!passage || passage.bottom < pane.top || passage.top > pane.bottom) {
    return { left, width, bottom: viewportHeight - pane.bottom + margin * 4 };
  }
  const lowerThird = pane.top + ((pane.bottom - pane.top) * 2) / 3;
  if (passage.bottom < lowerThird) return { left, width, top: passage.bottom + 8 };
  return { left, width, bottom: viewportHeight - passage.top + 8 };
}
