import { useLayoutEffect, useMemo, useRef } from 'preact/hooks';
import { askBox, memory, threads } from './session.ts';
import { countWords, threadNumber } from './target.ts';
import { passageClientBox, placeAskBox } from './geometry.ts';

const MAX_LINES = 5;

/** The ask box (DESIGN.md 5.3): one line that grows to five, near the staged passage. */
export function AskBox() {
  const box = askBox.value;
  const input = useRef<HTMLTextAreaElement>(null);

  // The position is fixed when the box opens. The PDF does not scroll while the box has focus.
  const placement = useMemo(() => {
    const container = memory.viewerContainer;
    if (!container) return null;
    const pane = container.getBoundingClientRect();
    const passage = box?.staged ? passageClientBox(container, box.staged.passage.rects) : null;
    return placeAskBox(passage, pane, window.innerHeight);
  }, []);

  useLayoutEffect(() => {
    input.current?.focus();
  }, []);

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    const line = parseFloat(getComputedStyle(el).lineHeight) || 24;
    el.style.height = `${Math.min(el.scrollHeight, line * MAX_LINES + 12)}px`;
  });

  if (!box) return null;
  const text = box.staged?.passage.text ?? '';
  const head = text.length > 80 ? `${text.slice(0, 80)}…` : text;
  const target =
    box.target === 'new' ? 'New question' : `Follow-up in thread #${box.followThreadId ? threadNumber(threads.value, box.followThreadId) : '?'}`;
  const style = placement
    ? { left: `${placement.left}px`, width: `${placement.width}px`, top: placement.top !== undefined ? `${placement.top}px` : undefined, bottom: placement.bottom !== undefined ? `${placement.bottom}px` : undefined }
    : undefined;

  return (
    <div class="ask-box" role="dialog" aria-label="Ask a question" style={style}>
      <div class="ask-head">
        {head ? <span class="ask-quote">“{head}”</span> : null}
        {text ? <span class="muted"> · {countWords(text)} words</span> : null}
        <span class={`ask-target target-${box.target}`}>{target}</span>
      </div>
      <textarea
        ref={input}
        rows={1}
        value={box.draft}
        placeholder="Type a question"
        aria-label="Question"
        onInput={(e) => {
          const current = askBox.value;
          if (current) askBox.value = { ...current, draft: e.currentTarget.value };
        }}
      />
      <div class="ask-help muted">Enter sends · Shift+Enter new line · Tab new or follow-up · Esc cancels</div>
    </div>
  );
}
