// Core types from DESIGN.md section 7.6. Shared by the browser and the server.

export type DocId = string; // SHA-256 hex of the PDF bytes

/** Normalized 0..1 rectangle in PDF user space, unrotated: [x0, y0, x1, y1]. */
export type Rect = [number, number, number, number];

export interface PassageAnchor {
  page: number; // 0-based
  offset: number; // UTF-16 offset in the page's logical text
}

export interface Passage {
  id: string;
  docId: DocId;
  start: PassageAnchor;
  end: PassageAnchor; // exclusive; may be on a later page
  kind: 'sentence' | 'paragraph' | 'selection' | 'region';
  text: string; // de-hyphenated, joined text that goes to the LLM
  quote: { exact: string; prefix: string; suffix: string };
  rects: { page: number; rect: Rect }[];
  segmenterVersion: number;
  quality?: 'low';
}

export type ChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }
  | { type: 'done'; finishReason: 'stop' | 'length' | 'cancelled' | 'error' | 'other' };
