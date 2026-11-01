import { describe, expect, it } from 'vitest';
import { textBatcher } from '../../src/web/chat/frameBatch.ts';

/** A frame scheduler that the test runs by hand. */
function fakeFrames() {
  const queue = new Map<number, () => void>();
  let next = 1;
  return {
    schedule: (cb: () => void) => {
      queue.set(next, cb);
      return next++;
    },
    cancel: (id: number) => void queue.delete(id),
    run: () => {
      const cbs = [...queue.values()];
      queue.clear();
      cbs.forEach((cb) => cb());
    },
    get size() {
      return queue.size;
    },
  };
}

describe('textBatcher', () => {
  it('applies all pieces of one frame as one text, with one scheduled frame', () => {
    const frames = fakeFrames();
    const applied: string[] = [];
    const b = textBatcher((t) => applied.push(t), frames.schedule, frames.cancel);
    b.push('Hel');
    b.push('lo ');
    b.push('world');
    expect(frames.size).toBe(1);
    expect(applied).toEqual([]);
    frames.run();
    expect(applied).toEqual(['Hello world']);
    b.push('!');
    frames.run();
    expect(applied).toEqual(['Hello world', '!']);
  });

  it('flush applies the pending text now and cancels the frame', () => {
    const frames = fakeFrames();
    const applied: string[] = [];
    const b = textBatcher((t) => applied.push(t), frames.schedule, frames.cancel);
    b.push('partial');
    b.flush();
    expect(applied).toEqual(['partial']);
    expect(frames.size).toBe(0);
    frames.run();
    expect(applied).toEqual(['partial']);
  });

  it('flush with no pending text applies nothing', () => {
    const frames = fakeFrames();
    const applied: string[] = [];
    textBatcher((t) => applied.push(t), frames.schedule, frames.cancel).flush();
    expect(applied).toEqual([]);
  });
});
