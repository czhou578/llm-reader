import { useLayoutEffect, useRef } from 'preact/hooks';
import { openAskBox } from './ask.ts';
import { keyFor } from './HintStrip.tsx';
import { askBox, threads } from './session.ts';
import { keepFocus } from './StatusLine.tsx';
import { countWords, threadNumber } from './target.ts';

const MAX_LINES = 5;

/** The closed dock: a prompt that opens the ask box, as the ask key does. The focus stays where it is. */
export function AskPrompt() {
  const key = keyFor('ask.open', 'NORMAL');
  return (
    <button type="button" class="ask-prompt" title="Ask a typed question about the staged passage" onMouseDown={keepFocus} onClick={() => openAskBox()}>
      <span>Ask about the selection…</span>
      {key && <kbd>{key}</kbd>}
    </button>
  );
}

/** The open ask box (DESIGN.md 5.3), docked at the bottom of the answer pane. One line that grows to five. */
export function AskBox() {
  const box = askBox.value;
  const input = useRef<HTMLTextAreaElement>(null);

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

  return (
    <div class="ask-box" role="dialog" aria-label="Ask a question">
      <div class="ask-head">
        <span class={`ask-target target-${box.target}`}>{target}</span>
        {head ? <span class="ask-quote">“{head}”</span> : null}
        {text ? <span class="muted">{countWords(text)} words</span> : null}
      </div>
      <textarea
        ref={input}
        rows={1}
        value={box.draft}
        placeholder="Ask about the selection…"
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
