# llm-reader

A keyboard-first PDF reader with a built-in LLM tutor. You read a PDF, move a cursor through the text with single
keys, and one key sends the current sentence to the model with the context of the book attached. The answer streams
into a pane beside the PDF. Focus never leaves the PDF. The design is in [DESIGN.md](DESIGN.md).

This is v0: the Phase 0 build from the design. It runs with no API key, with a mock provider, so you can try the
whole loop first.

## Run

```bash
pnpm install
pnpm dev          # server on 127.0.0.1:7777, UI on http://127.0.0.1:5173
```

Open http://127.0.0.1:5173. The library lists the PDFs in `~/books` (change it with `LLM_READER_BOOKS_DIR`).
Type a few letters of a title and press `Enter`. You can also open a file from the shell:

```bash
pnpm llm-reader open ~/books/some-book.pdf
pnpm llm-reader doctor          # shows the config path, the data dir, and which profiles have a key
```

For a production-style run without Vite: `pnpm build && pnpm start`, then open http://127.0.0.1:7777.

## Keys (the `left` layout; the right hand rests)

| Key | Action |
|---|---|
| `Space` / `q` | Next / previous paragraph. The whole paragraph is selected; the gutter bar marks it. |
| `s` / `w` | Next / previous sentence |
| `d` / `a` | Add the next sentence / remove the last one |
| `p` | Switch between the selected sentence and its whole paragraph |
| Mouse | Point at text, then press `s` (its sentence), `Space` (its paragraph), or `d` (extend to it). No click needed. A click selects a sentence; a triple-click selects its paragraph. |
| `Enter` or `e` | Explain the staged passage |
| `c` | Define the terms |
| `v` | Ask a typed question (Enter sends, Shift+Enter adds a line, Tab toggles new thread / follow-up) |
| `Tab` | Move focus to the answer pane and back; there `s` `w` scroll 3 lines, `Space` `q` scroll a screen |
| `Esc` | Close the help, stop a streaming answer, or return to the PDF |
| `r` / `.` | Regenerate the last answer / repeat the last preset |
| `'` | Jump back to the reading position |
| `?` / `:` | Key help / command prompt (`open`, `page <n>`, `layout home`) |

A mouse selection in the PDF is staged at once. An ask on the same selection is a follow-up in the same thread.
Threads and the reading position persist across restarts.

## Configuration

Copy `config.example.toml` to `~/.config/llm-reader/config.toml` and edit the profiles. The config names an
environment variable for each key. It never holds a key. The `effort` field of a profile sets the Opus effort level.

Put the key in `~/.config/llm-reader/secrets.env`, next to the config, and run `chmod 600` on the file:

```bash
LLM_READER_ANTHROPIC_API_KEY=sk-ant-...
```

Only the llm-reader server reads this file. Do not export `ANTHROPIC_API_KEY` in your shell profile for this app.
Claude Code reads that variable too, so a global export can move Claude Code from your plan to API billing.
A variable that is already set in the environment wins over the file. `pnpm llm-reader doctor` shows whether the key
is set.

| Variable | Meaning |
|---|---|
| `ANTHROPIC_API_KEY` | Only when no config file exists: if set, both roles use the `claude` profile. Without it, the `mock` provider answers. |
| `LLM_READER_CONFIG` | Path of the config file. Default `~/.config/llm-reader/config.toml`. |
| `LLM_READER_SECRETS` | Path of the secrets file. Default: `secrets.env` next to the config file. |
| `LLM_READER_DATA_DIR` | Where the SQLite database and the PDF blobs live. Default `~/.local/share/llm-reader`. |
| `LLM_READER_BOOKS_DIR` | The directory the library lists. Default `~/books`. |

A local OpenAI-compatible server (colinfer, llama.cpp, vLLM, Ollama) works through the `local` profile.

## Develop

```bash
pnpm typecheck
pnpm test         # Vitest: server (real HTTP, temp dirs), segmenter (pdf-lib fixtures), web (pure logic)
pnpm build
```

Layout: `src/server` (Hono, SQLite, LLM drivers, context builder, SSE runs), `src/web/viewer` (PDF.js, reading cursor),
`src/shared/segment` (text segmentation shared by browser and server), `src/web/app|commands|chat|library` (the shell).
