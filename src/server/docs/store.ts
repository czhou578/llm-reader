import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path';
import type { Document, LibraryEntry } from '../../shared/types.ts';
import { expandHome } from '../config.ts';
import type { Db } from '../db/index.ts';
import { getDocument, insertDocument, listRecentDocuments, touchDocument, type StoredDocument } from '../db/repo.ts';
import { HttpError } from '../errors.ts';
import { isPdf, readPdfMeta } from './pdf.ts';

// Document open, upload, and the library list.

export const MAX_PDF_BYTES = 1024 * 1024 * 1024; // 1 GiB; a larger file is almost surely not a book

export function blobPath(dataDir: string, id: string): string {
  return join(dataDir, 'blobs', `${id}.pdf`);
}

export function publicDocument(d: StoredDocument): Document {
  const { fileName: _f, lastOpenedAt: _l, ...doc } = d;
  return doc;
}

export interface OpenResult {
  doc: StoredDocument;
  created: boolean;
}

/** Open a local file by path. The path must be absolute or `~`-relative. */
export async function openPath(db: Db, dataDir: string, rawPath: string): Promise<OpenResult> {
  const expanded = expandHome(rawPath.trim());
  if (!isAbsolute(expanded)) throw new HttpError(400, 'bad_path', 'path must be absolute or start with ~/');
  const path = resolve(expanded);
  let size: number;
  try {
    const st = await stat(path);
    if (!st.isFile()) throw new HttpError(400, 'bad_path', `${path} is not a file`);
    size = st.size;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(404, 'file_not_found', `${path} does not exist or cannot be read`);
  }
  if (size > MAX_PDF_BYTES) throw new HttpError(413, 'too_large', 'file is larger than 1 GiB');
  const bytes = await readFile(path);
  // The library lists uploads by their blob path; opening one must not record the blob as the source file.
  const isBlob = path.startsWith(join(resolve(dataDir), 'blobs') + sep);
  return importBytes(db, dataDir, bytes, { sourcePath: isBlob ? null : path, fileName: isBlob ? null : basename(path) });
}

/** Store bytes from an upload or a file, keyed by their SHA-256. */
export async function importBytes(
  db: Db,
  dataDir: string,
  bytes: Uint8Array,
  origin: { sourcePath: string | null; fileName: string | null },
): Promise<OpenResult> {
  if (!isPdf(bytes)) throw new HttpError(415, 'not_pdf', 'the file is not a PDF (no %PDF- header)');
  const id = createHash('sha256').update(bytes).digest('hex');
  await writeBlob(dataDir, id, bytes);

  const known = getDocument(db, id);
  if (known) {
    touchDocument(db, id, origin.sourcePath, origin.fileName);
    return { doc: getDocument(db, id)!, created: false };
  }

  let meta;
  try {
    meta = await readPdfMeta(bytes);
  } catch (err) {
    throw new HttpError(422, 'pdf_unreadable', `PDF.js cannot read the file: ${(err as Error).message}`);
  }
  const doc = insertDocument(db, {
    id,
    title: meta.title ?? stripExt(origin.fileName ?? `${id.slice(0, 12)}.pdf`),
    author: meta.author,
    pageCount: meta.pageCount,
    byteSize: bytes.byteLength,
    sourcePath: origin.sourcePath,
    pageLabels: meta.pageLabels,
    outline: meta.outline,
    fileName: origin.fileName,
  });
  return { doc, created: true };
}

async function writeBlob(dataDir: string, id: string, bytes: Uint8Array): Promise<void> {
  const target = blobPath(dataDir, id);
  try {
    await stat(target);
    return; // content-addressed: present means identical
  } catch {
    // not present yet
  }
  await mkdir(join(dataDir, 'blobs'), { recursive: true });
  // Write the hashed bytes (not a second read of the file) to a temp name, then rename,
  // so the blob always matches its id and a crash never leaves a partial blob under the final name.
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, target);
}

function stripExt(name: string): string {
  const ext = extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}

// ---------- library ----------

const SCAN_MAX_DEPTH = 4;
const SCAN_MAX_FILES = 5000;

async function scanPdfs(dir: string): Promise<{ path: string; size: number; mtimeMs: number }[]> {
  const out: { path: string; size: number; mtimeMs: number }[] = [];
  const walk = async (d: string, depth: number): Promise<void> => {
    if (out.length >= SCAN_MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return; // a missing or unreadable directory gives no entries, not an error
    }
    for (const e of entries) {
      if (out.length >= SCAN_MAX_FILES) return;
      if (e.name.startsWith('.')) continue;
      const p = join(d, e.name);
      if (e.isDirectory() && depth < SCAN_MAX_DEPTH) await walk(p, depth + 1);
      else if ((e.isFile() || e.isSymbolicLink()) && e.name.toLowerCase().endsWith('.pdf')) {
        try {
          const st = await stat(p);
          if (st.isFile()) out.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          // broken symlink
        }
      }
    }
  };
  await walk(dir, 0);
  return out;
}

/** Recent documents first (by last open), then the PDFs in books_dir by mtime, newest first. */
export async function listLibrary(db: Db, dataDir: string, booksDir: string): Promise<LibraryEntry[]> {
  const recent = listRecentDocuments(db);
  const byPath = new Map<string, StoredDocument>();
  const entries: LibraryEntry[] = [];
  for (const d of recent) {
    let path = d.sourcePath ?? null;
    let st = path ? await stat(path).catch(() => null) : null;
    if (!st) {
      // The source file moved or the document came from an upload: the blob still opens it.
      path = blobPath(dataDir, d.id);
      st = await stat(path).catch(() => null);
    }
    if (!path || !st) continue;
    byPath.set(path, d);
    const entry: LibraryEntry = {
      path,
      name: d.fileName ?? basename(d.sourcePath ?? `${d.title}.pdf`),
      byteSize: d.byteSize,
      mtime: st.mtime.toISOString(),
      docId: d.id,
      title: d.title,
    };
    const last = d.lastOpenedAt ?? d.addedAt;
    if (last) entry.lastOpenedAt = last;
    entries.push(entry);
  }
  const files = await scanPdfs(booksDir);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const f of files) {
    if (byPath.has(f.path)) continue;
    entries.push({ path: f.path, name: basename(f.path), byteSize: f.size, mtime: new Date(f.mtimeMs).toISOString() });
  }
  return entries;
}
