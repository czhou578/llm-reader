// nearestBox picks the text span that a pointer aims at. Pure logic; no DOM.
import { describe, expect, it } from 'vitest';
import { nearestBox } from '../../src/web/viewer/geometry.ts';

const line = (top: number, left: number, right: number) => ({ left, right, top, bottom: top + 14 });

describe('nearestBox', () => {
  it('returns the box under the point', () => {
    expect(nearestBox([line(100, 10, 200), line(120, 10, 200)], 50, 125, 24)).toBe(1);
  });

  it('prefers the same line over a closer box on another line', () => {
    // The point is 30 px right of the first line's end, and 6 px below the box above it.
    const boxes = [line(100, 10, 200), line(120, 10, 100)];
    expect(nearestBox(boxes, 120, 126, 40)).toBe(1);
  });

  it('skips holes and empty boxes, and returns -1 when nothing is near', () => {
    const boxes = [undefined, null, { left: 5, right: 5, top: 0, bottom: 10 }, line(100, 10, 200)];
    expect(nearestBox(boxes, 50, 106, 24)).toBe(3);
    expect(nearestBox(boxes, 50, 300, 24)).toBe(-1);
  });
});
