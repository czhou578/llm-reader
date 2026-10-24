import 'katex/dist/katex.min.css';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'preact/hooks';
import type { Message, Thread, Usage } from '../../shared/types.ts';
import { activeThreadId, config, doc, memory, threads } from '../app/session.ts';
import { pageLabel, PRESET_LABEL } from '../app/target.ts';
import { firstSentence, renderMarkdown } from './markdown.ts';
import { applyPin, onPaneScroll, onUserScrollIntent, revealThread, setPaneElement } from './paneControl.ts';

const STATUS_LABEL: Partial<Record<Message['status'], string>> = {
  streaming: 'streaming…',
  cancelled: 'stopped',
  error: 'error',
  interrupted: 'interrupted',
};

function usageLine(u: Usage | undefined, model?: string): string {
  const parts: string[] = [];
  if (u?.inputTokens != null) parts.push(`${u.inputTokens.toLocaleString('en')} in`);
  if (u?.cachedInputTokens) parts.push(`${u.cachedInputTokens.toLocaleString('en')} cached`);
  if (u?.outputTokens != null) parts.push(`${u.outputTokens.toLocaleString('en')} out`);
  if (u?.costUsd != null) parts.push(`$${u.costUsd.toFixed(4)}`);
  if (model) parts.push(model);
  return parts.join(' · ');
}

function questionText(m: Message): string {
  if (m.preset && m.preset !== 'ask') return PRESET_LABEL[m.preset];
  return m.content;
}

function AnswerView({ message }: { message: Message }) {
  const html = useMemo(() => renderMarkdown(message.content), [message.content]);
  const status = STATUS_LABEL[message.status];
  const usage = usageLine(message.usage, message.model);
  return (
    <div class={`msg msg-assistant status-${message.status}`} data-msg={message.id}>
      {message.content ? (
        <div class="md" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <div class="md muted">{message.status === 'streaming' ? 'Waiting for the first words…' : '(no answer)'}</div>
      )}
      <div class="msg-meta">
        {status && <span class={`msg-status status-${message.status}`}>{status}</span>}
        {message.contextUsed && <span class="context-used">{message.contextUsed}</span>}
        {usage && <span class="msg-usage">{usage}</span>}
      </div>
    </div>
  );
}

function QuestionView({ message, first }: { message: Message; first: boolean }) {
  const preset = message.preset && message.preset !== 'ask';
  return (
    <div class={`msg msg-user${first ? ' first' : ''}`} data-msg={message.id}>
      {preset ? <span class="preset-tag">{questionText(message)}</span> : <span><span class="q-mark">Q:</span> {message.content}</span>}
    </div>
  );
}

function ThreadView({ thread, number }: { thread: Thread; number: number }) {
  const first = thread.messages.find((m) => m.role === 'user');
  const quote = thread.passage.text.length > 320 ? `${thread.passage.text.slice(0, 320)}…` : thread.passage.text;
  return (
    <article class="thread expanded" data-thread={thread.id}>
      <header class="thread-head">
        #{number} · {pageLabel(thread.location)}
        {first ? ` · ${PRESET_LABEL[first.preset ?? 'ask']}` : ''}
      </header>
      <blockquote class="passage">{quote}</blockquote>
      {thread.messages.map((m, i) =>
        m.role === 'user' ? <QuestionView key={m.id} message={m} first={i === 0} /> : <AnswerView key={m.id} message={m} />,
      )}
    </article>
  );
}

function ThreadLine({ thread, number }: { thread: Thread; number: number }) {
  const q = thread.messages.find((m) => m.role === 'user');
  const a = thread.messages.find((m) => m.role === 'assistant');
  const open = () => {
    activeThreadId.value = thread.id;
    memory.viewer?.stage(thread.passage);
    requestAnimationFrame(() => revealThread(thread.id));
  };
  return (
    <button type="button" class="thread collapsed" data-thread={thread.id} onClick={open} tabIndex={-1}>
      <span class="thread-num">#{number}</span>
      <span class="thread-line">
        <strong>{q ? questionText(q) : thread.title}</strong>
        {a?.content ? ` — ${firstSentence(a.content)}` : ''}
      </span>
    </button>
  );
}

/** The answer pane: all threads of the document, oldest first. The active thread is expanded. */
export function AnswerPane() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setPaneElement(ref.current);
    return () => setPaneElement(null);
  }, []);
  // Each render may make the pinned answer reachable. applyPin does nothing after a user scroll.
  useLayoutEffect(() => applyPin());

  const list = threads.value;
  const active = activeThreadId.value;
  const strong = config.value ? config.value.profiles[config.value.roles.strong] : undefined;

  return (
    <div
      class="answer-scroll"
      ref={ref}
      tabIndex={-1}
      onScroll={onPaneScroll}
      onWheel={onUserScrollIntent}
      onTouchMove={onUserScrollIntent}
      aria-label="Answers"
    >
      <header class="pane-head">
        <span class="doc-title">{doc.value?.title}</span>
        {strong && (
          <span class={`model${strong.provider === 'mock' ? ' model-mock' : ''}`} title="The model for asks (role: strong)">
            {strong.provider === 'mock' ? 'mock answers (no API key)' : strong.model}
          </span>
        )}
      </header>
      {list.length === 0 ? (
        <div class="empty muted">
          <p>No questions yet.</p>
          <p>
            Press <kbd>s</kbd> to select a sentence, then <kbd>Enter</kbd> to explain it.
          </p>
        </div>
      ) : (
        list.map((t, i) =>
          t.id === active ? <ThreadView key={t.id} thread={t} number={i + 1} /> : <ThreadLine key={t.id} thread={t} number={i + 1} />,
        )
      )}
    </div>
  );
}
