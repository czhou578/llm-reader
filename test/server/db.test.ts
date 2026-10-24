import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDb, type Db } from '../../src/server/db/index.ts';
import {
  createThread,
  getDocument,
  getMessage,
  getReadingState,
  getSetting,
  getThread,
  insertDocument,
  insertMessage,
  insertUsage,
  listRecentDocuments,
  listThreads,
  markInterrupted,
  putReadingState,
  setSetting,
  touchDocument,
  updateMessage,
  usageSummary,
} from '../../src/server/db/repo.ts';
import { samplePassage, tempDir } from './helpers.ts';

const DOC_ID = 'a'.repeat(64);

describe('db', () => {
  let tmp: ReturnType<typeof tempDir>;
  let db: Db;

  beforeEach(() => {
    tmp = tempDir();
    db = openDb(tmp.path);
    insertDocument(db, { id: DOC_ID, title: 'Book', author: 'Me', pageCount: 3, byteSize: 100, sourcePath: '/x/book.pdf', pageLabels: ['i', 'ii', '1'], outline: [{ title: 'Ch 1', page: 2 }], fileName: 'book.pdf' });
  });
  afterEach(() => {
    db.close();
    tmp.cleanup();
  });

  it('uses WAL, enforces foreign keys, and applies migrations once', () => {
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(migrate(db)).toEqual([]);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    for (const t of ['documents', 'sources', 'passages', 'threads', 'messages', 'usage', 'reading_state', 'settings']) {
      expect(tables).toContain(t);
    }
    expect(() => createThread(db, 'b'.repeat(64), samplePassage(), { page: 0 })).toThrow(/FOREIGN KEY/);
  });

  it('stores and touches documents', () => {
    const d = getDocument(db, DOC_ID)!;
    expect(d).toMatchObject({ title: 'Book', pageCount: 3, pageLabels: ['i', 'ii', '1'], outline: [{ title: 'Ch 1', page: 2 }] });
    touchDocument(db, DOC_ID, '/y/moved.pdf', 'moved.pdf');
    expect(getDocument(db, DOC_ID)!.sourcePath).toBe('/y/moved.pdf');
    expect(listRecentDocuments(db).map((x) => x.id)).toEqual([DOC_ID]);
  });

  it('keeps threads with passages and ordered messages', () => {
    const t = createThread(db, DOC_ID, samplePassage(), { page: 0, pageLabel: 'i' });
    expect(t.passage.text).toBe(samplePassage().text);
    expect(t.title).toBe(samplePassage().text);
    const u = insertMessage(db, { threadId: t.id, role: 'user', content: 'Explain', prompt: '<request>…', preset: 'explain', status: 'complete' });
    const a = insertMessage(db, { threadId: t.id, role: 'assistant', content: '', status: 'streaming', profile: 'mock', model: 'mock-1' });
    updateMessage(db, a.id, { content: 'Answer', status: 'complete', finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 2 } });
    const thread = getThread(db, t.id)!;
    expect(thread.messages.map((m) => m.id)).toEqual([u.id, a.id]);
    expect(thread.messages[1]).toMatchObject({ content: 'Answer', status: 'complete', finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 2 } });
    // The stored prompt is a server-only field.
    expect(thread.messages[0]).not.toHaveProperty('prompt');
    expect(getMessage(db, u.id)!.prompt).toBe('<request>…');
    expect(listThreads(db, DOC_ID)).toHaveLength(1);
  });

  it('marks streaming rows as interrupted', () => {
    const t = createThread(db, DOC_ID, samplePassage(), { page: 0 });
    const a = insertMessage(db, { threadId: t.id, role: 'assistant', content: 'half', status: 'streaming' });
    expect(markInterrupted(db)).toBe(1);
    expect(getMessage(db, a.id)).toMatchObject({ status: 'interrupted', content: 'half' });
    // Reopening the store does the same at startup; nothing is left to mark.
    db.close();
    db = openDb(tmp.path);
    expect(markInterrupted(db)).toBe(0);
  });

  it('sums usage per session and per document', () => {
    const start = new Date(Date.now() - 1000).toISOString();
    expect(usageSummary(db, start, DOC_ID)).toEqual({
      session: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: null },
      document: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: null },
    });
    insertUsage(db, { runId: 'r1', messageId: null, docId: DOC_ID, profile: 'mock', model: 'm', inputTokens: 10, outputTokens: 4, cachedInputTokens: 2, costUsd: null });
    insertUsage(db, { runId: 'r2', messageId: null, docId: DOC_ID, profile: 'c', model: 'm', inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, costUsd: 0.5 });
    const s = usageSummary(db, start, DOC_ID);
    expect(s.session).toEqual({ inputTokens: 11, outputTokens: 5, cachedInputTokens: 2, costUsd: 0.5 });
    expect(s.document).toEqual(s.session);
    expect(usageSummary(db, new Date(Date.now() + 60_000).toISOString()).session.inputTokens).toBe(0);
  });

  it('upserts reading state and settings', () => {
    expect(getReadingState(db, DOC_ID)).toBeUndefined();
    putReadingState(db, DOC_ID, { page: 1, scrollFrac: 0.5, zoom: 'page-width', cursor: { page: 1, offset: 3 } });
    putReadingState(db, DOC_ID, { page: 2, scrollFrac: 0.25, zoom: 1.5 });
    expect(getReadingState(db, DOC_ID)).toMatchObject({ page: 2, scrollFrac: 0.25, zoom: 1.5, cursor: null });
    setSetting(db, 'theme', { dark: true });
    setSetting(db, 'theme', { dark: false });
    expect(getSetting(db, 'theme')).toEqual({ dark: false });
  });
});
