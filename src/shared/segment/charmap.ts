// Char map: links each logical offset in PageText.text to a character in one text item (architecture.md 2.4).
import type { CharRun, PageText } from '../types.ts';

/** The item index that synthetic runs carry. Synthetic runs have no source character. */
export const NO_ITEM = -1;

/** Builds the logical text and its run-length char map together. */
export class CharMapBuilder {
  text = '';
  readonly runs: CharRun[] = [];

  /** Append str[start, end) of item `item`. */
  addSource(item: number, str: string, start: number, end: number): void {
    if (end <= start) return;
    const length = end - start;
    const last = this.runs[this.runs.length - 1];
    if (
      last &&
      !last.synthetic &&
      last.item === item &&
      last.itemStart + last.length === start &&
      last.logicalStart + last.length === this.text.length
    ) {
      last.length += length;
    } else {
      this.runs.push({ logicalStart: this.text.length, length, item, itemStart: start });
    }
    this.text += str.slice(start, end);
  }

  /** Append characters that have no source, for example an inserted space or a paragraph break. */
  addSynthetic(chars: string): void {
    if (!chars) return;
    const last = this.runs[this.runs.length - 1];
    if (last && last.synthetic && last.logicalStart + last.length === this.text.length) {
      last.length += chars.length;
    } else {
      this.runs.push({ logicalStart: this.text.length, length: chars.length, item: NO_ITEM, itemStart: 0, synthetic: true });
    }
    this.text += chars;
  }
}

export interface ItemRange {
  item: number; // index into getTextContent().items
  start: number; // UTF-16 offset in items[item].str
  end: number; // exclusive
}

/** Index of the last run whose logicalStart <= offset, or -1. */
function runIndexAt(runs: readonly CharRun[], offset: number): number {
  let lo = 0;
  let hi = runs.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (runs[mid]!.logicalStart <= offset) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * Map the logical range [start, end) to ranges of source characters in text items.
 * Synthetic runs give no range. Dropped characters (hyphens) are not in any range.
 */
export function offsetsToItemRanges(pageText: PageText, start: number, end: number): ItemRange[] {
  const out: ItemRange[] = [];
  const runs = pageText.charMap;
  if (end <= start) return out;
  let i = Math.max(0, runIndexAt(runs, start));
  for (; i < runs.length; i++) {
    const run = runs[i]!;
    const runEnd = run.logicalStart + run.length;
    if (run.logicalStart >= end) break;
    if (runEnd <= start || run.synthetic) continue;
    const a = Math.max(start, run.logicalStart) - run.logicalStart + run.itemStart;
    const b = Math.min(end, runEnd) - run.logicalStart + run.itemStart;
    const prev = out[out.length - 1];
    if (prev && prev.item === run.item && prev.end === a) prev.end = b;
    else out.push({ item: run.item, start: a, end: b });
  }
  return out;
}

/**
 * Map a character offset in items[item].str to a logical offset.
 * A character with no logical position (a dropped hyphen or trimmed space) maps to the next logical
 * position of the same item, else to the end of the item's last run before it.
 * Returns null when the item has no characters in the logical text.
 */
export function itemOffsetToLogical(pageText: PageText, item: number, itemStart: number): number | null {
  let following: number | null = null;
  let followingAt = Infinity;
  let preceding: number | null = null;
  let precedingAt = -Infinity;
  for (const run of pageText.charMap) {
    if (run.synthetic || run.item !== item) continue;
    const runEnd = run.itemStart + run.length;
    if (itemStart >= run.itemStart && itemStart < runEnd) return run.logicalStart + (itemStart - run.itemStart);
    if (run.itemStart > itemStart && run.itemStart < followingAt) {
      followingAt = run.itemStart;
      following = run.logicalStart;
    }
    if (runEnd <= itemStart && runEnd > precedingAt) {
      precedingAt = runEnd;
      preceding = run.logicalStart + run.length;
    }
  }
  return following ?? preceding;
}

/**
 * Map an exclusive end offset in items[item].str to a logical offset: the position after the last character
 * of the item before `itemEnd` that is in the logical text. Returns null when there is no such character.
 */
export function itemEndToLogical(pageText: PageText, item: number, itemEnd: number): number | null {
  let best: number | null = null;
  let bestAt = -1;
  for (const run of pageText.charMap) {
    if (run.synthetic || run.item !== item || run.itemStart >= itemEnd) continue;
    const upTo = Math.min(itemEnd, run.itemStart + run.length);
    if (upTo > bestAt) {
      bestAt = upTo;
      best = run.logicalStart + (upTo - run.itemStart);
    }
  }
  return best;
}

/** The logical text of [start, end) with synthetic characters removed. Used to check the char map. */
export function sourceCharsOf(pageText: PageText, start: number, end: number): string {
  let out = '';
  for (const run of pageText.charMap) {
    if (run.synthetic) continue;
    const a = Math.max(start, run.logicalStart);
    const b = Math.min(end, run.logicalStart + run.length);
    if (b > a) out += pageText.text.slice(a, b);
  }
  return out;
}
