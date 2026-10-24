import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Document, StartRunResponse, Thread } from '../../src/shared/types.ts';
import { makePdf, postJson, readSse, samplePassage, startTestServer, tempDir } from './helpers.ts';

describe('static files and SSE keep-alive', () => {
  it('serves dist/ with an SPA fallback, and API routes still win', async () => {
    const dist = tempDir();
    mkdirSync(join(dist.path, 'assets'));
    writeFileSync(join(dist.path, 'index.html'), '<!doctype html><title>app</title>');
    writeFileSync(join(dist.path, 'assets', 'a.js'), 'console.log(1)');
    const srv = await startTestServer({ app: { distDir: dist.path } });
    try {
      expect(await (await fetch(`${srv.url}/`)).text()).toContain('<title>app</title>');
      expect(await (await fetch(`${srv.url}/assets/a.js`)).text()).toBe('console.log(1)');
      expect(await (await fetch(`${srv.url}/some/view?doc=1`)).text()).toContain('<title>app</title>');
      expect(((await (await fetch(`${srv.api}/health`)).json()) as { ok: boolean }).ok).toBe(true);
      expect((await fetch(`${srv.api}/missing`)).status).toBe(404);
    } finally {
      await srv.stop();
      dist.cleanup();
    }
  });

  it('sends ": ping" comments while a run is idle', async () => {
    const srv = await startTestServer({ chunkMs: 15, app: { distDir: null, pingMs: 5 } });
    try {
      const path = join(srv.dir, 'b.pdf');
      writeFileSync(path, await makePdf({ title: 'P' }));
      const doc = (await (await postJson(`${srv.api}/docs/open`, { path })).json()) as Document;
      const location = { page: 0 };
      const thread = (await (await postJson(`${srv.api}/docs/${doc.id}/threads`, { passage: samplePassage(), location })).json()) as Thread;
      const run = (await (await postJson(`${srv.api}/threads/${thread.id}/runs`, { preset: 'explain', context: { surrounding: 'x', location } })).json()) as StartRunResponse;
      const comments: string[] = [];
      await readSse(`${srv.api}/runs/${run.runId}/events`, { comments });
      expect(comments.length).toBeGreaterThan(0);
      expect(comments[0]!.trim()).toBe('ping');
    } finally {
      await srv.stop();
    }
  });
});
