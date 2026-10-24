import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { PassageInput } from '../../src/shared/types.ts';
import { buildConfig, type ServerConfig } from '../../src/server/config.ts';
import { createMockDriver } from '../../src/server/llm/mock.ts';
import { startServer, type RunningServer, type StartOptions } from '../../src/server/main.ts';

// Test helpers: temp data dirs, a pdf-lib fixture, a server on an ephemeral port, and an SSE reader.

export function tempDir(prefix = 'llm-reader-test-'): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

/** A two-page PDF with a title and an author. */
export async function makePdf(opts: { title?: string; pages?: string[] } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  if (opts.title !== undefined) doc.setTitle(opts.title);
  doc.setAuthor('A. Writer');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of opts.pages ?? ['The first page.', 'The second page.']) {
    const page = doc.addPage([300, 200]);
    page.drawText(text, { x: 20, y: 100, size: 14, font });
  }
  return doc.save();
}

export function testConfig(dataDir: string, booksDir: string, raw: Record<string, unknown> = {}): ServerConfig {
  // Never read the user's environment: no key, so both roles are mock.
  return buildConfig(raw, { LLM_READER_DATA_DIR: dataDir, LLM_READER_BOOKS_DIR: booksDir });
}

export interface TestServer extends RunningServer {
  dir: string;
  api: string;
  stop: () => Promise<void>;
}

export async function startTestServer(opts: Partial<StartOptions> & { chunkMs?: number } = {}): Promise<TestServer> {
  const tmp = tempDir();
  const config = opts.config ?? testConfig(join(tmp.path, 'data'), join(tmp.path, 'books'));
  const server = await startServer({
    config,
    port: 0,
    quiet: true,
    app: { distDir: null, ...opts.app },
    drivers: { mock: createMockDriver({ chunkMs: opts.chunkMs ?? 2 }), ...opts.drivers },
    runOptions: { flushMs: 20, retry: { baseMs: 1 }, ...opts.runOptions },
  });
  return {
    ...server,
    dir: tmp.path,
    api: `${server.url}/api`,
    stop: async () => {
      await server.close();
      tmp.cleanup();
    },
  };
}

export async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

export interface SseFrame {
  id: string | undefined;
  event: string | undefined;
  data: Record<string, unknown>;
}

/**
 * Read an SSE stream until it closes, or until `stopAfter` returns true for a frame.
 * `onFrame` runs for each frame, so a test can act in the middle of a stream.
 */
export async function readSse(
  url: string,
  opts: { lastEventId?: number; onFrame?: (f: SseFrame) => void | Promise<void>; comments?: string[] } = {},
): Promise<SseFrame[]> {
  const headers: Record<string, string> = { accept: 'text/event-stream' };
  if (opts.lastEventId !== undefined) headers['last-event-id'] = String(opts.lastEventId);
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`SSE ${res.status}: ${await res.text()}`);
  const frames: SseFrame[] = [];
  const pending: EventSourceMessage[] = [];
  const parser = createParser({
    onEvent: (m) => pending.push(m),
    onComment: (c) => opts.comments?.push(c),
  });
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.feed(value);
    while (pending.length) {
      const m = pending.shift()!;
      const f = { id: m.id, event: m.event, data: JSON.parse(m.data) as Record<string, unknown> };
      frames.push(f);
      await opts.onFrame?.(f);
    }
  }
  return frames;
}

export function samplePassage(text = 'The kernel trick replaces the explicit map.'): PassageInput {
  return {
    start: { page: 0, offset: 10 },
    end: { page: 0, offset: 10 + text.length },
    kind: 'sentence',
    text,
    quote: { exact: text, prefix: 'before ', suffix: ' after' },
    rects: [{ page: 0, rect: [0.1, 0.2, 0.8, 0.25] }],
    segmenterVersion: 1,
  };
}
