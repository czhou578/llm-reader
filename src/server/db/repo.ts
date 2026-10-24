import { ulid } from 'ulid';
import type {
  DocId,
  Document,
  Location,
  Message,
  MessageStatus,
  OutlineItem,
  Passage,
  PassageInput,
  PresetId,
  ReadingState,
  Thread,
  Usage,
  UsageSummary,
} from '../../shared/types.ts';
import type { Db } from './index.ts';

// Repository functions: plain SQL, rows mapped to the shared types. No ORM (DESIGN.md 7.6).

const now = (): string => new Date().toISOString();
const json = (v: unknown): string => JSON.stringify(v);
const parse = <T>(s: string | null | undefined): T | undefined => (s == null ? undefined : (JSON.parse(s) as T));

// ---------- documents ----------

interface DocumentRow {
  id: string;
  title: string;
  author: string | null;
  page_count: number;
  byte_size: number;
  source_path: string | null;
  file_name: string | null;
  page_labels_json: string | null;
  outline_json: string | null;
  added_at: string;
  last_opened_at: string | null;
}

export interface StoredDocument extends Document {
  fileName: string | null;
  lastOpenedAt: string | null;
}

function toDocument(r: DocumentRow): StoredDocument {
  return {
    id: r.id,
    title: r.title,
    author: r.author,
    pageCount: r.page_count,
    byteSize: r.byte_size,
    sourcePath: r.source_path,
    addedAt: r.added_at,
    pageLabels: parse<string[]>(r.page_labels_json) ?? null,
    outline: parse<OutlineItem[]>(r.outline_json) ?? [],
    fileName: r.file_name,
    lastOpenedAt: r.last_opened_at,
  };
}

export function getDocument(db: Db, id: DocId): StoredDocument | undefined {
  const r = db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as DocumentRow | undefined;
  return r ? toDocument(r) : undefined;
}

export function insertDocument(db: Db, doc: Omit<Document, 'addedAt'> & { fileName?: string | null }): StoredDocument {
  const at = now();
  db.prepare(
    `INSERT INTO documents (id, title, author, page_count, byte_size, source_path, file_name, page_labels_json,
       outline_json, added_at, last_opened_at)
     VALUES (@id, @title, @author, @pageCount, @byteSize, @sourcePath, @fileName, @pageLabels, @outline, @at, @at)`,
  ).run({
    id: doc.id,
    title: doc.title,
    author: doc.author ?? null,
    pageCount: doc.pageCount,
    byteSize: doc.byteSize,
    sourcePath: doc.sourcePath ?? null,
    fileName: doc.fileName ?? null,
    pageLabels: doc.pageLabels ? json(doc.pageLabels) : null,
    outline: json(doc.outline ?? []),
    at,
  });
  return getDocument(db, doc.id)!;
}

/** Record that a known document was opened again, optionally from a new path. */
export function touchDocument(db: Db, id: DocId, sourcePath?: string | null, fileName?: string | null): void {
  db.prepare(
    `UPDATE documents SET last_opened_at = ?, source_path = COALESCE(?, source_path), file_name = COALESCE(?, file_name)
     WHERE id = ?`,
  ).run(now(), sourcePath ?? null, fileName ?? null, id);
}

export function listRecentDocuments(db: Db, limit = 50): StoredDocument[] {
  const rows = db
    .prepare('SELECT * FROM documents ORDER BY COALESCE(last_opened_at, added_at) DESC LIMIT ?')
    .all(limit) as DocumentRow[];
  return rows.map(toDocument);
}

// ---------- passages ----------

interface PassageRow {
  id: string;
  doc_id: string;
  start_page: number;
  start_offset: number;
  end_page: number;
  end_offset: number;
  kind: Passage['kind'];
  text: string;
  quote_json: string;
  rects_json: string;
  segmenter_version: number;
  quality: 'low' | null;
}

function toPassage(r: PassageRow): Passage {
  const p: Passage = {
    id: r.id,
    docId: r.doc_id,
    start: { page: r.start_page, offset: r.start_offset },
    end: { page: r.end_page, offset: r.end_offset },
    kind: r.kind,
    text: r.text,
    quote: JSON.parse(r.quote_json) as Passage['quote'],
    rects: JSON.parse(r.rects_json) as Passage['rects'],
    segmenterVersion: r.segmenter_version,
  };
  if (r.quality) p.quality = r.quality;
  return p;
}

export function insertPassage(db: Db, docId: DocId, input: PassageInput): Passage {
  const id = `p_${ulid()}`;
  db.prepare(
    `INSERT INTO passages (id, doc_id, start_page, start_offset, end_page, end_offset, kind, text, quote_json,
       rects_json, segmenter_version, quality)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    docId,
    input.start.page,
    input.start.offset,
    input.end.page,
    input.end.offset,
    input.kind,
    input.text,
    json(input.quote),
    json(input.rects),
    input.segmenterVersion,
    input.quality ?? null,
  );
  return getPassage(db, id)!;
}

export function getPassage(db: Db, id: string): Passage | undefined {
  const r = db.prepare('SELECT * FROM passages WHERE id = ?').get(id) as PassageRow | undefined;
  return r ? toPassage(r) : undefined;
}

// ---------- threads and messages ----------

interface ThreadRow {
  id: string;
  doc_id: string;
  passage_id: string | null;
  location_json: string;
  title: string;
  created_at: string;
}

interface MessageRow {
  id: string;
  thread_id: string;
  seq: number;
  role: 'user' | 'assistant';
  content: string;
  prompt: string | null;
  preset: PresetId | null;
  status: MessageStatus;
  profile: string | null;
  model: string | null;
  finish_reason: string | null;
  usage_json: string | null;
  context_used: string | null;
  created_at: string;
}

/** A message plus the server-only prompt text. */
export interface StoredMessage extends Message {
  prompt: string | null;
}

function toMessage(r: MessageRow): StoredMessage {
  const m: StoredMessage = {
    id: r.id,
    threadId: r.thread_id,
    role: r.role,
    content: r.content,
    status: r.status,
    createdAt: r.created_at,
    prompt: r.prompt,
  };
  if (r.preset) m.preset = r.preset;
  if (r.profile) m.profile = r.profile;
  if (r.model) m.model = r.model;
  if (r.finish_reason) m.finishReason = r.finish_reason;
  const usage = parse<Usage>(r.usage_json);
  if (usage) m.usage = usage;
  if (r.context_used) m.contextUsed = r.context_used;
  return m;
}

/** Strip server-only fields before a message goes to the browser. */
export function publicMessage(m: StoredMessage): Message {
  const { prompt: _prompt, ...rest } = m;
  return rest;
}

function toThread(db: Db, r: ThreadRow): Thread {
  const passage = r.passage_id ? getPassage(db, r.passage_id) : undefined;
  return {
    id: r.id,
    docId: r.doc_id,
    // A thread always has a passage in v0; the fallback covers a deleted passage row.
    passage: passage ?? {
      id: '',
      docId: r.doc_id,
      start: { page: 0, offset: 0 },
      end: { page: 0, offset: 0 },
      kind: 'selection',
      text: '',
      quote: { exact: '', prefix: '', suffix: '' },
      rects: [],
      segmenterVersion: 0,
    },
    location: JSON.parse(r.location_json) as Location,
    title: r.title,
    createdAt: r.created_at,
    messages: listMessages(db, r.id).map(publicMessage),
  };
}

export function createThread(db: Db, docId: DocId, input: PassageInput, location: Location): Thread {
  const id = `t_${ulid()}`;
  db.transaction(() => {
    const passage = insertPassage(db, docId, input);
    const title = input.text.replace(/\s+/g, ' ').trim().slice(0, 80);
    db.prepare(
      'INSERT INTO threads (id, doc_id, passage_id, location_json, title, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, docId, passage.id, json(location), title, now());
  })();
  return getThread(db, id)!;
}

export function getThread(db: Db, id: string): Thread | undefined {
  const r = db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as ThreadRow | undefined;
  return r ? toThread(db, r) : undefined;
}

export function listThreads(db: Db, docId: DocId): Thread[] {
  const rows = db
    .prepare('SELECT * FROM threads WHERE doc_id = ? ORDER BY created_at, id')
    .all(docId) as ThreadRow[];
  return rows.map((r) => toThread(db, r));
}

export function listMessages(db: Db, threadId: string): StoredMessage[] {
  const rows = db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY seq').all(threadId) as MessageRow[];
  return rows.map(toMessage);
}

export function getMessage(db: Db, id: string): StoredMessage | undefined {
  const r = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
  return r ? toMessage(r) : undefined;
}

export interface NewMessage {
  threadId: string;
  role: 'user' | 'assistant';
  content: string;
  prompt?: string | null;
  preset?: PresetId;
  status: MessageStatus;
  profile?: string;
  model?: string;
  contextUsed?: string;
}

export function insertMessage(db: Db, m: NewMessage): StoredMessage {
  const id = `m_${ulid()}`;
  const at = now();
  const next = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE thread_id = ?').get(m.threadId) as {
    seq: number;
  };
  db.prepare(
    `INSERT INTO messages (id, thread_id, seq, role, content, prompt, preset, status, profile, model, context_used,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    m.threadId,
    next.seq,
    m.role,
    m.content,
    m.prompt ?? null,
    m.preset ?? null,
    m.status,
    m.profile ?? null,
    m.model ?? null,
    m.contextUsed ?? null,
    at,
    at,
  );
  return getMessage(db, id)!;
}

export interface MessagePatch {
  content?: string;
  status?: MessageStatus;
  finishReason?: string | null;
  usage?: Usage;
  contextUsed?: string;
}

export function updateMessage(db: Db, id: string, patch: MessagePatch): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.content !== undefined) (sets.push('content = ?'), vals.push(patch.content));
  if (patch.status !== undefined) (sets.push('status = ?'), vals.push(patch.status));
  if (patch.finishReason !== undefined) (sets.push('finish_reason = ?'), vals.push(patch.finishReason));
  if (patch.usage !== undefined) (sets.push('usage_json = ?'), vals.push(json(patch.usage)));
  if (patch.contextUsed !== undefined) (sets.push('context_used = ?'), vals.push(patch.contextUsed));
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  vals.push(now(), id);
  db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

/** At startup: runs from an earlier process are gone, so their rows cannot finish. */
export function markInterrupted(db: Db): number {
  return db
    .prepare(`UPDATE messages SET status = 'interrupted', finish_reason = 'interrupted', updated_at = ? WHERE status = 'streaming'`)
    .run(now()).changes;
}

// ---------- usage ----------

export interface UsageRow {
  runId: string;
  messageId: string | null;
  docId: DocId | null;
  profile: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number | null;
}

export function insertUsage(db: Db, u: UsageRow): void {
  db.prepare(
    `INSERT INTO usage (run_id, message_id, doc_id, profile, model, input_tokens, output_tokens, cached_input_tokens,
       cost_usd, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    u.runId,
    u.messageId,
    u.docId,
    u.profile,
    u.model,
    u.inputTokens,
    u.outputTokens,
    u.cachedInputTokens,
    u.costUsd,
    now(),
  );
}

type Totals = UsageSummary['session'];

function totals(db: Db, where: string, arg: string): Totals {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o,
         COALESCE(SUM(cached_input_tokens), 0) AS c, SUM(cost_usd) AS cost
       FROM usage WHERE ${where}`,
    )
    .get(arg) as { i: number; o: number; c: number; cost: number | null };
  // SUM over only NULL costs is NULL, which is the "no prices configured" case.
  return { inputTokens: r.i, outputTokens: r.o, cachedInputTokens: r.c, costUsd: r.cost };
}

/** `session` counts usage since `sessionStart` (the server start). `document` counts all usage of one document. */
export function usageSummary(db: Db, sessionStart: string, docId?: string): UsageSummary {
  const out: UsageSummary = { session: totals(db, 'at >= ?', sessionStart) };
  if (docId) out.document = totals(db, 'doc_id = ?', docId);
  return out;
}

// ---------- reading state ----------

interface ReadingStateRow {
  page: number;
  scroll_frac: number;
  zoom_json: string;
  cursor_passage_json: string | null;
  updated_at: string;
}

export function getReadingState(db: Db, docId: DocId): ReadingState | undefined {
  const r = db.prepare('SELECT * FROM reading_state WHERE doc_id = ?').get(docId) as ReadingStateRow | undefined;
  if (!r) return undefined;
  return {
    page: r.page,
    scrollFrac: r.scroll_frac,
    zoom: JSON.parse(r.zoom_json) as ReadingState['zoom'],
    cursor: parse<ReadingState['cursor']>(r.cursor_passage_json) ?? null,
    updatedAt: r.updated_at,
  };
}

export function putReadingState(db: Db, docId: DocId, s: ReadingState): ReadingState {
  db.prepare(
    `INSERT INTO reading_state (doc_id, page, scroll_frac, zoom_json, cursor_passage_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (doc_id) DO UPDATE SET page = excluded.page, scroll_frac = excluded.scroll_frac,
       zoom_json = excluded.zoom_json, cursor_passage_json = excluded.cursor_passage_json, updated_at = excluded.updated_at`,
  ).run(docId, s.page, s.scrollFrac, json(s.zoom), s.cursor ? json(s.cursor) : null, now());
  return getReadingState(db, docId)!;
}

// ---------- settings ----------

export function getSetting<T>(db: Db, key: string): T | undefined {
  const r = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as { value_json: string } | undefined;
  return r ? (JSON.parse(r.value_json) as T) : undefined;
}

export function setSetting(db: Db, key: string, value: unknown): void {
  db.prepare(
    'INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json',
  ).run(key, json(value));
}
