import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import type { Document, Message, StartRunResponse, Thread, UsageSummary } from '../../src/shared/types.ts';
import { makePdf, postJson, readSse, samplePassage, startTestServer, tempDir, testConfig, type TestServer } from './helpers.ts';

const context = {
  surrounding: 'Before.\n\n⟦The kernel trick replaces the explicit map.⟧\n\nAfter.',
  location: { page: 0, pageLabel: '1' },
};

describe('runs over HTTP with the mock driver', () => {
  let srv: TestServer;
  let doc: Document;

  beforeAll(async () => {
    srv = await startTestServer({ chunkMs: 5 });
    const path = join(srv.dir, 'book.pdf');
    writeFileSync(path, await makePdf({ title: 'Run Book' }));
    doc = (await (await postJson(`${srv.api}/docs/open`, { path })).json()) as Document;
  });
  afterAll(async () => srv.stop());

  async function newThread(): Promise<Thread> {
    const res = await postJson(`${srv.api}/docs/${doc.id}/threads`, { passage: samplePassage(), location: context.location });
    expect(res.status).toBe(201);
    return (await res.json()) as Thread;
  }

  async function startRun(threadId: string, body: Record<string, unknown>): Promise<StartRunResponse> {
    const res = await postJson(`${srv.api}/threads/${threadId}/runs`, { context, ...body });
    expect(res.status).toBe(202);
    return (await res.json()) as StartRunResponse;
  }

  it('streams a full run, stores the answer, and records usage', async () => {
    const thread = await newThread();
    const { runId, messageId } = await startRun(thread.id, { preset: 'explain' });
    const frames = await readSse(`${srv.api}/runs/${runId}/events`);

    expect(frames[0]).toMatchObject({ id: '1', event: 'run.start', data: { type: 'run.start', runId, messageId, profile: 'mock', model: 'mock-1' } });
    expect(frames.map((f) => Number(f.id))).toEqual(frames.map((_, i) => i + 1));
    const deltas = frames.filter((f) => f.event === 'delta').map((f) => f.data['text'] as string);
    expect(deltas.length).toBeGreaterThan(10);
    const text = deltas.join('');
    expect(text).toContain('(explain)');
    expect(text).toContain('The kernel trick replaces');
    expect(frames.find((f) => f.event === 'usage')!.data['usage']).toMatchObject({ inputTokens: expect.any(Number), costUsd: null });
    expect(frames.at(-1)).toMatchObject({ event: 'run.end', data: { finishReason: 'stop' } });

    const stored = (await (await fetch(`${srv.api}/threads/${thread.id}`)).json()) as Thread;
    expect(stored.messages.map((m) => [m.role, m.status])).toEqual([
      ['user', 'complete'],
      ['assistant', 'complete'],
    ]);
    const answer = stored.messages[1]!;
    expect(answer).toMatchObject({ id: messageId, content: text, finishReason: 'stop', profile: 'mock', preset: 'explain' });
    expect(answer.contextUsed).toMatch(/^passage · p\. 1 · ±1 paragraph · [\d,]+ tok$/);
    expect(answer.usage!.outputTokens).toBeGreaterThan(0);

    const summary = (await (await fetch(`${srv.api}/usage/summary?docId=${doc.id}`)).json()) as UsageSummary;
    expect(summary.session.inputTokens).toBeGreaterThan(0);
    expect(summary.session.outputTokens).toBeGreaterThan(0);
    expect(summary.document!.inputTokens).toBe(summary.session.inputTokens);

    // Replay from Last-Event-ID: only the later frames come back.
    const replay = await readSse(`${srv.api}/runs/${runId}/events`, { lastEventId: frames.length - 2 });
    expect(replay.map((f) => f.id)).toEqual(frames.slice(-2).map((f) => f.id));

    // A follow-up in the same thread is a new run on the same thread.
    const follow = await startRun(thread.id, { preset: 'ask', question: 'And then?' });
    const followFrames = await readSse(`${srv.api}/runs/${follow.runId}/events`);
    expect(followFrames.filter((f) => f.event === 'delta').map((f) => f.data['text']).join('')).toContain('(follow-up)');
    const after = (await (await fetch(`${srv.api}/threads/${thread.id}`)).json()) as Thread;
    expect(after.messages).toHaveLength(4);
    expect(after.messages[2]!.content).toBe('And then?');
    expect(after.messages[3]!.contextUsed).toMatch(/^follow-up · turn 2 · p\. 1 · /);
  });

  it('cancel keeps the partial text', async () => {
    const thread = await newThread();
    const { runId, messageId } = await startRun(thread.id, { preset: 'define' });
    // A second run on the same thread while one is active is refused.
    const busy = await postJson(`${srv.api}/threads/${thread.id}/runs`, { context, preset: 'explain' });
    expect(busy.status).toBe(409);

    let deltas = 0;
    let cancelled = false;
    const frames = await readSse(`${srv.api}/runs/${runId}/events`, {
      onFrame: async (f) => {
        if (f.event === 'delta' && ++deltas === 3 && !cancelled) {
          cancelled = true;
          const res = await fetch(`${srv.api}/runs/${runId}/cancel`, { method: 'POST' });
          expect(await res.json()).toEqual({ ok: true });
        }
      },
    });
    expect(frames.at(-1)).toMatchObject({ event: 'run.end', data: { finishReason: 'cancelled' } });
    const partial = frames.filter((f) => f.event === 'delta').map((f) => f.data['text']).join('');
    expect(partial.length).toBeGreaterThan(0);

    const msg = ((await (await fetch(`${srv.api}/threads/${thread.id}`)).json()) as Thread).messages.find((m) => m.id === messageId) as Message;
    expect(msg).toMatchObject({ status: 'cancelled', finishReason: 'cancelled', content: partial });
    expect(msg.content.length).toBeLessThan(200);
  });

  it('a closed SSE stream does not cancel the run', async () => {
    const thread = await newThread();
    const { runId, messageId } = await startRun(thread.id, { preset: 'explain' });
    const ctrl = new AbortController();
    const res = await fetch(`${srv.api}/runs/${runId}/events`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    await reader.read();
    ctrl.abort();
    const frames = await readSse(`${srv.api}/runs/${runId}/events`);
    expect(frames.at(-1)!.event).toBe('run.end');
    const msg = ((await (await fetch(`${srv.api}/threads/${thread.id}`)).json()) as Thread).messages.find((m) => m.id === messageId)!;
    expect(msg.status).toBe('complete');
  });

  it('validates run requests', async () => {
    const thread = await newThread();
    const noQuestion = await postJson(`${srv.api}/threads/${thread.id}/runs`, { context, preset: 'ask' });
    expect(noQuestion.status).toBe(400);
    expect((await postJson(`${srv.api}/threads/t_none/runs`, { context, preset: 'explain' })).status).toBe(404);
    expect((await fetch(`${srv.api}/runs/r_none/events`)).status).toBe(404);
    expect((await fetch(`${srv.api}/runs/r_none/cancel`, { method: 'POST' })).status).toBe(404);
  });
});

describe('a run that fails', () => {
  it('sends an error event and stores the message as error', async () => {
    const tmp = tempDir();
    // A key variable that is never set, and an address that never answers: no real provider is called.
    const config = testConfig(join(tmp.path, 'data'), join(tmp.path, 'books'), {
      roles: { strong: 'remote' },
      profiles: { remote: { provider: 'anthropic', model: 'm', base_url: 'http://127.0.0.1:9', api_key_env: 'LLM_READER_TEST_UNSET_KEY' } },
    });
    const srv = await startTestServer({ config });
    try {
      const path = join(srv.dir, 'book.pdf');
      writeFileSync(path, await makePdf({ title: 'E' }));
      const doc = (await (await postJson(`${srv.api}/docs/open`, { path })).json()) as Document;
      const thread = (await (await postJson(`${srv.api}/docs/${doc.id}/threads`, { passage: samplePassage(), location: context.location })).json()) as Thread;
      const { runId, messageId } = (await (await postJson(`${srv.api}/threads/${thread.id}/runs`, { context, preset: 'explain' })).json()) as StartRunResponse;
      const frames = await readSse(`${srv.api}/runs/${runId}/events`);
      expect(frames.map((f) => f.event)).toEqual(['run.start', 'error']);
      expect(frames[1]!.data).toMatchObject({ code: 'missing_key', retryable: false, partialKept: false });
      expect(frames[1]!.data['message']).toContain('LLM_READER_TEST_UNSET_KEY');
      const msg = ((await (await fetch(`${srv.api}/threads/${thread.id}`)).json()) as Thread).messages.find((m) => m.id === messageId)!;
      expect(msg).toMatchObject({ status: 'error', finishReason: 'error', content: '' });
    } finally {
      await srv.stop();
      tmp.cleanup();
    }
  });
});
