import { mode } from '../commands/modes.ts';
import { activeRun, notice, runSeconds, staged, stagedTarget, usage } from './session.ts';
import { PRESET_LABEL, stagedSummary, targetLabel } from './target.ts';

function formatTokens(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function RunStateView() {
  const run = activeRun.value;
  if (!run) return null;
  const name = PRESET_LABEL[run.preset].toLowerCase();
  switch (run.state) {
    case 'streaming':
      return <span class="run run-streaming">◌ {name}… {runSeconds.value} s</span>;
    case 'ready':
      return <span class="run run-ready">● ready · Tab to read</span>;
    case 'cancelled':
      return <span class="run run-cancelled">■ stopped · r to retry</span>;
    case 'error':
      return (
        <span class="run run-error" title={run.error}>
          ✕ error · r to retry
        </span>
      );
  }
}

/** Text for screen readers. It changes only with the run state, not with the timer. */
function liveText(): string {
  const run = activeRun.value;
  const state = !run ? '' : run.state === 'streaming' ? 'Answer streams.' : run.state === 'ready' ? 'Answer ready.' : run.state === 'error' ? 'Answer failed.' : 'Answer stopped.';
  return [state, notice.value ?? ''].join(' ').trim();
}

export function StatusLine() {
  const s = staged.value;
  const u = usage.value?.session;
  return (
    <footer class="status-line">
      <span class={`mode mode-${mode.value.toLowerCase()}`}>{mode.value}</span>
      <span class="staged">
        {notice.value ? (
          <span class="notice">{notice.value}</span>
        ) : s ? (
          <>
            <span class="staged-summary">
              {stagedSummary(s)} · {targetLabel(stagedTarget.value)}
            </span>
            <span class="staged-text" title={s.passage.text}>
              {s.passage.text}
            </span>
          </>
        ) : (
          <span class="muted">Nothing staged · s selects a sentence</span>
        )}
      </span>
      <RunStateView />
      {u && (u.inputTokens > 0 || u.outputTokens > 0) && (
        <span class="usage-total" title="Tokens in this server session">
          {formatTokens(u.inputTokens)} in · {formatTokens(u.outputTokens)} out
          {u.costUsd != null ? ` · $${u.costUsd.toFixed(3)}` : ''}
        </span>
      )}
      <span class="visually-hidden" aria-live="polite">
        {liveText()}
      </span>
    </footer>
  );
}
