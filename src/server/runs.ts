import { ulid } from 'ulid';
import type { ChatEvent, Pricing, RunEvent, StartRunRequest, StartRunResponse, Usage } from '../shared/types.ts';
import type { ServerConfig } from './config.ts';
import { buildContext, formatContextUsed } from './context/build.ts';
import type { Db } from './db/index.ts';
import { getDocument, getThread, insertMessage, insertUsage, listMessages, updateMessage } from './db/repo.ts';
import { HttpError, notFound } from './errors.ts';
import { DriverError, resolveProfile, streamWithRetry, type Drivers, type RetryOptions } from './llm/index.ts';
import { log, redact } from './log.ts';

// Run manager (DESIGN.md 7.5): one in-memory event buffer per run for Last-Event-ID replay,
// text flushed to the message row every 500 ms, cancel by AbortController. A closed SSE stream does not cancel a run.

export interface BufferedEvent {
  seq: number; // 1-based, the SSE id
  event: RunEvent;
}

export interface Run {
  id: string;
  threadId: string;
  messageId: string;
  events: BufferedEvent[];
  done: boolean;
  /** Called when an event is added or the run ends. */
  listeners: Set<() => void>;
  abort: AbortController;
  /** Settles when the run has written its final state. */
  finished: Promise<void>;
}

export interface RunManagerOptions {
  flushMs?: number; // 500 by default
  retainMs?: number; // how long a finished run stays replayable; 10 minutes by default
  maxRunMs?: number; // a run that takes longer is stopped with an error; 10 minutes by default
  retry?: RetryOptions;
  /** Output cap when the profile sets none. High, because reasoning models count thinking tokens in it. */
  defaultMaxTokens?: number;
}

export function costUsd(pricing: Pricing | undefined, u: Usage): number | null {
  if (!pricing || (pricing.input === undefined && pricing.output === undefined)) return null;
  const input = u.inputTokens ?? 0;
  const cached = Math.min(u.cachedInputTokens ?? 0, input);
  const cost =
    (input - cached) * (pricing.input ?? 0) +
    cached * (pricing.cache_read ?? pricing.input ?? 0) +
    (u.outputTokens ?? 0) * (pricing.output ?? 0);
  return cost / 1_000_000;
}

export class RunManager {
  private runs = new Map<string, Run>();
  private activeByThread = new Map<string, string>();
  private readonly flushMs: number;
  private readonly retainMs: number;
  private readonly maxRunMs: number;
  private readonly defaultMaxTokens: number;

  constructor(
    private readonly db: Db,
    private readonly config: ServerConfig,
    private readonly drivers: Drivers,
    private readonly opts: RunManagerOptions = {},
  ) {
    this.flushMs = opts.flushMs ?? 500;
    this.retainMs = opts.retainMs ?? 10 * 60_000;
    this.maxRunMs = opts.maxRunMs ?? 10 * 60_000;
    this.defaultMaxTokens = opts.defaultMaxTokens ?? 8192;
  }

  get(id: string): Run | undefined {
    return this.runs.get(id);
  }

  start(threadId: string, req: StartRunRequest): StartRunResponse {
    const thread = getThread(this.db, threadId);
    if (!thread) throw notFound('thread');
    if (!['explain', 'define', 'ask'].includes(req.preset)) throw new HttpError(400, 'bad_request', 'unknown preset');
    if (!req.context || typeof req.context !== 'object' || !req.context.location) {
      throw new HttpError(400, 'bad_request', 'context with a location is required');
    }
    if (this.activeByThread.has(threadId)) throw new HttpError(409, 'run_active', 'a run is already active on this thread');
    const doc = getDocument(this.db, thread.docId);
    if (!doc) throw notFound('document');

    const role = req.role === 'fast' ? 'fast' : 'strong';
    const profile = resolveProfile(this.config, role);
    const prior = listMessages(this.db, threadId);
    const built = buildContext({
      doc,
      readerProfile: this.config.reader.profile,
      passage: thread.passage,
      threadLocation: thread.location,
      request: req,
      prior,
    });

    const runId = `r_${ulid()}`;
    const userMsg = { threadId, role: 'user' as const, content: built.userContent, prompt: built.userPrompt, status: 'complete' as const, preset: req.preset };
    const assistant = this.db.transaction(() => {
      insertMessage(this.db, userMsg);
      return insertMessage(this.db, {
        threadId,
        role: 'assistant',
        content: '',
        preset: req.preset,
        status: 'streaming',
        profile: profile.name,
        model: profile.model,
        contextUsed: formatContextUsed(built.contextParts, built.estimatedTokens),
      });
    })();

    const run: Run = {
      id: runId,
      threadId,
      messageId: assistant.id,
      events: [],
      done: false,
      listeners: new Set(),
      abort: new AbortController(),
      finished: Promise.resolve(),
    };
    this.runs.set(runId, run);
    this.activeByThread.set(threadId, runId);
    this.push(run, { type: 'run.start', runId, messageId: assistant.id, profile: profile.name, model: profile.model });

    const driver = this.drivers[profile.provider];
    const maxTokens = profile.max_tokens ?? this.defaultMaxTokens;
    const chatReq = { system: built.system, messages: built.messages, maxTokens, cacheHints: built.cacheHints };
    const events = streamWithRetry(driver, profile, chatReq, run.abort.signal, this.opts.retry);
    run.finished = this.execute(run, events, { docId: doc.id, profile: profile.name, model: profile.model, pricing: profile.pricing, contextParts: built.contextParts });
    return { runId, messageId: assistant.id };
  }

  /** Abort a run. The partial text stays; the message gets finishReason 'cancelled'. */
  cancel(id: string): void {
    const run = this.runs.get(id);
    if (!run) throw notFound('run');
    if (!run.done) run.abort.abort(new DOMException('cancelled', 'AbortError'));
  }

  /** Abort all runs and wait until each one has stored its partial text, for shutdown. */
  async shutdown(): Promise<void> {
    const active = [...this.runs.values()].filter((r) => !r.done);
    for (const run of active) run.abort.abort(new DOMException('shutdown', 'AbortError'));
    await Promise.all(active.map((r) => r.finished));
  }

  private push(run: Run, event: RunEvent): void {
    run.events.push({ seq: run.events.length + 1, event });
    for (const fn of [...run.listeners]) fn();
  }

  private async execute(
    run: Run,
    events: AsyncIterable<ChatEvent>,
    meta: { docId: string; profile: string; model: string; pricing: Pricing | undefined; contextParts: string[] },
  ): Promise<void> {
    let text = '';
    let flushed = '';
    let finish: 'stop' | 'length' | 'cancelled' | 'error' | 'other' = 'other';
    const usage: Required<Omit<Usage, 'costUsd'>> & { costUsd: number | null } = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costUsd: null,
    };
    let sawUsage = false;
    const flush = (): void => {
      if (text === flushed) return;
      try {
        updateMessage(this.db, run.messageId, { content: text });
        flushed = text;
      } catch (err) {
        log.error('flush failed', err);
      }
    };
    const timer = setInterval(flush, this.flushMs);
    const deadline = setTimeout(() => run.abort.abort(new DriverError('timeout', 'the run took longer than the limit', false)), this.maxRunMs);

    try {
      for await (const ev of events) {
        if (ev.type === 'delta') {
          text += ev.text;
          this.push(run, { type: 'delta', text: ev.text });
        } else if (ev.type === 'usage') {
          const u: Usage = {
            inputTokens: ev.inputTokens ?? 0,
            outputTokens: ev.outputTokens ?? 0,
            cachedInputTokens: ev.cachedInputTokens ?? 0,
          };
          u.costUsd = costUsd(meta.pricing, u);
          insertUsage(this.db, {
            runId: run.id,
            messageId: run.messageId,
            docId: meta.docId,
            profile: meta.profile,
            model: meta.model,
            inputTokens: u.inputTokens!,
            outputTokens: u.outputTokens!,
            cachedInputTokens: u.cachedInputTokens!,
            costUsd: u.costUsd,
          });
          usage.inputTokens += u.inputTokens!;
          usage.outputTokens += u.outputTokens!;
          usage.cachedInputTokens += u.cachedInputTokens!;
          if (u.costUsd !== null) usage.costUsd = (usage.costUsd ?? 0) + u.costUsd;
          sawUsage = true;
          this.push(run, { type: 'usage', usage: u });
        } else if (ev.type === 'done') {
          finish = ev.finishReason;
        }
      }
      clearInterval(timer);
      this.finishMessage(run, text, finish === 'cancelled' ? 'cancelled' : 'complete', finish, sawUsage ? usage : undefined, meta.contextParts);
      this.push(run, { type: 'run.end', finishReason: finish });
    } catch (err) {
      clearInterval(timer);
      const reason = run.abort.signal.reason as unknown;
      if (run.abort.signal.aborted && !(reason instanceof DriverError)) {
        // Cancel: keep the partial text.
        this.finishMessage(run, text, 'cancelled', 'cancelled', sawUsage ? usage : undefined, meta.contextParts);
        this.push(run, { type: 'run.end', finishReason: 'cancelled' });
      } else {
        const e = reason instanceof DriverError ? reason : err;
        const code = e instanceof DriverError ? e.code : 'internal';
        const message = redact(e instanceof Error ? e.message : String(e));
        const retryable = e instanceof DriverError ? e.retryable : false;
        if (!(e instanceof DriverError)) log.error(`run ${run.id} failed`, e);
        this.finishMessage(run, text, 'error', 'error', sawUsage ? usage : undefined, meta.contextParts);
        this.push(run, { type: 'error', code, message, retryable, partialKept: text.length > 0 });
      }
    } finally {
      clearInterval(timer);
      clearTimeout(deadline);
      run.done = true;
      this.activeByThread.delete(run.threadId);
      for (const fn of [...run.listeners]) fn();
      setTimeout(() => this.runs.delete(run.id), this.retainMs).unref();
    }
  }

  private finishMessage(
    run: Run,
    text: string,
    status: 'complete' | 'cancelled' | 'error',
    finishReason: string,
    usage: Usage | undefined,
    contextParts: string[],
  ): void {
    try {
      const patch: Parameters<typeof updateMessage>[2] = { content: text, status, finishReason };
      if (usage) {
        patch.usage = usage;
        // The provider's input count replaces the chars/4 estimate.
        if (usage.inputTokens) patch.contextUsed = formatContextUsed(contextParts, usage.inputTokens);
      }
      updateMessage(this.db, run.messageId, patch);
    } catch (err) {
      log.error('final write failed', err);
    }
  }
}
