import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';

// Scaffold server. Routes, fetch, context, runs, and db modules from DESIGN.md go under src/server/.
const app = new Hono();

app.get('/api/health', (c) => c.json({ ok: true, name: 'llm-reader', node: process.version }));
app.use('/*', serveStatic({ root: './dist' }));

const port = Number(process.env['PORT'] ?? 7777);
serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, (info) => {
  console.log(`llm-reader server on http://127.0.0.1:${info.port}`);
});
