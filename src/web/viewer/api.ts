// Viewer interface. FROZEN during the v0 build. The shell (src/web/app) codes against this; the viewer implements it.
import type { PassageInput, ReadingState, StagedSelection } from '../../shared/types.ts';

export interface ViewerEvents {
  /** Document loaded; pages are being rendered lazily. */
  ready: { pageCount: number };
  /** The staged selection changed. null when the selection was cleared. */
  selection: StagedSelection | null;
  /** The reading position changed (cursor move, scroll, zoom). Emitted at most a few times per second. */
  position: ReadingState;
  /** The visible page range changed. */
  pages: { first: number; last: number };
  /** Something the status line should show for a moment, e.g. "No text layer on this page". */
  notice: { text: string };
}

export type ViewerListener<K extends keyof ViewerEvents> = (payload: ViewerEvents[K]) => void;

export interface ViewerOpenOptions {
  state?: ReadingState | null; // restore position and zoom
}

export interface ViewerApi {
  /** Load a PDF from a URL (the server's /api/docs/:id/file, which supports Range requests). */
  open(url: string, opts?: ViewerOpenOptions): Promise<void>;
  close(): void;

  on<K extends keyof ViewerEvents>(event: K, fn: ViewerListener<K>): () => void;

  // Reading cursor (DESIGN.md 5.2). Each returns false when it could not move.
  nextParagraph(): boolean;
  prevParagraph(): boolean;
  nextSentence(): boolean;
  prevSentence(): boolean;
  extendSelection(): boolean; // add the next sentence
  shrinkSelection(): boolean; // remove the last sentence, or add the previous one when only one is selected
  toggleParagraph(): void; // sentence <-> whole paragraph
  collapseSelection(): void; // back to one sentence at the cursor; also clears a mouse selection

  /** Current staged selection, or null. */
  getStaged(): StagedSelection | null;
  /** Stage a passage programmatically (e.g. when the user jumps to a thread). */
  stage(passage: PassageInput): void;

  // Position
  jumpBack(): void; // toggle between the reading position and the last excursion
  goToPage(page: number): void;
  scrollBy(lines: number): void; // free scroll, cursor does not move
  zoomIn(): void;
  zoomOut(): void;
  getState(): ReadingState;

  /** Draw faint underlines for passages that have threads. Optional in v0; may be a no-op. */
  setAnchors(passages: PassageInput[]): void;

  focus(): void;
}
