// Geometry steps of the segmenter: normalize items, build lines, find a column gutter, order the lines.
// Coordinates are PDF user space: the origin is at the bottom left and y goes up.

/** The fields of a pdf.js TextItem or TextMarkedContent that the segmenter reads. */
export interface TextItemLike {
  str?: string;
  transform?: readonly number[];
  width?: number;
  height?: number;
  dir?: string;
  fontName?: string;
  hasEOL?: boolean;
  type?: string;
}

export interface TextStyleLike {
  ascent?: number;
  descent?: number;
  vertical?: boolean;
}

/** One text item, positioned. */
export interface Frag {
  item: number; // index into the items array
  str: string;
  x: number; // left edge of the run
  y: number; // baseline
  w: number;
  fs: number; // font size in user space
  ascent: number; // fraction of fs above the baseline
  descent: number; // fraction of fs below the baseline (negative)
  rtl: boolean;
}

export interface Line {
  frags: Frag[];
  y: number;
  x0: number;
  x1: number;
  fs: number;
  /** 0 = left or only column, 1 = right column, -1 = spans the gutter. */
  col: number;
}

const ROTATION_LIMIT = (2 * Math.PI) / 180;
const WS = /\s/;

export function isBlank(s: string): boolean {
  return !/\S/.test(s);
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))]!;
}

/** Step 1: drop empty items and fake-bold duplicates, and separate rotated items. Item indexes stay as they are. */
export function normalizeItems(
  items: readonly TextItemLike[],
  styles: Record<string, TextStyleLike>,
): { frags: Frag[]; rotated: Frag[] } {
  const frags: Frag[] = [];
  const rotated: Frag[] = [];
  const seen = new Set<string>();
  items.forEach((it, index) => {
    if (typeof it.str !== 'string' || isBlank(it.str) || !it.transform || it.transform.length < 6) return;
    const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = it.transform;
    const style = (it.fontName && styles[it.fontName]) || {};
    const fs = Math.hypot(c, d) || it.height || 0;
    if (fs <= 0) return;
    const key = `${it.str}|${Math.round(e * 2)}|${Math.round(f * 2)}`;
    if (seen.has(key)) return; // overprint for fake bold
    seen.add(key);
    const frag: Frag = {
      item: index,
      str: it.str,
      x: e,
      y: f,
      w: it.width ?? 0,
      fs,
      ascent: style.ascent ?? 0.8,
      descent: style.descent ?? -0.2,
      rtl: it.dir === 'rtl',
    };
    const angle = Math.atan2(b, a);
    if (Math.abs(angle) > ROTATION_LIMIT || style.vertical || it.dir === 'ttb') rotated.push(frag);
    else frags.push(frag);
  });
  return { frags, rotated };
}

function makeLine(frags: Frag[], col = 0): Line {
  const rtl = frags.filter((f) => f.rtl).length > frags.length / 2;
  frags.sort((p, q) => (rtl ? q.x - p.x : p.x - q.x));
  let main = frags[0]!;
  for (const f of frags) if (f.str.length > main.str.length) main = f;
  return {
    frags,
    y: main.y,
    x0: Math.min(...frags.map((f) => f.x)),
    x1: Math.max(...frags.map((f) => f.x + f.w)),
    fs: main.fs,
    col,
  };
}

/** Step 2: group items into lines by baseline. */
export function buildLines(frags: Frag[], medianFs: number): Line[] {
  const tol = 0.35 * medianFs;
  const sorted = [...frags].sort((p, q) => q.y - p.y || p.x - q.x);
  const lines: Line[] = [];
  let current: Frag[] = [];
  let currentY = 0;
  for (const f of sorted) {
    if (current.length > 0 && Math.abs(currentY - f.y) <= tol) {
      current.push(f);
    } else {
      if (current.length > 0) lines.push(makeLine(current));
      current = [f];
      currentY = f.y;
    }
  }
  if (current.length > 0) lines.push(makeLine(current));
  return lines;
}

/**
 * Step 3 (simple form of XY-cut): find one vertical gutter in the middle 40 % of the page.
 * Returns the gutter x, or null for a single-column page.
 */
export function findGutter(lines: Line[], viewBox: readonly number[], medianFs: number): number | null {
  const [vx0 = 0, , vx1 = 612] = viewBox;
  const width = vx1 - vx0;
  if (lines.length < 3 || width <= 0) return null;
  const lo = Math.floor(vx0 + 0.3 * width);
  const hi = Math.ceil(vx0 + 0.7 * width);
  const cover = new Array<number>(hi - lo).fill(0);
  for (const line of lines) {
    for (const f of line.frags) {
      const a = Math.max(lo, Math.floor(f.x));
      const b = Math.min(hi, Math.ceil(f.x + f.w));
      for (let x = a; x < b; x++) cover[x - lo]!++;
    }
  }
  const limit = Math.max(1, Math.floor(0.04 * lines.length));
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  for (let i = 0; i <= cover.length; i++) {
    const low = i < cover.length && cover[i]! <= limit;
    if (low && runStart < 0) runStart = i;
    if (!low && runStart >= 0) {
      if (i - runStart > bestLen) {
        bestLen = i - runStart;
        bestStart = runStart;
      }
      runStart = -1;
    }
  }
  if (bestLen < Math.max(6, medianFs)) return null;
  const gx = lo + bestStart + bestLen / 2;

  const left: Line[] = [];
  const right: Line[] = [];
  let mixed = 0;
  for (const line of lines) {
    if (line.frags.some((f) => f.x < gx && f.x + f.w > gx)) continue;
    const hasLeft = line.frags.some((f) => f.x + f.w <= gx);
    const hasRight = line.frags.some((f) => f.x >= gx);
    if (hasLeft && hasRight) mixed++;
    if (hasLeft) left.push(line);
    if (hasRight) right.push(line);
  }
  if (left.length < 3 || right.length < 3) return null;
  if (left.length + right.length - mixed < 0.6 * lines.length) return null;
  // The two columns must sit side by side.
  const span = (ls: Line[]): [number, number] => [Math.min(...ls.map((l) => l.y)), Math.max(...ls.map((l) => l.y))];
  const [la, lb] = span(left);
  const [ra, rb] = span(right);
  const overlap = Math.min(lb, rb) - Math.max(la, ra);
  if (overlap < 0.5 * Math.min(lb - la, rb - ra)) return null;
  return gx;
}

/** Split lines at the gutter and return them in reading order: top to bottom, left column before right column. */
export function orderLines(lines: Line[], gutter: number | null): Line[] {
  if (gutter === null) return lines.map((l) => ({ ...l, col: 0 }));
  const order: Line[] = [];
  let bandLeft: Line[] = [];
  let bandRight: Line[] = [];
  const flush = (): void => {
    order.push(...bandLeft, ...bandRight);
    bandLeft = [];
    bandRight = [];
  };
  for (const line of lines) {
    if (line.frags.some((f) => f.x < gutter && f.x + f.w > gutter)) {
      flush();
      order.push({ ...line, col: -1 });
      continue;
    }
    const l = line.frags.filter((f) => f.x + f.w <= gutter);
    const r = line.frags.filter((f) => f.x >= gutter);
    if (l.length > 0) bandLeft.push(makeLine(l, 0));
    if (r.length > 0) bandRight.push(makeLine(r, 1));
  }
  flush();
  return order;
}

/** A piece of a line: a slice of one item, or null for an inserted space. */
export type Piece = { item: number; str: string; start: number; end: number } | null;

/** Join the items of one line. Insert a space where the gap is wider than 0.2 x the font size. */
export function linePieces(line: Line): Piece[] {
  const pieces: Piece[] = [];
  let prev: Frag | null = null;
  let lastWasSpace = true; // trims leading white space at the line start
  for (const f of line.frags) {
    let s = 0;
    const e = f.str.length;
    if (lastWasSpace) while (s < e && WS.test(f.str[s]!)) s++;
    if (s >= e) continue;
    if (prev && !lastWasSpace) {
      const gap = f.rtl ? prev.x - (f.x + f.w) : f.x - (prev.x + prev.w);
      if (gap > 0.2 * line.fs) pieces.push(null);
    }
    pieces.push({ item: f.item, str: f.str, start: s, end: e });
    lastWasSpace = WS.test(f.str[e - 1]!);
    prev = f;
  }
  // Trim trailing white space at the line end.
  for (;;) {
    const last = pieces[pieces.length - 1];
    if (last === undefined) break;
    if (last === null) {
      pieces.pop();
      continue;
    }
    while (last.end > last.start && WS.test(last.str[last.end - 1]!)) last.end--;
    if (last.end > last.start) break;
    pieces.pop();
  }
  return pieces;
}

export function piecesText(pieces: Piece[]): string {
  return pieces.map((p) => (p === null ? ' ' : p.str.slice(p.start, p.end))).join('');
}
