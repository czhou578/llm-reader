import { Hono } from 'hono';
import { toClientConfig } from '../config.ts';
import { usageSummary } from '../db/repo.ts';
import { listLibrary } from '../docs/store.ts';
import type { AppDeps } from './deps.ts';

export function metaRoutes(deps: AppDeps): Hono {
  const r = new Hono();
  r.get('/health', (c) => c.json({ ok: true, name: 'llm-reader', node: process.version }));
  r.get('/config', (c) => c.json(toClientConfig(deps.config)));
  r.get('/library', async (c) =>
    c.json(await listLibrary(deps.db, deps.config.storage.data_dir, deps.config.storage.books_dir)),
  );
  r.get('/usage/summary', (c) => c.json(usageSummary(deps.db, deps.startedAt, c.req.query('docId') || undefined)));
  return r;
}
