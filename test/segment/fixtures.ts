// Builds one-page PDFs with pdf-lib and runs them through pdf.js getTextContent() and segmentPage().
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { PageText } from '../../src/shared/types.ts';
import { TEXT_CONTENT_PARAMS, segmentPage, type SegmentProfile, type TextItemLike } from '../../src/shared/segment/index.ts';

export interface FixtureLine {
  text: string;
  x?: number;
  y: number; // baseline in PDF user space
  size?: number;
}

export interface Fixture {
  pageText: PageText;
  items: TextItemLike[];
}

export async function segmentFixture(
  lines: FixtureLine[],
  opts: { width?: number; height?: number; profile?: SegmentProfile } = {},
): Promise<Fixture> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([opts.width ?? 400, opts.height ?? 600]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const l of lines) page.drawText(l.text, { x: l.x ?? 40, y: l.y, size: l.size ?? 12, font });
  const bytes = await doc.save();

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loaded = await pdfjs.getDocument({ data: bytes, verbosity: 0 }).promise;
  try {
    const p = await loaded.getPage(1);
    const content = await p.getTextContent(TEXT_CONTENT_PARAMS);
    const items = content.items as TextItemLike[];
    const pageText = segmentPage({ page: 0, items, styles: content.styles, viewBox: p.view, profile: opts.profile });
    return { pageText, items };
  } finally {
    await loaded.loadingTask.destroy();
  }
}

export function spanTexts(pt: PageText, spans: [number, number][]): string[] {
  return spans.map(([a, b]) => pt.text.slice(a, b));
}
