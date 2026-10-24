import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Document, LibraryEntry, ReadingState } from '../../src/shared/types.ts';
import { makePdf, postJson, startTestServer, type TestServer } from './helpers.ts';

describe('documents over HTTP', () => {
  let srv: TestServer;
  let bytes: Uint8Array;
  let pdfPath: string;
  let doc: Document;

  beforeAll(async () => {
    srv = await startTestServer();
    bytes = await makePdf({ title: 'A Test Book' });
    const books = srv.deps.config.storage.books_dir;
    mkdirSync(join(books, 'sub'), { recursive: true });
    pdfPath = join(books, 'book.pdf');
    writeFileSync(pdfPath, bytes);
    writeFileSync(join(books, 'sub', 'other.pdf'), await makePdf({ pages: ['x'] }));
    writeFileSync(join(books, 'notes.txt'), 'not a pdf');
  });
  afterAll(async () => srv.stop());

  it('opens a file by path: id is the SHA-256, metadata comes from PDF.js', async () => {
    const res = await postJson(`${srv.api}/docs/open`, { path: pdfPath });
    expect(res.status).toBe(201);
    doc = (await res.json()) as Document;
    expect(doc.id).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(doc).toMatchObject({ title: 'A Test Book', author: 'A. Writer', pageCount: 2, byteSize: bytes.byteLength, sourcePath: pdfPath });
    // A second open of the same bytes is a known document.
    const again = await postJson(`${srv.api}/docs/open`, { path: pdfPath });
    expect(again.status).toBe(200);
    expect(((await again.json()) as Document).id).toBe(doc.id);
    expect(((await (await fetch(`${srv.api}/docs/${doc.id}`)).json()) as Document).title).toBe('A Test Book');
  });

  it('serves Range requests with ETag and immutable caching', async () => {
    const full = await fetch(`${srv.api}/docs/${doc.id}/file`);
    expect(full.status).toBe(200);
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(full.headers.get('etag')).toBe(`"${doc.id}"`);
    expect(full.headers.get('cache-control')).toContain('immutable');
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(bytes);

    const part = await fetch(`${srv.api}/docs/${doc.id}/file`, { headers: { range: 'bytes=5-20' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 5-20/${bytes.byteLength}`);
    expect(part.headers.get('content-length')).toBe('16');
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes.slice(5, 21));

    const suffix = await fetch(`${srv.api}/docs/${doc.id}/file`, { headers: { range: 'bytes=-10' } });
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(bytes.slice(bytes.byteLength - 10));

    const bad = await fetch(`${srv.api}/docs/${doc.id}/file`, { headers: { range: `bytes=${bytes.byteLength}-` } });
    expect(bad.status).toBe(416);
    await bad.arrayBuffer();

    const cached = await fetch(`${srv.api}/docs/${doc.id}/file`, { headers: { 'if-none-match': `"${doc.id}"` } });
    expect(cached.status).toBe(304);
  });

  it('accepts a multipart upload and rejects a file that is not a PDF', async () => {
    const other = await makePdf({ title: 'Uploaded', pages: ['u'] });
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(other)], { type: 'application/pdf' }), 'up.pdf');
    const res = await fetch(`${srv.api}/docs`, { method: 'POST', body: form });
    expect(res.status).toBe(201);
    expect(((await res.json()) as Document).title).toBe('Uploaded');

    const junk = new FormData();
    junk.append('file', new Blob(['hello']), 'x.pdf');
    const bad = await fetch(`${srv.api}/docs`, { method: 'POST', body: junk });
    expect(bad.status).toBe(415);
    expect(await bad.json()).toEqual({ error: { code: 'not_pdf', message: expect.any(String) } });
  });

  it('reports errors in the JSON error shape', async () => {
    const missing = await postJson(`${srv.api}/docs/open`, { path: join(srv.dir, 'nope.pdf') });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('file_not_found');
    const relative = await postJson(`${srv.api}/docs/open`, { path: 'book.pdf' });
    expect(relative.status).toBe(400);
    const unknown = await fetch(`${srv.api}/docs/${'f'.repeat(64)}`);
    expect(unknown.status).toBe(404);
    const route = await fetch(`${srv.api}/nothing`);
    expect(((await route.json()) as { error: { code: string } }).error.code).toBe('not_found');
  });

  it('lists recent documents first, then books_dir PDFs', async () => {
    const list = (await (await fetch(`${srv.api}/library`)).json()) as LibraryEntry[];
    const recent = list.filter((e) => e.docId);
    expect(recent.map((e) => e.title).sort()).toEqual(['A Test Book', 'Uploaded']);
    expect(list.slice(0, recent.length).every((e) => e.docId)).toBe(true);
    const scanned = list.filter((e) => !e.docId).map((e) => e.name);
    expect(scanned).toEqual(['other.pdf']); // book.pdf is already a recent document; notes.txt is not a PDF
  });

  it('stores the reading state', async () => {
    expect((await fetch(`${srv.api}/docs/${doc.id}/state`)).status).toBe(404);
    const state: ReadingState = { page: 1, scrollFrac: 0.4, zoom: 'page-width', cursor: { page: 1, offset: 12 } };
    const put = await fetch(`${srv.api}/docs/${doc.id}/state`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state) });
    expect(put.status).toBe(200);
    const got = (await (await fetch(`${srv.api}/docs/${doc.id}/state`)).json()) as ReadingState;
    expect(got).toMatchObject(state);
  });

  it('checks Host and Origin', async () => {
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: srv.port, path: '/api/health', headers: { host: 'evil.example:80' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
    const cross = await postJson(`${srv.api}/docs/open`, { path: pdfPath }, { origin: 'https://evil.example' });
    expect(cross.status).toBe(403);
    const dev = await postJson(`${srv.api}/docs/open`, { path: pdfPath }, { origin: 'http://127.0.0.1:5173' });
    expect(dev.status).toBe(200);
  });
});
