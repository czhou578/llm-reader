// Shared contract for llm-reader v0. FROZEN during the v0 build: agents extend it only in their own modules.
// See docs/v0-contract.md for the API and module boundaries, and DESIGN.md for the rationale.

export const SEGMENTER_VERSION = 1;

export type DocId = string; // SHA-256 hex of the PDF bytes

/** Normalized 0..1 rectangle in PDF user space, unrotated: [x0, y0, x1, y1]. */
export type Rect = [number, number, number, number];

// ---------- documents ----------

export interface OutlineItem {
  title: string;
  page: number | null; // 0-based page index, null when unresolved
  children?: OutlineItem[];
}

export interface Document {
  id: DocId;
  title: string;
  author?: string | null;
  pageCount: number;
  byteSize: number;
  sourcePath?: string | null; // local file it was opened from, if any
  addedAt: string; // ISO 8601
  pageLabels?: string[] | null; // printed page labels by 0-based index, when the PDF defines them
  outline?: OutlineItem[];
}

export interface LibraryEntry {
  path: string; // absolute path on disk
  name: string; // file name
  byteSize: number;
  mtime: string; // ISO 8601
  docId?: DocId; // set when this file was opened before
  title?: string;
  lastOpenedAt?: string;
}

export interface ReadingState {
  page: number; // 0-based
  scrollFrac: number; // 0..1 within the page
  zoom: number | 'page-width';
  cursor?: PassageAnchor | null;
  updatedAt?: string;
}

// ---------- passages ----------

export interface PassageAnchor {
  page: number; // 0-based
  offset: number; // UTF-16 offset in the page's logical text (PageText.text)
}

export interface PassageInput {
  start: PassageAnchor;
  end: PassageAnchor; // exclusive; may be on a later page
  kind: 'sentence' | 'paragraph' | 'selection' | 'region';
  text: string; // de-hyphenated, joined text that goes to the LLM
  quote: { exact: string; prefix: string; suffix: string }; // ~32 chars of context each side
  rects: { page: number; rect: Rect }[];
  segmenterVersion: number;
  quality?: 'low';
}

export interface Passage extends PassageInput {
  id: string;
  docId: DocId;
}

export interface Location {
  page: number; // 0-based PDF page index
  pageLabel?: string | null; // printed page label, e.g. "142"
  section?: string | null; // nearest outline heading, when known
}

/** What the viewer hands to the shell whenever the staged selection changes. */
export interface StagedSelection {
  passage: PassageInput;
  location: Location;
  /** The containing paragraph plus up to 2 paragraphs before and 1 after, with the passage marked as ⟦…⟧. */
  surrounding: string;
  /** Logical text of the page that holds the passage start. */
  pageText: string;
  /** Logical text of the previous page, when it is segmented already. */
  prevPageText?: string;
}

// ---------- segmenter (src/shared/segment) ----------

export interface CharRun {
  logicalStart: number; // UTF-16 offset in PageText.text
  length: number;
  item: number; // index into getTextContent().items (marked-content entries included in the index space)
  itemStart: number; // UTF-16 offset in items[item].str
  synthetic?: true; // inserted space or join; no source char
}

export interface SkipSpan {
  start: number;
  end: number;
  kind: 'furniture' | 'footnote' | 'margin';
}

export interface PageText {
  page: number; // 0-based
  text: string; // logical text of the page
  charMap: CharRun[];
  paragraphs: [number, number][]; // [start, end) offsets, reading order
  sentences: [number, number][]; // [start, end) offsets, reading order
  skipSpans: SkipSpan[];
  segmenterVersion: number;
  flags?: { lowText?: true; lowQuality?: true; continuesOnNextPage?: true };
}

// ---------- threads, messages, runs ----------

export type PresetId = 'explain' | 'define' | 'ask';
export type Role = 'strong' | 'fast';

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number | null;
}

export type MessageStatus = 'complete' | 'streaming' | 'cancelled' | 'error' | 'interrupted';

export interface Message {
  id: string;
  threadId: string;
  role: 'user' | 'assistant';
  content: string; // user: the question text or the preset instruction summary; assistant: the answer markdown
  preset?: PresetId;
  status: MessageStatus;
  profile?: string;
  model?: string;
  finishReason?: string;
  usage?: Usage;
  contextUsed?: string; // one-line summary, e.g. "passage · p. 142 ±1 paragraph · 2,140 tok"
  createdAt: string;
}

export interface Thread {
  id: string;
  docId: DocId;
  passage: Passage;
  location: Location;
  title: string; // first 80 chars of the passage
  createdAt: string;
  messages: Message[];
}

export interface AskContext {
  surrounding: string;
  pageText?: string;
  prevPageText?: string;
  location: Location;
  focusTerm?: string;
}

export interface CreateThreadRequest {
  passage: PassageInput;
  location: Location;
}

export interface StartRunRequest {
  preset: PresetId;
  question?: string; // required for 'ask'
  context: AskContext;
  role?: Role; // default 'strong'
}

export interface StartRunResponse {
  runId: string;
  messageId: string;
}

/** Events on GET /api/runs/:id/events. Each SSE frame has `id: <seq>` and `event: <type>`; `data` is the JSON below. */
export type RunEvent =
  | { type: 'run.start'; runId: string; messageId: string; profile: string; model: string }
  | { type: 'delta'; text: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'run.end'; finishReason: 'stop' | 'length' | 'cancelled' | 'error' | 'other' }
  | { type: 'error'; code: string; message: string; retryable: boolean; partialKept: boolean };

// ---------- LLM adapter (server side) ----------

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
}

export type ChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }
  | { type: 'done'; finishReason: 'stop' | 'length' | 'cancelled' | 'error' | 'other' };

export type ProviderKind = 'anthropic' | 'openai-compatible' | 'mock';

export interface Pricing {
  input?: number; // USD per million tokens
  cache_read?: number;
  output?: number;
}

export interface ProfileConfig {
  provider: ProviderKind;
  base_url?: string;
  model: string;
  api_key_env?: string;
  max_tokens?: number;
  pricing?: Pricing;
}

export interface AppConfig {
  server: { bind: string; port: number };
  roles: { strong: string; fast: string }; // profile names
  profiles: Record<string, ProfileConfig>;
  storage: { data_dir: string; books_dir: string };
  notes?: { file?: string };
  reader: { profile: string; budget_tokens: number };
}

/** What GET /api/config returns to the browser. Never includes keys. */
export interface ClientConfig {
  roles: { strong: string; fast: string };
  profiles: Record<string, { provider: ProviderKind; model: string; hasKey: boolean }>;
  booksDir: string;
  readerProfile: string;
}

export interface UsageSummary {
  session: { inputTokens: number; outputTokens: number; cachedInputTokens: number; costUsd: number | null };
  document?: { inputTokens: number; outputTokens: number; cachedInputTokens: number; costUsd: number | null };
}
