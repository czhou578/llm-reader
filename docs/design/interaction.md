> **Research appendix.** This file holds the full detail behind one area of [DESIGN.md](../../DESIGN.md).
> Where this file and DESIGN.md differ on a key, a phase, or a preset list, DESIGN.md wins.

# llm-reader: Interaction design

Scope: this section covers what the user sees and presses. The backend and the LLM context strategy are out of scope. Where the interaction design needs something from them, this section names the need and stops there.

## 0. Design goals and the assumptions

The goals, in priority order:

1. **Less hand strain.** The core loop needs no mouse and no chorded keys. Frequent actions use one unshifted key near the home row or the thumb.
2. **No loss of place.** The PDF pane keeps focus and the reading position. An answer never moves the user's place in the text.
3. **Few keystrokes.** The common case ("explain the sentence that I just read") takes three keys or fewer.
4. **Visible state.** The user always sees what text is staged, where the question goes, and if an answer is ready.

I accept the working assumptions, with three notes:

- **A single web page is the correct choice.** A browser extension cannot get the text layer of the built-in Chrome PDF viewer, and it cannot own the keymap reliably. PDF.js in our own page gives both.
- **Side by side is a default, not a rule.** The answer pane can hide (`\`). Then answers appear as margin notes and in a reader overlay, and the PDF uses the full width. This helps on a laptop screen.
- **Voice is optional, but the design must not depend on the keyboard alone.** Every action has a name in the command palette and in the keymap file. A later voice-command layer can call the same actions.

## 1. Passage selection without a mouse

### 1.1 The text model that the UI needs

All keyboard mechanisms depend on one structure: the document as **pages → blocks (paragraphs) → sentences**, in reading order. Each sentence maps back to spans in the PDF.js text layer, so the UI can highlight it. The frontend builds this model from `getTextContent()` geometry and `Intl.Segmenter` (sentence granularity). A sentence can cross a line, a column, or a page break.

The UI shows the **staged text** before the user sends it. The status line shows the cleaned text that the LLM will get. Thus a text-layer defect is visible, and the user can fix the selection before the question goes out.

### 1.2 The four mechanisms

#### A. The reading cursor (recommended primary)

The reading cursor has two levels:

- **Paragraph level.** `Space` moves to the next paragraph. `b` moves to the previous paragraph. A 3 px bar in the left gutter marks the current paragraph. The text gets no tint, so normal reading is not disturbed.
- **Sentence level.** `j` and `k` move to the next and the previous sentence. The current sentence gets a soft background tint. From paragraph level, the first `j` selects the first sentence of the paragraph.

The important point: **`Space` replaces the mouse wheel.** The user presses `Space` when they finish a paragraph, which they did before with the wheel. So the cursor tracks the reading position at no extra cost. When a sentence is confusing, it is almost always in the current paragraph, one to three `j` presses away.

**Scroll behavior.** The page scrolls only when the cursor leaves a comfort band (25% to 60% of the viewport height). The scroll is short (at most 150 ms) and obeys `prefers-reduced-motion`. The text on the screen stays still while the user reads.

**Snap rule.** If the cursor is off screen (for example, after a mouse-wheel scroll), the next movement key first puts the cursor on the first paragraph that is fully visible. The old position goes into the jump list, so `'` returns to it.

**Extend the selection without a chord.** I recommend `l` and `h` instead of shift+key:

| Key | Action |
|---|---|
| `l` | Add the next sentence to the selection. |
| `h` | Remove the last sentence from the selection. If only one sentence is selected, add the previous sentence. |
| `p` | Toggle the selection between the current sentence and the whole paragraph. |
| `Esc` | Collapse the selection back to one sentence at the cursor. |

Shift+`j` and shift+`k` are also bound as aliases, for users who expect them. The default does not need them, because a held shift is a chord and the user extends often.

**Text-layer problems, handled at the UI level:**

| Problem | UI behavior |
|---|---|
| Line breaks inside a sentence | The cursor moves by sentence, not by line. The highlight covers all line fragments. The staged text joins lines with one space. |
| Hyphenation at line end | The model joins `exam-` + `ple` when the next line starts with a lowercase letter. The staged preview shows `example`, so the user sees the result. A real hyphen in a compound word stays when the joined form is not a dictionary word. |
| Two-column layout | The model orders blocks column by column. When the cursor jumps from the bottom of column 1 to the top of column 2, a short slide of the gutter bar shows the jump. If the order is wrong, `:order columns` or `:order single` fixes it for the page, and the fix persists. |
| Running headers, footers, page numbers | The model marks text that repeats at the same position across pages. The cursor skips it. The marked text shows at 60% opacity in hint mode only. |
| Footnotes, captions | The cursor skips them in normal flow. Hint mode and search can still select them. |
| Sentence across a page break | The highlight shows on both pages. `Space` from that sentence goes to the next paragraph on the new page. |
| Math and garbled glyphs | The staged preview shows the raw text. A warning icon appears when more than 20% of characters are outside normal letters. Later: a "send this region as an image" key (the context-strategy owner decides if this is possible). |
| Scanned PDF with no text layer | The cursor is not available. The status line says "No text layer on this page". Mouse region selection and a future OCR path are the fallback. |
| Bad sentence split (for example, "e.g." or "Fig. 3") | `l` and `h` fix it with one key. The segmenter gets a list of common abbreviations. |

#### B. Hint mode (recommended secondary)

`f` shows a two-letter label at the start of every visible sentence. The user types the label, and the cursor moves to that sentence. Then any ask key works as usual.

- **Labels alternate hands.** The first letter is from the left home row (`a s d f g`). The second letter is from the right home row (`h j k l ;`). Alternate-hand pairs are fast, and they put the load on two hands. This gives 25 labels. The reverse pairs give 25 more. Labels are ordered from top to bottom.
- **All labels have two letters.** There is no mix of one-letter and two-letter labels, and there is no timeout. The muscle memory is constant, and slow typists are safe.
- **Paragraph labels.** In hint mode, `p` switches the labels to paragraph starts. This is for dense pages with more than 50 sentences on screen.
- **Label style.** Small pills in a high-contrast color, placed in the left margin of the line when possible. Placement inside the text covers only the first two characters of the sentence.
- **Wrong label.** The status line flashes and hint mode stays open. `Esc` closes it.

Hint mode is the best tool for a far jump on the screen, for example to a sentence in the other column or to a figure caption.

#### C. Search to select (later, v1.1)

`/` opens a one-line input in the status line. The search is incremental, from the cursor forward. It uses normalized text (no hyphenation, collapsed spaces, ligatures resolved).

- `Tab` and `Down` go to the next match. `Up` goes to the previous match.
- `Enter` selects the sentence that contains the match, and returns to normal mode.
- The matched words stay stored as the **focus term**. The define preset (`d`) uses the focus term when one exists. So `/entropy` `Enter` `d` defines the one word "entropy", not the full sentence.

Search is the best tool for one specific term and for a target that is not on the screen.

#### D. Mouse selection as a fallback (MVP)

Any mouse selection in the PDF pane becomes the staged passage at once. The user never copies or pastes.

- The UI does not snap a mouse selection to sentence borders. The user chose the exact text.
- A double-click on a word stages the word as the focus term.
- A small floating toolbar appears above the selection, with the preset names. The toolbar is for mouse-only use. A keyboard user can ignore it, because the preset keys work at once.
- After a mouse selection, the reading cursor moves to the first sentence of the selection. Keyboard and mouse use stay consistent.

### 1.3 Comparison and recommendation

| Mechanism | Keys to a nearby target | Keys to a far target on screen | Mental load | Precision | Tracks the reading position | Phase |
|---|---|---|---|---|---|---|
| Reading cursor | 1 to 3 | 5 to 15 | Very low | Sentence | Yes | MVP |
| Hint mode | 3 | 3 | Medium (find the label) | Sentence or paragraph | No (it moves the cursor) | MVP |
| Search to select | 4 to 8 | 4 to 8, also off screen | Medium (recall the words) | Word | No | v1.1 |
| Mouse selection | 0 keys, 1 drag | 0 keys, 1 drag | Low | Character | No | MVP |

**Recommendation.** Use the reading cursor as the primary mechanism, because it tracks the reading position for free and needs almost no thought. Use hint mode as the secondary mechanism, for targets that are far from the cursor. Add search in v1.1 for single terms. Keep mouse auto-staging always on, so a mouse user also loses the copy and paste.

## 2. The ask loop

### 2.1 The modes

The page has a small number of modes. The status line always shows the current mode.

| Mode | Where focus is | What letter keys do |
|---|---|---|
| `NORMAL` | PDF pane | Move the cursor, select, and ask. This is the default mode. |
| `HINT` | PDF pane | Type a hint label. |
| `SEARCH` | Status-line input | Type search text. |
| `ASK` | The ask overlay | Type the question. |
| `READER` | The answer pane or the reader overlay | Scroll the answer and ask a follow-up. |
| `PALETTE` | The command palette | Type a command name. |

### 2.2 Preset prompts

A preset is one key that sends the staged passage with a fixed intent. The preset keys are on the left hand. The navigation keys are on the right hand. So the right hand points and the left hand asks, and neither hand must move.

| Key | Preset | Default intent (the context owner writes the real prompt text) |
|---|---|---|
| `Enter` or `e` | Explain | Explain this passage in plain words, in the context of the book. |
| `d` | Define | Define the technical terms in the passage. If a focus term exists, define only that term. |
| `s` | Simplify | Say the same thing in simpler words and shorter sentences. |
| `g` | Gist | Summarize the selection in two or three sentences. |
| `x` | Example | Give one concrete example of the idea. |
| `w` | Why | Why does this matter? How does it connect to the argument? |
| `t` | Translate | Translate the passage into the target language from the settings. |
| `q` | Teach-back (v1.1) | Open the ask overlay with "Explain it in your own words". The LLM checks the user's text. |

`Enter` is the default preset because a paste into ChatGPT with no question meant "explain this". The old habit maps to one key.

The user can add presets in the keymap file (section 6.4). A user preset has a key, a label, and an intent text.

### 2.3 The free-text ask overlay

`a` opens the ask overlay. It looks like a command palette, but it appears next to the passage, not in the center of the screen.

- **Position.** The overlay appears just below the last line of the passage. If the passage is in the bottom third of the viewport, the overlay appears above it. The passage stays visible.
- **Header.** The first line shows the first 80 characters of the staged text, the word count, and the target thread: "New question" or "Follow-up in thread #4".
- **Input.** One line that grows to five lines. `Enter` sends. Shift+`Enter` adds a new line. `Up` in an empty input recalls the previous question.
- **Thread toggle.** `Tab` toggles between "new thread" and "follow-up".
- **Voice.** `v` in normal mode opens the same overlay with the microphone on. Ctrl+`Space` toggles the microphone inside the overlay. This is a chord, but it is rare, because `v` covers the common case.
- **Close.** On `Enter` or `Esc`, the overlay closes and focus returns to the PDF pane in normal mode. The cursor does not move.

### 2.4 Follow-ups and threads

A thread is a passage plus the questions and answers about it. The rule for the target thread is simple and visible:

- **If the selection is the same as the passage of the most recent thread, the question is a follow-up.** This applies to presets and to `a`.
- **If the selection is different, the question starts a new thread** anchored at the new selection.
- The status line and the overlay header always show the target before the user sends.
- In the ask overlay, `Tab` overrides the rule.

So after `Enter` (explain), a press of `x` gives "an example of that" in the same thread. No extra key is needed.

In `READER` mode, the preset keys act on the last answer. For example, `s` means "simplify your last answer".

### 2.5 Cancel, regenerate, repeat

| Key | Action | Note |
|---|---|---|
| `c` | Stop the answer that streams now. | The partial answer stays, with a "stopped" label. |
| `r` | Regenerate the last answer. | The old version stays under a fold in the answer pane. |
| `.` | Repeat the last preset on the current selection. | This is fast for a list of terms: `j` `.` `j` `.` |

The preset keys ignore auto-repeat events (`event.repeat`). A held key must not send ten requests. A second press of the same preset on the same passage within two seconds is ignored, with a short status message.

### 2.6 The complete keymap (home-row layout, the default)

Global keys work in every mode.

| Key | Action | Mode | Rationale |
|---|---|---|---|
| `Esc` | Close the overlay or mode. Collapse the selection. Return focus to the PDF pane. | Global | One universal "back" key. Remap Caps Lock to Esc (section 6). |
| `Tab` | Toggle focus between the PDF pane and the answer pane. | NORMAL, READER | One key to move and one key to return. |
| `:` | Open the command palette (go to page, open file, settings, all actions by name). | NORMAL, READER | Rare actions do not need their own key. |
| `?` | Show the keymap help. | NORMAL, READER | Rare, so a shift is acceptable. |
| `Space` | Next paragraph. | NORMAL | Thumb key, the most frequent action. It replaces the mouse wheel. |
| `b` | Previous paragraph. | NORMAL | Left index finger, no reach. |
| `j` / `k` | Next / previous sentence. | NORMAL | Right home row. |
| `l` / `h` | Extend / shrink the selection by one sentence. | NORMAL | Right home row, no chord. |
| `p` | Toggle sentence / paragraph selection. | NORMAL | |
| `f` | Hint mode. | NORMAL | Left index home key. Vimium convention. |
| `/` | Search to select (v1.1). | NORMAL | Common convention. |
| `'` | Jump back to the reading position (toggles between the last two positions). | NORMAL | Right pinky home row. Vim convention. |
| `]` / `[` | Next / previous Q&A anchor. | NORMAL, READER | |
| `o` | Open or close the margin note at the cursor. | NORMAL | |
| `z` | Open the reader overlay for the latest answer. | NORMAL | For long answers. |
| `\` | Show or hide the answer pane. | NORMAL | |
| `Enter`, `e` | Explain. | NORMAL, READER | The most common question in one key. |
| `d` `s` `g` `x` `w` `t` | Define, simplify, gist, example, why, translate. | NORMAL, READER | Left hand. Mnemonic letters. |
| `q` | Teach-back (v1.1). | NORMAL | |
| `a` | Ask free text (open the ask overlay). | NORMAL, READER | "a" for ask. Typing follows, so the pinky load is small. |
| `v` | Ask by voice (overlay with the microphone on). | NORMAL, READER | |
| `.` | Repeat the last preset on the current selection. | NORMAL | |
| `r` | Regenerate the last answer. | NORMAL, READER | |
| `c` | Cancel the answer that streams now. | NORMAL, READER | |
| `m` | Mark the passage as confusing, with no question. | NORMAL | Feeds the confusion map. |
| `Down` / `Up`, `PageDown` / `PageUp` | Free scroll. The cursor does not move. | NORMAL | To look at a figure without a loss of place. |
| `=` / `-` | Zoom in / out. | NORMAL | No shift needed. |

Keys in `READER` mode only:

| Key | Action |
|---|---|
| `j` / `k` | Scroll the answer by three lines. |
| `Space` / `b` | Scroll the answer by one screen. |
| `]` / `[` | Next / previous message in the thread. |
| `y` | Copy the answer as Markdown. |
| `,` | Read the answer aloud, or stop. |
| `z` | Switch between the answer pane and the full reader overlay. |
| `Esc` or `Tab` | Return to the PDF pane at the reading position. |

Keys in `HINT` mode: the label letters, `p` (paragraph labels), `Esc`. Keys in `ASK` and `SEARCH` modes: all letters are text. Only `Enter`, `Esc`, `Tab`, `Up`, `Down` and Ctrl+`Space` have functions.

Every letter key except the global keys is mode-dependent. A letter never does a NORMAL action while a text input has focus.

## 3. Focus management

### 3.1 The rule

**The PDF pane owns focus.** Only four things take focus away from it, and each one gives focus back:

| What takes focus | How focus returns |
|---|---|
| `a` or `v` (ask overlay) | Automatically on `Enter` (send) or `Esc`. |
| `/` (search) | Automatically on `Enter` or `Esc`. |
| `:` (palette) | Automatically when the command runs, or on `Esc`. |
| `Tab` or `z` (read the answer) | `Esc` or `Tab`, one key. |

A streaming answer **never** takes focus. A new answer never moves the cursor and never scrolls the PDF.

### 3.2 Read an answer without a focus change

The answer pane is visible next to the PDF. A short answer fits in the pane, so the user reads it with their eyes and presses no key. For this reason, the answer pane scrolls so that the **first line** of the new answer is at the top. The pane does not follow the end of the stream, because the user reads from the top. If the user scrolls the pane during the stream, the auto-scroll stops.

### 3.3 Signals for a streaming answer

The UI uses three signals, from the most visible to the least visible:

1. **The status line** (the bottom of the PDF pane, always visible). Left: the mode. Center: the staged text ("S · 2 sentences · 41 words · p. 42"). Right: the answer state.
   - `◌ explain… 3 s` while the answer streams.
   - `● ready · Tab to read · o to open here` when it is done.
   - `✕ error · r to retry` when it fails.
2. **The margin marker.** A small ring pulses in the gutter next to the passage while the answer streams. When the answer is done, the ring becomes a solid numbered tag.
3. **A sound (off by default).** A soft, short chime plays only when an answer takes more than 5 seconds. Then the user can look away from the screen and still know when to come back.

The status line is also an `aria-live="polite"` region, so a screen reader announces "answer ready".

## 4. Response placement

### 4.1 The options

| Option | Good | Bad |
|---|---|---|
| Answer pane only | Wide text, easy to read. One full history. Simple to build. | The answer is far from the passage. Old answers are hard to find from the text. |
| Margin notes only | The answer is next to the passage. The PDF shows where you had questions. | PDF margins are narrow. Long answers overlap on a dense page. Hard to read a 300-word answer. |
| **Both (recommended)** | Each place does the job it is good at. | More UI to build. |

**Recommendation: both, with different jobs.** The answer pane holds the full threads. The margin holds compact anchors that lead to them. A margin note shows only the first sentence of the answer (its "gist line"). The full text stays in the answer pane or the reader overlay.

### 4.2 Anchor markers in the PDF

- **The tag.** A small pill in the page gutter, level with the first line of the passage, with the thread number ("4"). In a two-column page, the tag for column 2 is in the right gutter.
- **Color by type.** Blue for a question thread. Amber for a passage marked with `m`. Green for a teach-back. The colors also have different shapes (circle, triangle, square), so color blindness is not a problem.
- **The passage tint.** The passage gets a faint underline at all times. It gets a full tint only when the cursor or anchor navigation is on it. This keeps a heavily annotated page readable.
- **Anchors persist** across sessions. The UI needs the backend to store each anchor with a text quote plus its position, so the anchor survives a re-render or a new copy of the same PDF.
- **The scrollbar map.** Small ticks on the PDF scrollbar show where anchors are. This is the basic confusion map (section 5).

### 4.3 Keyboard navigation between anchors

- `]` and `[` move to the next and the previous anchor in document order.
- The jump moves the cursor to the anchor passage. The answer pane scrolls to that thread. Focus stays in the PDF pane.
- Anchor jumps are excursions. They do not change the stored reading position. `'` returns to the place where the user was reading.
- `o` opens the anchor as an inline card under the passage. The card shows the gist line and the last question. `o` again closes it.
- `:anchors` in the palette lists all anchors with their gist lines, for a document-wide view.

### 4.4 Collapse and expand

- A margin note is collapsed by default: tag only.
- `o` expands one note to the inline card.
- `:notes all` expands all notes on the current page. `:notes none` collapses all.
- In the answer pane, old threads collapse to one line (the question and the gist line). The current thread is always expanded.

### 4.5 Read a long answer without the mouse

Two ways, and the user picks one per answer:

- **In the answer pane:** `Tab`, then `j` / `k` or `Space` / `b` to scroll, then `Esc`. This is good for answers up to about two screens.
- **In the reader overlay:** `z`. The overlay covers the center of the screen. It uses a 70-character line length and a larger font. It has the same keys as `READER` mode. `Esc` closes it. This is good for long answers, and it is the default view when the answer pane is hidden.

## 5. Reading-flow features

| Feature | Behavior | Phase | Why this phase |
|---|---|---|---|
| Continue reading (`'`) | The reading position is the last place that the movement keys and hint mode reached. Anchor jumps, search and page jumps do not change it. `'` toggles between the reading position and the last excursion. On reopen, the document opens at the reading position. | MVP | It is cheap and it removes the "re-find my place" step. |
| Cursor stays after an answer | After an answer, the cursor stays on the passage, so a follow-up needs no reselection. `Space` continues. | MVP | This is the default. |
| Auto-advance after an answer | Option: when the user leaves `READER` mode, the cursor moves to the next sentence. | Later | It conflicts with follow-ups. Test the default first. |
| Repeat preset (`.`) | Apply the last preset to the new selection. | MVP | It costs almost nothing. |
| Mark confusing (`m`) | Add an amber anchor with no question. | MVP | It is the "I will ask later" path and it feeds the map. |
| Confusion map, basic | Scrollbar ticks and `:anchors` list. | MVP | It comes free from the anchors. |
| Confusion map, full | A chapter view of all asked and marked passages. Export as Markdown study notes. A "review my confusions" pass that steps through them with `]`. | Later | It needs some use data first. |
| Per-page glossary | In the background, the system extracts the terms on the current page and the next page and defines them. `d` on a known term then answers at once, from a local cache. Known terms can get a faint dotted underline (option, off by default). | Later | It costs LLM calls per page. The context owner must agree. In the MVP, `d` works with a normal LLM call. |
| Teach-back (`q`) | The user explains the passage in their own words. The LLM says what is correct and what is missing. | v1.1 | High learning value, but it needs a good prompt and a new answer layout. |
| Quiz me | `:quiz` asks three questions about the current section. | Later | Lower priority than teach-back. |
| Return recap | On reopen, the status line offers "`g` for a gist of where you stopped". | Later | Small value. |

## 6. Ergonomics and accessibility

### 6.1 RSI-friendly choices

- **No chords for frequent actions.** All frequent keys are single and unshifted. Shift appears only on `?` and `:`. Ctrl appears only on the microphone toggle in the overlay.
- **Home row and thumb.** `Space` (thumb) does the most frequent action. The right home row moves. The left hand asks.
- **Two hands share the load.** Navigation is on the right hand and asks are on the left hand. Hint labels alternate hands.
- **Key repeat.** A held `j`, `k`, `Space` or `b` repeats, with the normal OS repeat rate. Presets never repeat (section 2.5).
- **Esc reach.** Esc is a far key. The help page tells the user to map Caps Lock to Esc at the OS level. The keymap file also accepts a second "back" key, for example `;`.
- **No timeouts.** No interaction needs a fast second key. Slow or one-finger typing is safe.
- **Hardware.** Because every frequent action is one key, a USB foot pedal or a small macro pad can send `Space` and `Enter`. The help page gives this as an option. A foot pedal on `Space` removes the most frequent key press from the hands.

### 6.2 Two layouts

The user picks one in the settings. The preset keys are the same in both layouts.

| Action | `home` layout (default) | `arrows` layout |
|---|---|---|
| Next / previous sentence | `j` / `k` | `Down` / `Up` |
| Next / previous paragraph | `Space` / `b` | `Space` / `Backspace` |
| Extend / shrink | `l` / `h` | `Right` / `Left` |
| Free scroll | `Down` / `Up`, `PageDown` / `PageUp` | `PageDown` / `PageUp` |
| Hint mode | `f` | `f` |
| Back to the reading position | `'` | `'` |

In the arrows layout, the right hand stays on the arrow keys and the left hand stays on the presets. This is easy to learn for a user who does not know vim.

I recommend `home` as the default. The arrow keys need the right hand to leave the home row, and the hand must move again to type a question.

### 6.3 Optional count prefix

In the `home` layout, a digit before a movement key repeats it: `3j` moves three sentences. This is off by default. A new user rarely knows the count, and hint mode does the same job better.

### 6.4 The keymap file

The keymap is a file: `~/.config/llm-reader/keymap.toml`. Every action has a stable name. The `?` help page and the command palette read the same file, so the help is always correct.

```toml
layout = "home"            # "home" or "arrows"
back_key_extra = ";"       # optional second Esc

[normal]
"space" = "cursor.next_paragraph"
"b"     = "cursor.prev_paragraph"
"j"     = "cursor.next_sentence"
"k"     = "cursor.prev_sentence"
"l"     = "selection.extend"
"h"     = "selection.shrink"
"f"     = "hint.sentences"
"'"     = "cursor.jump_back"
"enter" = "ask.preset:explain"
"a"     = "ask.overlay"

[presets.explain]
key   = "e"
label = "Explain"
intent = "Explain this passage in plain words, in the context of the book."

[presets.proof]           # a user preset
key   = "u"
label = "Walk through the proof"
intent = "Walk through this argument one step at a time."
```

The settings page validates the file and shows conflicts (two actions on one key) before it saves.

### 6.5 Voice input for the question text

| | Web Speech API | Local Whisper (whisper.cpp or faster-whisper on the local server) |
|---|---|---|
| Setup | None in Chrome and Edge. | Model download (about 150 MB to 1.5 GB). Needs a reasonable CPU or a GPU. |
| Browser support | Chrome, Edge, Safari. Not Firefox. | Any browser. |
| Privacy | Chrome sends the audio to Google servers. | Audio stays on the machine. |
| Latency | Live partial text while the user speaks. | Text appears 0.5 to 2 s after the user stops. |
| Technical words | Weak on rare terms. | Better. The page can pass the terms of the current page as a prompt hint. |
| Offline | No. | Yes. |

**Recommendation.** Ship the Web Speech API first, because it needs no setup. Put the speech engine behind one small interface, so local Whisper can replace it in v1.1. Use local Whisper by default when the user is on Firefox or turns on "private mode".

**Interaction.** `v` starts the microphone. The microphone stops after 1.5 s of silence, or when the user presses `v` or `Enter`. The user does not hold a key, because a held key is a static load on the finger. The text appears in the ask overlay, and the user can edit it before `Enter`. A setting "send on silence" removes the `Enter` too.

Later: voice commands ("explain", "next paragraph", "define") that map to the same action names.

### 6.6 Read-aloud of answers

- `,` in `READER` mode reads the answer aloud. `,` again stops it.
- The MVP uses the browser `speechSynthesis` API. The voice and the rate are in the settings.
- The current sentence of the answer is highlighted while it plays.
- Later: a local TTS engine (for example, Piper) for better voices and offline use.
- Option (later): auto-read every new answer. This lets the user keep the eyes on the PDF.

### 6.7 Fonts, layout and themes for long sessions

| Item | Default |
|---|---|
| Split | PDF 62%, answer pane 38%. `:split 70` changes it. The split persists. |
| PDF zoom | Fit width. The zoom persists per document. |
| Answer text | 18 px, line height 1.6, at most 70 characters per line, a readable sans-serif font (system UI font). |
| Reader overlay | 20 px, the same line length. |
| Cursor highlight | A low-saturation tint (for example, a pale yellow at 35% opacity in light mode). It never hides the text. |
| Theme | Follow the OS (`prefers-color-scheme`). Options: light, sepia, dark. |
| Dark mode for the PDF | Invert the page canvas with a hue rotation, so text is light on dark. Images then look wrong, so an option keeps images in their true colors. Sepia is the alternative for users who dislike an inverted page. |
| Motion | All scrolls and animations obey `prefers-reduced-motion`. |
| Focus ring | A clear 2 px outline on the pane with focus. The user always sees which pane gets the keys. |

## 7. Worked walkthrough: a 60-second session

The user reads page 42 of a statistical mechanics textbook in a two-column layout. Layout: `home`.

| Time | Key | What happens | Running count |
|---|---|---|---|
| 0 s | (open) | The document opens at the stored reading position, paragraph 1 of page 42. The gutter bar marks it. | 0 |
| 8 s | `Space` | The user finishes paragraph 1. The bar moves to paragraph 2. | 1 |
| 17 s | `Space` | The bar moves to paragraph 3, at the bottom of column 1. | 2 |
| 21 s | `j` | The first sentence of paragraph 3 gets the tint. | 3 |
| 22 s | `j` | The second sentence gets the tint: "In the canonical ensemble the system exchanges energy with a reservoir at fixed temperature…". The status line shows "S · 1 sentence · 24 words · p. 42 · new thread". | 4 |
| 23 s | `Enter` | Explain. The status line shows "◌ explain… 1 s". A ring pulses in the gutter. Focus stays in the PDF. | 5 |
| 25 s | (none) | The answer streams into the answer pane, top first. The user reads the first part with no key. | 5 |
| 33 s | `Tab` | The answer is longer than the pane. Focus moves to the answer pane (`READER`). | 6 |
| 34 s | `Space` | The answer scrolls one screen. The user reads the rest. | 7 |
| 40 s | `a` | The ask overlay opens. The header says "Follow-up in thread #7". | 8 |
| 41–47 s | (types) `why is the temperature fixed but not the energy` | 47 characters of text. | 8 + text |
| 47 s | `Enter` | The follow-up goes to thread #7. The overlay closes. The new answer streams below the first one. | 9 |
| 55 s | `Esc` | The answer was short. The user returns to the PDF. The cursor is still on sentence 2 of paragraph 3. | 10 |
| 57 s | `Space` | The bar moves to paragraph 1 of column 2. The user reads on. | 11 |

**Totals for the new workflow:** 11 single keys plus one typed question. 0 chords, 0 mouse actions, 0 copy and paste, 1 focus round-trip (`Tab` / `Esc`, optional), 0 re-find. Without the follow-up, the question costs 3 keys: `j` `j` `Enter`.

**The same question in the old workflow:**

| Step | Action | Type |
|---|---|---|
| 1 | Move the mouse to the sentence and drag across it | Precise mouse drag |
| 2 | Ctrl+C | Chord |
| 3 | Alt+Tab, or move the mouse to the other tab | Chord or mouse |
| 4 | Click the prompt box | Mouse click |
| 5 | Ctrl+V | Chord |
| 6 | Enter | Key |
| 7 | Scroll the answer with the wheel | Mouse |
| 8 | Type the follow-up, Enter | Text + key |
| 9 | Alt+Tab or click back into the PDF tab | Chord or mouse |
| 10 | Find the place in the PDF again | Eye search, often a scroll |

| Measure | Old workflow | llm-reader |
|---|---|---|
| Mouse actions | 3 to 5 (one is a precise drag) | 0 |
| Chords | 3 to 4 | 0 |
| Single keys | 2 | 11 (5 of them are `Space` presses that replace the wheel) |
| Focus switches between apps or tabs | 2 | 0 (one optional pane switch) |
| Re-find the place | Yes | No |
| Context sent to the LLM | Only the pasted text | The passage plus the book context (owned by the context strategy) |

The key count looks similar, but the cost is very different. The old workflow uses the most painful actions: a precise mouse drag, chords, and hand moves between mouse and keyboard. The new workflow uses only home-row and thumb keys.

## 8. Open questions for the user

1. **Do you use vim keys anywhere today?** If not, the `arrows` layout may be the better default, and the help page must teach `j` / `k`.
2. **Which hand or fingers hurt?** If only the mouse hand hurts, the current split is fine. If both hands hurt, a foot pedal, a one-hand layout, or voice-first input moves up in priority.
3. **What PDFs do you read most?** Two-column papers, textbooks with math, or scanned books? Math and scans need region-image questions and OCR, which change the selection design.
4. **Do you want answers next to the PDF, or the PDF at full width with answers in an overlay?** What is your screen size? This sets the default layout.
5. **Is cloud speech recognition acceptable to you, and do you want voice for questions only, or also for commands?** This decides between the Web Speech API and local Whisper, and if a voice-command layer is worth the work.
