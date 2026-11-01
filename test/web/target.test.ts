import { describe, expect, it } from 'vitest';
import type { PassageInput, StagedSelection, Thread } from '../../src/shared/types.ts';
import {
  chooseTarget,
  isDuplicate,
  latestThread,
  passageKey,
  samePassage,
  stagedSummary,
  targetLabel,
} from '../../src/web/app/target.ts';
import { filterEntries } from '../../src/web/library/filter.ts';
import { resolvePage } from '../../src/web/app/palette.ts';
import { threadToMarkdown } from '../../src/web/chat/export.ts';

function passage(page: number, start: number, end: number, text = `text ${page}:${start}`): PassageInput {
  return {
    start: { page, offset: start },
    end: { page, offset: end },
    kind: 'sentence',
    text,
    quote: { exact: text, prefix: '', suffix: '' },
    rects: [],
    segmenterVersion: 1,
  };
}

function thread(id: string, p: PassageInput, createdAt: string): Thread {
  return {
    id,
    docId: 'doc',
    passage: { ...p, id: `p-${id}`, docId: 'doc' },
    location: { page: p.start.page, pageLabel: String(p.start.page + 1) },
    title: p.text.slice(0, 80),
    createdAt,
    messages: [],
  };
}

describe('follow-up rule', () => {
  const a = passage(4, 10, 50, 'In the canonical ensemble the system exchanges energy.');
  const b = passage(4, 51, 90, 'The partition function Z then sums the states.');
  const threads = [thread('t1', a, '2026-10-23T10:00:00Z'), thread('t2', b, '2026-10-23T10:05:00Z')];

  it('sends to the latest thread when the staged passage is the same', () => {
    const target = chooseTarget(passage(4, 51, 90, b.text), threads);
    expect(target.kind).toBe('follow-up');
    if (target.kind === 'follow-up') {
      expect(target.thread.id).toBe('t2');
      expect(target.number).toBe(2);
    }
    expect(targetLabel(target)).toBe('Follow-up #2');
  });

  it('starts a new thread when the passage equals an older thread only', () => {
    expect(chooseTarget(a, threads)).toEqual({ kind: 'new' });
  });

  it('starts a new thread when the start, the end, or the text differs', () => {
    expect(chooseTarget(passage(4, 51, 91, b.text), threads).kind).toBe('new');
    expect(chooseTarget(passage(4, 52, 90, b.text), threads).kind).toBe('new');
    expect(chooseTarget(passage(4, 51, 90, 'other text'), threads).kind).toBe('new');
    expect(chooseTarget(passage(5, 51, 90, b.text), threads).kind).toBe('new');
  });

  it('starts a new thread with no threads or no staged passage', () => {
    expect(chooseTarget(a, []).kind).toBe('new');
    expect(chooseTarget(null, threads).kind).toBe('new');
    expect(targetLabel({ kind: 'new' })).toBe('New thread');
  });

  it('picks the latest thread by createdAt', () => {
    const out = [threads[1]!, threads[0]!];
    expect(latestThread(out)?.id).toBe('t2');
    expect(samePassage(a, { ...a })).toBe(true);
  });
});

describe('duplicate guard', () => {
  const key = passageKey(passage(1, 0, 10));
  it('ignores the same preset on the same passage within 2 s', () => {
    const last = { preset: 'explain' as const, key, at: 1000 };
    expect(isDuplicate(last, { preset: 'explain', key, at: 2999 })).toBe(true);
    expect(isDuplicate(last, { preset: 'explain', key, at: 3000 })).toBe(false);
    expect(isDuplicate(last, { preset: 'define', key, at: 1500 })).toBe(false);
    expect(isDuplicate(last, { preset: 'explain', key: passageKey(passage(1, 11, 20)), at: 1500 })).toBe(false);
    expect(isDuplicate(null, { preset: 'explain', key, at: 1500 })).toBe(false);
  });
});

describe('status line summary', () => {
  it('shows level, sentences, words, and page label', () => {
    const s: StagedSelection = {
      passage: passage(41, 0, 40, 'The system exchanges energy with a reservoir at a fixed temperature.'),
      location: { page: 41, pageLabel: '42' },
      surrounding: '',
      pageText: '',
    };
    expect(stagedSummary(s)).toBe('Sentence · 1 sentence · 11 words · Page 42');
  });
});

describe('library filter and palette page', () => {
  const entries = [
    { path: '/b/stat-mech.pdf', name: 'stat-mech.pdf', byteSize: 1, mtime: '', title: 'Statistical Mechanics' },
    { path: '/b/linear.pdf', name: 'linear.pdf', byteSize: 1, mtime: '' },
  ];
  it('filters on the name and the title', () => {
    expect(filterEntries(entries, 'stat mech').map((e) => e.name)).toEqual(['stat-mech.pdf']);
    expect(filterEntries(entries, 'MECHANICS').length).toBe(1);
    expect(filterEntries(entries, 'lin').map((e) => e.name)).toEqual(['linear.pdf']);
    expect(filterEntries(entries, '').length).toBe(2);
  });
  it('resolves a page by label first, then by number', () => {
    expect(resolvePage('iv', ['i', 'ii', 'iii', 'iv', '1', '2'], 6)).toBe(3);
    expect(resolvePage('2', ['i', 'ii', 'iii', 'iv', '1', '2'], 6)).toBe(5);
    expect(resolvePage('3', null, 6)).toBe(2);
    expect(resolvePage('9', null, 6)).toBeNull();
  });
});

describe('thread export', () => {
  it('writes the passage as a quote and the answers', () => {
    const t = thread('t1', passage(41, 0, 10, 'A passage.'), '2026-10-23T10:00:00Z');
    t.messages = [
      { id: 'm1', threadId: 't1', role: 'user', content: 'Explain the passage', preset: 'explain', status: 'complete', createdAt: '' },
      { id: 'm2', threadId: 't1', role: 'assistant', content: 'It means X.', status: 'complete', createdAt: '' },
      { id: 'm3', threadId: 't1', role: 'user', content: 'Why?', preset: 'ask', status: 'complete', createdAt: '' },
    ];
    expect(threadToMarkdown(t, 3, 'Book')).toBe('## #3 · p. 42 · Book\n\n> A passage.\n\n**Explain**\n\nIt means X.\n\n**Q:** Why?\n');
  });
});
