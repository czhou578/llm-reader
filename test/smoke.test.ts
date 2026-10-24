import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// First-day checks from DESIGN.md section 11: the native and PDF.js pieces must work on this arm64 machine.
describe('platform smoke', () => {
  it('better-sqlite3 loads and runs a query', () => {
    const db = new Database(':memory:');
    expect(db.prepare('select 1 as one').get()).toEqual({ one: 1 });
    db.close();
  });

  it('pdf.js extracts text in Node', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 200]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('Hello llm-reader', { x: 20, y: 100, size: 14, font });
    const bytes = await doc.save();

    const loaded = await pdfjs.getDocument({ data: bytes }).promise;
    const first = await loaded.getPage(1);
    const content = await first.getTextContent();
    const text = content.items.map((item) => ('str' in item ? item.str : '')).join('');
    expect(text).toContain('Hello llm-reader');
  });
});
