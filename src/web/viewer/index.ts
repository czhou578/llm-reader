// The PDF viewer. It implements the ViewerApi from api.ts, which the shell codes against.
// pdf.js PDFViewer owns the canvas and the text layer. This module owns the overlay, the reading cursor,
// the mouse-selection mapping, and the StagedSelection. It does not import Preact.
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import './viewer.css';
import type { PassageAnchor, PassageInput, ReadingState, Rect, StagedSelection } from '../../shared/types.ts';
import { itemEndToLogical, itemOffsetToLogical, offsetsToItemRanges } from '../../shared/segment/index.ts';
import type { ViewerApi, ViewerEvents, ViewerListener, ViewerOpenOptions } from './api.ts';
import * as cur from './cursor.ts';
import type { CursorState, Level, MoveResult } from './cursor.ts';
import { clientRectToRect, itemRangeRect, mergeRects, nearestBox, rectToPct, unionRect } from './geometry.ts';
import { Overlay } from './overlay.ts';
import { PageStore } from './pages.ts';
import { alignSpans } from './spans.ts';
import { buildStaged, reanchor } from './staging.ts';

type ViewerLib = typeof import('pdfjs-dist/web/pdf_viewer.mjs');
type PDFViewerT = InstanceType<ViewerLib['PDFViewer']>;
type EventBusT = InstanceType<ViewerLib['EventBus']>;
type LinkServiceT = InstanceType<ViewerLib['PDFLinkService']>;
// pdf.js reads `abortSignal` (it stops the viewer's ResizeObserver), but its option type does not list it.
type PDFViewerOptions = ConstructorParameters<ViewerLib['PDFViewer']>[0] & { abortSignal?: AbortSignal };

/** The parts of a pdf.js PDFPageView that the viewer reads. */
interface PageViewLike {
  div: HTMLDivElement;
  textLayer: { div: HTMLDivElement } | null;
}

/** Text-layer spans by item index. pdf.js makes one span per text item, in item order. */
interface SpanMap {
  layer: HTMLElement;
  spans: (HTMLElement | undefined)[];
  itemOf: Map<Element, number>;
}

interface MouseSelection {
  start: PassageAnchor;
  end: PassageAnchor;
  kind: PassageInput['kind'];
}

interface Mark {
  page: number;
  scrollFrac: number;
  cursor: CursorState | null;
  mouse: MouseSelection | null;
}

const NO_TEXT = 'No text layer on this page';
const POSITION_DEBOUNCE_MS = 250;
const SELECTION_DEBOUNCE_MS = 150;
const SCROLL_MS = 120; // comfort-band scroll; DESIGN.md allows at most 150 ms
const BAND_TOP = 0.25;
const BAND_BOTTOM = 0.6;
const MAX_RETRIES = 40;
// Point and key: a pointer move of at least this many pixels aims the next s, w, Space, q, or d. A smaller move,
// such as a bumped mouse, does not count.
const AIM_MIN_MOVE = 12;
// The pointer must be this close (in pixels) to a text span to aim at it.
const AIM_MAX_DISTANCE = 24;

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Find the text node and offset for character `offset` inside an element. */
function textPoint(el: Node, offset: number): { node: Node; offset: number } {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let left = offset;
  let last: Text | null = null;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (left <= n.data.length) return { node: n, offset: left };
    left -= n.data.length;
    last = n;
  }
  return last ? { node: last, offset: last.data.length } : { node: el, offset: 0 };
}

type CaretDocument = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

/** Character offset in a span at a client point: the caret position when the point is on the span, else a proportional guess. */
function charOffsetAt(span: HTMLElement, x: number, y: number, box: DOMRect): number {
  const len = span.textContent?.length ?? 0;
  const doc = document as CaretDocument;
  const pos = doc.caretPositionFromPoint?.(x, y);
  if (pos && span.contains(pos.offsetNode)) return Math.min(offsetIn(span, pos.offsetNode, pos.offset), Math.max(0, len - 1));
  const range = !pos ? doc.caretRangeFromPoint?.(x, y) : null;
  if (range && span.contains(range.startContainer)) return Math.min(offsetIn(span, range.startContainer, range.startOffset), Math.max(0, len - 1));
  if (box.width <= 0 || len === 0) return 0;
  return Math.max(0, Math.min(len - 1, Math.floor(((x - box.left) / box.width) * len)));
}

/** Character offset of a DOM boundary point inside an element. */
function offsetIn(el: Element, node: Node, offset: number): number {
  const r = document.createRange();
  r.setStart(el, 0);
  r.setEnd(node, offset);
  return r.toString().length;
}

export class Viewer implements ViewerApi {
  private readonly listeners = new Map<keyof ViewerEvents, Set<(payload: never) => void>>();
  private lib: ViewerLib | null = null;
  private generation = 0;

  // Per-document state. close() resets all of it.
  private root: HTMLDivElement | null = null;
  private eventBus: EventBusT | null = null;
  private linkService: LinkServiceT | null = null;
  private pdfViewer: PDFViewerT | null = null;
  private loadingTask: PDFDocumentLoadingTask | null = null;
  private store: PageStore | null = null;
  private overlay: Overlay | null = null;
  private labels: string[] | null = null;
  private domAbort: AbortController | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private spanMaps = new Map<number, SpanMap>();
  private cursor: CursorState | null = null;
  private savedSentence: CursorState | null = null; // restored when toggleParagraph goes back to sentence level
  private mouse: MouseSelection | null = null;
  private staged: StagedSelection | null = null;
  private jumpMark: Mark | null = null;
  private visible = { first: -1, last: -1 };
  private noticed = new Set<number>();
  private positionTimer: ReturnType<typeof setTimeout> | null = null;
  private selectionTimer: ReturnType<typeof setTimeout> | null = null;
  private scrollFrame = 0;
  private lastDomSelection = '';
  // Point and key: the last pointer position over the PDF, and the position when a key last used or reset the aim.
  private pointer: { x: number; y: number } | null = null;
  private pointerRest: { x: number; y: number } | null = null;

  constructor(public readonly container: HTMLElement) {
    if (!container.hasAttribute('tabindex')) container.tabIndex = -1;
    container.classList.add('lr-viewer');
  }

  // ---------- events ----------

  on<K extends keyof ViewerEvents>(event: K, fn: ViewerListener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(fn as (payload: never) => void);
    return () => set.delete(fn as (payload: never) => void);
  }

  private emit<K extends keyof ViewerEvents>(event: K, payload: ViewerEvents[K]): void {
    for (const fn of this.listeners.get(event) ?? []) {
      try {
        (fn as ViewerListener<K>)(payload);
      } catch (err) {
        console.error(`llm-reader viewer: "${event}" listener failed`, err);
      }
    }
  }

  // ---------- open and close ----------

  async open(url: string, opts: ViewerOpenOptions = {}): Promise<void> {
    this.close();
    const gen = ++this.generation;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    // pdf_viewer.mjs reads globalThis.pdfjsLib, which the pdfjs-dist import above sets. A dynamic import keeps that order.
    this.lib ??= await import('pdfjs-dist/web/pdf_viewer.mjs');
    if (gen !== this.generation) return;
    const lib = this.lib;

    if (getComputedStyle(this.container).position === 'static') this.container.style.position = 'relative';
    const root = document.createElement('div');
    root.className = 'lr-viewer-root';
    // PDFViewer requires an absolutely positioned container. Inline styles hold before the CSS loads.
    root.style.cssText = 'position:absolute;inset:0;overflow:auto';
    const viewerDiv = document.createElement('div');
    viewerDiv.className = 'pdfViewer';
    root.append(viewerDiv);
    this.container.append(root);
    this.root = root;

    const ac = new AbortController();
    this.domAbort = ac;
    const eventBus = new lib.EventBus();
    const linkService = new lib.PDFLinkService({ eventBus });
    const options: PDFViewerOptions = {
      container: root,
      viewer: viewerDiv,
      eventBus,
      linkService,
      annotationMode: pdfjs.AnnotationMode.ENABLE, // links, no forms
      abortSignal: ac.signal,
    };
    const pdfViewer = new lib.PDFViewer(options);
    linkService.setViewer(pdfViewer);
    this.eventBus = eventBus;
    this.linkService = linkService;
    this.pdfViewer = pdfViewer;
    this.overlay = new Overlay(
      (page) => this.pageView(page)?.div ?? null,
      (page) => this.store?.get(page),
    );
    this.wire(gen, opts.state ?? null);

    // PDF.js 6.4 has no isEvalSupported option. Scripting stays off because no scripting manager is set.
    const task = pdfjs.getDocument({ url, rangeChunkSize: 65536, disableAutoFetch: true });
    this.loadingTask = task;
    let pdf: PDFDocumentProxy;
    try {
      pdf = await task.promise;
    } catch (err) {
      if (gen === this.generation) this.close();
      throw err;
    }
    if (gen !== this.generation) {
      void task.destroy();
      return;
    }
    this.labels = await pdf.getPageLabels().catch(() => null);
    const meta = await pdf.getMetadata().catch(() => null);
    if (gen !== this.generation) return;
    const info = (meta?.info ?? {}) as { Language?: unknown };
    const lang = typeof info.Language === 'string' && info.Language ? info.Language : 'en';
    this.store = new PageStore(pdf, lang);
    this.store.onResegment = () => this.restage(false);
    pdfViewer.setDocument(pdf);
    linkService.setDocument(pdf);
    if (this.labels) pdfViewer.setPageLabels(this.labels);
    this.emit('ready', { pageCount: pdf.numPages });
  }

  close(): void {
    this.generation++;
    const hadSelection = this.staged !== null;
    this.domAbort?.abort();
    this.domAbort = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.positionTimer) clearTimeout(this.positionTimer);
    if (this.selectionTimer) clearTimeout(this.selectionTimer);
    cancelAnimationFrame(this.scrollFrame);
    this.positionTimer = this.selectionTimer = null;
    this.pdfViewer?.setDocument(null);
    this.linkService?.setDocument(null);
    void this.loadingTask?.destroy();
    this.store?.destroy();
    this.root?.remove();
    this.root = null;
    this.eventBus = this.linkService = this.pdfViewer = null;
    this.loadingTask = this.store = this.overlay = null;
    this.labels = null;
    this.spanMaps.clear();
    this.cursor = this.savedSentence = this.mouse = this.staged = this.jumpMark = null;
    this.visible = { first: -1, last: -1 };
    this.noticed.clear();
    this.lastDomSelection = '';
    if (hadSelection) this.emit('selection', null);
  }

  private wire(gen: number, state: ReadingState | null): void {
    const bus = this.eventBus!;
    const root = this.root!;
    const ac = this.domAbort!;
    const live = (): boolean => gen === this.generation;

    bus.on('pagesinit', () => {
      if (!live()) return;
      this.restore(state);
      this.updateVisible();
    });
    bus.on('textlayerrendered', (evt: { pageNumber: number }) => {
      if (live()) void this.onTextLayer(gen, evt.pageNumber - 1);
    });
    bus.on('pagerendered', (evt: { pageNumber: number }) => {
      if (live()) this.overlay?.render(evt.pageNumber - 1);
    });
    bus.on('scalechanging', () => {
      if (!live()) return;
      requestAnimationFrame(() => live() && this.overlay?.renderAll());
      this.schedulePosition();
    });
    bus.on('updateviewarea', () => {
      if (!live()) return;
      this.updateVisible();
      this.schedulePosition();
    });
    root.addEventListener('scroll', () => this.updateVisible(), { passive: true, signal: ac.signal });
    document.addEventListener('selectionchange', () => this.onSelectionChange(), { signal: ac.signal });
    root.addEventListener('pointermove', (ev) => this.onPointerMove(ev), { passive: true, signal: ac.signal });
    root.addEventListener('pointerleave', () => (this.pointer = null), { passive: true, signal: ac.signal });
    root.addEventListener('pointerup', (ev) => (this.pointerRest = { x: ev.clientX, y: ev.clientY }), { passive: true, signal: ac.signal });
    // A triple-click selects the paragraph through onClick. Stop the browser's own triple-click selection.
    root.addEventListener('mousedown', (ev) => ev.detail >= 3 && ev.preventDefault(), { signal: ac.signal });
    root.addEventListener('click', (ev) => this.onClick(ev), { signal: ac.signal });

    let frame = 0;
    this.resizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (live() && this.pdfViewer?.currentScaleValue === 'page-width') this.pdfViewer.currentScaleValue = 'page-width';
      });
    });
    this.resizeObserver.observe(root);
  }

  private restore(state: ReadingState | null): void {
    const v = this.pdfViewer;
    if (!v) return;
    const zoom = state?.zoom ?? 'page-width';
    v.currentScaleValue = typeof zoom === 'number' && zoom > 0 ? String(zoom) : 'page-width';
    if (!state) return;
    this.scrollToPosition(state.page, state.scrollFrac);
    const anchor = state.cursor;
    if (!anchor) return;
    const gen = this.generation;
    void this.store?.ensure(anchor.page).then(() => {
      if (gen !== this.generation || !this.store || this.cursor) return;
      const para = cur.paragraphAt(this.store, anchor);
      if (para) this.setCursor({ level: 'paragraph', from: para, to: para, tint: false }, null);
    });
  }

  // ---------- pages and text layers ----------

  private pageView(page: number): PageViewLike | null {
    const v = this.pdfViewer;
    if (!v || page < 0 || page >= v.pagesCount) return null;
    return (v.getPageView(page) as PageViewLike | undefined) ?? null;
  }

  private async onTextLayer(gen: number, page: number): Promise<void> {
    const entry = await this.store?.ensure(page);
    if (!entry || gen !== this.generation) return;
    this.buildSpanMap(page);
    // Replace approximate rects with precise ones now that the spans exist.
    if (this.staged?.passage.rects.some((r) => r.page === page) || this.cursorTouches(page)) this.restage(false);
    else this.overlay?.render(page);
    if (entry.pageText.paragraphs.length === 0 && page === this.visible.first && !this.noticed.has(page)) {
      this.noticed.add(page);
      this.emit('notice', { text: NO_TEXT });
    }
  }

  private buildSpanMap(page: number): void {
    const entry = this.store?.get(page);
    const layer = this.pageView(page)?.textLayer?.div;
    if (!entry || !layer) return;
    // Leaf spans only: marked-content spans wrap the text spans.
    const spans = [...layer.querySelectorAll<HTMLElement>('span')].filter((el) => el.childElementCount === 0);
    const pairs = alignSpans(entry.items.map((it) => it.str), spans.map((el) => el.textContent ?? ''));
    const map: SpanMap = { layer, spans: [], itemOf: new Map() };
    let wanted = 0;
    let matched = 0;
    pairs.forEach((j, i) => {
      const str = entry.items[i]!.str;
      if (typeof str === 'string' && str !== '') wanted++;
      const el = j >= 0 ? spans[j] : undefined;
      if (!el) return;
      map.spans[i] = el;
      map.itemOf.set(el, i);
      matched++;
    });
    // An unmatched item is a hole: its rects come from the item box. With few matches the layout is too different.
    if (wanted > 0 && matched < wanted / 2) {
      this.spanMaps.delete(page);
      return;
    }
    this.spanMaps.set(page, map);
  }

  /** Rects of [start, end) on a page: DOM ranges over text-layer spans, else item boxes. */
  private rectsFor = (page: number, start: number, end: number): Rect[] => {
    const entry = this.store?.get(page);
    if (!entry) return [];
    const map = this.spanMaps.get(page);
    const pageDiv = this.pageView(page)?.div;
    const live = map && pageDiv && map.layer.isConnected && !map.layer.hidden;
    const out: Rect[] = [];
    for (const r of offsetsToItemRanges(entry.pageText, start, end)) {
      let done = false;
      const span = live ? map.spans[r.item] : undefined;
      if (span && pageDiv) {
        const range = document.createRange();
        const a = textPoint(span, r.start);
        const b = textPoint(span, r.end);
        range.setStart(a.node, a.offset);
        range.setEnd(b.node, b.offset);
        for (const cr of range.getClientRects()) {
          const rect = clientRectToRect(entry, pageDiv, cr);
          if (rect) {
            out.push(rect);
            done = true;
          }
        }
      }
      if (!done) {
        const rect = itemRangeRect(entry, r);
        if (rect) out.push(rect);
      }
    }
    return mergeRects(out);
  };

  /** Screen box (client coordinates) of normalized rects on one page. */
  private screenBox(page: number, rects: Rect[]): { top: number; bottom: number } | null {
    const u = unionRect(rects);
    const div = this.pageView(page)?.div;
    const entry = this.store?.get(page);
    if (!u || !div || !entry) return null;
    const box = div.getBoundingClientRect();
    const pct = rectToPct(entry, u);
    const top = box.top + div.clientTop + (pct.top / 100) * div.clientHeight;
    return { top, bottom: top + (pct.height / 100) * div.clientHeight };
  }

  private updateVisible(): void {
    const v = this.pdfViewer;
    const root = this.root;
    if (!v || !root || v.pagesCount === 0) return;
    const view = root.getBoundingClientRect();
    const n = v.pagesCount;
    const rectOf = (i: number): DOMRect => this.pageView(i)!.div.getBoundingClientRect();
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rectOf(mid).bottom <= view.top) lo = mid + 1;
      else hi = mid;
    }
    const first = lo;
    hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (rectOf(mid).top < view.bottom) lo = mid;
      else hi = mid - 1;
    }
    const last = Math.max(first, lo);
    if (first !== this.visible.first || last !== this.visible.last) {
      this.visible = { first, last };
      this.emit('pages', { first, last });
    }
  }

  // ---------- position ----------

  getState(): ReadingState {
    const v = this.pdfViewer;
    const root = this.root;
    const state: ReadingState = { page: Math.max(0, this.visible.first), scrollFrac: 0, zoom: 'page-width' };
    if (!v || !root) return state;
    state.zoom = v.currentScaleValue === 'page-width' ? 'page-width' : v.currentScale;
    const div = this.pageView(state.page)?.div;
    if (div) {
      const box = div.getBoundingClientRect();
      const top = root.getBoundingClientRect().top;
      state.scrollFrac = box.height > 0 ? Math.min(1, Math.max(0, (top - box.top) / box.height)) : 0;
    }
    state.cursor = this.cursor?.from ?? this.mouse?.start ?? null;
    return state;
  }

  private schedulePosition(): void {
    if (this.positionTimer) clearTimeout(this.positionTimer);
    const gen = this.generation;
    this.positionTimer = setTimeout(() => {
      this.positionTimer = null;
      if (gen === this.generation && this.pdfViewer) this.emit('position', this.getState());
    }, POSITION_DEBOUNCE_MS);
  }

  private scrollToPosition(page: number, frac: number): void {
    const root = this.root;
    const div = this.pageView(page)?.div;
    if (!root || !div) return;
    const box = div.getBoundingClientRect();
    root.scrollTop += box.top - root.getBoundingClientRect().top + Math.min(1, Math.max(0, frac)) * box.height;
  }

  private animateScroll(target: number): void {
    const root = this.root;
    if (!root) return;
    cancelAnimationFrame(this.scrollFrame);
    const from = root.scrollTop;
    const max = root.scrollHeight - root.clientHeight;
    const to = Math.max(0, Math.min(max, target));
    if (Math.abs(to - from) < 1) return;
    if (prefersReducedMotion()) {
      root.scrollTop = to;
      return;
    }
    const t0 = performance.now();
    const tick = (now: number): void => {
      const t = Math.min(1, (now - t0) / SCROLL_MS);
      root.scrollTop = from + (to - from) * (1 - (1 - t) ** 3);
      if (t < 1) this.scrollFrame = requestAnimationFrame(tick);
    };
    this.scrollFrame = requestAnimationFrame(tick);
  }

  /** Scroll only when the unit top leaves the comfort band (25-60 % of the viewport). */
  private keepInBand(dir: -1 | 0 | 1): void {
    const root = this.root;
    const rects = this.staged?.passage.rects;
    if (!root || !rects || rects.length === 0) return;
    const page = rects[0]!.page;
    const box = this.screenBox(page, rects.filter((r) => r.page === page).map((r) => r.rect));
    if (!box) return;
    const h = root.clientHeight;
    const top = box.top - root.getBoundingClientRect().top;
    if (top >= BAND_TOP * h && top <= BAND_BOTTOM * h) return;
    // Going back, put the unit bottom at the band bottom when it fits, so the next step back does not scroll.
    const height = box.bottom - box.top;
    const target = dir < 0 ? Math.max(BAND_TOP * h, BAND_BOTTOM * h - height) : BAND_TOP * h;
    this.animateScroll(root.scrollTop + top - target);
  }

  goToPage(page: number): void {
    const v = this.pdfViewer;
    if (!v || v.pagesCount === 0) return;
    this.recordJump();
    v.currentPageNumber = Math.max(1, Math.min(v.pagesCount, Math.round(page) + 1));
    this.schedulePosition();
  }

  scrollBy(lines: number): void {
    const root = this.root;
    const v = this.pdfViewer;
    if (!root || !v) return;
    // One line is about 14 pt of text at the current zoom (1 pt = 4/3 CSS px).
    root.scrollTop += lines * 14 * (4 / 3) * v.currentScale;
    this.schedulePosition();
  }

  zoomIn(): void {
    this.pdfViewer?.increaseScale();
    this.schedulePosition();
  }

  zoomOut(): void {
    this.pdfViewer?.decreaseScale();
    this.schedulePosition();
  }

  // ---------- jump list ----------

  private currentMark(): Mark {
    const s = this.getState();
    return { page: s.page, scrollFrac: s.scrollFrac, cursor: this.cursor, mouse: this.mouse };
  }

  private recordJump(): void {
    if (this.pdfViewer) this.jumpMark = this.currentMark();
  }

  jumpBack(): void {
    const mark = this.jumpMark;
    if (!mark || !this.pdfViewer) return;
    this.jumpMark = this.currentMark();
    cancelAnimationFrame(this.scrollFrame);
    this.scrollToPosition(mark.page, mark.scrollFrac);
    this.cursor = mark.cursor;
    this.mouse = mark.mouse;
    this.restage(true);
    this.schedulePosition();
  }

  // ---------- reading cursor ----------

  private cursorTouches(page: number): boolean {
    const c = this.cursor;
    return !!c && page >= c.from.page && page <= c.to.page;
  }

  /** True when any part of the cursor unit is inside the viewport. */
  private cursorOnScreen(): boolean {
    const c = this.cursor;
    const root = this.root;
    if (!c || !root || !this.store) return false;
    const range = cur.stateRange(this.store, c);
    if (!range) return false;
    const view = root.getBoundingClientRect();
    for (let p = range.start.page; p <= range.end.page; p++) {
      const pt = this.store.text(p);
      if (!pt) continue;
      const a = p === range.start.page ? range.start.offset : 0;
      const b = p === range.end.page ? range.end.offset : pt.text.length;
      const box = this.screenBox(p, this.rectsFor(p, a, b));
      if (box && box.bottom > view.top && box.top < view.bottom) return true;
    }
    return false;
  }

  /** The first fully visible paragraph, else the first paragraph that is partly visible. */
  private firstVisibleParagraph(): PassageAnchor | { need: number } | null {
    const root = this.root;
    const store = this.store;
    if (!root || !store) return null;
    this.updateVisible();
    const { first, last } = this.visible;
    if (first < 0) return null;
    const view = root.getBoundingClientRect();
    let partial: PassageAnchor | null = null;
    for (let p = first; p <= last; p++) {
      const pt = store.text(p);
      if (!pt) return { need: p };
      for (const [a, b] of pt.paragraphs) {
        const box = this.screenBox(p, this.rectsFor(p, a, b));
        if (!box) continue;
        if (box.top >= view.top && box.bottom <= view.bottom) return { page: p, offset: a };
        if (!partial && box.bottom > view.top && box.top < view.bottom) partial = { page: p, offset: a };
      }
    }
    return partial;
  }

  /** Snap rule: put the cursor on the first fully visible paragraph. The old position goes to the jump list. */
  private snap(level: Level, retries = 0): boolean {
    const store = this.store;
    if (!store) return false;
    const hit = this.firstVisibleParagraph();
    if (hit && 'need' in hit) {
      const gen = this.generation;
      void store.ensure(hit.need).then((e) => {
        if (gen === this.generation && e && retries < MAX_RETRIES) this.snap(level, retries + 1);
      });
      return true;
    }
    if (!hit) {
      this.emit('notice', { text: NO_TEXT });
      return false;
    }
    if (this.cursor) this.recordJump();
    let state: CursorState = { level: 'paragraph', from: hit, to: hit, tint: false };
    if (level === 'sentence') {
      const r = cur.nextSentence(store, state);
      if (r && 'state' in r) state = r.state;
    }
    this.setCursor(cur.joinAcrossBreak(store, state), 0);
    return true;
  }

  /** Run one cursor operation. It segments pages on demand and retries. */
  private move(op: (src: PageStore, s: CursorState) => MoveResult, snapLevel: Level | null, dir: -1 | 1, retries = 0): boolean {
    const store = this.store;
    if (!store || !this.pdfViewer) return false;
    if (snapLevel && retries === 0 && !this.mouse && !this.cursorOnScreen()) return this.snap(snapLevel);
    const base = this.mouseAsCursor() ?? this.cursor;
    if (!base) return snapLevel ? this.snap(snapLevel) : false;
    const r = op(store, base);
    if (r === null) {
      const pt = store.text(base.to.page);
      if (pt && pt.paragraphs.length === 0) this.emit('notice', { text: NO_TEXT });
      return false;
    }
    if ('need' in r) {
      if (retries >= MAX_RETRIES) return false;
      const gen = this.generation;
      void store.ensure(r.need).then((e) => {
        if (gen !== this.generation) return;
        if (e) this.move(op, snapLevel, dir, retries + 1);
        else this.emit('notice', { text: NO_TEXT });
      });
      return true;
    }
    this.setCursor(r.state, dir);
    return true;
  }

  /** A mouse selection as a sentence range, so extend and shrink work on it. */
  private mouseAsCursor(): CursorState | null {
    const m = this.mouse;
    const store = this.store;
    if (!m || !store) return null;
    const from = cur.sentenceAt(store, m.start);
    const to = cur.sentenceAt(store, { page: m.end.page, offset: Math.max(0, m.end.offset - 1) });
    if (!from) return null;
    return { level: 'sentence', from, to: to ?? from, tint: false };
  }

  private setCursor(state: CursorState, dir: -1 | 0 | 1 | null): void {
    this.cursor = state;
    if (this.mouse) {
      this.mouse = null;
      this.clearDomSelection();
    }
    this.restage(true);
    if (dir !== null) this.keepInBand(dir);
    this.schedulePosition();
    // Segment the neighbor pages early, so a move across the page break needs no wait.
    void this.store?.ensure(state.to.page + 1);
    void this.store?.ensure(state.from.page - 1);
  }

  // A movement key first checks the aim: after a pointer move, it acts on the text under the pointer.
  nextParagraph(): boolean {
    return this.aimed('paragraph') || this.move(cur.nextParagraph, 'paragraph', 1);
  }

  prevParagraph(): boolean {
    return this.aimed('paragraph') || this.move(cur.prevParagraph, 'paragraph', -1);
  }

  nextSentence(): boolean {
    return this.aimed('sentence') || this.move(cur.nextSentence, 'sentence', 1);
  }

  prevSentence(): boolean {
    return this.aimed('sentence') || this.move(cur.prevSentence, 'sentence', -1);
  }

  extendSelection(): boolean {
    const a = this.takeAim();
    const store = this.store;
    if (a && store) {
      const state = cur.extendTo(store, this.mouseAsCursor() ?? this.cursor, a);
      if (state) {
        this.setCursor(state, null);
        return true;
      }
    }
    return this.move(cur.extend, null, 1);
  }

  shrinkSelection(): boolean {
    this.takeAim(); // any cursor key resets the aim
    return this.move(cur.shrink, null, -1);
  }

  // ---------- point and key, click ----------

  private onPointerMove(ev: PointerEvent): void {
    const p = { x: ev.clientX, y: ev.clientY };
    this.pointer = p;
    // The first move and a drag set the rest point, so only a free move aims the next key.
    if (!this.pointerRest || ev.buttons !== 0) this.pointerRest = p;
  }

  /** The anchor under the pointer when the pointer moved since the last cursor key, else null. Always resets the aim. */
  private takeAim(): PassageAnchor | null {
    const p = this.pointer;
    const rest = this.pointerRest;
    if (p) this.pointerRest = p;
    if (!p || !rest || Math.hypot(p.x - rest.x, p.y - rest.y) < AIM_MIN_MOVE) return null;
    return this.anchorAtPoint(p.x, p.y);
  }

  /** Put the cursor on the sentence or paragraph under the pointer, when the pointer aims. */
  private aimed(level: Level): boolean {
    const a = this.takeAim();
    const state = a && this.store ? cur.placeAt(this.store, level, a) : null;
    if (!state) return false;
    this.jumpTo(state);
    return true;
  }

  /** Move the cursor without a scroll: the target is under the pointer already. The old place goes to the jump list. */
  private jumpTo(state: CursorState): void {
    if (this.cursor || this.mouse) this.recordJump();
    this.setCursor(state, null);
  }

  /** A click selects the sentence under the pointer. A triple-click selects its paragraph. */
  private onClick(ev: MouseEvent): void {
    if (ev.button !== 0 || ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey) return;
    if (ev.detail !== 1 && ev.detail !== 3) return; // a double-click selects a word through the DOM selection
    if ((ev.target as Element | null)?.closest('a, .annotationLayer')) return; // links keep working
    this.pointerRest = { x: ev.clientX, y: ev.clientY };
    // A click at the end of a drag leaves a selection; readDomSelection stages it.
    if (ev.detail === 1 && document.getSelection()?.isCollapsed === false) return;
    const a = this.anchorAtPoint(ev.clientX, ev.clientY);
    const state = a && this.store ? cur.placeAt(this.store, ev.detail === 3 ? 'paragraph' : 'sentence', a) : null;
    if (!state) return;
    if (ev.detail === 3) {
      this.clearDomSelection();
      state.tint = true; // an explicit paragraph selection, as with toggleParagraph
    }
    this.jumpTo(state);
  }

  /** The logical position at a client point: the text span there, or the nearest span on the same line of that page. */
  private anchorAtPoint(x: number, y: number): PassageAnchor | null {
    const store = this.store;
    if (!store) return null;
    for (const [page, map] of this.spanMaps) {
      if (!map.layer.isConnected || map.layer.hidden) continue;
      const box = map.layer.getBoundingClientRect();
      if (x < box.left || x > box.right || y < box.top || y > box.bottom) continue;
      const pt = store.text(page);
      if (!pt) return null;
      const boxes = map.spans.map((s) => s?.getBoundingClientRect());
      const item = nearestBox(boxes, x, y, AIM_MAX_DISTANCE);
      const span = map.spans[item];
      const r = boxes[item];
      if (!span || !r) return null;
      const off = charOffsetAt(span, x, y, r);
      const logical = itemOffsetToLogical(pt, item, off) ?? (off > 0 ? itemOffsetToLogical(pt, item, off - 1) : null);
      return logical === null ? null : { page, offset: logical };
    }
    return null;
  }

  toggleParagraph(): void {
    this.takeAim(); // any cursor key resets the aim
    const store = this.store;
    if (!store) return;
    const base = this.mouseAsCursor() ?? this.cursor;
    if (!base) {
      this.snap('paragraph');
      return;
    }
    if (base.level === 'sentence') {
      const from = cur.paragraphAt(store, base.from);
      const to = cur.paragraphAt(store, base.to);
      if (!from || !to) return;
      this.savedSentence = base;
      this.setCursor({ level: 'paragraph', from, to, tint: true }, 0);
      return;
    }
    const saved = this.savedSentence;
    const range = cur.stateRange(store, base);
    const inside =
      saved && range && saved.from.page === range.start.page && saved.from.offset >= range.start.offset &&
      (saved.from.page < range.end.page || saved.from.offset < range.end.offset);
    if (saved && inside) {
      this.setCursor(saved, 0);
      return;
    }
    const r = cur.nextSentence(store, base);
    if (r && 'state' in r) this.setCursor(r.state, 0);
  }

  collapseSelection(): void {
    this.takeAim(); // any cursor key resets the aim
    const store = this.store;
    if (!store) return;
    let changed = false;
    if (this.mouse) {
      this.mouse = null;
      this.clearDomSelection();
      changed = true;
    }
    const c = this.cursor;
    if (c?.level === 'sentence' && !cur.sameAnchor(c.from, c.to)) {
      this.cursor = { ...c, to: c.from };
      changed = true;
    } else if (c?.level === 'paragraph' && c.tint) {
      const r = cur.nextSentence(store, c);
      const saved = this.savedSentence;
      this.cursor = saved ? { ...saved, to: saved.from } : r && 'state' in r ? r.state : c;
      changed = true;
    }
    if (changed) {
      this.restage(false);
      this.schedulePosition();
    }
  }

  // ---------- staged selection ----------

  getStaged(): StagedSelection | null {
    return this.staged;
  }

  stage(passage: PassageInput): void {
    const store = this.store;
    if (!store) return;
    const gen = this.generation;
    const pages: Promise<unknown>[] = [];
    for (let p = passage.start.page; p <= passage.end.page && p - passage.start.page < 10; p++) pages.push(store.ensure(p));
    void Promise.all(pages).then(() => {
      if (gen !== this.generation) return;
      const { start, end } = reanchor(store, passage);
      this.recordJump();
      const sentence = cur.sentenceAt(store, start);
      this.cursor = sentence ? { level: 'sentence', from: sentence, to: sentence, tint: false } : this.cursor;
      this.mouse = { start, end, kind: passage.kind };
      this.restage(true);
      // Without rects there is no box to bring into the band, so show the page top.
      if (this.staged?.passage.rects.length) this.keepInBand(0);
      else if (this.pdfViewer) this.pdfViewer.currentPageNumber = start.page + 1;
      this.schedulePosition();
    });
  }

  /** Rebuild the staged selection and the overlay. Emit `selection` when `emit` is true. */
  private restage(emit: boolean): void {
    const store = this.store;
    if (!store || !this.overlay) return;
    let range: { start: PassageAnchor; end: PassageAnchor } | null = null;
    let kind: PassageInput['kind'] = 'sentence';
    if (this.mouse) {
      range = this.mouse;
      kind = this.mouse.kind;
    } else if (this.cursor) {
      range = cur.stateRange(store, this.cursor);
      kind = this.cursor.level;
    }
    const before = this.staged;
    this.staged = range ? buildStaged(store, this.labels, range.start, range.end, kind, this.rectsFor) : null;
    const c = this.cursor;
    this.overlay.setSelection(
      this.staged
        ? {
            rects: this.staged.passage.rects,
            tint: !!this.mouse || c?.level === 'sentence' || !!c?.tint,
            bar: !this.mouse && c?.level === 'paragraph',
          }
        : null,
    );
    if (emit || (before === null) !== (this.staged === null)) this.emit('selection', this.staged);
  }

  // ---------- mouse selection ----------

  private onSelectionChange(): void {
    if (this.selectionTimer) clearTimeout(this.selectionTimer);
    this.selectionTimer = setTimeout(() => {
      this.selectionTimer = null;
      this.readDomSelection();
    }, SELECTION_DEBOUNCE_MS);
  }

  private clearDomSelection(): void {
    const sel = document.getSelection();
    if (sel && sel.rangeCount > 0 && this.root?.contains(sel.getRangeAt(0).commonAncestorContainer)) sel.removeAllRanges();
    this.lastDomSelection = '';
  }

  private readDomSelection(): void {
    const sel = document.getSelection();
    const root = this.root;
    const store = this.store;
    if (!sel || !root || !store || sel.rangeCount === 0 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return;

    let start: PassageAnchor | null = null;
    let end: PassageAnchor | null = null;
    for (const page of [...this.spanMaps.keys()].sort((a, b) => a - b)) {
      const map = this.spanMaps.get(page)!;
      const pt = store.text(page);
      if (!pt || !map.layer.isConnected || !range.intersectsNode(map.layer)) continue;
      map.spans.forEach((span, item) => {
        if (!span || !range.intersectsNode(span)) return;
        const len = span.textContent?.length ?? 0;
        const a = span.contains(range.startContainer) ? offsetIn(span, range.startContainer, range.startOffset) : 0;
        const b = span.contains(range.endContainer) ? offsetIn(span, range.endContainer, range.endOffset) : len;
        if (b <= a) return;
        const la = itemOffsetToLogical(pt, item, a);
        const lb = itemEndToLogical(pt, item, b);
        if (la === null || lb === null || lb <= la) return;
        if (!start) start = { page, offset: la };
        end = { page, offset: lb };
      });
    }
    let s = start as PassageAnchor | null;
    let e = end as PassageAnchor | null;
    if (!s || !e) return;
    // Drop white space at the edges, so the quote starts and ends on a character the user sees.
    const st = store.text(s.page)!.text;
    const et = store.text(e.page)!.text;
    let a = s.offset;
    let b = e.offset;
    while (a < st.length && /\s/.test(st[a]!) && (s.page !== e.page || a < b)) a++;
    while (b > 0 && /\s/.test(et[b - 1]!) && (s.page !== e.page || b > a)) b--;
    if (s.page === e.page && b <= a) return;
    s = { page: s.page, offset: a };
    e = { page: e.page, offset: b };
    const key = `${s.page}:${s.offset}-${e.page}:${e.offset}`;
    if (key === this.lastDomSelection) return;
    this.lastDomSelection = key;
    const sentence = cur.sentenceAt(store, s);
    if (sentence) this.cursor = { level: 'sentence', from: sentence, to: sentence, tint: false };
    this.savedSentence = null;
    this.mouse = { start: s, end: e, kind: 'selection' };
    this.restage(true);
    this.schedulePosition();
  }

  // ---------- anchors and focus ----------

  setAnchors(passages: PassageInput[]): void {
    const byPage = new Map<number, Rect[]>();
    for (const p of passages) {
      for (const { page, rect } of p.rects) {
        const list = byPage.get(page) ?? [];
        list.push(rect);
        byPage.set(page, list);
      }
    }
    this.overlay?.setAnchors(byPage);
  }

  focus(): void {
    this.container.focus({ preventScroll: true });
  }
}
