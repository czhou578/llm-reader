import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Document, Passage, StartRunRequest } from '../../src/shared/types.ts';
import { buildContext, estimateTokens, formatContextUsed, sectionPath } from '../../src/server/context/build.ts';
import { DEFINE, EXPLAIN, SYSTEM_PROMPT } from '../../src/server/context/prompts.ts';
import type { StoredMessage } from '../../src/server/db/repo.ts';
import { samplePassage } from './helpers.ts';

const doc: Document = {
  id: 'd'.repeat(64),
  title: 'Learning with Kernels',
  author: 'B. Schölkopf',
  pageCount: 300,
  byteSize: 1,
  addedAt: '2026-01-01T00:00:00.000Z',
  outline: [
    { title: '1 Introduction', page: 10 },
    { title: '2 Kernels', page: 40, children: [{ title: '2.1 Products', page: 42 }, { title: '2.2 The trick', page: 50 }] },
    { title: '3 Risk', page: 80 },
    { title: '4 Regularization', page: 120 },
  ],
};
const passage: Passage = { ...samplePassage(), id: 'p_1', docId: doc.id };
const location = { page: 51, pageLabel: '37' };
const surrounding =
  'Earlier text about feature maps.\n\nThe map is costly. ⟦The kernel trick replaces the explicit map.⟧ It uses inner products.\n\nNext paragraph.';

function ask(preset: StartRunRequest['preset'], question?: string): StartRunRequest {
  const req: StartRunRequest = { preset, context: { surrounding, prevPageText: 'Text of the page before.', location } };
  if (question) req.question = question;
  return req;
}

function stored(role: 'user' | 'assistant', content: string, prompt: string | null = null, id = `m_${Math.random()}`): StoredMessage {
  return { id, threadId: 't', role, content, prompt, status: 'complete', createdAt: '' };
}

describe('context builder', () => {
  it('keeps the system prompt and the preset texts verbatim from DESIGN.md 6.6', () => {
    const design = readFileSync(new URL('../../DESIGN.md', import.meta.url), 'utf8');
    const section = design.slice(design.indexOf('### 6.6 The system prompt'), design.indexOf('### 6.7'));
    const blocks = [...section.matchAll(/```\n([\s\S]*?)\n```/g)].map((m) => m[1]);
    expect(blocks).toEqual([SYSTEM_PROMPT, EXPLAIN, DEFINE]);
  });

  const base = { doc, readerProfile: 'I am a software engineer.', passage, threadLocation: location };

  it('builds turn 1 in the layer order of DESIGN.md 6.3', () => {
    const built = buildContext({ ...base, request: ask('explain'), prior: [] });
    expect(built.system).toBe(SYSTEM_PROMPT);
    expect(built.system).toContain('The surrounding text marks the selection with ⟦ ⟧.');
    expect(built.messages).toHaveLength(1);
    const text = built.userPrompt;
    expect(built.messages[0]!.content).toBe(text);
    const order = ['<document>', '<reader>', '<previous_page>', '<surrounding_text pages="37">', '<request>'].map((t) => text.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain('⟦The kernel trick replaces the explicit map.⟧');
    expect(text).toContain('location: 2 Kernels > 2.2 The trick — page 37 (PDF page 52)');
    expect(text).toContain(`selected passage:\n"""\n${passage.text}\n"""\n${EXPLAIN}\n</request>`);
    expect(text).toMatchSnapshot();
    expect(built.userContent).toBe('Explain');
    expect(built.estimatedTokens).toBe(estimateTokens(SYSTEM_PROMPT + text));
    expect(formatContextUsed(built.contextParts, 2140)).toBe('passage · p. 37 · ±1 paragraph · prev page · 2,140 tok');
  });

  it('uses the Define template and the Free ask template', () => {
    expect(buildContext({ ...base, request: ask('define'), prior: [] }).userPrompt).toContain(`"""\n${DEFINE}\n</request>`);
    const free = buildContext({ ...base, request: ask('ask', 'Why inner products?'), prior: [] });
    expect(free.userPrompt).toContain(
      "Task: Answer the reader's question about the selected passage:\n<question>\nWhy inner products?\n</question>\nLength: at most 200 words, unless the question clearly needs more.",
    );
    expect(free.userContent).toBe('Why inner products?');
    expect(() => buildContext({ ...base, request: ask('ask'), prior: [] })).toThrow(/question/);
  });

  it('resends turn 1 byte for byte in a follow-up', () => {
    const first = buildContext({ ...base, request: ask('explain'), prior: [] });
    const prior = [stored('user', 'Explain', first.userPrompt, 'u1'), stored('assistant', 'It avoids the map.')];
    const follow = buildContext({ ...base, request: ask('ask', 'And the cost?'), prior });
    expect(follow.system).toBe(first.system);
    expect(follow.messages[0]!.content).toBe(first.userPrompt);
    expect(follow.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(follow.messages[1]!.content).toBe('It avoids the map.');
    expect(follow.userPrompt).toBe(
      'Follow-up on the same passage (page 37):\n<question>\nAnd the cost?\n</question>\nLength: at most 150 words, unless the question needs more.',
    );
    expect(follow.userPrompt).not.toContain(passage.text);
    expect(follow.contextParts).toEqual(['follow-up', 'turn 2', 'p. 37']);
    expect(follow.messages).toMatchSnapshot();

    // A preset follow-up sends the template without the passage; a later turn without an answer is dropped.
    const prior2 = [...prior, stored('user', 'And the cost?', follow.userPrompt, 'u2'), stored('assistant', '')];
    const define = buildContext({ ...base, request: ask('define'), prior: prior2 });
    expect(define.messages[0]!.content).toBe(first.userPrompt);
    expect(define.messages).toHaveLength(3);
    expect(define.userPrompt).toBe(`Follow-up on the same passage (page 37):\n${DEFINE}`);
  });

  it('refuses a passage over the hard cap instead of cutting it', () => {
    const long = { ...passage, text: 'word '.repeat(4000) };
    expect(() => buildContext({ ...base, passage: long, request: ask('explain'), prior: [] })).toThrow(/cap/);
  });

  it('finds the section path from the outline', () => {
    expect(sectionPath(doc.outline!, 5)).toBeNull();
    expect(sectionPath(doc.outline!, 45)).toBe('2 Kernels > 2.1 Products');
    expect(sectionPath(doc.outline!, 200)).toBe('4 Regularization');
  });
});
