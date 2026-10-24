import type { OutlineItem } from '../../shared/types.ts';

// PDF metadata in Node with the legacy PDF.js build (verified in test/smoke.test.ts).

export interface PdfMeta {
  title: string | null; // metadata title, else the outline root; null when neither exists
  author: string | null;
  pageCount: number;
  pageLabels: string[] | null;
  outline: OutlineItem[];
}

const MAX_OUTLINE_ITEMS = 5000;

type RawOutlineNode = { title: string; dest: string | unknown[] | null; items: RawOutlineNode[] };

export function isPdf(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1');
  return head.includes('%PDF-');
}

export async function readPdfMeta(bytes: Uint8Array): Promise<PdfMeta> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // PDF.js takes ownership of the buffer it gets, so pass a copy.
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    verbosity: 0,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
  });
  const doc = await task.promise;
  try {
    const [meta, labels, rawOutline] = await Promise.all([
      doc.getMetadata().catch(() => null),
      doc.getPageLabels().catch(() => null),
      doc.getOutline().catch(() => null),
    ]);
    const info = (meta?.info ?? {}) as Record<string, unknown>;
    const xmpTitle = meta?.metadata?.get('dc:title');
    let budget = MAX_OUTLINE_ITEMS;
    const resolveDest = async (dest: RawOutlineNode['dest']): Promise<number | null> => {
      try {
        const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
        if (!Array.isArray(explicit) || explicit.length === 0) return null;
        const target = explicit[0] as unknown;
        if (typeof target === 'number') return target; // some writers store a 0-based page index
        if (target && typeof target === 'object' && 'num' in target) {
          return await doc.getPageIndex(target as Parameters<typeof doc.getPageIndex>[0]);
        }
      } catch {
        // An unresolved destination keeps page null.
      }
      return null;
    };
    const walk = async (nodes: RawOutlineNode[]): Promise<OutlineItem[]> => {
      const kept = nodes.slice(0, Math.max(0, budget));
      budget -= kept.length;
      return Promise.all(
        kept.map(async (n) => {
          const item: OutlineItem = { title: cleanText(n.title) ?? '', page: await resolveDest(n.dest) };
          if (n.items?.length) item.children = await walk(n.items);
          return item;
        }),
      );
    };
    const outline = rawOutline ? await walk(rawOutline as RawOutlineNode[]) : [];
    const title =
      cleanText(info['Title']) ?? cleanText(xmpTitle) ?? (outline.length === 1 ? cleanText(outline[0]!.title) : null);
    return {
      title,
      author: cleanText(info['Author']),
      pageCount: doc.numPages,
      pageLabels: labels && labels.length === doc.numPages ? labels : null,
      outline,
    };
  } finally {
    await task.destroy();
  }
}

function cleanText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  if (!s || /^untitled$/i.test(s)) return null;
  return s;
}
