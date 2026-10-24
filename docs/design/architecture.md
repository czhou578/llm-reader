> **Research appendix.** This file holds the full detail behind one area of [DESIGN.md](../../DESIGN.md).
> Where this file and DESIGN.md differ on a key, a phase, or a preset list, DESIGN.md wins.

# Technical architecture

This section describes how llm-reader is built. It does not define the keymap or the prompt and context strategy. Other sections own those topics. This section only supplies the hooks that they need: a command registry, a reading cursor, a passage type, and a chat adapter.

## Summary of decisions

| Topic | Decision |
|---|---|
| Form factor (MVP) | Local web app: one Node process on `127.0.0.1` serves the API and a browser SPA. |
| Later form factors | MV3 browser extension (for PDFs behind login), then an optional desktop wrapper. Both reuse the same SPA bundle. |
| PDF engine | PDF.js (`pdfjs-dist`), with its `PDFViewer` component for lazy page rendering and our own overlay layer for highlights. |
| Text segmentation | One shared TypeScript module. It runs in the browser for visible pages and in Node for background whole-document extraction. |
| Online PDFs | A server-side fetch with content sniffing, a content-addressed cache, and Range responses to PDF.js. |
| PDFs behind login | v1: watch `~/Downloads`, keyboard paste of a file or URL, and file open. v2: the extension saves the PDF with the browser's own session. |
| LLM access | A server-side adapter with two drivers: `openai-compatible` and `anthropic`. Raw `fetch`, no vendor SDKs. |
| Browser streaming | Server-Sent Events. `POST` creates a run, `GET` streams its events. Runs survive a page reload. |
| Storage | SQLite on the server (`better-sqlite3`), plus an optional Markdown mirror of the notes. |
| Frontend | Vanilla TypeScript for the viewer core. Preact with signals for the chat pane and lists. Vite for the build. |
| Backend | Node LTS + TypeScript + Hono. |

## 1. Delivery form factor

### Options

- **(a) Local web app.** A small server on `127.0.0.1` and a SPA in a normal browser tab or an `--app` window.
- **(b) Browser extension.** The extension opens PDFs in its own PDF.js viewer page. The chat pane is part of that page. A side panel is optional.
- **(c) Desktop app.** Tauri or Electron with PDF.js inside.
- **(d) Userscript or bookmarklet.** Code that the browser injects into an existing PDF viewer.
- **(e) Terminal UI.** A TUI with text extraction and possibly terminal graphics.

### Decision table

Ratings: **++** strong, **+** adequate, **–** weak, **– –** blocker.

| Criterion | (a) Local web app | (b) Extension | (c) Desktop (Tauri / Electron) | (d) Userscript / bookmarklet | (e) TUI |
|---|---|---|---|---|---|
| Opens arbitrary online PDF URLs | ++ (server fetch has no CORS limit) | ++ (host permissions have no CORS limit) | ++ | – (the page origin limits fetches) | + (the CLI fetches) |
| Opens PDFs behind login or cookies | – (needs a download or the extension) | ++ (uses the browser session) | + (Electron can host a login window and reuse its session; Tauri cannot easily) | + (runs inside the session, but see the next rows) | – – |
| Full control of the keymap | + (browser reserves `Ctrl+W`, `Ctrl+T`, `Ctrl+N`, `Ctrl+Tab`) | + (same reserved keys) | ++ | – (competes with the host viewer) | ++ |
| Works with the built-in Chrome and Firefox PDF viewers | n/a (uses its own viewer) | n/a (uses its own viewer) | n/a | – – (Chrome's viewer is a sealed plugin frame; Firefox's viewer blocks most injection) | n/a |
| Text selection to on-screen rectangles | ++ | ++ | ++ | – (no access to the host's text layer) | – – |
| Effort to build the MVP | ++ (lowest) | + (manifest, permissions, reload loop) | – (packaging, WebKitGTK quirks on Linux for Tauri, size for Electron) | + to start, – – to keep working | – (PDF rendering in a terminal is poor) |
| Hackability (edit, reload, debug) | ++ (Vite hot reload, `curl` the API, SQLite file) | + | – | – | + |
| Path to the other forms | ++ (the SPA becomes the extension page and the desktop window) | + (can call the same local server) | + | – – (dead end) | – – (no shared UI code) |

### Recommendation

Build **(a), the local web app**, for the MVP.

- It has the shortest edit and reload loop.
- The server removes the CORS problem for public URLs.
- The server holds the API keys and the SQLite database.
- The user can open it in `chromium --app=http://127.0.0.1:7777` to get a window with no tabs and no URL bar.

Layer **(b), the extension**, on later without a rewrite. The extension does two jobs:

1. It adds a keyboard command "Open this tab in llm-reader". The command saves the PDF with `chrome.downloads.download({url})`. The browser then sends its own cookies, so the cookies never leave the browser. The server's download watcher (section 3) imports the file.
2. Optionally, it hosts the same SPA bundle as an extension page in a "direct mode" (section 4.7) with IndexedDB storage. This mode needs no server.

Layer **(c)** on later only if the browser keymap limits become a real problem. Use Electron, not Tauri, if login sessions matter: Electron can open a login window and reuse its cookie session for PDF downloads.

Reject **(d)** and **(e)**. (d) cannot read the text layer of the built-in viewers. (e) cannot map a sentence to a highlight on a rendered page.

### Keyboard-only ways to open a URL in v1

The user wants no mouse and no copy-paste. The server accepts three entry forms:

| Entry form | What the user types |
|---|---|
| URL prefix | `Ctrl+L`, `Home`, type `127.0.0.1:7777/`, `Enter`. The address becomes `http://127.0.0.1:7777/https://host/book.pdf`. The server takes everything after the first `/` as the target URL, query string included. |
| Browser search keyword | Define a site-search keyword `r` with the URL `http://127.0.0.1:7777/open?url=%s`. Then: `Ctrl+L`, type `r `, then the URL (or paste it with `Ctrl+V`). |
| CLI | `llm-reader open <url-or-path>`. The CLI posts to the running server and opens the reader tab with `xdg-open`. |

Inside the app, `Ctrl+V` with a URL or a file on the clipboard opens it. `Ctrl+O` opens the file picker. Drag and drop also works.

## 2. PDF rendering and text extraction

### 2.1 Rendering

Use the `pdfjs-dist` package. Pin one exact version in `package.json`. The segmenter output depends on the PDF.js version (section 2.6).

Use the `PDFViewer`, `EventBus`, and `PDFLinkService` classes from `pdfjs-dist/web/pdf_viewer.mjs`. They give the MVP these features at no cost:

- Lazy rendering: the viewer renders only the visible pages and keeps a small buffer of page views.
- A canvas layer and a text layer for each page.
- Zoom, scroll modes, internal links, and the document outline.
- Events: `pagerendered`, `textlayerrendered`, `pagechanging`, `scalechanging`.

Add one custom layer per page: the **overlay layer**. It is an absolutely positioned `div` above the text layer. It holds highlight rectangles, the reading cursor, and thread markers. The viewer owns the canvas and the text layer. llm-reader owns the overlay layer.

Load documents with Range support:

```ts
const task = pdfjsLib.getDocument({
  url: `/api/docs/${docId}/file`,   // served by our server with Range support
  rangeChunkSize: 65536,
  disableAutoFetch: true,           // fetch only the chunks that visible pages need
  isEvalSupported: false,           // do not evaluate code from the PDF
  enableXfa: false,
});
```

Do not enable PDF.js scripting. PDF JavaScript is a needless risk in a page that can call an LLM.

### 2.2 Text items from PDF.js

`page.getTextContent()` returns `{ items, styles }`. Each text item has:

| Field | Meaning |
|---|---|
| `str` | The text of the run. pdf.js applies Unicode normalization (for example, ligature `ﬁ` to `fi`) unless `disableNormalization` is set. Keep the default. |
| `transform` | `[a, b, c, d, e, f]`. `e, f` is the baseline origin in PDF user space (origin at the bottom left). `a, b` gives the scale and the rotation. |
| `width`, `height` | The run size in PDF user space. `height` is close to the font size. |
| `dir` | `ltr`, `rtl`, or `ttb`. |
| `fontName` | A key into `styles`, which gives `ascent`, `descent`, and `vertical`. |
| `hasEOL` | PDF.js thinks that a line ends after this item. |

Filter out marked-content entries (entries without `str`). Keep the item index. The item index is the link between the logical text and the text layer: the PDF.js `TextLayer` creates one `span` per text item, in item order.

### 2.3 Segmentation pipeline

The segmenter is a pure function. It has no DOM dependency, so it runs in the browser and in Node.

```
segmentPage(items, styles, pageSize, docProfile) -> PageText

1. Normalize items
   - drop empty and whitespace-only items (keep their index gaps)
   - compute angle = atan2(b, a); mark items with |angle| > 2 deg as "rotated"
   - drop exact duplicates (same str, same origin within 0.5 pt): fake-bold overprint
2. Build lines
   - group non-rotated items by baseline y, tolerance = 0.35 * median font size
   - inside a line, sort by x (by -x for rtl)
   - insert a space between items when gap > 0.2 * font size and neither side is whitespace
3. Build blocks (reading order)
   - recursive XY-cut on the line boxes:
     split on the widest horizontal whitespace band, then on the widest vertical gutter
   - order: top to bottom; inside a row of columns, left to right
   - the user can override per document: columns = auto | 1 | 2 | 3
4. Classify lines
   - furniture: a line in the top or bottom 10% of the page whose normalized form
     (digits -> '#', trimmed, lowercased) matches docProfile.headerFooterKeys,
     or a line that holds only a page number
   - footnote: a block at the page bottom with a font size < 0.85 * body size
   - margin: rotated items and lines outside the body text box (for example the
     vertical arXiv identifier in the left margin)
5. Build paragraphs inside each body block. Start a new paragraph when:
   - vertical gap > 1.4 * median line pitch, or
   - first-line indent > 1.5 * font size, or
   - the previous line ends before 80% of the block width and ends in . ? ! : or a quote mark
6. Join lines into the logical text
   - line ends in U+00AD (soft hyphen): drop it, join with no space
   - line ends in '-' or U+2010 and the next line starts with a lowercase letter:
     drop the hyphen, join with no space, record the dropped char in the char map
   - else: join with one space
7. Split sentences
   - Intl.Segmenter(lang, { granularity: 'sentence' }) on each paragraph
   - merge a split that follows a known abbreviation: e.g. i.e. et al. Fig. Eq. Dr. vs. cf. a single capital initial
8. Mark cross-page continuations
   - last paragraph without terminal punctuation + next page's first paragraph that starts in lowercase
     and has no indent -> flag "continuesOnNextPage"
```

Two rules keep offsets stable:

- **The logical text keeps every body line, also furniture lines.** The segmenter marks furniture, footnote, and margin lines as *skip spans*. The reading cursor and the sentence list ignore skip spans. The offsets do not change when the header and footer profile improves.
- **The document profile is a separate input.** The background extractor (section 2.6) builds `docProfile` from a sample of pages: header and footer keys, the body font size, and the body text box. The segmenter reads the profile. It does not write to it.

### 2.4 The char map

`PageText` stores the logical text and a run-length char map. Each run maps a range of logical offsets to a range of characters in one text item:

```ts
interface CharRun {
  logicalStart: number;  // UTF-16 offset in PageText.text
  length: number;
  item: number;          // index into getTextContent().items
  itemStart: number;     // UTF-16 offset in items[item].str
  synthetic?: true;      // inserted space or join; no source char
}
```

Dropped hyphens appear as gaps between runs. Inserted spaces are `synthetic` runs. A mouse selection maps back to logical offsets through the same map in the reverse direction.

### 2.5 From a sentence to on-screen rectangles

Use two methods.

1. **Precise method (visible pages).** Convert `[start, end)` to item ranges with the char map. Find the text-layer `span` for each item (`textLayer.textDivs[item]`). Make a DOM `Range` over the characters in that span. Call `range.getClientRects()`. PDF.js scales each span to the real glyph width, so these rectangles match the canvas. Convert them to page-relative coordinates and draw them in the overlay layer.
2. **Approximate method (pages without a text layer yet).** Compute the item box from `transform`, `width`, and the font ascent and descent. Take a part of the box in proportion to the character count. Convert it with `viewport.convertToViewportRectangle`.

Store rectangles in **normalized PDF user space**: `[x0, y0, x1, y1]` divided by the page view box, with no rotation applied. Stored rectangles then do not depend on zoom or on page rotation. Recompute them with the precise method on each `textlayerrendered` event, and update the stored copy if the values differ.

### 2.6 Browser or server segmentation

**Decision: run the same segmenter in both places, and treat the PDF.js output as the only source of offsets.**

| Location | Job | Why |
|---|---|---|
| Browser | Segment each page when it becomes visible. Map selections and the cursor to rectangles. | The text items match the rendered text layer exactly. It is instant. It works in the extension direct mode with no server. |
| Server (Node, `pdfjs-dist` legacy build) | Segment all pages in the background after the first open. Build `docProfile`. Fill the page text cache. | The context strategy and search need text for pages that the user has not seen. `getTextContent` needs no canvas, so Node runs it cheaply. |

Both sides produce the same offsets because they run the same code and the same pinned PDF.js version. Every `PageText` row stores `pdfjsVersion` and `segmenterVersion`. A version change invalidates the cache, and passages re-anchor with their quote selector (section 5).

Do not use pdfplumber or PyMuPDF for anchoring. Their text and their offsets differ from PDF.js. Two sources of offsets would break highlights. A Python tool is still acceptable as an *offline* helper, for example OCR, because OCR produces a new PDF that PDF.js then reads.

### 2.7 Known failure modes

| Failure mode | Detection | Mitigation |
|---|---|---|
| Scanned PDF (no text layer) | Fewer than 20 characters on most sampled pages, and the page has images. | Show a banner: "No text layer. Run OCR?". The server runs `ocrmypdf --skip-text in.pdf out.pdf` as an optional system dependency. The output is a new document with `derived_from` set. The reader opens the OCR version from then on. As a no-OCR fallback, the user selects a region and sends a canvas crop as an image to a multimodal model. |
| Math-heavy text (TeX fonts, no ToUnicode map) | A high ratio of Private Use Area characters, U+FFFD, or isolated single-glyph items with shifted baselines. | Flag the passage with `quality: 'low'`. Offer a region capture (PNG crop of the canvas) together with the extracted text. A later version can fetch LaTeX source for arXiv papers. |
| Ligatures | Usually solved by the PDF.js normalization. | Keep normalization on. Apply NFKC to the text that goes to the LLM only, never to the stored offsets. |
| Rotated text (margin stamps, figure axes) | Item angle from `transform`. | Mark as margin and exclude from the reading flow. Pages with `/Rotate` are handled by the viewport and need no special case. |
| Character-by-character items | Many one-character items on a line. | Line grouping and the space rule handle it. Add a fixture test. |
| Multi-column with spanning figures or titles | XY-cut gives an odd order on a page. | Per-document column override. Per-page "re-segment as 1 column" command. |
| Hidden or white text, overprints | Duplicate items at the same origin. | Deduplicate in step 1. |
| Right-to-left and vertical text | `dir` is `rtl` or `ttb`. | Basic `rtl` sort only. Full support is a non-goal for v1. |
| Encrypted or damaged PDF | `getDocument` raises an error. | PDF.js asks for a password through `onPassword`. Show the error text for damaged files. |

## 3. Fetching online PDFs

### 3.1 Flow

```
browser: POST /api/docs/open { url }
server:
  1. rewrite known landing pages (small table, e.g. arxiv.org/abs/<id> -> arxiv.org/pdf/<id>)
  2. look up sources(url_norm). If a cached doc exists: return it at once,
     and revalidate in the background with If-None-Match / If-Modified-Since
  3. GET with redirects (max 5), timeout, browser-like User-Agent, size cap (config)
  4. stream the body to data/tmp/<random>, hash it with SHA-256 while it streams
  5. sniff: the first 1024 bytes must contain "%PDF-"
       - if not and the body is HTML: look for <meta name="citation_pdf_url">,
         <link type="application/pdf">, <embed|iframe src=...pdf>; follow one candidate once
       - else: error not_pdf, with a hint: "This looks like a login or landing page.
         Download the PDF in your browser; llm-reader imports it from ~/Downloads."
  6. move the file to data/blobs/<sha256>.pdf (content-addressed; a duplicate is a no-op)
  7. upsert documents(id = sha256) and sources(url_norm -> doc id, etag, last_modified)
  8. reply { docId, title, pageCount } and start the background extractor
```

The server ignores the `Content-Type` header for the PDF decision. Many servers send `application/octet-stream` or a wrong type. The magic bytes decide.

The server sends progress for large downloads as SSE on `GET /api/fetches/:id/events` (bytes received, total if known).

### 3.2 Cache

| Item | Key | Location |
|---|---|---|
| PDF bytes | SHA-256 of the bytes (= document id) | `~/.local/share/llm-reader/blobs/<id>.pdf` |
| URL index | Normalized URL (lowercase host, no fragment, sorted query) | SQLite `sources` table |
| Page text | `(doc_id, page, segmenter_version)` | SQLite `page_text` table |

When revalidation shows new bytes at the same URL, the server makes a new document. Notes stay with the old document. The UI tells the user that a new version exists and offers to open it.

### 3.3 Range responses

`GET /api/docs/:id/file` serves the blob from disk:

- `Accept-Ranges: bytes`, `Content-Length`, and `206 Partial Content` for `Range` requests.
- `ETag: "<doc id>"` and `Cache-Control: private, max-age=31536000, immutable`. The bytes for an id never change.

PDF.js then loads only the chunks that it needs. A 300 MB scanned book opens at the first page without a full parse.

v1 waits for the full download before it opens the document, because the document id is the hash of all bytes. v2 can add progressive open: serve a partial file under a temporary id, block each Range request until its bytes arrive, then rename the document when the hash is known.

### 3.4 PDFs behind login

Do not copy cookies out of the browser profile in v1. Chrome encrypts its cookie store with the system keyring on Linux, and the code that reads it breaks often.

Fallbacks, in order of preference:

1. **Download watcher (v1).** The server watches the directories in `fetch.watch_dirs` (default `~/Downloads`). The user presses `Ctrl+S` in the browser's own PDF viewer. The new PDF appears at the top of the "recent" list in llm-reader, and a notice offers to open it. The server records no source URL for it, unless the extension supplies one.
2. **Paste or open a file (v1).** `Ctrl+V` with a file on the clipboard, `Ctrl+O`, or drag and drop. The browser uploads the bytes with `POST /api/docs` (multipart).
3. **Extension "Open in llm-reader" (v2).** The extension calls `chrome.downloads.download()` on the tab URL into `~/Downloads/llm-reader/`. The browser sends its own cookies and handles `SameSite` rules. The extension then tells the server the source URL, so the server can link the URL to the document. This method is more robust than cookie forwarding: no cookie leaves the browser, and no header needs a copy.
4. **Netscape `cookies.txt` (optional, v2).** A per-domain `cookies_file` in the config, for users who already export cookies for tools such as `yt-dlp`.

## 4. LLM adapter

### 4.1 Interface

The adapter lives on the server. The browser never calls a provider in the default mode.

```ts
type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: 'image/png' | 'image/jpeg'; dataBase64: string };

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | ContentPart[];
}

interface ChatRequest {
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;          // required by the anthropic driver; default from the profile
  temperature?: number;
  cacheHints?: { messageIndex: number }[]; // optional; drivers that support prompt caching use it
  extra?: Record<string, unknown>;          // provider-specific passthrough from the profile
}

type ChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }     // only if the provider streams it and the profile allows it
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }
  | { type: 'done'; finishReason: 'stop' | 'length' | 'cancelled' | 'error' | 'other' };

interface ChatDriver {
  readonly kind: 'openai-compatible' | 'anthropic';
  stream(profile: Profile, req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>;
  listModels?(profile: Profile, signal: AbortSignal): Promise<string[]>;
}
```

The other sections own the content of `system` and `messages`. The adapter only transports them.

### 4.2 The two drivers

| Concern | `openai-compatible` | `anthropic` |
|---|---|---|
| Endpoint | `POST {base_url}/chat/completions` | `POST {base_url}/v1/messages` |
| Auth header | `Authorization: Bearer <key>` (omit if no key, for example a local server) | `x-api-key: <key>` and `anthropic-version` |
| System prompt | First message with `role: 'system'` | Top-level `system` field |
| Streaming | `stream: true`; SSE lines `data: {...}`, ends with `data: [DONE]`; text in `choices[0].delta.content` | `stream: true`; typed SSE events; text in `content_block_delta` events of type `text_delta` |
| Usage | Final chunk, if the server supports `stream_options: { include_usage: true }`. Some compatible servers ignore it, so usage is optional. | `message_start` (input) and `message_delta` (output) |
| Images | `image_url` part with a `data:` URL | `image` block with a `base64` source |
| Targets | OpenAI, xAI, OpenRouter, Ollama (`/v1`), vLLM, llama.cpp server, LM Studio | Anthropic |

Use raw `fetch` and a small SSE line parser (for example the `eventsource-parser` package). Each driver is about 150 lines. Raw `fetch` has three advantages: the same driver code runs in the browser for direct mode, there is no SDK version drift, and compatible servers with small deviations are easy to patch with `extra`.

### 4.3 Streaming to the browser: SSE

**Decision: Server-Sent Events, in two steps.**

1. `POST /api/threads/:threadId/runs` with the user message. The server stores the user message, makes an assistant message with `status = 'streaming'`, starts the run, and replies `{ runId, messageId }`.
2. `GET /api/runs/:runId/events` returns `text/event-stream`. The browser reads it with `EventSource`.

Why SSE and not WebSocket:

- The data flows in one direction. Client-to-server actions (send, cancel) are rare and fit plain `POST` requests.
- `EventSource` reconnects by itself and sends `Last-Event-ID`. The server keeps an in-memory event buffer per active run and replays the missed events. A page reload during a long answer loses nothing.
- It is plain HTTP. `curl -N` shows the stream. Hono has a `streamSSE` helper. No extra library is needed.

The only SSE limit is six HTTP/1.1 connections per origin. Close each stream when its run ends. If parallel runs become common, add one multiplexed `GET /api/events` stream.

Event shape (each event has `id: <seq>`):

```
event: run.start
data: {"runId":"r_01J...","messageId":"m_01J...","profile":"fast","model":"<model>"}

event: delta
data: {"text":"The author means that "}

event: usage
data: {"inputTokens":1834,"outputTokens":212,"cachedInputTokens":1500,"costUsd":null}

event: run.end
data: {"finishReason":"stop"}

event: error
data: {"code":"rate_limited","message":"429 from provider","retryable":true,"partialKept":true}

: ping            (a comment line every 15 s keeps proxies and the browser from closing the stream)
```

### 4.4 Cancel, retries, and persistence

- **Cancel.** `POST /api/runs/:runId/cancel` aborts the `AbortController` of the run. The upstream `fetch` stops. The server keeps the partial text and sets `finishReason = 'cancelled'`. A closed browser stream does **not** cancel the run, so that a reload does not lose the answer. A run has a maximum duration (config, default 10 minutes).
- **Retries.** Retry only before the first `delta` arrives. Retry on network errors, `429`, `500`, `502`, `503`, `504`, and provider "overloaded" errors. Use exponential backoff with jitter (0.5 s, 1 s, 2 s; at most 3 tries). Obey `Retry-After` if it is present. After the first `delta`, do not retry automatically. Send `error` with `partialKept: true`. The user then gives a "retry" command, which makes a new run.
- **Persistence.** The run writes the accumulated text to the `messages` row every 500 ms and at the end. At startup, the server marks any row that still has `status = 'streaming'` as `interrupted`.

### 4.5 Token and cost accounting

The run calls `onUsage(event, profile, runId)` for each `usage` event. The default hook writes one row to the `usage` table. Cost is `null` unless the profile has a user-supplied `pricing` table. llm-reader ships no prices. A later hook can enforce a daily budget per profile.

### 4.6 Configuration

Location: `$XDG_CONFIG_HOME/llm-reader/config.toml` (default `~/.config/llm-reader/config.toml`). The server reloads the file when it changes. The browser gets only the profile names and models, never the keys.

```toml
default_profile = "fast"

[server]
bind = "127.0.0.1"
port = 7777

[storage]
data_dir = "~/.local/share/llm-reader"
notes_mirror_dir = "~/notes/llm-reader"   # optional Markdown mirror (section 5.4)

[fetch]
max_bytes = 524288000
watch_dirs = ["~/Downloads"]

[profiles.fast]
provider = "openai-compatible"
base_url = "https://api.openai.com/v1"
model = "<model-id>"
api_key_env = "OPENAI_API_KEY"

[profiles.grok]
provider = "openai-compatible"
base_url = "https://api.x.ai/v1"
model = "<model-id>"
api_key_env = "XAI_API_KEY"

[profiles.router]
provider = "openai-compatible"
base_url = "https://openrouter.ai/api/v1"
model = "<vendor/model-id>"
api_key_env = "OPENROUTER_API_KEY"

[profiles.local]
provider = "openai-compatible"
base_url = "http://127.0.0.1:11434/v1"   # Ollama; no key
model = "<local-model>"

[profiles.claude]
provider = "anthropic"
base_url = "https://api.anthropic.com"
model = "<model-id>"
api_key_env = "ANTHROPIC_API_KEY"
max_tokens = 2048

[profiles.claude.pricing]   # optional; the user supplies the numbers
input_per_mtok = 0.0
output_per_mtok = 0.0

[profiles.claude.extra]     # optional passthrough fields for the request body
```

The config holds the *name* of an environment variable, not the key. `api_key_cmd = "pass show openai"` is an optional alternative for users of a password manager. The server refuses to start if the config file contains a literal key and has permissions wider than `0600`.

### 4.7 Why the keys stay on the server

- The SPA renders text from PDFs and from LLM output. A bug in the Markdown sanitizer or in PDF.js could run script in the page origin. A key in `localStorage` or in page memory is then readable. A key in the server process is not.
- Browser extensions with wide host permissions can read page storage.
- The server is one place for retries, usage logs, and key rotation.
- Some providers refuse or discourage direct browser calls (CORS rules, or a special opt-in header).

**Direct mode (later, for the extension or a static build).** The SPA uses a `BrowserTransport` that runs the same drivers in the browser. The key lives in `chrome.storage.local`.

| Benefit | Cost |
|---|---|
| No server process; works on any machine with the extension. | The key is in the browser profile. |
| Extension host permissions remove most CORS problems. | Outside an extension, CORS support differs per provider. Anthropic needs an explicit opt-in header for browser calls. Ollama needs `OLLAMA_ORIGINS`. |
| Same SPA code. | IndexedDB storage instead of SQLite, with no CLI access to the notes. |

Treat direct mode as a second transport, not a fork. Section 6 defines the transport interface.

## 5. Data model and persistence

### 5.1 Types

```ts
type DocId = string;                 // SHA-256 hex of the PDF bytes
type Rect = [x0: number, y0: number, x1: number, y1: number]; // normalized 0..1, PDF user space, unrotated

interface Document {
  id: DocId;
  title: string;                     // PDF metadata title, else outline root, else file name
  pageCount: number;
  byteSize: number;
  derivedFrom?: DocId;               // for an OCR output
  addedAt: string;
}

interface PageText {
  docId: DocId; page: number;        // 0-based
  pdfjsVersion: string; segmenterVersion: number;
  text: string;                      // logical text of the page
  charMap: CharRun[];
  paragraphs: [number, number][];    // [start, end) offsets
  sentences: [number, number][];
  skipSpans: { start: number; end: number; kind: 'furniture' | 'footnote' | 'margin' }[];
  flags: { lowText?: true; lowQuality?: true; continuesOnNextPage?: true };
}

interface PassageAnchor { page: number; offset: number }

interface Passage {
  id: string;                        // ULID
  docId: DocId;
  start: PassageAnchor;              // a passage may cross a page break
  end: PassageAnchor;                // exclusive
  kind: 'sentence' | 'paragraph' | 'selection' | 'region';
  text: string;                      // de-hyphenated, joined text that goes to the LLM
  quote: { exact: string; prefix: string; suffix: string }; // ~32 chars of context each side
  rects: { page: number; rect: Rect }[];
  image?: { page: number; rect: Rect };  // for kind 'region': the crop to render and attach
  segmenterVersion: number;
  quality?: 'low';
}
```

The `quote` selector follows the W3C Web Annotation "TextQuoteSelector" idea. If the segmenter version changes, the anchor code searches for `exact` near the old offsets, and uses `prefix` and `suffix` to choose between matches. The offsets are a fast path. The quote is the durable anchor.

### 5.2 Tables

| Table | Key columns | Notes |
|---|---|---|
| `documents` | `id`, `title`, `page_count`, `byte_size`, `derived_from`, `added_at` | One row per distinct byte content. |
| `sources` | `url_norm` (PK), `url`, `doc_id`, `etag`, `last_modified`, `fetched_at` | Many URLs can point to one document. |
| `page_text` | `(doc_id, page, segmenter_version)` PK, `json` | Cache. Safe to delete. |
| `doc_profile` | `doc_id` PK, `json` | Header and footer keys, body font size, column override. |
| `passages` | `id`, `doc_id`, `start_page`, `start_offset`, `end_page`, `end_offset`, `kind`, `text`, `quote_json`, `rects_json` | Index on `(doc_id, start_page)`. |
| `highlights` | `id`, `passage_id`, `color`, `note`, `created_at` | A highlight with no thread is a plain mark. |
| `threads` | `id`, `doc_id`, `passage_id` (nullable for document-level threads), `title`, `created_at` | One thread per anchored question. |
| `messages` | `id`, `thread_id`, `role`, `content_json`, `status`, `profile`, `model`, `finish_reason`, `created_at` | `status`: `complete`, `streaming`, `cancelled`, `error`, `interrupted`. |
| `usage` | `run_id`, `message_id`, `profile`, `model`, `input_tokens`, `output_tokens`, `cached_input_tokens`, `cost_usd`, `at` | One row per usage event. |
| `reading_state` | `doc_id` PK, `page`, `scroll_frac`, `zoom`, `cursor_passage_json`, `updated_at` | The last reading position. |
| `settings` | `key` PK, `value_json` | UI settings that follow the user across browsers. |

Use plain SQL migrations in `src/server/db/migrations/NNN_name.sql`. Turn on WAL mode and `foreign_keys`. Do not add an ORM.

### 5.3 SQLite on the server, not IndexedDB

- **Durability.** The browser can clear IndexedDB (site data clear, private window, a new browser profile). The notes are the valuable output of the tool, so they need a plain file.
- **Access from other tools.** The user can run `sqlite3 ~/.local/share/llm-reader/llm-reader.db`, back it up with any file tool, or ask Claude Code to query it.
- **One store for many clients.** A normal tab, an `--app` window, and the extension all see the same notes.
- **The server already exists** for fetch and keys, so SQLite adds no new process.

Put IndexedDB behind the same `Store` interface only for the direct mode.

### 5.4 Export

- `GET /api/docs/:id/export.md` and `llm-reader export <doc> --format md`.
- `GET /api/docs/:id/export.json` and `--format json`: the full rows for that document, with a `schemaVersion`.
- Optional Markdown mirror: if `storage.notes_mirror_dir` is set, the server writes `<slug-of-title>.md` 2 s after each change. The mirror is a second copy that is easy to read and to search with `grep`.

Markdown shape:

```markdown
# <Title>
Source: <url> · sha256: <id>

## Page 12
> The quoted passage text, de-hyphenated.

**Q:** What does "transcendental" mean here?

**A (<profile>/<model>):** In this context the author ...
```

## 6. Frontend stack

The hard parts are imperative: PDF.js page views, the char map, DOM ranges, the overlay layer, focus, and the command dispatcher. The widgets (a message list, an input, a document list) are simple.

| Option | Fit for the PDF.js core | Fit for the chat pane | Size and build | Reuse in the extension | Verdict |
|---|---|---|---|---|---|
| Vanilla TypeScript only | ++ | – (manual DOM updates for streaming lists) | ++ | ++ | Good for the core, tedious for the pane. |
| Preact + `@preact/signals` | + (stays out of the way) | ++ (fine-grained updates per streamed token) | ++ (a few KB, JSX, React knowledge transfers) | ++ | **Recommended for the shell and the chat pane.** |
| Svelte | + | ++ | ++ | ++ | Also good. It adds a compiler and its own syntax for little gain here. |
| React | + | ++ | – (larger runtime, more ceremony) | + | No benefit over Preact for this app. |

**Decision.**

- `src/web/viewer/` is framework-free TypeScript: `Viewer`, `OverlayLayer`, `ReadingCursor`, `SelectionMapper`. These classes talk through a small typed event emitter. They do not import Preact. Thus the extension or a desktop wrapper can reuse them as they are.
- `src/web/commands/` holds a command registry (`id -> handler`) and a keymap loader. One `keydown` listener on `window` in the capture phase finds the command for the key and the current mode, and calls `preventDefault()` for keys that llm-reader owns. The keymap section owns the bindings. This layer only provides the dispatch.
- `src/web/chat/` is Preact. The chat pane renders Markdown with `markdown-it`, sanitizes it with `DOMPurify`, and renders math with KaTeX (LLM answers about math books contain LaTeX).
- `src/web/api/` defines the transport interfaces so that direct mode can replace the server:

```ts
interface Transport {
  docs: { open(urlOrFile: string | File): Promise<Document>; fileUrl(id: DocId): string };
  store: Store;                                   // passages, threads, messages, reading_state
  runs: { start(threadId: string, msg: ChatMessage, profile?: string): Promise<{ runId: string }>;
          events(runId: string): AsyncIterable<RunEvent>;
          cancel(runId: string): Promise<void> };
}
```

**Build and dev loop.**

- Vite builds the SPA. Import the PDF.js worker as an asset (`pdfjs-dist/build/pdf.worker.min.mjs?url`).
- `pnpm dev` starts two processes: Vite on port 5173 with a proxy from `/api` to the server, and the server with `tsx watch`. The user opens `http://127.0.0.1:5173`.
- `pnpm start` builds the SPA and starts one server on port 7777. The server serves `dist/` and the API.
- Tests use Vitest. The segmenter tests run in Node on fixture PDFs, with no browser.

## 7. Backend stack

| Criterion | Node + TypeScript (Hono) | Python (FastAPI) | Go |
|---|---|---|---|
| PDF libraries | `pdfjs-dist` runs in Node: the same text items and offsets as the browser. | PyMuPDF and pdfplumber are better general PDF tools, but their offsets differ from PDF.js. | No strong text extraction library. |
| Shared code with the frontend | ++ One segmenter, one `types.ts`, one set of drivers for both transports. | – Types and the segmenter exist twice. | – Same problem. |
| SSE support | Hono `streamSSE`; Web-standard `Request` and `Response`. | `sse-starlette` or `StreamingResponse`; good. | Good with the standard library. |
| One-command local run | `pnpm start` (or `npx llm-reader` after a publish). | `uv run llm-reader`; good. | One binary; best. |
| SQLite | `better-sqlite3` (synchronous, fast, prebuilt binaries). `node:sqlite` is a zero-dependency option on recent Node versions. | Standard library `sqlite3`. | `modernc.org/sqlite`. |
| OCR | Shell out to `ocrmypdf`. | Shell out to `ocrmypdf`, or call it as a library. | Shell out. |
| User comfort | Likely: the user works in VS Code with a TypeScript frontend in any case. | Likely also fine. | Less likely. |

**Decision: Node LTS (22 or newer) + TypeScript + Hono, run with `tsx` in development.**

The deciding reason is the single source of offsets. The browser and the server must agree on page text to the character. Only a JavaScript backend runs the same PDF.js code. A second reason is one language and one type file for the whole project, which keeps the project easy to change.

Hono is small and uses Web-standard APIs. Hono also runs on Bun and Deno, so a later move to a single-binary runtime stays open. Fastify is an equal choice if the user knows it already.

If the user strongly prefers Python, the design still works. Keep all segmentation in the browser, upload each `PageText` to the server, and accept that background whole-document extraction then needs a headless browser or waits until each page is viewed.

### Security of the local server

The server can fetch any URL and can spend money on API calls. Protect it from other websites that the user visits.

- Bind to `127.0.0.1` only. Never to `0.0.0.0`.
- Check the `Host` header: allow only `127.0.0.1:<port>` and `localhost:<port>`. This blocks DNS rebinding.
- Check the `Origin` header on every state-changing request.
- At startup, the server makes a random session secret. It sets the secret as an `HttpOnly`, `SameSite=Strict` cookie when it serves `index.html`. All `/api` routes require the cookie. Other origins cannot send it, and `EventSource` sends it automatically.
- Redact keys and `Authorization` headers in all logs.

## 8. Repository layout

```
llm-reader/
├── package.json             one package; scripts: dev, start, build, test, lint
├── pnpm-lock.yaml           pinned versions (pdfjs-dist pinned exactly)
├── tsconfig.json            strict TS for all of src/
├── vite.config.ts           SPA build; dev proxy from /api to the server
├── config.example.toml      sample config with named LLM profiles and no keys
├── bin/
│   └── llm-reader.ts        CLI: serve, open <url|path>, export <doc>, doctor (checks config and deps)
├── src/
│   ├── shared/              code that runs in the browser and in Node
│   │   ├── types.ts         Document, PageText, Passage, Thread, Message, RunEvent
│   │   ├── segment/         text items -> lines, blocks, paragraphs, sentences, char map
│   │   ├── anchor.ts        offsets <-> rects <-> quote selector; re-anchoring
│   │   └── llm/             ChatDriver interface, openai-compatible.ts, anthropic.ts, sse-parse.ts
│   ├── server/
│   │   ├── main.ts          Hono app, Host/Origin/cookie checks, static files
│   │   ├── config.ts        load and validate config.toml; resolve keys from env or command
│   │   ├── routes/          docs, threads, runs (SSE), export, settings
│   │   ├── fetch/           URL fetch, rewrites, sniffing, HTML-to-PDF-link discovery, Range serving
│   │   ├── runs.ts          RunManager: abort controllers, retries, event buffer, persistence
│   │   ├── extract/         background whole-document segmentation (pdfjs in Node), doc profile, OCR job
│   │   ├── watch.ts         watch download directories and import new PDFs
│   │   └── db/              SQLite open, migrations/*.sql, repository functions, Markdown mirror
│   └── web/
│       ├── index.html       SPA entry
│       ├── main.ts          boot: transport, viewer, panes, command registry
│       ├── viewer/          PDFViewer wrapper, overlay layer, reading cursor, selection mapper
│       ├── commands/        command registry and keymap loader (bindings are defined elsewhere)
│       ├── chat/            Preact chat pane; Markdown, DOMPurify, KaTeX; SSE client
│       ├── library/         Preact document list, recent files, open box
│       ├── api/             Transport interface; ServerTransport (v1); BrowserTransport (later)
│       └── styles/          CSS variables and layout of the split view
├── extension/               (v2) MV3 manifest, background worker, "Open in llm-reader" command
├── test/
│   ├── fixtures/            small tricky PDFs (two-column paper, textbook with headers, scan, math)
│   ├── fixtures/expected/   golden PageText JSON per fixture
│   └── *.test.ts            Vitest: segmenter, anchors, drivers (against a fake SSE server), fetch
└── docs/
    └── design/              research appendices; DESIGN.md at the repo root is authoritative
```

## 9. Key risks and mitigations

| Risk | Effect | Mitigation |
|---|---|---|
| Text extraction quality (columns, headers, math, hyphens) | Wrong sentence boundaries; garbage text goes to the LLM. | Golden fixture tests for each failure class. Per-document column override. Quality flag with a region-image fallback. A "show extracted text" debug view of each page. |
| PDF.js version drift | Offsets change; old highlights move. | Pin the exact version. Store `pdfjsVersion` and `segmenterVersion` on each `PageText`. Re-anchor with the quote selector. |
| Large PDFs (memory, slow open) | The tab uses too much memory or the first page is slow. | Range responses with `disableAutoFetch`. `PDFViewer` renders only visible pages and frees old canvases. Set `maxCanvasPixels`. Background extraction in Node, not in the tab. |
| Latency of the first token | The user waits with no feedback. | Start the run on the key press. Stream with SSE. Show a pending state at once. Keep upstream HTTP connections alive. Let the context strategy use provider prompt caching through `cacheHints`. Offer a local profile for fast short answers. |
| API key leakage | Someone uses the user's paid account. | Keys only in server memory, from environment variables or a command. Never sent to the browser. Logs redact keys. Config permission check. Sanitized Markdown rendering and no PDF scripting reduce XSS risk. |
| Other websites call the local server (CSRF, DNS rebinding) | A web page triggers fetches or paid API calls. | Bind `127.0.0.1`. `Host` and `Origin` checks. `SameSite=Strict` session cookie on all `/api` routes. |
| Keymap conflicts with the browser | Some keys never reach the page (`Ctrl+W`, `Ctrl+T`, `Ctrl+N`, `Ctrl+Tab`). | The keymap section avoids reserved keys. Capture-phase listener with `preventDefault` for owned keys. The `--app` window removes tab and URL-bar distractions. Electron is the escape route if the limits matter. |
| Loss of notes | Months of reading notes disappear. | SQLite file on disk in WAL mode, outside the browser. Streaming answers are flushed every 500 ms. Interrupted runs are kept and marked. Optional Markdown mirror. A daily copy of the database file to `backups/` (keep 14). |
| PDFs behind login | The main use case fails on paywalled or institutional sites. | v1 download watcher and file paste. v2 extension that saves with the browser session. |
| Provider API differences | A compatible server rejects a field or streams a different shape. | Two thin drivers on raw `fetch`. `extra` passthrough per profile. Usage is optional. Driver tests against recorded streams. |

## 10. Non-goals for v1

- No cloud sync, accounts, or multi-user sharing. One user on one machine.
- No mobile or tablet layout.
- No edits to the PDF file. Highlights and notes stay in the database, not in PDF annotations.
- No EPUB, HTML, or DjVu input. The `Transport` and `Passage` types do not prevent them later.
- No built-in OCR engine. OCR is an optional call to `ocrmypdf` if it is installed.
- No full support for right-to-left or vertical scripts.
- No reading of cookies from browser profiles.
- No progressive open during download.
- No vector index or embeddings in the storage layer. The context strategy section can add one later.
- No tool use or agent loops in the adapter. Plain chat with text and image parts only.
- No published extension or packaged desktop app. Load the extension unpacked when it exists.
- No packaging for Windows or macOS. The code is portable, but only Linux is tested.
