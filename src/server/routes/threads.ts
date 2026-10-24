import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { StartRunRequest } from '../../shared/types.ts';
import { getThread } from '../db/repo.ts';
import { badRequest, notFound } from '../errors.ts';
import { isObject, readJson, type AppDeps } from './deps.ts';

const PING_MS = 15_000;

export function threadRoutes(deps: AppDeps, opts: { pingMs?: number } = {}): Hono {
  const r = new Hono();
  const pingMs = opts.pingMs ?? PING_MS;

  r.get('/threads/:id', (c) => {
    const thread = getThread(deps.db, c.req.param('id'));
    if (!thread) throw notFound('thread');
    return c.json(thread);
  });

  r.post('/threads/:id/runs', async (c) => {
    const body = await readJson<StartRunRequest>(c);
    if (!isObject(body)) throw badRequest('body must be an object');
    return c.json(deps.runs.start(c.req.param('id'), body), 202);
  });

  r.post('/runs/:id/cancel', (c) => {
    deps.runs.cancel(c.req.param('id'));
    return c.json({ ok: true });
  });

  // SSE: replays the buffer after Last-Event-ID, then follows the run until run.end or error.
  r.get('/runs/:id/events', (c) => {
    const run = deps.runs.get(c.req.param('id'));
    if (!run) throw notFound('run');
    const lastId = Number(c.req.header('last-event-id') ?? c.req.query('lastEventId') ?? 0);
    let next = Number.isInteger(lastId) && lastId > 0 ? lastId + 1 : 1;
    return streamSSE(c, async (stream) => {
      let wake: (() => void) | null = null;
      stream.onAbort(() => wake?.());
      const ping = setInterval(() => {
        // A comment line keeps proxies and the browser from closing an idle stream.
        void stream.write(': ping\n\n').catch(() => undefined);
      }, pingMs);
      try {
        while (!stream.aborted) {
          while (next <= run.events.length) {
            const { seq, event } = run.events[next - 1]!;
            await stream.writeSSE({ id: String(seq), event: event.type, data: JSON.stringify(event) });
            next++;
          }
          if (run.done) break;
          await new Promise<void>((resolve) => {
            wake = resolve;
            run.listeners.add(resolve);
          });
          if (wake) run.listeners.delete(wake);
          wake = null;
        }
      } finally {
        clearInterval(ping);
        if (wake) run.listeners.delete(wake);
      }
    });
  });

  return r;
}
