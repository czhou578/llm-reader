# llm-reader: design

**Status:** design v0.4, 2026-10-23; Phase 0 (section 10) is built as of 2026-10-31, see [README.md](README.md). The later phases describe plans, not the current program. v0.2 added the running-cost estimate (section 6.7). v0.3 applied the user's answers to the open questions: a left-hand keymap, local files first, and a local-model option (sections 5.7, 6.8, 13). v0.4 removes voice input and read-aloud at the user's request.
**Audience:** the author of the tool, and anyone who builds on it later.
**Detail:** this file is the authoritative design. The three research appendices under
[docs/design/](docs/design/) hold the full detail. Where an appendix differs from this file, this file wins.

---

## 1. Summary

llm-reader is a keyboard-first PDF reader with a built-in LLM tutor. The PDF is on the left. The answer pane is on the right. The user moves a reading cursor through the text with single keys. All frequent keys sit under the left hand, because the user's right hand is the one that hurts. One key sends the current sentence to the model, with the context of the book attached. The answer streams into the pane. Focus never leaves the PDF. There is no clipboard and no tab switch.

The design rests on three decisions:

1. **One page, one keymap.** A local web app renders the PDF with PDF.js, so the app owns the text layer and the keys. A browser extension and a desktop wrapper can reuse the same code later.
2. **The passage is the prompt.** A selection in the PDF becomes the staged passage at once. The app adds the book title, the chapter, the surrounding paragraphs, a running summary, the book's own definitions, and the user's past questions. This makes the answers better, not only cheaper to get.
3. **Answers become marginalia.** Each question is a thread anchored to a passage. The anchors persist across sessions, show in the page margin, and export to Markdown.

The plan has three phases. Phase 0 is a weekend build that already removes the copy-paste and the focus-switch pain. Phase 1 adds the context engine and the notes. Phase 2 adds figures, OCR, and learning features.

An hour of reading costs about a quarter of a US dollar on Opus 5.5 with prompt caching, so the tool is cheap to run (section 6.7).

---

## 2. The problem

The user reads online PDFs and asks an LLM to clarify passages. Today the user keeps two browser tabs side by side: one with a chat UI, one with the PDF. For each question the user does this:

1. Drag the mouse across the passage.
2. Press Ctrl+C.
3. Move the mouse or press Alt+Tab to the chat tab.
4. Click the prompt box.
5. Press Ctrl+V, then Enter.
6. Scroll the answer with the mouse wheel.
7. Switch back to the PDF tab.
8. Find the reading position again.

The user's hands hurt from the mouse. The user dislikes the focus switch and the copy-paste. The pain has three parts:

| Part | Effect |
|---|---|
| Mouse work | A precise drag, two clicks, a scroll, and a tab switch for every question. |
| Focus switches | Two switches per question. The user loses the reading position each time. |
| Bare context | The model gets one sentence. It knows nothing about the book, the chapter, or earlier questions. The answers are generic. |

The third part is not a comfort problem. It is a quality problem. Section 6 explains why.

---

## 3. Goals and non-goals

Goals, in priority order:

1. **Less hand strain.** The core loop needs no mouse and no chorded keys. Frequent actions use one unshifted key under the left hand or the thumb. The user's right hand hurts from mouse clicks, so it rests.
2. **No loss of place.** The PDF pane keeps focus and the reading position. An answer never moves the user's place in the text.
3. **Few keystrokes.** The common case, "explain the sentence that I just read", takes three keys or fewer.
4. **Better answers.** Every ask carries the context of the book at zero cost to the user.
5. **Durable notes.** Questions and answers survive a restart, a cleared browser, and a new copy of the PDF. They export to plain Markdown.
6. **Hackable.** One language, one process, one SQLite file. The user can change any prompt, key, or provider in a config file.

Non-goals for v1:

- No cloud sync, accounts, or sharing. One user on one machine.
- No mobile layout.
- No edits to the PDF file. Notes live in the database, not in PDF annotations.
- No EPUB, HTML, or DjVu input.
- No built-in OCR engine. OCR is an optional call to `ocrmypdf`.
- No reading of cookies from browser profiles.
- No embeddings or vector index.
- No tool use or agent loops in the LLM adapter.
- No packaged extension or desktop app. Linux is the only tested platform.

---

## 4. The product in one page

### 4.1 The screen

```
┌─────────────────────────────────────────────┬───────────────────────────────┐
│ PDF pane (62 %)                             │ Answer pane (38 %)            │
│                                             │                               │
│ ▌ 2.3 The canonical ensemble                │ #7 · p. 42 · Explain          │
│   In the microcanonical ensemble the ...    │ > "In the canonical ensemble  │
│   ░In the canonical ensemble the system░ ⑦  │   the system exchanges ..."   │
│   ░exchanges energy with a reservoir ...░   │                               │
│   The partition function Z then ...         │ The passage says that ...     │
│                                             │                               │
│   (figure)                                  │ Q: why is the temperature     │
│                                             │    fixed but not the energy?  │
│                                             │ A: Because the reservoir ...  │
├─────────────────────────────────────────────┴───────────────────────────────┤
│ NORMAL · S · 1 sentence · 24 words · p. 42 · follow-up #7    ● ready · Tab │
└─────────────────────────────────────────────────────────────────────────────┘
```

- The **gutter bar** (▌) marks the current paragraph.
- The **tinted sentence** (░) is the staged passage.
- The **anchor tag** (⑦) marks a passage that has a thread.
- The **status line** shows the mode, the staged text, the target thread, and the answer state.
- The answer pane can hide with one key. Then the PDF uses the full width, and answers open in an overlay.

### 4.2 The core loop

1. The user reads. `Space` moves to the next paragraph. This replaces the mouse wheel, so the cursor tracks the reading position for free.
2. A sentence is confusing. `s` moves the cursor onto it. `d` adds the next sentence if needed.
3. `Enter` sends "explain this". The app builds the context in under 50 ms and streams the answer into the pane. Focus stays in the PDF.
4. The user reads the answer. For a long answer, `Tab` moves into the pane and `Space` scrolls it. `Esc` returns.
5. `x` asks for an example in the same thread. `v` opens the ask box for a typed question.
6. `Space` continues reading. The cursor is where the user left it.

### 4.3 A 60-second session

The user reads page 42 of a two-column physics textbook.

| Time | Key | What happens |
|---|---|---|
| 0 s | (open) | The document opens at the stored reading position. |
| 8 s | `Space` | The gutter bar moves to paragraph 2. |
| 17 s | `Space` | The bar moves to paragraph 3. |
| 21 s | `s` `s` | The second sentence of paragraph 3 gets the tint. The status line shows "1 sentence · 24 words · new thread". |
| 23 s | `Enter` | Explain. The status line shows "◌ explain… 1 s". A ring pulses in the gutter. |
| 25 s | | The answer streams into the pane, first line at the top. The user reads it with no key. |
| 33 s | `Tab` `Space` | The answer is long. Focus moves to the pane and scrolls one screen. |
| 40 s | `v` | The ask box opens. Its header says "Follow-up in thread #7". |
| 41 s | (types) | "why is the temperature fixed but not the energy" |
| 47 s | `Enter` | The follow-up streams below the first answer. The box closes. Focus returns to the PDF. |
| 55 s | `Esc` | The pane loses focus. The cursor is still on the sentence. |
| 57 s | `Space` | The bar moves to the next paragraph. The user reads on. |

| Measure | Old workflow | llm-reader |
|---|---|---|
| Mouse actions | 3 to 5, one is a precise drag | 0 |
| Chorded keys | 3 to 4 | 0 |
| Focus switches between tabs | 2 | 0 (one optional pane switch) |
| Re-find the reading position | Yes | No |
| Context sent to the model | The pasted text | The passage plus the book context |

Without the follow-up, the question costs three keys: `s` `s` `Enter`. Apart from the typed question, every key in the session is under the left hand or the thumb.

---

## 5. Interaction design

### 5.1 The text model

All keyboard mechanisms depend on one structure: the document as **pages → paragraphs → sentences**, in reading order. Each sentence maps back to spans in the PDF.js text layer, so the UI can highlight it. A sentence can cross a line, a column, or a page break. Section 7.3 describes how the app builds this model.

The status line always shows the **cleaned text** that the model gets. A text-layer defect is visible before the question goes out, and the user can fix the selection with one key.

### 5.2 Selection without a mouse

The app offers four mechanisms. The reading cursor is primary. Hint mode is secondary.

**A. The reading cursor (primary, Phase 0).** The cursor has two levels:

- Paragraph level. `Space` moves to the next paragraph. `q` moves to the previous one. A thin bar in the left gutter marks the current paragraph. The text gets no tint, so normal reading is not disturbed.
- Sentence level. `s` and `w` move to the next and the previous sentence. The current sentence gets a soft tint.

The page scrolls only when the cursor leaves a comfort band in the middle of the viewport. The text on the screen stays still while the user reads. If the cursor is off screen after a wheel scroll, the next movement key snaps it to the first fully visible paragraph.

The selection extends without a chord. `d` adds the next sentence. `a` removes the last one. `p` toggles between the sentence and the whole paragraph; it is a right-hand key because it is rare. `Esc` collapses the selection to one sentence.

| Text-layer problem | UI behavior |
|---|---|
| Line breaks inside a sentence | The highlight covers all line fragments. The staged text joins the lines with one space. |
| Hyphen at a line end | The model joins `exam-` + `ple`. The staged preview shows `example`. |
| Two columns | The cursor moves column by column. `:order single` fixes a wrong order for the page. |
| Running headers, footers, page numbers | The cursor skips them. |
| Footnotes and captions | The cursor skips them in normal flow. Hint mode can still select them. |
| Sentence across a page break | The highlight shows on both pages. |
| Math or garbled glyphs | A warning icon appears when more than 20 % of the characters are not normal letters. Phase 2 adds "send this region as an image". |
| No text layer (scan) | The status line says so. Mouse region selection and OCR are the fallback. |
| Bad sentence split ("e.g.", "Fig. 3") | `d` and `a` fix it with one key. The segmenter knows common abbreviations. |

**B. Hint mode (secondary, Phase 1).** `f` shows a two-letter label at the start of every visible sentence. The user types the label, and the cursor moves there. Both letters come from the left hand, so the right hand stays at rest; fifteen letters give 225 labels. All labels have two letters and there is no timeout. In hint mode, `p` switches the labels to paragraph starts. Hint mode is the best tool for a far jump, for example to the other column or to a caption.

**C. Search to select (Phase 1).** `/` opens a one-line input. The search is incremental and uses normalized text. `Enter` selects the sentence that contains the match. The matched words stay stored as the **focus term**. The Define preset uses the focus term when one exists, so `/entropy` `Enter` `c` defines the one word.

**D. Mouse selection (Phase 0).** Any mouse selection becomes the staged passage at once. The user never copies or pastes. A double-click on a word stages the word as the focus term. A small floating toolbar with the preset names appears for mouse-only use. After a mouse selection, the reading cursor moves to the first selected sentence, so keyboard and mouse stay consistent. A plain click selects the sentence under the pointer, and a triple-click selects its paragraph.

**E. Point and key (Phase 0).** After the pointer moves over the PDF, the next `s` or `w` selects the sentence under the pointer, `Space` or `q` selects its paragraph, and `d` extends the selection to it. The user moves the mouse but does not click, which spares the clicking hand. Any other cursor key resets the aim, and a move under 12 px does not count, so a bumped mouse does not move the cursor. This is the fast way to jump to a far place on the screen; hint mode (B) is the keyboard-only way.

| Mechanism | Keys to a nearby target | Keys to a far target on screen | Tracks the reading position | Phase |
|---|---|---|---|---|
| Reading cursor | 1 to 3 | 5 to 15 | Yes | 0 |
| Hint mode | 3 | 3 | No | 1 |
| Search to select | 4 to 8 | 4 to 8, also off screen | No | 1 |
| Mouse selection | 1 drag | 1 drag | No | 0 |

### 5.3 The ask loop

**Modes.** The status line always shows the current mode.

| Mode | Focus | Letter keys |
|---|---|---|
| `NORMAL` | PDF pane | Move, select, ask. This is the default. |
| `HINT` | PDF pane | Type a hint label. |
| `SEARCH` | Status-line input | Type search text. |
| `ASK` | The ask overlay | Type the question. |
| `READER` | Answer pane or reader overlay | Scroll the answer, ask a follow-up. |
| `PALETTE` | Command palette | Type a command name. |

**Presets.** A preset is one key that sends the staged passage with a fixed intent. The movement keys and the frequent preset keys are all under the left hand, because the user's right hand is the one that hurts. The right hand rests. It joins in only when the user types a free-text question.

| Key | Preset | Intent | Target length | Phase |
|---|---|---|---|---|
| `Enter` or `e` | Explain | What it means, why the author says it here, what "this" refers to. | ≤150 words | 0 |
| `c` | Define | Define the terms, or only the focus term. Cite the book's own definition. | ≤5 terms × 40 words | 0 |
| `v` | Ask | Open the ask box for a typed question. | ≤200 words | 0 |
| `z` | Simplify | The same claims in plain words. | ≤ the original | 1 |
| `x` | Example | One concrete example, mapped back to the passage. | ≤200 words | 1 |
| `b` | Why / Connect | Purpose, what it depends on, what it sets up. | ≤200 words | 1 |
| `g` | Gist | Two or three sentences. | ≤60 words | 1 |
| `t` | Translate | Into the language in the settings. | ≈ the source | 1 |
| none | Check me, Critique, Steps, Quiz | The user restates the passage and the model grades it. Steelman and critique. Restate as steps. Three questions on the page. Run from the palette, or bind a key in the keymap file. | see appendix | 1 |

The letters are mnemonic where the left hand allows: `e` explain, `c` clarify the terms, `x` example, `b` because, `g` gist, `t` translate. `v` for Ask and `z` for Simplify have no mnemonic; they are the free keys under the left hand. The number row `1` to `5` is free for user presets.

`Enter` is the default preset because a paste into a chat UI with no question meant "explain this". The old habit maps to one key.

**The ask box.** `v` opens a one-line box that grows to five lines. It appears just below the passage, or above it when the passage is near the bottom. The header shows the first 80 characters of the staged text and the target: "New question" or "Follow-up in thread #4". `Enter` sends. Shift+`Enter` adds a line. `Tab` toggles between new thread and follow-up. `Esc` cancels. On send or cancel, focus returns to the PDF, and the cursor does not move.

**Follow-ups.** The rule is simple and visible:

- If the selection equals the passage of the most recent thread, the ask is a follow-up.
- If the selection differs, the ask starts a new thread at the new selection.
- The status line shows the target before each send.

So `Enter` then `x` gives "an example of that" in the same thread, with no extra key. In `READER` mode the preset keys act on the last answer, so `z` means "simplify your last answer".

**Cancel, regenerate, repeat.** `Esc` stops the stream when no overlay is open, and keeps the partial text. `r` regenerates and keeps the old version under a fold. `.` repeats the last preset on the current selection, which is fast for a list of terms: `s` `.` `s` `.`

Preset keys ignore key auto-repeat. A second press of the same preset on the same passage within two seconds is ignored. A held key never sends ten requests.

### 5.4 The keymap

The `left` layout, the default. Every frequent action sits under the left hand. Rare actions use right-hand keys or the command palette. Section 5.7 describes the `home` layout for users who know vim keys.

| Key | Action | Mode |
|---|---|---|
| `Esc` | Close the overlay or mode. Stop a streaming answer. Collapse the selection. Return focus to the PDF. | Global |
| `Tab` | Toggle focus between the PDF pane and the answer pane. | NORMAL, READER |
| `:` | Open the command palette: go to page, open file, settings, every action by name. | NORMAL, READER |
| `?` | Show the keymap help. | NORMAL, READER |
| `Space` / `q` | Next / previous paragraph. | NORMAL |
| `s` / `w` | Next / previous sentence. | NORMAL |
| `d` / `a` | Extend / shrink the selection by one sentence. | NORMAL |
| `p` | Toggle sentence / paragraph selection. | NORMAL |
| `f` | Hint mode. | NORMAL |
| `/` | Search to select. | NORMAL |
| `'` | Jump back to the reading position. Toggles between the last two positions. | NORMAL |
| `]` / `[` | Next / previous Q&A anchor. | NORMAL, READER |
| `o` | Open or close the margin card at the cursor. | NORMAL |
| `` ` `` | Open the reader overlay for the latest answer. | NORMAL |
| `\` | Show or hide the answer pane. | NORMAL |
| `Enter`, `e` | Explain. | NORMAL, READER |
| `c` | Define the terms. | NORMAL, READER |
| `v` | Ask: open the ask box for a typed question. | NORMAL, READER |
| `x`, `z`, `b`, `g`, `t` | Example, Simplify, Why, Gist, Translate (section 5.3). | NORMAL, READER |
| `.` | Repeat the last preset on the current selection. | NORMAL |
| `r` | Regenerate the last answer. | NORMAL, READER |
| `m` | Mark the passage as confusing, with no question. | NORMAL |
| `Down` / `Up`, `PageDown` / `PageUp` | Free scroll. The cursor does not move. | NORMAL |
| `=` / `-` | Zoom in / out. | NORMAL |

Keys in `READER` mode only:

| Key | Action |
|---|---|
| `s` / `w` | Scroll the answer by three lines. |
| `Space` / `q` | Scroll the answer by one screen. |
| `]` / `[` | Next / previous message in the thread. |
| `y` | Append the thread to the user's notes file as Markdown. Copies to the clipboard when no notes file is set. |
| `` ` `` | Switch between the pane and the full reader overlay. |
| `Esc` or `Tab` | Return to the PDF at the reading position. |

In `ASK` and `SEARCH` modes all letters are text. A letter never runs a `NORMAL` action while a text input has focus.

### 5.5 Focus rule and answer signals

**The PDF pane owns focus.** Only four things take focus away, and each one gives it back:

| What takes focus | How focus returns |
|---|---|
| `v` (ask box) | Automatically on `Enter` or `Esc`. |
| `/` (search) | Automatically on `Enter` or `Esc`. |
| `:` (palette) | Automatically when the command runs, or on `Esc`. |
| `Tab` or `` ` `` (read the answer) | `Esc` or `Tab`, one key. |

A streaming answer never takes focus. It never moves the cursor and never scrolls the PDF.

The answer pane scrolls so that the **first line** of a new answer is at the top. It does not follow the end of the stream, because the user reads from the top. A short answer fits in the pane, so the user reads it with no key.

Three signals show the answer state, from most to least visible:

1. **The status line.** `◌ explain… 3 s` while the answer streams. `● ready · Tab to read` when it is done. `✕ error · r to retry` when it fails. The line is an `aria-live` region.
2. **The margin ring.** A small ring pulses next to the passage during the stream. It becomes a solid numbered tag when the answer is done.
3. **A chime, off by default.** It plays only for answers that take more than 5 seconds, so the user can look away and still know when to come back.

### 5.6 Where answers appear

Answers appear in **both** places, with different jobs:

- **The answer pane** holds the full threads. Old threads collapse to one line: the question and a one-line gist. The current thread is always expanded.
- **The margin** holds compact anchors. A tag in the gutter, level with the first line of the passage, shows the thread number. Blue is a question thread. Amber is a passage marked with `m`. Green is a check-me thread. The shapes differ too, so color blindness is not a problem. The passage keeps a faint underline. Ticks on the PDF scrollbar show where the anchors are. This is the basic confusion map.

Navigation between anchors is an excursion. `]` and `[` move the cursor to the next or previous anchor and scroll the pane to its thread. The stored reading position does not change, so `'` returns to it. `o` opens an inline card under the passage with the gist and the last question.

A long answer is read without the mouse in two ways. `Tab` then `Space` scrolls the pane. `` ` `` (backtick) opens a reader overlay in the center of the screen with a 70-character line and a larger font. The overlay is the default view when the pane is hidden.

### 5.7 Ergonomics

- **Left hand first.** The user's right hand hurts from mouse clicks. The whole core loop runs on the left hand: `Space`, `q`, `w`, `s`, `a`, `d`, `Enter`, `e`, `c`, `v`. The right hand rests and handles only rare keys.
- **No chords for frequent actions.** Shift appears only on `?` and `:`. Ctrl appears nowhere in the core loop.
- **Key repeat.** Movement keys repeat at the OS rate. Presets never repeat.
- **Esc reach.** The help page tells the user to map Caps Lock to Esc at the OS level. The keymap file also accepts a second back key, for example `;`.
- **No timeouts.** No interaction needs a fast second key.
- **Hardware.** Every frequent action is one key, so a USB foot pedal or a macro pad can send `Space` and `Enter`. A foot pedal on `Space` removes the most frequent press from the hands.

**Two layouts.** `left` is the default. `home` is the vim-style layout for users who already know it. Rare keys are the same in both.

| Action | `left` (default) | `home` |
|---|---|---|
| Next / previous paragraph | `Space` / `q` | `Space` / `b` |
| Next / previous sentence | `s` / `w` | `j` / `k` |
| Extend / shrink | `d` / `a` | `l` / `h` |
| Define | `c` | `d` |
| Ask | `v` | `a` |
| Simplify | `z` | `s` |
| Why / Connect | `b` | `w` |
| Check me | palette | `q` |
| Cancel the stream | `Esc` | `c` or `Esc` |
| Reader overlay | `` ` `` | `z` |

The `left` layout follows the WASD convention from games: `w` up, `s` down, `a` left, `d` right. A user who does not know vim keys learns it in one session. The core loop is ten keys: `Space`, `q`, `w`, `s`, `a`, `d`, `Enter`, `c`, `v`, `Esc`. Two learning aids help at the start: a first-run cheat card, and a key-hint strip in the status line that shows the five most useful keys for the current mode. The strip is on for the first ten sessions and then off.

**The keymap file** is `~/.config/llm-reader/keymap.toml`. Every action has a stable name. The help page and the palette read the same file. A user preset has a key, a label, and an intent text:

```toml
layout = "left"
back_key_extra = ";"

[normal]
"space" = "cursor.next_paragraph"
"s"     = "cursor.next_sentence"
"enter" = "ask.preset:explain"

[presets.proof]
key    = "1"
label  = "Walk through the proof"
intent = "Walk through this argument one step at a time."
```

**Layout and theme defaults.**

| Item | Default |
|---|---|
| Split | PDF 62 %, pane 38 %. `:split 70` changes it. |
| Answer text | 18 px, line height 1.6, at most 70 characters per line, the system sans-serif font. |
| Cursor tint | A pale, low-saturation color at 35 % opacity. It never hides the text. |
| Theme | Follows the OS. Options: light, sepia, dark. Dark mode inverts the page canvas with a hue rotation, with an option to keep images in true colors. |
| Motion | All scrolls obey `prefers-reduced-motion`. |
| Focus ring | A clear 2 px outline on the pane that has focus. |

---

## 6. Context strategy

### 6.1 Why a bare paste gives mediocre answers

In the old workflow the model receives one thing: the pasted text. It does not know:

| Missing | Effect |
|---|---|
| The book, the author, the field | The model guesses the field and explains a term with its most common meaning, not the book's meaning. |
| The chapter and the section | The model explains the sentence, not the role of the sentence. |
| The surrounding paragraphs | "This", "the second approach", "as shown above" have no referent. The model guesses. |
| Earlier definitions and notation | The model redefines symbols. The book uses `k` for the number of clusters, and the model treats `k` as an index. |
| The user's earlier questions | The model explains the same background again. It cannot say "this is the invariant from page 42". |
| The reader's background | The model picks a level at random. |

Example. The user pastes: *"This is why the second approach fails: it conflates the two kinds of error that we distinguished above."* With a bare paste, the model says "the approach mixes two types of error". That is correct and useless. With the context, the model sees that "the second approach" is the pooled estimator from page 141, and that the two errors are the book's *sampling error* and *specification error* from page 137. It can now say which error the pooled estimator hides.

Context also costs effort in the old workflow. A user with hand pain pastes one sentence, never three paragraphs, and never types "I am reading chapter 7 of X". The answer quality drops when the user is most tired. In llm-reader, context costs zero keystrokes on every ask.

Automatic context is the largest quality gain of the product. The removal of copy-paste makes each ask cheaper. The automatic context makes each answer better. The two multiply: the user asks more often, and each answer is more specific.

### 6.2 Layers and budget

Rules:

1. The ask path makes exactly one LLM call. All other context comes from local data or from background jobs that already finished.
2. The app assembles the context in less than 50 ms.
3. Importance controls the trim order. Stability controls the position in the prompt. Stable layers go first, so the provider can cache them.
4. A "context used" line under each answer shows what was sent, for example `passage · p. 142 ±1 paragraph · ch. 7 summary · 3 past Q&A · 5,400 tok`.

The default budget is **6,000 input tokens**. A book page is roughly 500 to 800 tokens.

| Layer | Content | Budget (tokens) | Trim order |
|---|---|---|---|
| S | System prompt | ~400 | never |
| C | Title, authors, chapter-level table of contents | ~300 | never |
| F | Reader profile and per-document goal | ≤150 | never |
| A | The selected passage, its location, the preset instruction | ≤2,000, hard cap 4,000 | never |
| B | Surrounding paragraphs, selection marked in place | 1,200 | 7 |
| G | Glossary hits: terms the book defines that occur in A or B | 400 | 5 |
| D1 | Running summary of the current chapter so far | 600 | 6 |
| D2 | Summary of the book up to this chapter | 400 | 2 |
| E1 | Turns of the active thread (follow-ups only) | 2,500 | 8 |
| E2 | The 2 most recent threads in this chapter, compact | 500 | 4 |
| E3 | Q&A index: one line per past thread | 600 | 3 |
| E4 | Up to 2 related threads from other chapters | 500 | 1 |

Unused budget expands B by whole paragraphs, two paragraphs before for each one after, because earlier text sets up the referents. B never crosses a chapter boundary. A selection over the hard cap is never truncated silently. The app offers to narrow it or to send a **Deep ask** with the full chapter, capped at 30,000 tokens.

Phase 0 ships S, C, F, A, and B only. It uses the raw text of the previous page in place of D1.

### 6.3 Prompt order and caching

The prompt runs from stable to volatile. The page number and the preset instruction go last, so the cached prefix stays valid.

```
[system]   S

[user]
<document> C </document>            static per document
<reader> F </reader>                static per document
<book_so_far> D2 </book_so_far>     changes once per chapter
<chapter_so_far> D1 </chapter_so_far>  changes every ~3 pages
                                    ← cache breakpoint
<glossary> G </glossary>
<past_questions> E3 </past_questions>
<recent_threads> E2, E4 </recent_threads>
<surrounding_text pages="141-142"> B, with ⟦selection⟧ marked </surrounding_text>
<request>
location: Part II > Ch. 7 > 7.3 — page 142 (PDF page 158)
selected passage: """ A """
{{preset instruction}}
</request>
```

The stable prefix is about 2,000 tokens and is byte-identical between asks. No timestamps or random ids go into it. The adapter marks two cache breakpoints: after D1, and after turn 1 of a thread. The usage readout shows cached tokens, so the user can see whether caching works.

### 6.4 Background jobs

Two model roles exist in the config: **strong** for asks and **fast** for background work. The fast role is a good fit for a local model.

| Job | What it gives | Cost | When | Phase |
|---|---|---|---|---|
| Text extraction, page-label map, bookmark outline | Prerequisite for all layers. The page-label map links printed page "142" to PDF page 158. | Local, no LLM | On open, current page first | 0 |
| Outline from running headers | Chapter names when the PDF has no bookmarks | Local | On open | 1 |
| Running summary D1, D2 | "Earlier in the chapter" context | ~1,000 fast tokens per page read | After every 3 pages read with a dwell of 15 s or more | 1 |
| Book glossary | The book's own definitions on every ask. A single-word Define becomes near-instant. | ~1,200 fast tokens per page | Per read page, plus one page look-ahead | 1 |
| Define cache | A repeated Define returns at once | Local | After each Define | 1 |
| Q&A index line | Feeds E3 | One small fast call | After each answer | 1 (Phase 0 uses the first sentence) |
| Outline from the printed contents page | Fallback when headers fail | One fast call | Once | 2 |

Background jobs run one at a time. They pause while an ask streams. They never block an ask. Prediction of confusing passages and page embeddings are rejected. The confusion map uses real asks, and lexical search covers retrieval at this scale.

### 6.5 Threads and memory of past questions

The model is **one thread per passage anchor, plus a compact memory of all other threads.**

| Item | New ask (turn 1) | Follow-up |
|---|---|---|
| S, C, F | Yes | Identical bytes, cached |
| D1, D2 | Current versions | The versions frozen at turn 1 |
| G, B | Fresh | From turn 1 only |
| E2, E3, E4 | Yes | No, already in turn 1 |
| Earlier turns | — | All, until 2,500 tokens. Then turn 1 plus the last 2 turns, with a 100-word summary of the middle. |

A follow-up resends turn 1 byte for byte, so a provider with prefix caching charges the full thread once.

"What we discussed on page 42" works without an LLM call or embeddings. The Q&A index (E3) holds one 35-token line per past thread: `#17 p.42 [explain] "The kernel trick replaces…" → inner products come from the kernel; no explicit map.` Before each ask, the app scans the question. `#17` includes thread 17. `page 42` includes the threads on printed page 42. "Earlier", "we discussed", or "you said" plus a matching word runs a full-text search over past threads. Matched threads go in compact form, at most 1,200 tokens. In Phase 1, SQLite FTS5 finds related threads from other chapters for E4.

### 6.6 The system prompt

```
You are a reading tutor. The reader is reading the document described in the <document> block. They select a passage and ask for help with it. Your job is to make that passage clear to this reader, so that they can return to the book quickly.

Rules:
1. Ground the answer in the selected passage and in the context given. The surrounding text marks the selection with ⟦ ⟧.
2. Use the book's own terms and notation. If the book uses a term in a way that differs from common usage, use the book's meaning and say that it differs.
3. Resolve back-references. When the passage says "this", "the above", or "the second approach", name the specific thing it refers to.
4. Answer first. Do not restate the passage. Do not open with praise of the question. Do not end with offers of more help or with a summary of what you just said.
5. Be concise. Obey the length limit in the request. A shorter correct answer is better than a complete one.
6. If you must assume something, state the assumption in one short line that starts with "Assumption:".
7. If the passage is wrong, ambiguous, or badly written, say so directly. Then give the most likely intended meaning. Do not defend unclear text.
8. Separate the book from your own knowledge. Start a sentence that adds outside knowledge with "Outside the book:".
9. Do not invent quotes, page numbers, or content of the book. If the answer needs material that is not in the context, say what is missing.
10. Fit the answer to the <reader> profile. Do not explain what the profile says the reader knows.
11. Format: Markdown. Use $...$ for inline math and $$...$$ for display math. Use a numbered list only for real sequences.
```

The preset instruction goes into the request block. Two examples:

```
Task: Explain the selected passage.
- Say what it means in plain terms, then why the author says it at this point in the chapter.
- Name the specific referent of every back-reference in the passage.
- If the passage depends on an earlier definition or result, name it and give its page if the context gives one.
Length: at most 150 words. If the passage is a multi-step argument, at most 250 words.
```

```
Task: Define the terms in the selected passage that this reader may not know.
- If the selection is a single word or symbol, define only that word or symbol.
- Give the meaning that the book uses here. If the <glossary> has the book's definition, use it and cite its page.
- If the common meaning differs from the book's meaning, add one line that starts with "Common meaning differs:".
Format: one line per term: **term** — definition.
Length: at most 5 terms, at most 40 words per term.
```

The full set of templates, the running-summary prompt, the glossary prompt, and the index-line prompt are in [docs/design/context-and-plan.md](docs/design/context-and-plan.md), section 3.

### 6.7 Running cost

**The provider decision.** Phase 0 ships the `anthropic` driver first, with Opus 5.5 as the strong role. The `openai-compatible` driver follows in Phase 1, for a local model or another hosted provider.

**The token model per reading hour.** The appendix estimates one hour of reading as about 25 pages and 12 asks. The strong role answers the asks. The fast role runs the background jobs.

| Item | Tokens per hour |
|---|---|
| Asks, strong input, not cached | 36,000 |
| Asks, strong input, cache reads (the stable prefix) | 36,000 |
| Asks, strong output | 3,600 |
| Background jobs, fast input (summaries 24,000, glossary 30,000, index lines 5,000) | 59,000 |
| Background jobs, fast output | 5,000 |

**List prices used.** These are the Anthropic first-party rates as of 2026-10-06. Check the pricing page before the first real month, and enter the current numbers in the config file. The app ships no prices.

| Model | Input $/MTok | Cache read $/MTok | Output $/MTok |
|---|---|---|---|
| Opus 5.5 | 4.00 | 0.20 | 20.00 |
| Haiku 5.5 | 0.10 | — | 0.50 |

**Cost per reading hour on Opus 5.5.**

| Configuration | Arithmetic | Per hour |
|---|---|---|
| Opus 5.5 strong, local model fast, caching on (the design default) | 36,000 × $4 + 36,000 × $0.20 + 3,600 × $20, all per million; the fast role costs nothing | $0.22 |
| Opus 5.5 strong, Haiku 5.5 fast, caching on | the first row + 59,000 × $0.10 + 5,000 × $0.50 | $0.23 |
| Opus 5.5 strong, Haiku 5.5 fast, caching off | 72,000 × $4 + 3,600 × $20 + the same fast cost | $0.37 |
| Opus 5.5 for both roles, caching on | the first row, with the fast tokens at Opus prices | $0.56 |

Per request, on the design default:

| Request | Per request |
|---|---|
| Standard ask: 6,000 input tokens, half cached, 300 output tokens | about $0.02 |
| Standard ask with no cache hit | about $0.03 |
| Deep ask: 30,000 input tokens, not cached, 500 output tokens | about $0.13 |

**What this means.**

- A month of 40 reading hours costs about $9 on the design default.
- At that price the context budget can rise above 6,000 tokens, and Deep asks can be routine, long before cost matters.
- The two-role split still pays. Background jobs on Opus 5.5 more than double the hourly cost, as the last row shows. The design default runs the fast role on the local model (section 6.8).
- The design keeps the cost readout and the per-profile prices in the config. The readout shows whether the real numbers match this estimate.

The estimate ignores two small items: cache writes cost more than plain input, and the first ask after each prefix change pays one. Both add a few percent.

### 6.8 A local model on this machine

**The machine.** This computer is an NVIDIA DGX Spark: a GB10 Grace Blackwell chip, 20 ARM cores, and 128 GB of unified memory shared by the CPU and the GPU. The memory bandwidth is about 273 GB/s. That profile suits large mixture-of-experts models with few active parameters. They fit in memory, and the small active set keeps generation fast. Dense models above about 30B parameters generate slowly on this bandwidth.

**The model the user named.** Qwen3.8-Flash-Next is an open-weights release from 2026-08-26 under the Qwen community license. It pairs a 125B mixture-of-experts backbone with a 51B n-gram embedding table and a 4B multi-token prediction head: about 176B parameters in total, 6B active per token, 262K native context, text and image input. GGUF quantizations start at 72.5 GB. The smallest one fits in the Spark's memory with room for the KV cache, the browser, and the server. The larger quantizations do not leave enough room. llama.cpp, vLLM, and SGLang serve it. llama.cpp and Ollama run on the Spark, and NVIDIA publishes Spark playbooks for vLLM.

**Expected speed, to verify by running it.** Generation: 6B active parameters at about 3.5 bits per weight read roughly 2.6 GB per token. At 273 GB/s that is under 100 tokens per second in theory, and perhaps 30 to 50 in practice. That is faster than the user reads. Prefill: a standard ask sends about 6,000 tokens. With the stable 2,000-token prefix cached by the local server, about 4,000 new tokens remain per ask. On this hardware that likely takes 2 to 5 seconds before the first token. The design target of 1.5 seconds will probably not hold for the local model on the strong role. Background jobs do not care about latency.

**Suitability for this task.** The strong role needs four things: follow an 11-rule system prompt, resolve back-references inside a 6,000-token context, use the book's own terminology, and keep to a length limit. A current large open model does all four. The gap to Opus 5.5 shows in nuance: how well it separates the book from outside knowledge, how honest it is when a passage is unclear, and how precise it is on technical detail. For single-column prose books the gap is probably modest. For the fast role, a local model is at least as good as the API. Summaries, glossary lines, and index lines are simple extraction tasks, and local means free, private, offline, and free of rate limits. The coding benchmarks published for the model say little about this task either way.

**Cost is not the reason for a local model.** Section 6.7 puts a reading hour at a quarter of a US dollar. A local model therefore earns its place through privacy, offline use, and the fast role, not through cost.

**Recommendation.**

1. Strong role: Opus 5.5. This is the default in the config.
2. Fast role: the local model. All background jobs run on it. Nothing leaves the machine except the asks.
3. Private mode: one setting switches the strong role to the local profile, for a book the user does not want to send out, or for offline use.
4. Run a two-week comparison. The one-key usefulness rating and the "clarify that" follow-up rate are logged per role. If the local model is rated useful on at least 80 % of Explain asks, flip the default and keep Opus 5.5 for Deep asks and Critique.

**How it plugs in.** The local server exposes an OpenAI-compatible endpoint, so the `openai-compatible` driver covers it with no new code. Order the prompt stable-first, as section 6.3 says. llama.cpp and vLLM both cache a matching prefix, which cuts the prefill time on every ask after the first. A smaller model in the 4B to 30B class is an alternative for the fast role when the user wants most of the memory free for other work.

---

## 7. Architecture

### 7.1 Form factor

| Criterion | Local web app | Browser extension | Desktop (Tauri / Electron) | Userscript | TUI |
|---|---|---|---|---|---|
| Opens arbitrary online PDF URLs | ++ | ++ | ++ | – | + |
| Opens PDFs behind a login | – | ++ | + | + | – – |
| Full control of the keymap | + | + | ++ | – | ++ |
| Maps a sentence to on-screen rectangles | ++ | ++ | ++ | – – | – – |
| Effort to build the MVP | ++ | + | – | + then – – | – |
| Hackability | ++ | + | – | – | + |
| Path to the other forms | ++ | + | + | – – | – – |

**Decision: a local web app for the MVP.** One Node process on `127.0.0.1` serves the API and a single-page app. The server removes the CORS problem for public URLs, holds the API keys, and owns the SQLite file. The user can run it in `chromium --app=http://127.0.0.1:7777` to get a window with no tabs and no URL bar.

A browser extension comes later without a rewrite. It adds one keyboard command, "Open this tab in llm-reader", which saves the PDF with the browser's own session, so cookies never leave the browser. It can also host the same bundle in a serverless "direct mode". Electron is the escape route if browser keymap limits ever matter. The userscript and the TUI are rejected: the first cannot read the text layer of the built-in viewers, and the second cannot highlight a sentence on a rendered page.

**Opening a document without a mouse.** The user's PDFs are mostly local files, so the file path comes first. Each form is used once per document.

| Form | What the user does |
|---|---|
| CLI | `llm-reader open ~/books/x.pdf` posts to the running server and opens the reader tab. Shell completion fills the path. |
| Library list | On start, the app shows the recent documents and every PDF in `books_dir` from the config. The user types a few letters of the title, and `Enter` opens the best match. |
| URL prefix | For the occasional online PDF: in any tab, `Ctrl+L`, type `127.0.0.1:7777/`, then the URL. The server takes everything after the first `/` as the target. |

Inside the app, `:open` runs the same fuzzy match from the palette. `Ctrl+O` opens the file picker as a fallback. Drag and drop also works.

### 7.2 System overview

```
 browser tab / --app window                      Node process on 127.0.0.1:7777
┌──────────────────────────────┐    HTTP + SSE   ┌──────────────────────────────────┐
│ viewer/   PDF.js PDFViewer   │◄───────────────►│ routes/   docs, threads, runs    │
│           overlay layer      │  /api/docs      │ fetch/    URL fetch, sniff, cache│
│           reading cursor     │  /api/runs/:id  │ extract/  whole-doc segmentation │
│ commands/ keymap dispatcher  │   /events (SSE) │ context/  layer builder, trimming│
│ chat/     Preact answer pane │                 │ llm/      drivers, RunManager    │
│ shared/segment  (same code)  │                 │ shared/segment  (same code)      │
└──────────────────────────────┘                 │ db/       SQLite, migrations     │
                                                 └───────┬──────────────┬───────────┘
                                                         │              │ HTTPS
                                            ~/.local/share/llm-reader   ▼
                                            blobs/<sha256>.pdf      LLM providers
                                            llm-reader.db           (openai-compatible,
                                            export (on demand)       anthropic)
```

### 7.3 PDF rendering and text segmentation

- **Rendering.** `pdfjs-dist`, pinned to one exact version. The `PDFViewer` component gives lazy page rendering, a canvas and a text layer per page, zoom, links, and the outline. llm-reader adds one **overlay layer** per page for highlights, the cursor, and anchor tags. Documents load with Range support and `disableAutoFetch`, so a 300 MB scan opens at the first page. PDF scripting stays off.
- **Text items.** `page.getTextContent()` returns runs with text, a transform, a size, and a direction. The item index links the logical text to the text-layer spans, because PDF.js creates one span per item.
- **The segmenter** is a pure function with no DOM dependency. It groups items into lines by baseline, builds blocks with a recursive XY-cut for reading order and columns, classifies running headers, footers, footnotes, and margin text as skip spans, splits paragraphs by vertical gap and indent, joins lines with de-hyphenation, splits sentences with `Intl.Segmenter` plus an abbreviation list, and flags sentences that continue on the next page. A run-length **char map** links every logical offset to a character in one text item.
- **Where it runs.** The same code runs in the browser for visible pages and in Node for whole-document background extraction. PDF.js is the only source of offsets. Python PDF tools are rejected for anchoring, because their offsets differ. Every page-text row stores the PDF.js version and the segmenter version. A version change invalidates the cache, and passages re-anchor with their quote selector.
- **Rectangles.** On visible pages, a DOM Range over the text-layer spans gives exact rectangles. Rectangles are stored in normalized PDF space, so zoom and rotation do not affect them.
- **Failure modes.** A scanned PDF gets a banner that offers `ocrmypdf`. Math-heavy text with no Unicode map gets a quality flag and, in Phase 2, a region-image fallback. Duplicate items from fake bold are removed. Right-to-left and vertical text get basic support only.

### 7.4 Fetching online PDFs

The user's PDFs are mostly local files. This path is Phase 1, and the login fallbacks at the end are low priority.

1. Rewrite known landing pages, for example an arXiv abstract URL to its PDF URL.
2. Return a cached document at once if the normalized URL is known. Revalidate in the background.
3. Fetch with redirects, a timeout, a browser-like User-Agent, and a size cap. Hash the bytes while they stream.
4. Sniff: the first 1,024 bytes must contain `%PDF-`. The Content-Type header is ignored. If the body is HTML, follow one `citation_pdf_url` or PDF link. Otherwise report "this looks like a login or landing page" with the download fallback.
5. Store the file as `blobs/<sha256>.pdf`. The hash is the document id. Many URLs can point to one document.
6. Serve it to PDF.js with Range responses, an ETag, and an immutable cache header.

**PDFs behind a login.** Rare for this user. The fallback is simple: save the file in the browser with `Ctrl+S` into `books_dir`, and it appears in the library list. A browser extension that saves with the browser's own session stays an option for later, if online PDFs behind a login become common.

### 7.5 LLM adapter and streaming

The adapter runs on the server. The browser never calls a provider in the default mode. Two drivers on raw `fetch`, about 150 lines each, with no vendor SDKs: `openai-compatible` covers OpenAI, xAI, OpenRouter, Ollama, vLLM, and llama.cpp. `anthropic` covers Anthropic.

```ts
interface ChatRequest {
  system?: string;
  messages: ChatMessage[];                  // text and image parts
  maxTokens?: number;
  temperature?: number;
  cacheHints?: { messageIndex: number }[];  // drivers that support prompt caching use it
}

type ChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }
  | { type: 'done'; finishReason: 'stop' | 'length' | 'cancelled' | 'error' | 'other' };

interface ChatDriver {
  stream(profile: Profile, req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>;
}
```

**Streaming to the browser is Server-Sent Events, in two steps.** `POST /api/threads/:id/runs` stores the user message and starts the run. `GET /api/runs/:id/events` streams `run.start`, `delta`, `usage`, `run.end`, and `error` events, with a comment line every 15 s. `EventSource` reconnects by itself and sends the last event id, and the server replays missed events from a per-run buffer. A page reload during a long answer loses nothing. WebSocket is rejected because the data flows one way.

- **Cancel.** `POST /api/runs/:id/cancel` aborts the upstream fetch and keeps the partial text. A closed browser stream does not cancel the run.
- **Retries.** Only before the first delta: network errors, 429, and 5xx, with exponential backoff and at most 3 tries. After the first delta, the error is reported with the partial text kept.
- **Persistence.** The run writes the accumulated text every 500 ms. On startup, rows still marked `streaming` become `interrupted`.
- **Usage.** Each usage event writes one row. Cost is `null` unless the user supplies prices in the config. The app ships no prices.

**Configuration** lives in `~/.config/llm-reader/config.toml`. It names an environment variable for each key and never holds a key. Two roles, `strong` and `fast`, point at named profiles.

```toml
[roles]
strong = "claude"         # or "local" for private or offline reading
fast   = "local"

[profiles.claude]
provider    = "anthropic"
base_url    = "https://api.anthropic.com"
model       = "claude-opus-5-5"
api_key_env = "ANTHROPIC_API_KEY"

[profiles.claude.pricing]   # list prices as of 2026-10-06, per million tokens; the user keeps these current
input      = 4.00
cache_read = 0.20
output     = 20.00

[profiles.local]
provider = "openai-compatible"
base_url = "http://127.0.0.1:8000/v1"   # llama.cpp server, vLLM, or Ollama on the Spark; no key
model    = "Qwen3.8-Flash-Next"

[profiles.haiku]            # alternative hosted fast role
provider    = "anthropic"
base_url    = "https://api.anthropic.com"
model       = "claude-haiku-5-5"
api_key_env = "ANTHROPIC_API_KEY"

[storage]
books_dir = "~/books"       # the library list scans this directory

[notes]
file = "~/notes/reading.md" # the y key appends a Q&A block here

[reader]
profile = "I am a software engineer. I know programming and basic probability. No biology background."
budget_tokens = 6000
```

Keys stay on the server for four reasons. The page renders Markdown from the model and text from PDFs, so a sanitizer bug could expose a key in page memory. Extensions with wide permissions can read page storage. The server is one place for retries, usage logs, and rotation. Some providers discourage direct browser calls. A later direct mode keeps the key in extension storage and runs the same drivers in the browser.

### 7.6 Data model and storage

```ts
type DocId = string;   // SHA-256 of the PDF bytes

interface Passage {
  id: string;
  docId: DocId;
  start: { page: number; offset: number };
  end:   { page: number; offset: number };   // may cross a page break
  kind: 'sentence' | 'paragraph' | 'selection' | 'region';
  text: string;                               // de-hyphenated, what the LLM gets
  quote: { exact: string; prefix: string; suffix: string };  // durable anchor
  rects: { page: number; rect: [number, number, number, number] }[];  // normalized
  segmenterVersion: number;
}
```

The offsets are the fast path. The quote selector, in the style of the W3C Web Annotation TextQuoteSelector, is the durable anchor. If the segmenter changes, the app searches for the exact text near the old offsets and uses the prefix and suffix to pick between matches.

| Table | Purpose |
|---|---|
| `documents` | One row per distinct byte content: title, page count, OCR parent. |
| `sources` | Normalized URL → document id, with ETag and Last-Modified. |
| `page_text` | Cache of segmented page text per segmenter version. Safe to delete. |
| `doc_profile` | Header and footer keys, body font size, column override. |
| `passages`, `highlights` | Anchors and plain marks. |
| `threads`, `messages` | One thread per anchored question. Message status: complete, streaming, cancelled, error, interrupted. |
| `usage` | Tokens and cost per run. |
| `reading_state` | Page, scroll, zoom, cursor passage per document. |
| `settings` | UI settings that follow the user across browsers. |

**SQLite on the server, not IndexedDB.** The browser can clear IndexedDB. The notes are the valuable output, so they need a plain file. The user can query `~/.local/share/llm-reader/llm-reader.db` from the CLI or from Claude Code. All clients share one store. Plain SQL migrations, WAL mode, no ORM.

**Export.** `GET /api/docs/:id/export.md` and `llm-reader export <doc>` write one heading per chapter, and for each thread the quoted passage, the page, the question, the answer, and the follow-ups. The user keeps their own notes file. The `y` key appends a thread to it (section 8). The app writes no other note files.

### 7.7 Stack

| Layer | Choice | Reason |
|---|---|---|
| Backend | Node LTS, TypeScript, Hono | Only a JavaScript backend runs the same PDF.js code as the browser, so offsets agree to the character. One language and one type file for the project. Hono is small and uses Web-standard APIs. |
| Viewer core | Vanilla TypeScript | PDF.js views, the char map, DOM ranges, the overlay, focus, and the key dispatcher are imperative. A framework would get in the way. These classes do not import Preact, so the extension can reuse them. |
| Chat pane and lists | Preact with signals | Fine-grained updates per streamed token at a few KB. `markdown-it`, `DOMPurify`, and KaTeX render answers. |
| Build | Vite, Vitest | `pnpm dev` runs Vite with an `/api` proxy and the server under `tsx watch`. `pnpm start` builds and runs one server. Segmenter tests run in Node on fixture PDFs. |
| Storage | `better-sqlite3`, or `node:sqlite` on recent Node | Synchronous, fast, prebuilt. |
| Key dispatch | One capture-phase `keydown` listener on `window` | It maps key plus mode to a command id and calls `preventDefault` for owned keys. |

The machine is an NVIDIA DGX Spark, so the platform is Linux on arm64. Node, `pdfjs-dist`, and `better-sqlite3` have arm64 builds, and `node:sqlite` needs no native module at all. Test the native pieces on the first day.

If the user prefers Python, the design still works: keep all segmentation in the browser and upload each page text to the server. Background whole-document extraction then waits until each page is viewed.

### 7.8 Security of the local server

The server can fetch any URL and spend money on API calls. Other websites must not be able to drive it.

- Bind to `127.0.0.1` only.
- Check the `Host` header against `127.0.0.1:<port>` and `localhost:<port>`. This blocks DNS rebinding.
- Check the `Origin` header on every state-changing request.
- Set a random `HttpOnly`, `SameSite=Strict` session cookie when serving `index.html`. Require it on all `/api` routes.
- Redact keys and `Authorization` headers in logs. Refuse to start if the config holds a literal key with permissions wider than `0600`.
- Keep PDF.js scripting off. Sanitize all rendered Markdown.

### 7.9 Repository layout

```
llm-reader/
├── DESIGN.md                this file
├── docs/design/             research appendices
├── package.json             scripts: dev, start, build, test, lint
├── config.example.toml      named profiles, roles, reader profile, no keys
├── bin/llm-reader.ts        CLI: serve, open <url|path>, export <doc>, doctor
├── src/
│   ├── shared/              runs in the browser and in Node
│   │   ├── types.ts         Document, PageText, Passage, Thread, Message, RunEvent
│   │   ├── segment/         text items → lines, blocks, paragraphs, sentences, char map
│   │   ├── anchor.ts        offsets ↔ rects ↔ quote selector, re-anchoring
│   │   └── llm/             ChatDriver, openai-compatible.ts, anthropic.ts, sse-parse.ts
│   ├── server/
│   │   ├── main.ts          Hono app, Host/Origin/cookie checks, static files
│   │   ├── config.ts        load and validate config.toml, resolve keys from env
│   │   ├── routes/          docs, threads, runs (SSE), export, settings
│   │   ├── fetch/           URL fetch, rewrites, sniffing, Range serving
│   │   ├── context/         layer builder, budget and trimming, prompt templates
│   │   ├── jobs/            background queue: summaries, glossary, index lines
│   │   ├── runs.ts          RunManager: abort, retries, event buffer, persistence
│   │   ├── extract/         whole-document segmentation in Node, doc profile, OCR job
│   │   ├── library.ts       scan books_dir, recent documents, fuzzy match
│   │   └── db/              SQLite open, migrations/*.sql, repositories, Markdown export
│   └── web/
│       ├── viewer/          PDFViewer wrapper, overlay layer, reading cursor, selection mapper
│       ├── commands/        command registry, keymap loader, modes
│       ├── chat/            Preact answer pane, Markdown, KaTeX, SSE client
│       ├── library/         document list, recent files, open box
│       ├── api/             Transport interface: ServerTransport now, BrowserTransport later
│       └── styles/
├── extension/               later, only if needed: MV3 manifest, "Open in llm-reader" command
└── test/
    ├── fixtures/            tricky PDFs: two-column paper, textbook with headers, scan, math
    └── *.test.ts            segmenter goldens, anchors, drivers against a fake SSE server
```

---

## 8. Features beyond the core loop

### Included

| Feature | Pitch | Phase |
|---|---|---|
| Continue reading (`'`) | Anchor jumps, search, and page jumps never change the reading position. One key returns to it. On reopen, the document opens there. | 0 |
| Context-used line and cost readout | Each answer shows the layers sent and its tokens. The status bar shows the session and document cost against user-entered prices. | 0 |
| Mark confusing (`m`) | An amber anchor with no question, for "ask later". Feeds the confusion map. | 1 |
| Marginalia | Anchor tags in the gutter, inline cards, scrollbar ticks, `]` and `[` navigation. The Q&A becomes annotations of the book, not a lost chat log. | 1 |
| Append to my notes (`y`) | One key appends the current passage, question, and answer as a Markdown block to the user's own notes file, set in the config. The app has no notes system of its own; the user already keeps one. | 1 |
| Markdown export | One file per book with chapter headings, passages, questions, and answers. A safety valve if the app dies, not a notes system. | 1 |
| End-of-session recap | On close or after 10 minutes idle, the fast model writes pages read, ideas clarified, and open items. Stored with the document. | 2 |
| Resume briefing | On reopen after a day, three lines: where you stopped, the chapter summary, and open items. No new LLM call. | 2 |
| Check me (palette) | The user restates the passage. The model grades it: correct, mostly, partly, incorrect, with the specific gap. Recall beats rereading. | 1 |
| Reader overlay (`` ` ``) | A centered, wide, large-font view for long answers. The default when the pane is hidden. | 1 |
| Figure and equation ask | Select a region. The crop goes to a vision-capable model with the normal context. The only way to ask about math that extraction garbles. | 2 |
| Teach-back per section | At a section end, explain it in 3 to 5 sentences. The model grades against the section text. Opt-in, never automatic. | 2 |
| Pre-read briefing | On entering a chapter, on demand: what it establishes, which earlier ideas it needs, three questions to keep in mind. | 2 |
| Confusion heatmap | A strip next to the scroller shows asks per page. Shows which pages were hard before a reread. No LLM call. | 2 |
| Deep ask | Send the full chapter so far, capped at 30,000 tokens, for "how does this connect" questions. Explicit, because it costs 4 to 6 times a standard ask without caching. | 2 |
| Browser extension | "Open this tab in llm-reader" for PDFs behind a login. Optional serverless direct mode. | later, only if online PDFs behind a login become common |
| Stuck detector | After 3× the median page time, a silent chip offers "Explain this page". Off by default. A long dwell usually means thought, not trouble. | 2 |

### Rejected

- **Automatic commentary on every page.** It multiplies cost by every page, most output is noise, and it turns active reading into passive reading of summaries.
- **"Chat with the whole PDF" as the main mode.** The questions are about a passage. Local context answers them better than chunks found by similarity. The Deep ask and the Connect preset cover the rest.
- **Prediction of confusing passages.** Confusion is personal. The heatmap gives the real signal for free.
- **Side-by-side answers from two models.** It doubles cost and reading time. `r` covers the rare bad answer.
- **Auto-advance after an answer.** It conflicts with follow-ups. The cursor stays on the passage.

---

## 9. Build plan

Do not start a phase before the previous one is in real daily use for at least a week. The logs of real use set the priorities inside the next phase.

### Phase 0: the weekend MVP

**Capability.** Open a local PDF from the CLI or the library list. Move the reading cursor by paragraph and sentence with the left hand. Mouse selections stage at once. `Enter` explains, `c` defines, `v` asks. Follow-ups go to the same thread. Answers stream into the pane. Threads and the reading position survive a restart.

**Pieces.**

1. Server: Hono, file open and the `books_dir` scan, Range serving, SQLite with the tables in 7.6, the `anthropic` driver (section 6.7), SSE runs with cancel.
2. Viewer: `PDFViewer`, the overlay layer, per-page segmentation for visible pages, the char map, the reading cursor with `Space` `q` `w` `s` `a` `d` `p`, mouse auto-stage.
3. Keymap dispatcher with the `NORMAL`, `ASK`, and `READER` modes. `Tab`, `Esc`, `'`, `r`, `=`, `-`. The first-run cheat card and the key-hint strip.
4. Context builder with S, C (title and bookmark outline), F, A, B, and the raw previous page in place of D1.
5. Answer pane with streaming Markdown, the status line, the context-used line, the token readout.

**Done when:**

- The user reads one chapter for 30 minutes and asks at least 10 questions.
- The session has zero copy-paste operations and zero tab switches.
- Each preset ask takes at most 2 keystrokes after the selection.
- The first token arrives in under 2 s at the median.
- The threads are still there after a restart.

### Phase 1: the context engine and the local model (weeks 2 to 3)

**Capability.** Answers know the chapter, the book's definitions, and the user's earlier questions. All presets work, also as follow-ups. Background jobs run on the local model. Hint mode and search select far targets. Anchors show in the margin and navigate with `]` `[`. One key appends a thread to the user's notes file.

**Pieces.**

1. Hint mode, search to select, the focus term, `.` repeat, `m` mark.
2. The remaining presets and the palette-only presets. Presets as follow-ups.
3. The `openai-compatible` driver and the local model as the fast role. The two roles, cache breakpoints, the cached-token readout. The per-role usefulness rating for the comparison in section 6.8.
4. The background job queue with the dwell filter. D1 and D2 summaries, the glossary, the Define cache, index lines, E2 to E4, trimming, FTS5 for related threads.
5. Running-header outline fallback. Whole-document extraction in Node. URL fetch with sniffing and the cache, for the occasional online PDF.
6. Margin tags, inline cards, scrollbar ticks, the reader overlay, the hidden-pane layout.
7. Markdown export, the append-to-notes key, the keymap file, and the `home` layout.

**Done when:**

- On a book with no bookmarks, the location line shows the correct chapter on 9 of 10 sampled pages.
- An ask that says "like on page 42" includes the thread from page 42, as the context-used line shows.
- A single-word Define on a term the book defined earlier cites the book's definition and page.
- The usage readout shows cached input tokens on the second and later asks in a chapter.
- The export opens in a Markdown editor with correct chapter headings and page references.

### Phase 2: hard content and learning

**Capability.** Region asks for figures and equations. OCR for scans. Teach-back, pre-read briefing, heatmap, Deep ask, the session recap, and the resume briefing. The browser extension only if online PDFs behind a login become common.

**Pieces.** Region capture and a vision-capable role. `ocrmypdf` job. The teach-back and briefing templates. The heatmap from the thread table. The recap and briefing jobs. The MV3 extension and the `BrowserTransport`, if needed.

**Done when:**

- The user asks about an equation and gets an answer that names its parts correctly.
- The user completes one teach-back per chapter for a whole book without friction.
- The measured hand-on-mouse time per session is near zero, including the questions.

---

## 10. Alternatives considered

| Alternative | Good enough for | What it lacks | Verdict |
|---|---|---|---|
| An `xdotool` + `xclip` macro: copy, focus the chat tab, paste, Enter, focus back | Acute pain tonight. One to two hours to build. | No context. Fragile. The focus still switches. | Build it as a stopgap if needed. It is not the product. |
| A browser extension with an LLM sidebar and "explain selection" | Occasional questions. | No document context, no anchored threads, little prompt control. The browser PDF viewer often blocks it. | Not for deep reading of a book. |
| Readwise Reader with its assistant | The closest existing product: select and ask, custom prompts, highlights, export. | A subscription. No running summary or Q&A memory of your design. No local models. The vendor's keyboard flow. | Try it for an evening first. The custom tool must beat it on context and keys. |
| NotebookLM | Whole-book questions with citations. | Chat-first, not reading-first. No selection-to-ask inside a reader. Cloud upload. | A complement, not a replacement. |
| Zotero or Obsidian with AI plugins | Academic papers. | Plugin quality varies. Context is usually only the selection. | Weak for books. |
| Adobe Acrobat AI Assistant | Integrated Q&A. | Paid, no model choice, no useful export, no native Linux version. | Reject. |
| Upload the whole PDF to a chat project, then paste passages | Better answers than a bare paste. | The copy-paste and the focus switch remain. | Same physical pain. Reject. |

**What the custom tool gains:** a keyboard flow built for this user's hands, layered context the user controls and can see, anchored threads that become marginalia, memory of past questions, free choice of provider including a local model, a visible cost per ask, and notes in plain Markdown the user owns.

**What it costs:** a weekend for Phase 0, a few weeks of evenings for Phase 1, and ongoing care of two thin provider drivers.

---

## 11. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| Text extraction quality: columns, headers, math, hyphens | Wrong sentence borders. Garbage goes to the model. | Golden fixture tests per failure class. Per-document column override. The staged preview shows the text before each send. A quality flag with the region-image fallback. |
| PDF.js version drift | Offsets change. Old highlights move. | Pin the exact version. Store versions on every page-text row. Re-anchor with the quote selector. |
| Large PDFs | Slow open, high memory. | Range responses with `disableAutoFetch`. The viewer renders only visible pages. Extraction runs in Node, not in the tab. |
| Time to first token | The user waits with no feedback. | Start the run on the key press. Stream. Show a pending state at once. No LLM call on the ask path. Prompt caching. A local fast role. |
| API key leakage | Someone spends the user's money. | Keys only in server memory, from environment variables. Never sent to the browser. Logs redact. Config permission check. |
| Another website drives the local server | Paid calls or fetches from a malicious page. | Bind `127.0.0.1`. Host and Origin checks. `SameSite=Strict` cookie on all API routes. |
| Keymap conflicts with the browser | Some keys never reach the page. | Avoid `Ctrl+W`, `Ctrl+T`, `Ctrl+N`, `Ctrl+Tab`. The core loop uses no Ctrl keys. The `--app` window removes the tab bar. Electron is the escape route. |
| Loss of notes | Months of notes disappear. | SQLite on disk in WAL mode, outside the browser. Flush every 500 ms. Markdown export on demand. A daily copy of the database, keep 14. |
| PDFs behind a login | Rare for this user. | Save the file in the browser into `books_dir`. The extension stays an option. |
| Local model latency | The first token on a 6,000-token prompt takes a few seconds on the Spark. | Prefix caching in the local server. The local model runs the fast role by default. The strong role stays on the API unless the user chooses private mode. |
| arm64 native modules | A prebuilt binary for `better-sqlite3` is missing or broken. | Verified on 2026-10-23: better-sqlite3 13 ships a linux-arm64 prebuild and loads. `node:sqlite` is the fallback and needs no native module. |
| Provider API differences | A compatible server rejects a field or streams a different shape. | Two thin drivers. A per-profile passthrough field. Usage is optional. Driver tests against recorded streams. |
| Context that misleads | Irrelevant layers dilute attention and raise cost. | A budget per layer and a trim order. The context-used line makes bad answers debuggable. |

Two claims in the architecture come from memory and need a test before the design depends on them: whether the browser's downloads API always sends session cookies for a login-protected PDF, and whether every OpenAI-compatible server returns token usage in its stream.

---

## 12. Success metrics

The app logs these locally. Nothing leaves the machine.

| Metric | Old workflow (estimate) | Target |
|---|---|---|
| Keystrokes per preset ask, after the selection | 3 to 4 chords, 4 mouse moves, 2 clicks | ≤2 keys, 0 mouse events |
| Keystrokes per free ask, without the question text | same | ≤3 |
| Pointer events the app requires per session | many per ask | 0 |
| From the decision to ask to the request sent | 10 to 15 s | <3 s |
| Time to first token | — | <1.5 s median |
| Time to resume reading after an answer | includes the tab switch | <10 s median |
| Explain threads that need a "clarify that" follow-up | — | <35 %. A rising rate means weak context or prompts. |
| Optional one-key usefulness rating | — | ≥80 % useful |
| Pages read per session | — | not lower than before |

Review after two weeks. If usefulness is poor, inspect the context-used lines of the bad answers first. The cause is usually a missing referent or a missing definition.

---

## 13. Open questions for the user

The user answered the first seven questions on 2026-10-23. The answers and the resulting decisions:

| Question | Answer | Decision in this design |
|---|---|---|
| Provider | Anthropic, with a local model as an option | `anthropic` driver first. Opus 5.5 as the strong role. Section 6.7. |
| Local model | Interested in Qwen3.8-Flash-Next | The local model runs the fast role and private mode. Opus 5.5 stays the strong role until a two-week comparison says otherwise. Section 6.8. |
| PDF sources | Mostly local files | File open first. URL fetch is Phase 1. Login fallbacks and the extension are later, if ever. |
| PDF kind | Single-column books | Column handling stays in the segmenter, but two-column fixtures move to later. Running headers, the page-label map, and chapter detection matter most. The region ask stays Phase 2. |
| Vim keys | Not used, willing to learn simple keys | The `left` layout is the default: WASD movement and ten core keys. The `home` layout is optional. |
| Hands | The right hand hurts from clicking. | The whole core loop runs on the left hand. The design has no voice input and no read-aloud, at the user's request. |
| Notes | The user keeps their own Markdown notes file | No notes system in the app. One key appends a Q&A block to the user's file. Export stays as a safety valve. The recap and the resume briefing move to Phase 2. |

Still open:

1. **Answers beside the PDF, or the PDF at full width with answers in an overlay?** What is the screen size? This sets the default layout.
2. **Is Qwen3.8-Flash-Next already installed, and with which server?** llama.cpp, vLLM, or Ollama. This sets the `base_url` and the model name in the config.
3. **Do math and figures matter in the books you read?** If yes, the region ask moves from Phase 2 to Phase 1.
4. **Does light tapping with the right hand hurt too, or only clicking?** If tapping hurts, a foot pedal for `Space` and `Enter` moves up, and the rare keys move to the left hand as well.

---

## Appendices

The full research behind this design, one file per area:

- [docs/design/interaction.md](docs/design/interaction.md): selection mechanisms, modes, the full keymap and keymap file, focus, answer placement, ergonomics, the worked walkthrough.
- [docs/design/architecture.md](docs/design/architecture.md): form-factor decision table, the segmentation pipeline step by step, the char map, fetch flow, SSE event shapes, the adapter and both drivers, the full data model and tables, config, stack comparison, security, repository layout, risks.
- [docs/design/context-and-plan.md](docs/design/context-and-plan.md): the context layers and trimming algorithm, every prompt template, the running-summary and glossary prompts, the threading model, precomputation jobs, latency and cost tactics, features, phases, alternatives, metrics.

Where an appendix and this file disagree on a key, a phase, or a preset list, this file wins.
