// Rectangles. Stored rects are normalized PDF user space: [x0, y0, x1, y1] / view box, y up, no rotation.
// The overlay draws in percent of the page box, so a zoom change needs no redraw.
import type { PageViewport } from 'pdfjs-dist';
import type { Rect } from '../../shared/types.ts';
import type { ItemRange, TextItemLike, TextStyleLike } from '../../shared/segment/index.ts';

export interface PageGeometry {
  view: number[]; // [x0, y0, x1, y1] in user space
  viewport: PageViewport; // scale 1, the page's own rotation
  items: readonly TextItemLike[];
  styles: Record<string, TextStyleLike>;
}

/** A box in percent of the page box, top-left origin, as the overlay draws it. */
export interface PctBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

function normalize(view: number[], x0: number, y0: number, x1: number, y1: number): Rect {
  const [vx0 = 0, vy0 = 0, vx1 = 1, vy1 = 1] = view;
  const w = vx1 - vx0 || 1;
  const h = vy1 - vy0 || 1;
  return [
    (Math.min(x0, x1) - vx0) / w,
    (Math.min(y0, y1) - vy0) / h,
    (Math.max(x0, x1) - vx0) / w,
    (Math.max(y0, y1) - vy0) / h,
  ];
}

/** Approximate method: a part of the item box in proportion to the character count (architecture.md 2.5). */
export function itemRangeRect(geo: PageGeometry, range: ItemRange): Rect | null {
  const item = geo.items[range.item];
  const t = item?.transform;
  if (!item || !t || typeof item.str !== 'string' || item.str.length === 0) return null;
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = t;
  const style = (item.fontName && geo.styles[item.fontName]) || {};
  const fs = Math.hypot(c, d) || item.height || 10;
  const asc = (style.ascent ?? 0.8) * fs;
  const desc = (style.descent ?? -0.2) * fs;
  const w = item.width ?? 0;
  const len = item.str.length;
  const u0 = (w * range.start) / len;
  const u1 = (w * range.end) / len;
  // Corners in text space (u along the baseline, v up), then rotate by the item angle.
  const angle = Math.atan2(b, a);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const pts = [
    [u0, desc],
    [u1, desc],
    [u0, asc],
    [u1, asc],
  ].map(([u, v]) => [e + u! * cos - v! * sin, f + u! * sin + v! * cos] as const);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return normalize(geo.view, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
}

/** Precise method: convert a client rect of a text-layer range to a normalized rect. */
export function clientRectToRect(geo: PageGeometry, pageDiv: HTMLElement, r: DOMRect): Rect | null {
  const box = pageDiv.getBoundingClientRect();
  const w = pageDiv.clientWidth;
  const h = pageDiv.clientHeight;
  if (w <= 0 || h <= 0 || r.width <= 0 || r.height <= 0) return null;
  const left = box.left + pageDiv.clientLeft;
  const top = box.top + pageDiv.clientTop;
  const vp = geo.viewport;
  const toPdf = (cx: number, cy: number): number[] =>
    vp.convertToPdfPoint(((cx - left) / w) * vp.width, ((cy - top) / h) * vp.height) as number[];
  const [x0 = 0, y0 = 0] = toPdf(r.left, r.top);
  const [x1 = 0, y1 = 0] = toPdf(r.right, r.bottom);
  return normalize(geo.view, x0, y0, x1, y1);
}

/** Normalized rect to a box in percent of the page box. */
export function rectToPct(geo: PageGeometry, rect: Rect): PctBox {
  const [vx0 = 0, vy0 = 0, vx1 = 1, vy1 = 1] = geo.view;
  const vp = geo.viewport;
  const x0 = vx0 + rect[0] * (vx1 - vx0);
  const y0 = vy0 + rect[1] * (vy1 - vy0);
  const x1 = vx0 + rect[2] * (vx1 - vx0);
  const y1 = vy0 + rect[3] * (vy1 - vy0);
  const [ax = 0, ay = 0] = vp.convertToViewportPoint(x0, y0) as number[];
  const [bx = 0, by = 0] = vp.convertToViewportPoint(x1, y1) as number[];
  return {
    left: (100 * Math.min(ax, bx)) / vp.width,
    top: (100 * Math.min(ay, by)) / vp.height,
    width: (100 * Math.abs(bx - ax)) / vp.width,
    height: (100 * Math.abs(by - ay)) / vp.height,
  };
}

/** Merge rects that sit on the same line and touch, so one line gives one rect. */
export function mergeRects(rects: Rect[]): Rect[] {
  const eps = 0.004;
  const sorted = [...rects].sort((p, q) => q[1] - p[1] || p[0] - q[0]);
  const out: Rect[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[1] - r[1]) < eps && Math.abs(last[3] - r[3]) < eps && r[0] <= last[2] + 0.02) {
      last[0] = Math.min(last[0], r[0]);
      last[2] = Math.max(last[2], r[2]);
    } else {
      out.push([...r]);
    }
  }
  return out;
}

export function unionRect(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  return [
    Math.min(...rects.map((r) => r[0])),
    Math.min(...rects.map((r) => r[1])),
    Math.max(...rects.map((r) => r[2])),
    Math.max(...rects.map((r) => r[3])),
  ];
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The index of the box nearest to a point, or -1 when no box is within maxDistance. A vertical gap counts four times
 * a horizontal gap, so a point between two words picks its own line, not the line above. Holes in the list are skipped.
 */
export function nearestBox(boxes: readonly (Box | null | undefined)[], x: number, y: number, maxDistance: number): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (!b || b.right <= b.left || b.bottom <= b.top) continue;
    const dx = x < b.left ? b.left - x : x > b.right ? x - b.right : 0;
    const dy = y < b.top ? b.top - y : y > b.bottom ? y - b.bottom : 0;
    if (dx > maxDistance || dy > maxDistance) continue;
    const d = dy * 4 + dx;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
