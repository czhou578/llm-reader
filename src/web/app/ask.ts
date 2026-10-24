// The ask flow (DESIGN.md 5.3): presets, the ask box, follow-ups, regenerate, repeat, cancel.
import type { AskContext, Message, PresetId, StagedSelection, StartRunRequest, StartRunResponse, Thread } from '../../shared/types.ts';
import * as api from '../api/client.ts';
import { mode } from '../commands/modes.ts';
import { pinMessage } from '../chat/paneControl.ts';
import {
  activeRun,
  activeThread,
  activeThreadId,
  askBox,
  doc,
  memory,
  runSeconds,
  showNotice,
  staged as stagedSignal,
  threads,
  usage,
  type RunState,
} from './session.ts';
import { chooseTarget, isDuplicate, latestThread, passageKey, PRESET_LABEL, threadNumber } from './target.ts';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function currentStaged(): StagedSelection | null {
  return stagedSignal.value ?? memory.viewer?.getStaged() ?? null;
}

function contextOf(s: StagedSelection): AskContext {
  return { surrounding: s.surrounding, pageText: s.pageText, prevPageText: s.prevPageText, location: s.location };
}

/** The context for a follow-up without a staged passage. The server resends turn 1 for follow-ups anyway. */
function threadContext(thread: Thread): AskContext {
  return memory.threadContext.get(thread.id) ?? { surrounding: thread.passage.text, location: thread.location };
}

function updateThread(threadId: string, fn: (t: Thread) => Thread): void {
  threads.value = threads.value.map((t) => (t.id === threadId ? fn(t) : t));
}

function updateMessage(threadId: string, messageId: string, fn: (m: Message) => Message): void {
  updateThread(threadId, (t) => ({ ...t, messages: t.messages.map((m) => (m.id === messageId ? fn(m) : m)) }));
}

function isStreaming(threadId: string): boolean {
  return threads.value.some((t) => t.id === threadId && t.messages.some((m) => m.role === 'assistant' && m.status === 'streaming'));
}

async function newThreadAt(s: StagedSelection): Promise<Thread> {
  const d = doc.value;
  if (!d) throw new Error('No document is open.');
  const thread = await api.createThread(d.id, { passage: s.passage, location: s.location });
  threads.value = [...threads.value, { ...thread, messages: thread.messages ?? [] }];
  memory.threadContext.set(thread.id, contextOf(s));
  return thread;
}

// ---------- runs ----------

let tick: ReturnType<typeof setInterval> | undefined;

function startTicker(startedAt: number): void {
  clearInterval(tick);
  runSeconds.value = 0;
  tick = setInterval(() => {
    runSeconds.value = Math.floor((Date.now() - startedAt) / 1000);
  }, 250);
}

function setRun(runId: string, patch: Partial<RunState>): void {
  const run = activeRun.value;
  if (run?.runId !== runId) return; // a newer run owns the status line
  activeRun.value = { ...run, ...patch };
  if (patch.state && patch.state !== 'streaming') clearInterval(tick);
}

async function startOnThread(thread: Thread, req: StartRunRequest): Promise<void> {
  if (isStreaming(thread.id)) {
    showNotice(`Thread #${threadNumber(threads.value, thread.id)} has an answer in progress. Press Esc to stop it.`);
    return;
  }
  memory.lastRequest.set(thread.id, req);
  activeThreadId.value = thread.id;
  let res: StartRunResponse;
  try {
    res = await api.startRun(thread.id, req);
  } catch (err) {
    showNotice(`The ask failed: ${errorText(err)}`, 5000);
    return;
  }
  const now = new Date().toISOString();
  const userMsg: Message = {
    id: `local-${res.runId}`,
    threadId: thread.id,
    role: 'user',
    content: req.preset === 'ask' ? (req.question ?? '') : PRESET_LABEL[req.preset],
    preset: req.preset,
    status: 'complete',
    createdAt: now,
  };
  const assistantMsg: Message = {
    id: res.messageId,
    threadId: thread.id,
    role: 'assistant',
    content: '',
    preset: req.preset,
    status: 'streaming',
    createdAt: now,
  };
  updateThread(thread.id, (t) => ({ ...t, messages: [...t.messages, userMsg, assistantMsg] }));
  const startedAt = Date.now();
  activeRun.value = { runId: res.runId, threadId: thread.id, messageId: res.messageId, preset: req.preset, startedAt, state: 'streaming' };
  startTicker(startedAt);
  // Wait one frame so the new message is in the DOM before the pin.
  requestAnimationFrame(() => pinMessage(res.messageId));
  void consume(res.runId, thread.id, res.messageId);
}

async function consume(runId: string, threadId: string, messageId: string): Promise<void> {
  try {
    for await (const ev of api.runEvents(runId)) {
      switch (ev.type) {
        case 'run.start':
          updateMessage(threadId, messageId, (m) => ({ ...m, profile: ev.profile, model: ev.model }));
          break;
        case 'delta':
          updateMessage(threadId, messageId, (m) => ({ ...m, content: m.content + ev.text }));
          break;
        case 'usage':
          updateMessage(threadId, messageId, (m) => ({ ...m, usage: { ...m.usage, ...ev.usage } }));
          break;
        case 'run.end': {
          const status = ev.finishReason === 'cancelled' ? 'cancelled' : ev.finishReason === 'error' ? 'error' : 'complete';
          updateMessage(threadId, messageId, (m) => ({ ...m, status, finishReason: ev.finishReason }));
          setRun(runId, { state: status === 'complete' ? 'ready' : status === 'cancelled' ? 'cancelled' : 'error' });
          break;
        }
        case 'error':
          updateMessage(threadId, messageId, (m) => ({ ...m, status: 'error', finishReason: 'error' }));
          setRun(runId, { state: 'error', error: ev.message });
          break;
      }
    }
  } catch (err) {
    setRun(runId, { state: 'error', error: errorText(err) });
  }
  await refreshThread(threadId);
  void refreshUsage();
}

/** Replaces the local copy of a thread with the server copy: real message ids, contextUsed, final usage. */
async function refreshThread(threadId: string): Promise<void> {
  try {
    const fresh = await api.getThread(threadId);
    // Keep the local copy while another run streams on it; that run refreshes it at its end.
    if (isStreaming(threadId)) return;
    updateThread(threadId, () => fresh);
  } catch {
    // The local copy stays. The next document open loads the server copy.
  }
}

export async function refreshUsage(): Promise<void> {
  try {
    usage.value = await api.getUsageSummary(doc.value?.id);
  } catch {
    // Usage is optional information.
  }
}

// ---------- commands ----------

/** A preset key. In NORMAL mode it acts on the staged passage; in READER mode on the last answer of the thread. */
export async function preset(id: Exclude<PresetId, 'ask'>): Promise<void> {
  if (mode.value === 'READER') {
    const thread = activeThread.value;
    if (!thread) return showNotice('No answer to act on yet.');
    if (guard(id, `thread:${thread.id}`)) return;
    memory.lastPreset = id;
    return startOnThread(thread, { preset: id, context: threadContext(thread) });
  }
  const s = currentStaged();
  if (!s) return showNotice('No passage is staged. Press s to select a sentence.');
  if (guard(id, passageKey(s.passage))) return;
  memory.lastPreset = id;
  const target = chooseTarget(s.passage, threads.value);
  try {
    const thread = target.kind === 'follow-up' ? target.thread : await newThreadAt(s);
    if (target.kind === 'follow-up') memory.threadContext.set(thread.id, contextOf(s));
    await startOnThread(thread, { preset: id, context: contextOf(s) });
  } catch (err) {
    showNotice(`The ask failed: ${errorText(err)}`, 5000);
  }
}

function guard(id: PresetId, key: string): boolean {
  const next = { preset: id, key, at: Date.now() };
  if (isDuplicate(memory.lastSent, next)) {
    showNotice(`${PRESET_LABEL[id]} was just sent for this passage.`);
    return true;
  }
  memory.lastSent = next;
  return false;
}

/** `v`: opens the ask box. NORMAL: the target follows the follow-up rule. READER: a follow-up on the open thread. */
export function openAskBox(): void {
  const s = currentStaged();
  if (mode.value === 'READER') {
    const thread = activeThread.value;
    if (!thread && !s) return showNotice('No passage is staged and no thread is open.');
    askBox.value = { draft: '', target: thread ? 'follow-up' : 'new', followThreadId: thread?.id ?? null, staged: s };
  } else {
    if (!s) return showNotice('No passage is staged. Press s to select a sentence.');
    const target = chooseTarget(s.passage, threads.value);
    const latest = latestThread(threads.value);
    askBox.value = {
      draft: '',
      target: target.kind,
      followThreadId: target.kind === 'follow-up' ? target.thread.id : (latest?.id ?? null),
      staged: s,
    };
  }
  memory.lastPreset = 'ask';
  mode.value = 'ASK';
}

export function closeAskBox(): void {
  askBox.value = null;
  mode.value = 'NORMAL';
  memory.viewer?.focus();
}

/** `Tab` in the ask box. A follow-up needs a thread; a new thread needs a staged passage. */
export function toggleAskTarget(): void {
  const box = askBox.value;
  if (!box) return;
  const next = box.target === 'new' ? 'follow-up' : 'new';
  if (next === 'follow-up' && !box.followThreadId) return showNotice('No thread to follow up yet.');
  if (next === 'new' && !box.staged) return showNotice('No passage is staged for a new thread.');
  askBox.value = { ...box, target: next };
}

export async function sendAskBox(): Promise<void> {
  const box = askBox.value;
  if (!box) return;
  const question = box.draft.trim();
  if (!question) return showNotice('Type a question first. Esc closes the box.');
  closeAskBox();
  try {
    let thread: Thread | undefined;
    let context: AskContext;
    if (box.target === 'new' && box.staged) {
      thread = await newThreadAt(box.staged);
      context = contextOf(box.staged);
    } else {
      thread = threads.value.find((t) => t.id === box.followThreadId);
      if (!thread) return showNotice('The thread is gone.');
      context = box.staged ? contextOf(box.staged) : threadContext(thread);
    }
    await startOnThread(thread, { preset: 'ask', question, context });
  } catch (err) {
    showNotice(`The ask failed: ${errorText(err)}`, 5000);
  }
}

/** `r`: the same request again on the same thread. */
export async function regenerate(): Promise<void> {
  const thread = (activeRun.value && threads.value.find((t) => t.id === activeRun.value?.threadId)) || activeThread.value;
  if (!thread) return showNotice('No answer to regenerate.');
  const req = memory.lastRequest.get(thread.id) ?? requestFromHistory(thread);
  if (!req) return showNotice('No answer to regenerate.');
  await startOnThread(thread, req);
}

/** After a reload the last request is not in memory. Rebuild it from the last user message. */
function requestFromHistory(thread: Thread): StartRunRequest | null {
  const last = [...thread.messages].reverse().find((m) => m.role === 'user');
  if (!last) return null;
  const preset = last.preset ?? 'explain';
  return { preset, question: preset === 'ask' ? last.content : undefined, context: threadContext(thread) };
}

/** `.`: the last preset again on the current selection. */
export function repeatLast(): Promise<void> | void {
  const last = memory.lastPreset;
  if (!last) return showNotice('No preset to repeat yet.');
  if (last === 'ask') return openAskBox();
  return preset(last);
}

/** Stops the active run. Returns false when nothing streams. */
export function cancelActiveRun(): boolean {
  const run = activeRun.value;
  if (!run || run.state !== 'streaming') return false;
  api.cancelRun(run.runId).catch((err: unknown) => showNotice(`Stop failed: ${errorText(err)}`));
  showNotice('Stopping the answer…');
  return true;
}
