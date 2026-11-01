# llm-reader

A keyboard-first PDF reader with a built-in LLM tutor. You read a PDF, move a cursor through the text with single
keys, and one key sends the current sentence to the model with the context of the book attached. The answer streams
into a pane beside the PDF. Focus never leaves the PDF.

The app runs with no API key: a mock provider answers, so you can try the whole loop first. With a key, Claude answers.
A local OpenAI-compatible server works too.

## Run

Requirements: Node 22.12 or later, and pnpm.

```bash
pnpm install
pnpm dev          # server on 127.0.0.1:7777, UI on http://127.0.0.1:5173
```

Open http://127.0.0.1:5173. The library lists the PDFs in `~/books` and the documents you opened before. Type a few
letters of a title, then press `Enter`. `Ctrl+O` opens a file from anywhere. A PDF dropped on the window opens too.
You can also open a file from the shell:

```bash
pnpm llm-reader open ~/books/some-book.pdf
pnpm llm-reader doctor          # shows the config path, the data dir, and which profiles have a key
```

For a run without Vite: `pnpm build && pnpm start`, then open http://127.0.0.1:7777.

The server listens on 127.0.0.1 only. It accepts state-changing requests only from a page on `localhost` or
`127.0.0.1`, on any port, so a forwarded port from VS Code or SSH works.

## Keys

The default layout keeps the frequent keys under the left hand. `:layout home` switches to a vim-style layout
(`j` `k` move, `l` `h` extend and shrink, `a` asks).

| Key | Action |
|---|---|
| `Space` / `q` | Next / previous paragraph. The whole paragraph is selected; the gutter bar marks it. |
| `s` / `w` | Next / previous sentence |
| `d` / `a` | Add the next sentence / remove the last one |
| `p` | Switch between the selected sentence and its whole paragraph |
| Mouse | Point at text, then press `s` (its sentence), `Space` (its paragraph), or `d` (extend to it). No click is needed. A click selects a sentence; a triple-click selects its paragraph. |
| `Enter` or `e` | Explain the staged passage |
| `c` | Define the terms |
| `v` | Ask a typed question in the box at the bottom of the answer pane. `Enter` sends, `Shift+Enter` adds a line, `Tab` switches between a new thread and a follow-up. |
| `Tab` | Move focus to the answer pane and back. There `s` `w` scroll 3 lines, `Space` `q` scroll a screen, `y` copies the thread as Markdown. |
| `Esc` | Close the help, stop a streaming answer, or return to the PDF |
| `r` / `.` | Regenerate the last answer / repeat the last preset |
| `'` | Jump back to the reading position |
| `\` | Show or hide the answer pane |
| `?` | Key help. The `?` Shortcuts button in the status line opens it too. |
| `:` | Command prompt: `open` (the library), `page <n>`, `layout left|home`, `pane`, `help` |

A mouse selection in the PDF is staged at once. An ask on the same passage as the latest thread is a follow-up in
that thread. The status line shows the mode, the staged passage, and the state of the answer. Threads and the reading
position persist across restarts.

## Configuration

Copy `config.example.toml` to `~/.config/llm-reader/config.toml` and edit the profiles. A profile names the provider,
the model, and the environment variable that holds its key. The config never holds a key itself. The `effort` field of
an Anthropic profile sets the effort level.

Put the key in `~/.config/llm-reader/secrets.env`, next to the config, and run `chmod 600` on the file. The variable
name is the one the profile names in `api_key_env`; the example config uses its own name:

```bash
LLM_READER_ANTHROPIC_API_KEY=sk-ant-...
```

Only the llm-reader server reads this file. Do not export `ANTHROPIC_API_KEY` in your shell profile for this app.
Claude Code reads that variable too, so a global export can move Claude Code from your plan to API billing.
A variable that is already set in the environment wins over the file. `pnpm llm-reader doctor` shows whether the key
is set.

| Variable | Meaning |
|---|---|
| `ANTHROPIC_API_KEY` | Only when no config file exists: if set, the built-in `claude` profile answers. Without it, the `mock` provider answers. |
| `LLM_READER_CONFIG` | Path of the config file. Default `~/.config/llm-reader/config.toml`. |
| `LLM_READER_SECRETS` | Path of the secrets file. Default: `secrets.env` next to the config file. |
| `LLM_READER_DATA_DIR` | Where the SQLite database and the PDF blobs live. Default `~/.local/share/llm-reader`. |
| `LLM_READER_BOOKS_DIR` | The directory the library lists. Default `~/books`. |

A local OpenAI-compatible server (llama.cpp, vLLM, Ollama, and others) works through the `local` profile of the
example config.

## Develop

```bash
pnpm typecheck
pnpm test         # Vitest: server (real HTTP, temp dirs), segmenter (pdf-lib fixtures), web (pure logic)
pnpm build
```

| Path | Content |
|---|---|
| `src/server` | Hono API, SQLite store, LLM drivers, context builder, SSE runs |
| `src/web/viewer` | PDF.js viewer, reading cursor, selection overlay |
| `src/web/app`, `commands`, `chat`, `library` | The shell: views, key map, answer pane, library |
| `src/shared` | The types and the text segmenter that the browser and the server share |
| `bin` | The `llm-reader` command line |
| `test` | The test suites |

## Documentation

- [DESIGN.md](DESIGN.md) is the design: the problem, the interaction model, the context strategy, and the plan.
  Phase 0 of that plan is what this repository builds. The later phases are plans, not the current program.
- [docs/design/](docs/design/) holds the three research appendices behind the design: interaction, context and
  prompts, and architecture. Where an appendix and DESIGN.md differ, DESIGN.md wins.
