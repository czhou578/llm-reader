// PageStore keeps at most maxPages pages, least recently used out, plus the pages that `keep` holds.
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PageStore } from '../../src/web/viewer/pages.ts';

const PAGES = 6;
let pdf: PDFDocumentProxy;

beforeAll(async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < PAGES; p++) {
    const page = doc.addPage([400, 600]);
    page.drawText(`Page ${p + 1} has one sentence. It also has a second one.`, { x: 40, y: 500, size: 12, font });
  }
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdf = (await pdfjs.getDocument({ data: await doc.save(), verbosity: 0 }).promise) as unknown as PDFDocumentProxy;
});

afterAll(async () => {
  await pdf.loadingTask.destroy();
});

async function load(store: PageStore, pages: number[]): Promise<void> {
  for (const p of pages) await store.ensure(p);
}

function cached(store: PageStore): number[] {
  return [...Array(PAGES).keys()].filter((p) => store.get(p) !== undefined);
}

describe('PageStore', () => {
  it('drops the least recently used page above the limit', async () => {
    const store = new PageStore(pdf, 'en', 3);
    await load(store, [0, 1, 2, 3, 4]);
    expect(cached(store)).toEqual([2, 3, 4]);
  });

  it('counts an ensure() of a cached page as a use', async () => {
    const store = new PageStore(pdf, 'en', 3);
    await load(store, [0, 1, 2, 0, 3]);
    expect(cached(store)).toEqual([0, 2, 3]);
  });

  it('keeps the pages that keep() holds', async () => {
    const store = new PageStore(pdf, 'en', 3);
    store.keep = (p) => p === 0;
    await load(store, [0, 1, 2, 3, 4]);
    expect(cached(store)).toEqual([0, 3, 4]);
  });

  it('keeps the new page when keep() holds all the others', async () => {
    const store = new PageStore(pdf, 'en', 3);
    store.keep = (p) => p < 3;
    await load(store, [0, 1, 2, 3]);
    expect(cached(store)).toEqual([0, 1, 2, 3]);
  });

  it('segments a dropped page again with the same text and offsets', async () => {
    const store = new PageStore(pdf, 'en', 2);
    const before = (await store.ensure(0))!.pageText;
    expect(before.text).toContain('Page 1 has one sentence.');
    await load(store, [1, 2]);
    expect(store.get(0)).toBeUndefined();
    const after = (await store.ensure(0))!.pageText;
    expect(after.text).toBe(before.text);
    expect(after.sentences).toEqual(before.sentences);
    expect(after.paragraphs).toEqual(before.paragraphs);
  });
});
