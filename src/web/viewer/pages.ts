// Per-page cache of text items and PageText. It also learns running headers and footers across pages.
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PageText } from '../../shared/types.ts';
import { TEXT_CONTENT_PARAMS, analyzePage, type TextItemLike } from '../../shared/segment/index.ts';
import type { PageGeometry } from './geometry.ts';

export interface PageEntry extends PageGeometry {
  page: number;
  pageText: PageText;
  bandKeys: string[];
}

/** A band line that repeats on this many pages becomes a header or footer key. */
const REPEAT_PAGES = 2;

export class PageStore {
  private readonly entries = new Map<number, PageEntry>();
  private readonly inflight = new Map<number, Promise<PageEntry | null>>();
  private readonly keyPages = new Map<string, Set<number>>();
  private readonly headerKeys = new Set<string>();
  private destroyed = false;

  /** Called with the pages whose skip spans changed after the profile learned a new key. */
  onResegment: ((pages: number[]) => void) | null = null;

  constructor(
    private readonly pdf: PDFDocumentProxy,
    private readonly lang: string,
  ) {}

  get pageCount(): number {
    return this.pdf.numPages;
  }

  get(page: number): PageEntry | undefined {
    return this.entries.get(page);
  }

  text(page: number): PageText | undefined {
    return this.entries.get(page)?.pageText;
  }

  /** Segment a page once. Concurrent calls share one promise. Returns null for a bad index or a failure. */
  ensure(page: number): Promise<PageEntry | null> {
    const cached = this.entries.get(page);
    if (cached) return Promise.resolve(cached);
    if (page < 0 || page >= this.pdf.numPages) return Promise.resolve(null);
    let p = this.inflight.get(page);
    if (!p) {
      p = this.load(page).finally(() => this.inflight.delete(page));
      this.inflight.set(page, p);
    }
    return p;
  }

  destroy(): void {
    this.destroyed = true;
    this.entries.clear();
    this.onResegment = null;
  }

  private async load(page: number): Promise<PageEntry | null> {
    try {
      const proxy = await this.pdf.getPage(page + 1);
      const content = await proxy.getTextContent(TEXT_CONTENT_PARAMS);
      if (this.destroyed) return null;
      const items = content.items as TextItemLike[];
      const view = [...proxy.view];
      const analysis = analyzePage({
        page,
        items,
        styles: content.styles,
        viewBox: view,
        lang: this.lang,
        profile: { headerFooterKeys: [...this.headerKeys] },
      });
      const entry: PageEntry = {
        page,
        items,
        styles: content.styles,
        view,
        viewport: proxy.getViewport({ scale: 1 }),
        pageText: analysis.pageText,
        bandKeys: analysis.bandKeys,
      };
      this.entries.set(page, entry);
      this.learn(entry);
      return entry;
    } catch (err) {
      if (!this.destroyed) console.warn(`llm-reader: page ${page + 1} text failed`, err);
      return null;
    }
  }

  private learn(entry: PageEntry): void {
    let added = false;
    for (const key of entry.bandKeys) {
      if (key.length < 3 || this.headerKeys.has(key)) continue;
      let pages = this.keyPages.get(key);
      if (!pages) this.keyPages.set(key, (pages = new Set()));
      pages.add(entry.page);
      if (pages.size >= REPEAT_PAGES) {
        this.headerKeys.add(key);
        added = true;
      }
    }
    if (!added) return;
    // The profile changes skip spans only. The logical text and its offsets stay the same.
    const changed: number[] = [];
    for (const e of this.entries.values()) {
      const next = analyzePage({
        page: e.page,
        items: e.items,
        styles: e.styles,
        viewBox: e.view,
        lang: this.lang,
        profile: { headerFooterKeys: [...this.headerKeys] },
      });
      if (next.pageText.skipSpans.length !== e.pageText.skipSpans.length) changed.push(e.page);
      e.pageText = next.pageText;
      e.bandKeys = next.bandKeys;
    }
    if (changed.length > 0) this.onResegment?.(changed);
  }
}
