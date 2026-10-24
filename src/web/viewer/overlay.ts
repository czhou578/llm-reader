// The overlay layer: one div per page above the text layer. It draws the tint, the gutter bar, and anchors.
// Positions are in percent of the page box, so a zoom change needs no redraw. pdf.js removes the div when it
// resets a page view; render() puts it back.
import type { Rect } from '../../shared/types.ts';
import { rectToPct, unionRect, type PageGeometry, type PctBox } from './geometry.ts';

export interface SelectionMarks {
  rects: { page: number; rect: Rect }[];
  tint: boolean;
  bar: boolean;
}

const OVERLAY_CLASS = 'lr-overlay';

function simplePct(rect: Rect): PctBox {
  return { left: 100 * rect[0], top: 100 * (1 - rect[3]), width: 100 * (rect[2] - rect[0]), height: 100 * (rect[3] - rect[1]) };
}

export class Overlay {
  private selection = new Map<number, { tint: Rect[]; bar: Rect | null }>();
  private anchors = new Map<number, Rect[]>();

  constructor(
    private readonly pageDiv: (page: number) => HTMLElement | null,
    private readonly geometry: (page: number) => PageGeometry | undefined,
  ) {}

  setSelection(marks: SelectionMarks | null): void {
    const old = new Set(this.selection.keys());
    this.selection = new Map();
    for (const { page, rect } of marks?.rects ?? []) {
      let entry = this.selection.get(page);
      if (!entry) this.selection.set(page, (entry = { tint: [], bar: null }));
      entry.tint.push(rect);
    }
    for (const entry of this.selection.values()) {
      const u = marks?.bar ? unionRect(entry.tint) : null;
      entry.bar = u;
      if (!marks?.tint) entry.tint = [];
    }
    for (const page of new Set([...old, ...this.selection.keys()])) this.render(page);
  }

  setAnchors(byPage: Map<number, Rect[]>): void {
    const pages = new Set([...this.anchors.keys(), ...byPage.keys()]);
    this.anchors = byPage;
    for (const page of pages) this.render(page);
  }

  /** Redraw every page that has marks, for example after a zoom change. */
  renderAll(): void {
    for (const page of new Set([...this.selection.keys(), ...this.anchors.keys()])) this.render(page);
  }

  clear(): void {
    const pages = new Set([...this.selection.keys(), ...this.anchors.keys()]);
    this.selection.clear();
    this.anchors.clear();
    for (const page of pages) this.render(page);
  }

  render(page: number): void {
    const div = this.pageDiv(page);
    if (!div) return;
    let layer = div.querySelector<HTMLDivElement>(`:scope > .${OVERLAY_CLASS}`);
    const sel = this.selection.get(page);
    const anchors = this.anchors.get(page) ?? [];
    if (!sel && anchors.length === 0) {
      layer?.replaceChildren();
      return;
    }
    if (!layer) {
      layer = document.createElement('div');
      layer.className = OVERLAY_CLASS;
      div.append(layer);
    }
    const geo = this.geometry(page);
    const pct = (r: Rect): PctBox => (geo ? rectToPct(geo, r) : simplePct(r));
    const nodes: HTMLElement[] = [];
    const box = (cls: string, b: PctBox, withWidth = true): void => {
      const el = document.createElement('div');
      el.className = cls;
      el.style.left = `${b.left}%`;
      el.style.top = `${b.top}%`;
      if (withWidth) el.style.width = `${b.width}%`;
      el.style.height = `${b.height}%`;
      nodes.push(el);
    };
    for (const r of anchors) {
      const b = pct(r);
      box('lr-anchor', { left: b.left, top: b.top + b.height, width: b.width, height: 0 });
    }
    for (const r of sel?.tint ?? []) box('lr-tint', pct(r));
    if (sel?.bar) box('lr-bar', pct(sel.bar), false); // the CSS gives the bar its width
    layer.replaceChildren(...nodes);
  }
}
