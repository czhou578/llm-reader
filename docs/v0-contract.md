# llm-reader v0 build contract

Three agents build v0 in parallel in this working tree. This file fixes the boundaries so the parts integrate.
DESIGN.md is the source of truth for behavior. Where DESIGN.md goes beyond Phase 0, build only what this file lists.

## Goal: a runnable v0 (DESIGN.md Phase 0)

`pnpm dev` starts the server on 127.0.0.1:7777 and Vite on 127.0.0.1:5173. In the browser:

1. The library view lists recent documents and the PDFs in `books_dir`. The user types a few letters and presses `Enter`.
   `pnpm llm-reader open <path.pdf>` also opens a file from the shell.
2. The PDF renders. `Space`/`q` move by paragraph, `s`/`w` by sentence, `d`/`a` extend/shrink. The current unit is tinted.
   A mouse selection is staged at once.
3. `Enter`/`e` explains, `c` defines, `v` opens the ask box for a typed question. The answer streams into the right pane.
   Focus stays in the PDF. A second ask on the same selection is a follow-up in the same thread.
4. `Tab` moves focus to the answer pane, `s`/`w`/`Space`/`q` scroll it, `Esc`/`Tab` return. `Esc` also cancels a stream.
5. Threads and the reading position survive a restart. The status line shows mode, staged text, and run state.
   Each answer shows a context-used line with token counts.

Without an API key the `mock` provider answers, so everything above runs with no network and no config file.

## Ownership (do not edit files outside your area; do not run `pnpm add`)

| Agent | Owns | May also edit |
|---|---|---|
| **server** | `src/server/**`, `bin/**`, `test/server/**` | `package.json` scripts only (`llm-reader` bin script) |
| **viewer** | `src/web/viewer/**` (replace `index.ts`; `api.ts` is frozen), `src/shared/segment/**`, `test/segment/**` | nothing else |
| **shell** | `src/web/app/**`, `src/web/commands/**`, `src/web/chat/**`, `src/web/library/**`, `src/web/api/**`, `src/web/styles/**`, `src/web/main.ts`, `src/web/index.html`, `vite.config.ts`, `test/web/**` | nothing else |

Frozen: `src/shared/types.ts`, `src/web/viewer/api.ts`, `tsconfig.json`, `vitest.config.ts`, `test/smoke.test.ts`.
If you need a type the contract lacks, define it in your own module and mention it in your final report.
All dependencies you need are installed (see `package.json`). If one is truly missing, stub around it and report it.
Keep `pnpm typecheck` green for your files. Run `pnpm test` before you finish. Use ports 7777 (server), 5173 (shell Vite),
5174 (viewer Vite if you need a manual check), and ephemeral ports in tests.

## Server HTTP API (server agent implements; shell agent consumes)

All routes are under `/api`. JSON bodies. Errors: `{ error: { code: string, message: string } }` with a 4xx/5xx status.
Types are in `src/shared/types.ts`.

| Method, path | Request | Response |
|---|---|---|
| `GET /api/health` | | `{ ok, name, node }` |
| `GET /api/config` | | `ClientConfig` |
| `GET /api/library` | | `LibraryEntry[]` sorted: recent documents first, then `books_dir` PDFs by mtime desc |
| `POST /api/docs/open` | `{ path: string }` absolute or `~`-relative local file | `Document` (201 when new, 200 when known) |
| `POST /api/docs` | multipart `file` | `Document` |
| `GET /api/docs/:id` | | `Document` |
| `GET /api/docs/:id/file` | `Range` supported | PDF bytes, `Accept-Ranges`, `ETag: "<id>"`, immutable cache headers |
| `GET /api/docs/:id/state` | | `ReadingState` or 404 |
| `PUT /api/docs/:id/state` | `ReadingState` | `ReadingState` |
| `GET /api/docs/:id/threads` | | `Thread[]` with messages, oldest first |
| `POST /api/docs/:id/threads` | `CreateThreadRequest` | `Thread` (201) |
| `GET /api/threads/:id` | | `Thread` |
| `POST /api/threads/:id/runs` | `StartRunRequest` | `StartRunResponse` (202). Stores the user message and an assistant message with `status: 'streaming'`. 409 if a run is active on the thread. |
| `GET /api/runs/:id/events` | SSE; honors `Last-Event-ID` | `RunEvent` frames: `id: <seq>` `event: <type>` `data: <json>`; comment `: ping` every 15 s; the stream closes after `run.end` or `error` |
| `POST /api/runs/:id/cancel` | | `{ ok: true }`; partial text is kept, `finishReason: 'cancelled'` |
| `GET /api/usage/summary?docId=` | | `UsageSummary` |

Document open: resolve the path, read bytes, SHA-256 → `id`, copy to `<data_dir>/blobs/<id>.pdf` (no-op if present),
extract `title` (PDF metadata title, else outline root, else file name), `author`, `pageCount`, `pageLabels`, `outline`
with `pdfjs-dist/legacy/build/pdf.mjs` in Node (verified to work in `test/smoke.test.ts`). Upsert `documents`.

Context builder (server, DESIGN.md 6.2–6.6, Phase 0 subset): layers S (system prompt, verbatim from DESIGN.md 6.6),
C (title, author, chapter-level outline titles), F (reader profile from config), B (`context.surrounding`, which already
marks the selection with ⟦ ⟧), the raw `prevPageText` in place of D1 when present, and A (location line + passage +
preset instruction). Preset texts: Explain and Define verbatim from DESIGN.md 6.6; Free ask from
`docs/design/context-and-plan.md` section 3.2 (`Task: Answer the reader's question…`). Order: system → one user turn with
`<document>`, `<reader>`, `<previous_page>`, `<surrounding_text>`, `<request>`. Follow-ups: resend turn 1 byte for byte,
then all later turns, then the follow-up shape from the appendix section 3.3 (a preset on the same selection sends its
template text without the passage). Record a `contextUsed` line per assistant message, e.g.
`passage · p. 142 · ±1 paragraph · prev page · 2,140 tok` (estimate tokens as chars/4 until usage arrives).

Drivers (`src/server/llm/`): `anthropic` (POST `{base_url}/v1/messages`, `x-api-key`, `anthropic-version: 2023-06-01`,
stream, text deltas from `content_block_delta`, usage from `message_start`/`message_delta`), `openai-compatible`
(POST `{base_url}/chat/completions`, `Authorization: Bearer` when a key exists, `stream: true`,
`stream_options: { include_usage: true }`, deltas from `choices[0].delta.content`, ends at `[DONE]`), and `mock`
(streams a deterministic answer that echoes the preset and the first words of the passage, ~40 words, 20 ms per chunk,
reports fake usage). Use raw `fetch` and `eventsource-parser`. Retry only before the first delta (429, 5xx, network),
3 tries, backoff with jitter. `AbortSignal` cancels.

Run manager: one in-memory buffer of events per run for `Last-Event-ID` replay; flush accumulated text to the message row
every 500 ms and at the end; on startup mark rows still `streaming` as `interrupted`. A closed SSE connection does not
cancel the run. Usage rows: one per usage event; cost from the profile's `pricing` when present, else null.

Config: `$LLM_READER_CONFIG`, else `~/.config/llm-reader/config.toml`, else built-in defaults. Parse with `smol-toml`.
Defaults when no file exists: profiles `claude` (anthropic, `claude-opus-5-5`, `ANTHROPIC_API_KEY`), `local`
(openai-compatible, `http://127.0.0.1:8000/v1`), `mock`; roles `strong`/`fast` = `claude` if `ANTHROPIC_API_KEY` is set,
else `mock`. `data_dir` default `~/.local/share/llm-reader` (`$LLM_READER_DATA_DIR` overrides; tests use a temp dir).
`books_dir` default `~/books` (`$LLM_READER_BOOKS_DIR` overrides; missing dir → empty list, not an error).
Keys come only from the named environment variable. Never send a key to the browser. Redact keys in logs.

Storage: SQLite via `better-sqlite3` at `<data_dir>/llm-reader.db`, WAL mode, plain SQL migrations in
`src/server/db/migrations/*.sql` applied at startup. Tables per DESIGN.md 7.6: `documents`, `sources` (may stay empty in
v0), `passages`, `threads`, `messages`, `usage`, `reading_state`, `settings`.

Security: bind 127.0.0.1; reject requests whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>` (allow the Vite
dev origin `http://127.0.0.1:5173` and `http://localhost:5173` in an `Origin` check on state-changing requests). The
session cookie from DESIGN.md 7.8 is deferred to Phase 1.

Static files: serve `dist/` at `/` when it exists (so `pnpm start` works without Vite).

CLI (`bin/llm-reader.ts`, run as `pnpm llm-reader <cmd>` via a `"llm-reader": "tsx bin/llm-reader.ts"` script):
`serve` (starts the server), `open <path>` (POSTs to `/api/docs/open`, prints `http://127.0.0.1:5173/?doc=<id>` in dev
or `:7777` when `dist/` exists, and tries `xdg-open`), `doctor` (prints config path, data dir, profiles with hasKey).

## Viewer module (viewer agent implements `src/web/viewer/index.ts`; shell consumes `ViewerApi` from `api.ts`)

- `new Viewer(container: HTMLElement)`; `open(url, { state })` loads with `pdfjs-dist` `PDFViewer` (`pdfjs-dist/web/pdf_viewer.mjs`
  and its CSS), `rangeChunkSize: 65536`, `disableAutoFetch: true`, worker from `pdfjs-dist/build/pdf.worker.min.mjs?url`.
  PDF.js 6.4 removed `isEvalSupported`; do not pass it.
- One overlay `div` per page above the text layer for highlights and the cursor bar.
- Segment each visible page on `textlayerrendered` with `segmentPage` from `src/shared/segment/index.ts`
  (pure function: `getTextContent()` items + styles + page size → `PageText`, DESIGN.md 7.3 pipeline; v0 needs lines,
  paragraphs by vertical gap/indent, de-hyphenation, sentences via `Intl.Segmenter` plus an abbreviation list,
  running header/footer marking by position; column detection may be a simple single-column assumption with a note).
- Reading cursor per DESIGN.md 5.2: paragraph level (gutter bar) and sentence level (tint); comfort-band scrolling;
  snap to the first fully visible paragraph when the cursor is off screen; `extend`/`shrink`/`toggleParagraph`;
  cross-page movement into the next segmented page (segment on demand if needed).
- Emit `selection` with a full `StagedSelection` (passage with `quote`, `rects` from DOM ranges over text-layer spans
  normalized to PDF space, `surrounding` = containing paragraph with up to 2 paragraphs before and 1 after, the selection
  marked with ⟦ ⟧, `pageText`, `prevPageText` when available, `location.pageLabel` from `pdf.getPageLabels()`).
- Mouse selection inside the text layer stages at once, mapped through the char map; the cursor moves to its first sentence.
- `position` events (debounced) with page, scrollFrac, zoom; `jumpBack`; `goToPage`; `scrollBy`; zoom in/out around
  `page-width`.
- Theme: respect `prefers-color-scheme`; the tint is a pale, low-saturation color at ~35 % opacity.
- Tests in `test/segment/`: golden tests of `segmentPage` on fixtures built with `pdf-lib` (multi-line paragraph with
  a hyphen at a line end, two paragraphs with a gap, abbreviations like "e.g." and "Fig. 3", a page number footer),
  and char-map round trips. Run segmenter tests in Node (no DOM).

## Shell (shell agent)

- `main.ts` boots: fetch `/api/config`; if the URL has `?doc=<id>` open it, else show the library.
- Library (`src/web/library`): list from `/api/library`, type-to-filter, `Enter` opens (`POST /api/docs/open` for a file
  path, or the known docId), `Ctrl+O` file picker → `POST /api/docs` multipart, drag-and-drop.
- Layout: PDF pane 62 % / answer pane 38 %, status line at the bottom (mode · staged text summary · target thread · run state),
  `\` hides the pane. Focus ring on the focused pane.
- Commands (`src/web/commands`): a registry `register(id, handler)`, modes `NORMAL | ASK | READER | PALETTE` (PALETTE may be
  a minimal `:` prompt with `open`, `page <n>`, `help`), one capture-phase `keydown` listener, the `left` layout from
  DESIGN.md 5.4 (`home` layout optional), key auto-repeat ignored for presets, a 2 s duplicate guard.
  Command ids follow DESIGN.md 5.7 names (`cursor.next_paragraph`, `ask.preset:explain`, …).
- Ask flow: presets `explain` (`Enter`/`e`), `define` (`c`), `ask` (`v` opens the ask box near the passage; `Enter` sends,
  Shift+`Enter` newline, `Tab` toggles new/follow-up, `Esc` cancels, focus returns to the PDF). Follow-up rule: if the staged
  passage equals the latest thread's passage (same start/end/text), send to that thread; else create a thread first.
  `r` regenerates (new run, same request). `.` repeats the last preset. `Esc` cancels a stream in NORMAL.
- Answer pane (`src/web/chat`, Preact + signals): thread list for the document, current thread expanded, older threads
  collapsed to one line; streaming Markdown via `markdown-it` + `DOMPurify` + KaTeX (`$…$`, `$$…$$`); the pane scrolls so
  the first line of a new answer is at the top; `contextUsed` and usage under each answer; READER mode keys.
- API client (`src/web/api`): typed fetch wrappers and an `EventSource` reader for runs that yields `RunEvent`s.
- Reading state: restore from `/api/docs/:id/state` on open; `PUT` debounced (1 s) on `position` events.
- Status line notices from viewer `notice` events. First-run cheat card (`?` toggles) listing the ten core keys.
- Tests in `test/web/`: pure-logic tests only (keymap dispatch by mode, follow-up rule, markdown sanitization). No jsdom.

## Definition of done for each agent

- `pnpm typecheck` passes for the whole repo with your files in place (the other agents' files may still be stubs).
- Your tests pass under `pnpm test`.
- Your final report lists: files created, how to run or verify your part alone, any contract gap you worked around,
  and anything left incomplete.
