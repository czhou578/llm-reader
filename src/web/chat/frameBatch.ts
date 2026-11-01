// Joins streamed text pieces and applies them at most once per animation frame. A provider can send many deltas in one
// frame, and each applied delta renders the whole answer again (Markdown, sanitizer, KaTeX, layout).

export interface TextBatcher {
  /** Add text. The batcher applies it on the next frame. */
  push(text: string): void;
  /** Apply the pending text now. Call it before any other change to the same message, so the order stays the same. */
  flush(): void;
}

export function textBatcher(
  apply: (text: string) => void,
  schedule: (cb: () => void) => number = requestAnimationFrame,
  cancel: (id: number) => void = cancelAnimationFrame,
): TextBatcher {
  let pending = '';
  let frame: number | null = null;
  const flush = (): void => {
    if (frame !== null) cancel(frame);
    frame = null;
    if (!pending) return;
    const text = pending;
    pending = '';
    apply(text);
  };
  return {
    push(text) {
      pending += text;
      frame ??= schedule(flush);
    },
    flush,
  };
}
