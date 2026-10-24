import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { CreateThreadRequest, ReadingState } from '../../shared/types.ts';
import { createThread, getDocument, getReadingState, listThreads, putReadingState } from '../db/repo.ts';
import { blobPath, importBytes, MAX_PDF_BYTES, openPath, publicDocument } from '../docs/store.ts';
import { HttpError, badRequest, notFound } from '../errors.ts';
import { isObject, readJson, type AppDeps } from './deps.ts';

const ID_RE = /^[0-9a-f]{64}$/;

export function docRoutes(deps: AppDeps): Hono {
  const r = new Hono();
  const dataDir = deps.config.storage.data_dir;

  const requireDoc = (id: string) => {
    const doc = ID_RE.test(id) ? getDocument(deps.db, id) : undefined;
    if (!doc) throw notFound('document');
    return doc;
  };

  r.post('/docs/open', async (c) => {
    const body = await readJson<{ path?: unknown }>(c);
    if (typeof body?.path !== 'string' || !body.path.trim()) throw badRequest('path is required');
    const { doc, created } = await openPath(deps.db, dataDir, body.path);
    return c.json(publicDocument(doc), created ? 201 : 200);
  });

  r.post(
    '/docs',
    bodyLimit({
      maxSize: MAX_PDF_BYTES,
      onError: () => {
        throw new HttpError(413, 'too_large', 'file is larger than 1 GiB');
      },
    }),
    async (c) => {
      const form = await c.req.parseBody().catch(() => {
        throw badRequest('expected a multipart body');
      });
      const file = form['file'];
      if (!(file instanceof File)) throw badRequest('multipart field "file" is required');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { doc, created } = await importBytes(deps.db, dataDir, bytes, {
        sourcePath: null,
        fileName: basename(file.name || 'upload.pdf'),
      });
      return c.json(publicDocument(doc), created ? 201 : 200);
    },
  );

  r.get('/docs/:id', (c) => c.json(publicDocument(requireDoc(c.req.param('id')))));

  // Range serving for PDF.js (docs/design/architecture.md 3.3). The bytes of an id never change.
  r.get('/docs/:id/file', async (c) => {
    const doc = requireDoc(c.req.param('id'));
    const path = blobPath(dataDir, doc.id);
    const st = await stat(path).catch(() => null);
    if (!st) throw new HttpError(404, 'blob_missing', 'the stored PDF file is missing');
    const size = st.size;
    const etag = `"${doc.id}"`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/pdf',
      'Accept-Ranges': 'bytes',
      ETag: etag,
      'Cache-Control': 'private, max-age=31536000, immutable',
    };
    const inm = c.req.header('if-none-match');
    if (inm && inm.split(',').some((t) => t.trim() === etag || t.trim() === '*')) {
      return c.body(null, 304, headers);
    }
    const range = parseRange(c.req.header('range'), size);
    if (range === 'invalid') {
      return c.body(null, 416, { ...headers, 'Content-Range': `bytes */${size}` });
    }
    const [start, end] = range ?? [0, size - 1];
    const length = size === 0 ? 0 : end - start + 1;
    headers['Content-Length'] = String(length);
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    const status = range ? 206 : 200;
    if (c.req.method === 'HEAD' || length === 0) return c.body(null, status, headers);
    const stream = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream<Uint8Array>;
    return c.body(stream, status, headers);
  });

  r.get('/docs/:id/state', (c) => {
    const doc = requireDoc(c.req.param('id'));
    const state = getReadingState(deps.db, doc.id);
    if (!state) throw notFound('reading state');
    return c.json(state);
  });

  r.put('/docs/:id/state', async (c) => {
    const doc = requireDoc(c.req.param('id'));
    const body = await readJson<ReadingState>(c);
    if (!isObject(body) || !Number.isInteger(body.page) || body.page < 0) throw badRequest('page must be a 0-based integer');
    if (typeof body.scrollFrac !== 'number' || !Number.isFinite(body.scrollFrac)) throw badRequest('scrollFrac must be a number');
    if (body.zoom !== 'page-width' && (typeof body.zoom !== 'number' || !(body.zoom > 0))) {
      throw badRequest("zoom must be a positive number or 'page-width'");
    }
    const state: ReadingState = {
      page: Math.min(body.page, Math.max(0, doc.pageCount - 1)),
      scrollFrac: Math.min(1, Math.max(0, body.scrollFrac)),
      zoom: body.zoom,
      cursor: isObject(body.cursor) ? body.cursor : null,
    };
    return c.json(putReadingState(deps.db, doc.id, state));
  });

  r.get('/docs/:id/threads', (c) => {
    const doc = requireDoc(c.req.param('id'));
    return c.json(listThreads(deps.db, doc.id));
  });

  r.post('/docs/:id/threads', async (c) => {
    const doc = requireDoc(c.req.param('id'));
    const body = await readJson<CreateThreadRequest>(c);
    validateThreadRequest(body);
    return c.json(createThread(deps.db, doc.id, body.passage, body.location), 201);
  });

  return r;
}

function validateThreadRequest(body: CreateThreadRequest): void {
  if (!isObject(body) || !isObject(body.passage) || !isObject(body.location)) throw badRequest('passage and location are required');
  const p = body.passage;
  const anchor = (a: unknown) => isObject(a) && Number.isInteger(a['page']) && Number.isInteger(a['offset']);
  if (!anchor(p.start) || !anchor(p.end)) throw badRequest('passage.start and passage.end need integer page and offset');
  if (typeof p.text !== 'string' || !p.text.trim()) throw badRequest('passage.text is required');
  if (!['sentence', 'paragraph', 'selection', 'region'].includes(p.kind)) throw badRequest('passage.kind is invalid');
  if (!isObject(p.quote) || typeof p.quote.exact !== 'string') throw badRequest('passage.quote is required');
  if (!Array.isArray(p.rects)) throw badRequest('passage.rects must be an array');
  if (!Number.isInteger(p.segmenterVersion)) throw badRequest('passage.segmenterVersion is required');
  if (!Number.isInteger(body.location.page)) throw badRequest('location.page is required');
}

/** Parse a single `bytes=` range. null: no usable Range header (serve all). 'invalid': unsatisfiable (416). */
export function parseRange(header: string | undefined, size: number): [number, number] | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  // Multiple ranges or another unit: ignoring the header and sending the full body is allowed (RFC 9110 14.2).
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  let start: number;
  let end: number;
  if (a === '') {
    const n = Number(b);
    if (n === 0) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return [start, end];
}
