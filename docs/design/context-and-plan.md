> **Research appendix.** This file holds the full detail behind one area of [DESIGN.md](../../DESIGN.md).
> Where this file and DESIGN.md differ on a key, a phase, or a preset list, DESIGN.md wins.

# LLM context strategy, prompt presets, product scope, and build plan

Scope of this section: what the app sends to the model, how it words the request, what it computes in advance, what the product includes, and the order of the build. The keymap, the UI layout, the server, and the PDF rendering are out of scope here. Other sections own them. Where this section needs a key or a UI element, it names the action (for example "the Explain action"), not the key.

Token sizes in this section are approximate. A typical book page is 500 to 800 tokens. A chapter of 20 to 40 pages is 10,000 to 30,000 tokens. A 300-page book is approximately 200,000 tokens.

---

## 1. Why the old workflow gives mediocre answers, and how integration fixes it

### 1.1 The bare paste removes the information that the answer depends on

In the old workflow, the model receives one thing: the passage that the user pasted. The model does not know the following:

| Missing information | Effect on the answer |
|---|---|
| The book title, the author, and the field | The model guesses the field. It explains a term with its most common meaning, which is often not the meaning of this book. |
| The chapter and the section | The model does not know what the passage tries to prove or set up. It explains the sentence, not the role of the sentence. |
| The surrounding paragraphs | Back-references ("this", "the second approach", "as shown above", "the two cases") have no referent. The model guesses, or it gives a generic answer that fits every referent. |
| The definitions and the notation that the book established earlier | The model redefines symbols. For example, the book uses `k` for the number of clusters, and the model treats `k` as a generic index. |
| The questions that the user already asked | The model explains the same background again. It cannot say "this is the same idea as the invariant on page 42". |
| The reader's background and goal | The model picks a level at random: too basic for an engineer, or too dense for a newcomer to the field. |

A worked example. The user pastes: *"This is why the second approach fails: it conflates the two kinds of error that we distinguished above."*

- With a bare paste, the model can only say "the approach mixes two different types of error". This answer is correct and useless.
- With the context, the model sees that "the second approach" is the pooled estimator from page 141. It also sees that "the two kinds of error" are the book's *sampling error* and *specification error* from page 137. The model can now say which error the pooled estimator hides, and why.

### 1.2 The user pastes the minimum, because each paste costs effort

Context costs keystrokes and mouse movement in the old workflow. A user with hand pain rationally pastes one sentence, not three paragraphs, and never types "I am reading chapter 7 of X by Y". The quality of the answer therefore drops exactly when the user is most tired. In the integrated app, context costs zero keystrokes. The context is present on every ask, including the 40th ask of the evening.

### 1.3 The long rolling web chat degrades over a session

A three-hour chat tab mixes many passages and topics. The web interface can silently truncate the oldest turns. The model then gives equal weight to an unrelated question from page 12 and to the current passage. The integrated app sends a *selected* history: the current thread in full, plus a compact index of the other threads. The app controls what the model sees.

### 1.4 Conclusion

Automatic context is the largest quality gain of the product, not only the largest convenience gain. The removal of copy and paste makes each ask cheaper. The automatic context makes each answer better. The two gains multiply: the user asks more often, and each answer is more specific.

Caution: more context is not always better. Irrelevant context dilutes the model's attention and increases cost. Section 2 therefore gives each layer a budget and a trim order.

---

## 2. Context assembly per request

### 2.1 Design rules

1. The ask path makes exactly one LLM call. All other context comes from local data or from background jobs that already finished. No background job blocks an ask.
2. The app assembles the context locally in less than 50 ms after the user triggers the ask.
3. The *importance* of a layer controls the trim order. The *stability* of a layer controls its position in the prompt. Stable layers go first, so that the provider can cache them (see section 6). The selected passage goes last, near the instruction.
4. The app shows the user what it sent: a small "context used" line under each answer (for example `passage · page 142 ±1 paragraph · ch.7 summary · 3 past Q&A · 5,400 tok`). This makes the context debuggable.

### 2.2 The layers and the default budget

The default budget for a standard ask is **6,000 input tokens**. The user can change it in the config file. A small local model with an 8,000-token window needs a smaller budget, for example 3,500.

| Layer | Content | Default budget (tokens) | Floor when trimmed | Trim order (1 = first to trim) |
|---|---|---|---|---|
| S | System prompt (static) | ~550 | fixed | never |
| C | Document metadata: title, authors, year, edition, chapter-level table of contents | ~300 | title, authors, current chapter | never |
| F | Reader profile and per-document goal | ≤150 | full | never |
| A | Selected passage, plus location (chapter > section > printed page and PDF page) and the preset instruction | passage ≤2,000; hard cap 4,000 | full | never |
| B | Surrounding text, with the selection marked in place | 1,200 | the containing paragraph | 7 |
| G | Glossary hits: book-defined terms that occur in A or B | 400 | 150 | 5 |
| D1 | Running summary of the current chapter up to the current page | 600 | 250 | 6 |
| D2 | Summary of the book up to the current chapter | 400 | 0 | 2 |
| E1 | Turns of the active thread (follow-ups only) | 2,500 | first turn + last 2 turns | 8 |
| E2 | The 2 most recent threads in this chapter, compact form | 500 | 0 | 4 |
| E3 | Q&A index: one line per past thread | 600 | lines for pages that the question names | 3 |
| E4 | Up to 2 related threads from other chapters, compact form (Phase 1 and later) | 500 | 0 | 1 |

A typical new ask with a 150-token selection uses approximately 5,000 tokens before slack. Follow-ups replace E2 to E4 with E1 (see section 4).

**Selection above the hard cap.** If the selection is longer than 4,000 tokens, the app does not truncate it silently. It shows a one-line notice and offers two choices: narrow the selection, or send it as a Deep ask (section 2.5).

### 2.3 The trimming algorithm

```
budget = config.budget            # 6,000 by default
layers = assemble_all_layers()    # each layer already capped at its own default budget
# 1. Fill: layers that are empty or short leave slack.
slack = budget - total(layers)
if slack > 0:
    expand B (surrounding text) by whole paragraphs until slack is used or B reaches 2 pages
# 2. Trim: when the total exceeds the budget (long selection, long thread, small model).
for layer in [E4, D2, E3, E2, G, D1, B, E1]:      # trim order
    while total(layers) > budget and layer.size > layer.floor:
        layer.shrink_one_unit()     # drop one thread, one paragraph, one glossary entry, or one summary sentence
if total(layers) > budget:
    warn the user and send anyway (S, C, F, A are never trimmed)
```

Rationale for the order: the app trims speculative and distant context first (related threads from other chapters, the whole-book summary). It keeps local context last (the surrounding text, the active thread). Local context answers most questions about a passage.

### 2.4 The surrounding text (layer B)

- Unit: whole paragraphs, not sentences. Sentence splitting on PDF text is unreliable (abbreviations, equations, hyphenation). Paragraph splitting with PDF.js line positions is more reliable.
- Start with the paragraph that contains the selection.
- Expand outward by whole paragraphs. Take **two paragraphs before for each paragraph after**. Earlier text sets up the referents ("the second approach"). Later text rarely resolves them.
- Cross page boundaries freely. A selection at the top of a page needs the end of the previous page.
- Mark the selection in place with `⟦` and `⟧`. Also repeat the selection in layer A. The repetition costs few tokens, and it puts the passage next to the instruction.
- Do not cross a chapter boundary. Text from the previous chapter is the job of D2.

### 2.5 Full chapter versus summary

| Mode | What goes into the prompt | When to use it |
|---|---|---|
| Standard (default) | D1 running summary of the chapter + layer B | Every ask, unless the user requests Deep |
| Deep ask | Full chapter text from the chapter start to the end of the current section, cap 30,000 tokens. If the chapter is longer: D1 summary + the last 10 pages in full. | The user requests it explicitly with a modifier on the ask action. The Connect preset also uses it when the chapter is short (≤15,000 tokens). |
| Auto (Phase 2, optional config `chapter_mode: auto`) | Full chapter as a cached prefix | The provider supports prompt caching, the chapter so far is ≤20,000 tokens, and the user has made 2 or more asks in this chapter. The cache then pays back over the following asks. |

Recommendation: use Standard by default. A good 600-token chapter summary plus the local paragraphs answers approximately nine of ten passage questions. The full chapter helps mainly with "how does this connect" questions and with long arguments that span many pages. A Deep ask costs 4 to 6 times a standard ask without caching. With caching, the repeat cost is a small fraction of that. The cost readout (section 6.5) shows the difference on each answer.

Spoilers: for nonfiction, the Deep ask can include the rest of the current section after the selection. For fiction, set `include_text_after_page: false` in the per-document settings.

### 2.6 How to build and refresh the running summary cheaply

There are two candidate strategies:

- **Eager, on each page turn.** The summary is always ready. But the app pays for summaries of pages with no asks, and skimmed pages trigger useless calls.
- **Lazy, on the first ask in a chapter.** There is no wasted cost. But the first ask in each chapter waits for the summary, which breaks design rule 1.

**Recommendation: a background, incremental summary with a dwell filter, never on the ask path.**

1. A page counts as "read" when it is visible for 15 seconds or more. Skimmed pages do not count.
2. After every 3 read pages in a chapter, the app queues one summary job for the fast model.
3. The job input is the previous summary plus the new pages, which is approximately 2,500 to 3,000 tokens. The job output is the updated summary, at most 350 words.
4. On an ask, the app uses the newest summary that exists. If no summary exists yet (the first pages of a chapter), the app uses the raw text of the previous 1 to 2 pages instead. The raw text is better than a summary at this distance anyway.
5. At the end of a chapter, the app compresses the final chapter summary to approximately 120 words. It appends the result to D2, the book-so-far summary. When D2 exceeds 400 tokens, the fast model compresses the older chapter entries further.
6. If the user jumps into the middle of a book, the app runs one catch-up job on the chapter pages before the current page, with a cap of 15,000 input tokens. For the earlier chapters, it builds D2 from the table of contents only. It does not summarize the earlier chapters unless the user asks for that.

Cost: one summary update per 3 pages is approximately 1,000 fast-model input tokens per page read. This is small next to the cost of the asks.

**The running summary prompt (fast model):**

```
You maintain a running summary of one chapter for a reader who is partway through it.

Book: {{title}} by {{authors}}
Chapter: {{chapter_title}}

Current summary (covers pages {{p_start}}–{{p_prev}}):
<summary>
{{previous_summary_or_"(none)"}}
</summary>

New pages {{p_from}}–{{p_to}}:
<pages>
{{page_text}}
</pages>

Write the updated summary so that it covers pages {{p_start}}–{{p_to}}.
Rules:
- At most 350 words. Compress older material more than newer material.
- Keep every term that the chapter defines, with its definition and page number.
- Keep every named result (theorem, law, principle, algorithm) with its page number.
- Keep the structure of the argument: the main claims, and what supports each claim.
- Use the author's terminology and notation. Do not add outside knowledge or opinions.
Output only the summary text.
```

### 2.7 The reader profile (layer F)

The profile is a plain-text field in the config file, plus an optional goal per document. Example:

```
I am a software engineer. I know programming, discrete math, and basic probability.
I have no biology or chemistry background. Examples from software systems help me most.
Goal for this book: understand the ideas well enough to explain them to a colleague. No exam.
```

Keep the profile under 150 tokens. The model reads it on every ask, so a long profile costs on every ask.

### 2.8 The assembled prompt, in order

The order is from stable to volatile, for caching. Both provider families accept this shape: one system message, then user and assistant messages.

```
[system]   S: system prompt (static, identical for all documents)

[user, turn 1]
<document>                          ← C, static per document
title: ...
authors: ...
contents: 1. ... 2. ... 3. ...
</document>
<reader>                            ← F, static per document
...
</reader>
<book_so_far>...</book_so_far>       ← D2, changes once per chapter
<chapter_so_far>...</chapter_so_far> ← D1, changes every ~3 pages
                                     ← cache breakpoint here
<glossary>                           ← G
term — definition (p. 31)
</glossary>
<past_questions>                     ← E3
#12 p.88 [explain] "A monad is just..." → bind sequences effects; return lifts a value.
</past_questions>
<recent_threads>...</recent_threads> ← E2, E4
<surrounding_text pages="141-142">   ← B
... ⟦selected text⟧ ...
</surrounding_text>
<request>                            ← A
location: Part II > Ch. 7 "Estimation" > 7.3 "Pooling" — page 142 (PDF page 158)
selected passage:
"""
...
"""
{{preset instruction}}
</request>
```

The location goes into the request block, not the document block. The location changes on every ask. If it were in the document block, it would break the cached prefix.

---

## 3. System prompt and preset prompts

### 3.1 The system prompt

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

This prompt is approximately 400 tokens. It is identical for all documents and all presets, so the provider can cache it. The preset instruction goes into the request block.

### 3.2 The preset templates

Each template below replaces `{{preset instruction}}` in the request block. `{{passage}}` is already in the request block. The `max_tokens` column is the output cap that the app sends. The cap is a backstop. The word limit in the prompt controls the length.

| Preset | Target length | `max_tokens` cap | Default model role |
|---|---|---|---|
| Explain | ≤150 words (≤250 for a multi-step argument) | 600 | strong |
| Define the terms | ≤40 words per term, ≤5 terms | 400 | fast (cache hit when possible) |
| Simplify | not longer than the original, ≤200 words | 500 | strong |
| Give an example | ≤200 words | 500 | strong |
| Why it matters / Connect | ≤200 words | 500 | strong |
| Steelman and critique | ≤250 words | 600 | strong |
| Restate as steps | ≤10 steps | 500 | strong |
| Check my understanding | ≤150 words | 400 | strong |
| Quiz me on this page | 3 questions, ≤25 words each | 300 | strong |
| Translate | about the length of the source + ≤3 notes | 1.5 × source + 200 | fast |
| Free ask (user types a question) | ≤200 words unless the question needs more | 800 | strong |

**Explain**

```
Task: Explain the selected passage.
- Say what it means in plain terms, then why the author says it at this point in the chapter.
- Name the specific referent of every back-reference in the passage.
- If the passage depends on an earlier definition or result, name it and give its page if the context gives one.
Length: at most 150 words. If the passage is a multi-step argument, at most 250 words.
```

**Define the terms**

```
Task: Define the terms in the selected passage that this reader may not know.
- If the selection is a single word or symbol, define only that word or symbol.
- Give the meaning that the book uses here. If the <glossary> has the book's definition, use it and cite its page.
- If the common meaning differs from the book's meaning, add one line that starts with "Common meaning differs:".
Format: one line per term: **term** — definition.
Length: at most 5 terms, at most 40 words per term.
```

**Simplify**

```
Task: Rewrite the selected passage in plain language for a first-year undergraduate in an unrelated field.
- Keep every claim. Do not drop a logical step.
- Replace jargon with plain words. Keep each key term from the book once, in parentheses, so that the reader can map the rewrite back to the book.
- Do not add new claims.
Length: no longer than the original passage, and at most 200 words.
```

**Give an example**

```
Task: Give one concrete example that makes the selected passage clear.
- Use an example from the reader's field if one fits honestly. Otherwise use an everyday example.
- Use specific numbers, names, or values, not placeholders.
- If the book gives an example nearby in the surrounding text, do not repeat it. Give a different one.
- After the example, map each part of the example to the passage in one or two sentences.
- If the example breaks down at an important point, say where in one sentence.
Length: at most 200 words.
```

**Why it matters / Connect**

```
Task: Explain why this passage matters and how it connects to earlier material.
Answer in three short parts:
1. Purpose: which question or problem this passage answers.
2. Depends on: the earlier ideas that it uses. Use <chapter_so_far>, <book_so_far>, <glossary>, and <past_questions>. Give page numbers only when the context contains them.
3. Sets up: what it probably prepares for next. Mark this part "(guess)" unless the text so far says it.
If a past question of the reader is about a related idea, mention it by its number, for example "(see #12, p. 88)".
Length: at most 200 words.
```

**Steelman and critique**

```
Task: Steelman the claim in the selected passage, then critique it.
- Steelman: the strongest version of the author's claim and the best reason to believe it. At most 80 words.
- Critique: the strongest objections, hidden assumptions, or known counter-evidence. At most 3 points, at most 40 words each. Mark outside knowledge.
- End with one line: "Verdict: sound | sound with caveats | contested | wrong — " and one reason.
If the passage makes no claim (for example, it is a definition), say so in one line and stop.
Length: at most 250 words.
```

**Restate as steps**

```
Task: Restate the selected passage as a numbered sequence of steps or a chain of reasoning.
- One step per line. Each step is one action or one inference.
- If the text skips a step, insert it and mark it "[implied]".
- Mark the step where the conclusion follows with "⇒".
- Keep the book's notation.
Length: at most 10 steps.
```

**Check my understanding** (the user types a restatement)

```
Task: The reader wrote what they think the selected passage means:
<reader_restatement>
{{user_text}}
</reader_restatement>
Grade the restatement against the passage.
- Line 1: exactly one of "Correct", "Mostly correct", "Partly correct", "Incorrect".
- Right: what the reader got right, in one line.
- Wrong or missing: each specific error or gap. Quote the reader's words when you point to an error.
- Fix: one corrected sentence.
Do not rewrite the whole restatement. Do not soften a grade of "Incorrect".
Length: at most 150 words.
```

**Quiz me on this page** (the anchor is the page; layer B is the whole page instead of a selection)

```
Task: Write 3 questions that test understanding of this page, not memory of its wording.
- Question 1: a "why" question.
- Question 2: apply the idea to a new case.
- Question 3: "what changes if ..." about one assumption.
Do not give the answers. The reader answers in the next message.
Length: at most 25 words per question.
```

Follow-up turn after the reader answers:

```
The reader's answers:
{{user_text}}
Grade each answer with the same scale and format as "Check my understanding". Then give the model answer for each question in at most 40 words.
```

**Translate**

```
Task: Translate the selected passage into {{target_language}}.
- Keep math, symbols, and code unchanged.
- For a technical term with no standard translation, keep the original term in parentheses after the translation.
- After the translation, add "Notes:" with at most 3 notes about idioms or terms where the translation loses meaning. Omit "Notes:" if there are none.
No other commentary.
```

**Free ask**

```
Task: Answer the reader's question about the selected passage:
<question>
{{user_text}}
</question>
Length: at most 200 words, unless the question clearly needs more.
```

### 3.3 The follow-up shape

A follow-up stays in the same thread and on the same anchor. The app does not resend the context blocks. They are already in turn 1 of the thread (see section 4.2). The follow-up user turn is short:

```
Follow-up on the same passage (page {{printed_page}}):
<question>
{{user_text}}
</question>
{{optional: <referenced_threads> ... </referenced_threads>}}
Length: at most 150 words, unless the question needs more.
```

A preset can also be a follow-up. For example, the user asks Explain, then triggers "Give an example" with no new selection. The app then sends the Example template as the follow-up text, without the passage. This makes "now give me an example" a single action.

### 3.4 The index-line prompt (fast model, after each answer)

```
Summarize what this answer clarified, in one line of at most 18 words. State the content, not the action.
Bad: "Explains the pooling estimator."
Good: "Pooling hides specification error because it averages groups with different true slopes."
<answer>
{{answer}}
</answer>
```

In Phase 0, the app uses the first sentence of the answer, truncated to 20 words, instead of this call.

---

## 4. Conversation threading model

### 4.1 The options

| Model | Advantage | Problem |
|---|---|---|
| One rolling conversation per document | Simple. The model sees everything. | Grows without limit. Old and unrelated turns dilute the attention. Each ask costs more than the previous ask. This is the problem of the old web chat. |
| One conversation per chapter | Bounded. On topic. | Still mixes unrelated passages inside a chapter. The size is unpredictable. A question about chapter 3 while the user reads chapter 9 has no home. |
| One thread per passage anchor | Small, focused, cheap. Follow-ups are precise. | Without extra help, the thread forgets the other threads. "As we discussed on page 42" fails. |

### 4.2 Recommendation: a thread per anchor, plus a compact memory of all other threads

- **The anchor** is a selection (page, start offset, end offset, text hash) or a whole page (for Quiz and for questions with no selection).
- **A new selection, then an ask → a new thread.**
- **An ask with no new selection while a thread is active → a follow-up in that thread.**
- **An ask with no selection and no active thread → a new thread anchored to the current page.**
- A thread becomes inactive when the user makes a new selection or moves to a different page. The user can reopen an old thread from its margin note (section 7) and continue it.

What the app sends:

| Item | New ask (turn 1 of a thread) | Follow-up (turn 2 and later) |
|---|---|---|
| S, C, F | Yes | Yes. Identical bytes, so cached. |
| D1, D2 summaries | The current versions | The versions frozen at turn 1. The cached prefix stays valid, and the thread stays consistent. |
| G glossary hits | Fresh | From turn 1 only |
| B surrounding text | Fresh | From turn 1 only |
| E2 recent threads, E4 related threads | Yes | No. They are already in turn 1. |
| E3 Q&A index | Yes | No. It is already in turn 1. |
| Earlier turns of this thread | — | All turns, until the thread exceeds 2,500 tokens. Then the app keeps turn 1 and the last 2 turns, and replaces the middle turns with a 100-word summary from the fast model. |
| Referenced threads (section 4.3) | If the question names them | If the question names them, appended to the new turn |

The app sends turn 1 again with each follow-up, byte for byte. A provider with prefix caching therefore charges the full price for a thread only once.

### 4.3 How the model references "what we discussed on page 42" cheaply

**The Q&A index (layer E3).** One line per past thread, at most 35 tokens:

```
#17 p.42 [explain] "The kernel trick replaces the explicit map…" → inner products in feature space come from the kernel; no explicit map needed.
```

- The fields are: thread id, printed page, preset, the first 8 words of the passage, and the one-line summary from section 3.4.
- The index includes all threads of the current chapter and the 15 most recent threads from other chapters. A budget of 600 tokens holds approximately 17 lines. The app trims the oldest lines from other chapters first.
- The system prompt tells the model to cite threads as `#17`. The UI can turn `#17` into a link to that thread.

**Deterministic retrieval of referenced threads.** Before the app sends an ask, it scans the user's question:

- `#17` → include thread 17.
- `page 42`, `p. 42`, `p42` → include the threads anchored on printed page 42. The app maps printed page labels to PDF page indices (section 5).
- "earlier", "before", "we discussed", "you said" + a word that matches a past passage or question → full-text search over past threads. Include the best match.

The app includes each matched thread in compact form: the passage, the question, and the answer, cut to 400 tokens each, at most 1,200 tokens in total. This costs no LLM call. It handles almost all real references.

**Later (Phase 2), optional:** give the model a `get_thread(id)` tool. Both provider families support tool calls. But a tool call adds a round trip, and the deterministic retrieval above covers the common cases. Add the tool only if the logs show that the model often needs threads that the regex did not find.

**Related threads (layer E4, Phase 1).** The app runs a lexical full-text search (for example SQLite FTS5, if the storage layer is SQLite) of the current passage against past passages and questions. It includes the top 2 hits from other chapters when their score is above a threshold. Embeddings are not necessary at this scale. A reader produces hundreds of threads per book, not millions.

---

## 5. Precomputation to make interactions instant

| Job | Value | Cost | When it runs | Phase |
|---|---|---|---|---|
| Text extraction, paragraph segmentation, page-label map (printed page "142" ↔ PDF page 158) | Prerequisite for all context layers. Without the page-label map, "page 42" points to the wrong page. | Local, no LLM. | On document open, for all pages, in the background. Current page first. | 0 |
| Outline from PDF bookmarks | Gives the chapter and section for the location line and for chapter scoping. | Local, no LLM. | On document open. | 0 |
| Outline fallback 1: running headers | Most books print the chapter title in the page header. The app detects the repeated top line and its changes. | Local, no LLM. | On document open, when no bookmarks exist. | 1 |
| Outline fallback 2: parse the printed contents page | Works for books with no bookmarks and no running headers. | One fast-model call, ~3,000 tokens. | Once per document, only when fallback 1 fails. | 2 |
| Running chapter summary (D1) and book summary (D2) | Main source of "earlier in the chapter" context. | ~1,000 fast-model tokens per page read. | Every 3 read pages (dwell ≥15 s). See section 2.6. | 1 |
| Book glossary: terms that the book defines | Gives the book's own definitions to every ask. Makes Define on a single word a cache hit or a near-instant fast call. | ~1,000–1,200 fast-model tokens per page. | For each read page, plus a look-ahead of 1 page. | 1 |
| Define-answer cache | A repeated Define on the same term in the same chapter returns instantly, with no cost. | Local. | After each Define answer. Key: (document, normalized term, chapter). | 1 |
| Q&A index line | Feeds layer E3. | One small fast-model call per answer. | After each answer streams to the end. | 1 (Phase 0 uses the first sentence) |
| Prompt-cache warm-up | Makes the first ask in a chapter cheaper. | One cache write that may be wasted. | Do not run it. The first real ask writes the cache anyway. | Skip |
| "Likely confusing passages" prediction | Low. Confusion is personal. The model predicts generic difficulty that the reader may not have. | A full pass over the book. | — | Skip. The confusion heatmap (section 7) uses real asks instead. |
| Page embeddings for semantic retrieval | Low at this scale. Lexical search covers the need. | An embedding call per page, plus a vector index. | — | Skip, unless logs show that lexical search misses. |

**The glossary extraction prompt (fast model, one page at a time):**

```
From the page below, list each term, symbol, or acronym that the text defines or introduces with a specific meaning.
Output one JSON object per line, with no other text:
{"term": "...", "definition": "...", "page": "{{printed_page}}", "kind": "definition|notation|acronym"}
- Use the author's wording where possible. At most 30 words per definition.
- Do not list terms that the page only uses without defining them.
- If the page defines nothing, output nothing.
<page>
{{page_text}}
</page>
```

The app merges the results into a per-document glossary table. On an ask, layer G takes the glossary entries whose term occurs in A or B, nearest definition first.

---

## 6. Latency and cost tactics

### 6.1 Two model roles

The config file defines two roles. Each role is a provider, a base URL, a model name, and a key reference.

- **strong**: for the asks (Explain, Simplify, Example, Connect, Critique, Steps, Check, Quiz, free ask).
- **fast**: for background jobs (summaries, glossary, index lines, thread compression) and for Define and Translate.

The user can override the role per preset. The fast role is a good fit for a local model behind an OpenAI-compatible endpoint, because background jobs are tolerant of latency and they are frequent.

### 6.2 Time to first token

- The app streams every answer. The UI shows the first token as soon as it arrives.
- The app assembles context locally, with no LLM call on the ask path (rule 1 in section 2.1).
- The app keeps one HTTP connection open per provider, so that a new ask does not pay for a new TLS handshake.
- Targets: ask action → request sent in <50 ms; request sent → first token in <1.5 s at the median for the strong model.

### 6.3 Prompt caching of the stable prefix

- Order the prompt from stable to volatile (section 2.8). The stable prefix is S + C + F + D2 + D1, approximately 2,000 tokens.
- Keep the stable prefix byte-identical between asks. Do not put timestamps, page numbers, or random ids in it. Serialize metadata in a fixed key order.
- D1 changes every 3 read pages. The cached prefix is therefore valid for several asks in a row.
- Providers differ. Some providers cache matching prefixes automatically. Others need explicit cache markers on message blocks. Some have a minimum prefix length, below which no caching occurs. The provider adapter owns these details. The context builder only marks two breakpoints: after D1, and after turn 1 of a thread.
- Read the cached-token counts from the usage fields of each response. Show them in the cost readout, so that the user can see whether caching works.

### 6.4 Debounce and cancellation

- Two ask triggers within 500 ms count as one ask.
- A new ask on a new selection does not cancel an answer that is still streaming. The new answer opens in a new thread. The UI owns the layout.
- The cancel action aborts the stream at once. The app stores the partial answer and marks it "stopped". An abort stops the output cost.
- Background jobs run one at a time, at low priority. They pause while an ask streams, so that they do not compete for rate limits.
- Page-turn events go into a queue only after the dwell filter (15 s). Fast skims through 30 pages do not queue 30 jobs.
- On a provider error, the app retries once after 1 s. Then it shows the error and offers the other role as a fallback.

### 6.5 The per-session cost readout

- The app records `input_tokens`, `cached_input_tokens`, and `output_tokens` from each response, per role.
- The user enters prices per million tokens for each role in the config file. The app does not hard-code prices, because prices change.
- The status bar shows the cost of the session and of the current document, for example `session ≈ $0.21 · doc ≈ $1.80`. Each answer shows its own tokens and cost in the "context used" line.
- Optional soft cap: `daily_soft_cap`. When the app reaches it, it shows a warning. It does not block asks.

**A relative cost picture for one hour of reading** (~25 pages, ~12 asks):

| Item | Approximate tokens |
|---|---|
| Asks, strong model input | 12 × ~6,000 = ~72,000, of which roughly half is a cached prefix |
| Asks, strong model output | 12 × ~300 = ~3,600 |
| Summaries, fast model | ~8 × ~3,000 = ~24,000 |
| Glossary, fast model | ~25 × ~1,200 = ~30,000 |
| Index lines, fast model | ~12 × ~400 = ~5,000 |

The strong-model input dominates. Caching and the 6,000-token budget are therefore the main cost controls. The background jobs are cheap. On a local fast model, they are free.

---

## 7. Creative features

### Included

**Marginalia (Phase 1).** Each thread leaves a small marker in the margin next to its anchor. A highlight shows the anchored passage. When the user opens the document again, the markers are still there. The user opens a marker to reread the answer or to continue the thread. This turns the Q&A into annotations of the book, not a chat log that the user loses. Phase 0 already stores the anchor (page, offsets, text hash), so Phase 1 only adds the display.

**End-of-session recap note (Phase 1).** When the user closes the document, or after 10 minutes of no activity, the fast model writes a recap from the session's threads: pages read, ideas clarified (from the index lines), and open items. An open item is a thread with 3 or more follow-ups, or a Check grade below "Mostly correct". The app stores the recap with the document and adds it to the export. Cost: one call of approximately 2,000 tokens.

**Resume briefing (Phase 1).** When the user opens a document after more than one day, the app shows 3 lines: where the user stopped, the last chapter summary in 2 sentences, and the open items from the last recap. This needs no new LLM call, because all parts exist already. It shortens the "time to resume reading" (section 10).

**Export as a study Markdown file (Phase 1).** One action writes `<book-title>.md`: one heading per chapter, and for each thread the quoted passage, the page, the question, the answer, and the follow-ups. Recaps go at the end of each chapter. The file works in Obsidian or in any Markdown editor. The export protects the user's notes if the app stops working. It is approximately 50 lines of code.

**Teach-back mode (Phase 2).** At the end of a section, the user triggers teach-back. The app asks: "Explain section 7.3 in your own words, in 3 to 5 sentences." The user types the answer. The model grades it with the Check template, with the section text as the reference. Teach-back is the most effective learning feature in this list, because recall is stronger than rereading. It is opt-in and never automatic.

**Confusion heatmap (Phase 2).** A thin bar next to the page scroller shows the number of asks per page as a color strip. Before a review or a reread, the user sees at once which pages were hard. The data already exists in the thread table. The feature needs no LLM call.

**Pre-read briefing (Phase 2).** On demand, when the user enters a chapter, the app shows: what the chapter is about (60 words), which earlier ideas it needs (from D2 and the glossary), and 3 questions to keep in mind. The fast model reads the full chapter once. The cost is approximately the token size of the chapter. Do not precompute it, because the user may never ask for it.

```
Write a pre-read briefing for the chapter below, for this reader.
1. About: what the chapter tries to establish, at most 60 words.
2. You need: the earlier terms and results that it relies on, at most 5 bullets. Use <book_so_far> and <glossary>. Mark ideas that the reader asked about before with their thread number.
3. Keep in mind: 3 questions that the chapter answers.
Do not reveal conclusions that the chapter builds up to as a surprise. Do not add outside knowledge.
```

**Figure and equation ask (Phase 2, depends on open question 4).** The user selects a rectangular region of the page. The app sends the region as an image to a vision-capable model, together with the normal context layers. PDF text extraction loses figures and often garbles equations. For math-heavy books, this is the only way to ask about them.

**Stuck detector (Phase 2, opt-in, low priority).** If the user stays on one page for more than 3 times their median page time, the app shows a small, silent chip: "Stuck? Explain this page". The chip never opens a dialog, never makes a sound, and disappears on the next page turn. It is off by default, because a wrong prompt is annoying, and a long dwell often means that the user is thinking, not stuck.

**Flashcard export (Phase 2).** The app exports the Define answers and the Quiz questions with model answers as an Anki-compatible CSV. This is useful only if the user studies with spaced repetition. Otherwise skip it.

### Rejected

**Automatic commentary on every page.** The model explains each page before the user asks. It is tempting because it feels "AI-native". Reject it. It multiplies the cost by every page read. Most of the output is noise for pages that the user understands. It also moves the user from active reading to passive reading of summaries, which is the opposite of the goal.

**"Chat with the whole PDF" (retrieval over the full book) as the main mode.** It is tempting because tools like NotebookLM do it. Reject it as the default. The user's questions are about a specific passage. Local context (the surrounding text, the chapter summary, the glossary) answers them better than chunks retrieved by similarity. An embedding pipeline also costs a weekend of work that the MVP does not need. The Deep ask and the Connect preset cover the cases where wider context helps.

**Prediction of confusing passages.** See section 5. The prediction is generic, and the confusion heatmap gives the real signal at no cost.

**Side-by-side answers from two models.** It is tempting for quality comparisons. Reject it. It doubles the cost and the reading time for each ask. The user wants to return to the book, not to judge models. A "regenerate with the other role" action covers the rare bad answer.

---

## 8. Phased build plan

### Phase 0: the weekend MVP

**User-visible capability.** The user opens a local PDF file. The user selects a passage, triggers Explain, Define, or a free ask, and reads the streamed answer in the side pane. The user asks follow-ups in the same thread. There is no clipboard, no tab switch, and no required mouse use for the ask itself.

**Main technical pieces:**

1. PDF.js view and text extraction per page, with the page-label map. (The rendering section owns the details.)
2. Selection capture: the page, the offsets, and the text. (The UI section owns the selection mechanism.)
3. A context builder with layers S, C (title, authors, bookmark outline), F (profile from the config file), A, and B (paragraph expansion, with the 2:1 before/after rule). It also includes the raw text of the previous page as a stand-in for D1.
4. Three presets: Explain, Define, free ask. Follow-ups in the same thread.
5. One provider adapter for the provider that the user has a key for. Streaming. Cancellation.
6. Local storage of threads with their anchors and token usage.
7. A "context used" line and a token and cost readout per answer and per session.

**Definition of done:**

- The user reads one chapter of a real book for 30 minutes and asks at least 10 questions.
- During this session, the user makes zero copy-paste operations and zero window or tab switches.
- Each preset ask takes at most 2 keystrokes after the selection.
- The first token arrives in less than 2 s at the median.
- The threads are still there after a restart of the app.

### Phase 1: the context engine and the notes (weeks 2 to 3)

**User-visible capability.** The answers know the chapter and the earlier definitions. The answers refer to the user's earlier questions. All 10 presets work. Margin markers show past asks. The user gets a recap at the end of a session and a briefing on return. The user exports all Q&A as Markdown.

**Main technical pieces:**

1. The remaining presets: Simplify, Example, Connect, Critique, Steps, Check, Quiz, Translate. Presets as follow-ups.
2. A background job queue with the dwell filter, one job at a time, paused during asks.
3. The running summaries D1 and D2. The book glossary and layer G. The Define cache.
4. Index lines (fast model). Layers E2, E3, and E4. Retrieval of referenced threads by `#id`, by page, and by full-text search.
5. The trimming algorithm with a configurable budget.
6. Both provider families (OpenAI-compatible and Anthropic). The two model roles. Prompt-cache breakpoints. Cached-token readout.
7. The running-header outline fallback.
8. Marginalia display, the recap, the resume briefing, and the Markdown export.

**Definition of done:**

- On a book without bookmarks, the location line shows the correct chapter on 9 of 10 sampled pages.
- An ask that says "like on page 42" includes the thread from page 42, as the "context used" line shows.
- A single-word Define on a term that the book defined earlier cites the book's definition and page.
- The cache counters show cached input tokens on the second and later asks in a chapter.
- The export file opens in a Markdown editor with correct chapter headings and page references.

### Phase 2: learning features and hard content (after Phase 1 is in daily use)

**User-visible capability.** Teach-back, pre-read briefings, the confusion heatmap, questions about figures and equations, and the Deep ask. Optional: the stuck detector and flashcard export.

**Main technical pieces:**

1. Region capture to image, and a vision-capable model role.
2. Deep ask and the optional `chapter_mode: auto` with the full chapter as a cached prefix.
3. The heatmap from the thread table.
4. Teach-back and briefing templates. The contents-page outline fallback.
5. Optional: the `get_thread` tool, if the logs show that deterministic retrieval misses references.

**Definition of done:**

- The user asks about an equation or a figure and gets an answer that names its parts correctly.
- The user completes one teach-back per chapter for a full book without friction.
- The user's measured time with the hand on the mouse per session is near zero, including the questions.

Order rule for all phases: do not start a phase before the previous phase is in real daily use for at least a week. The logs of real use decide the priorities inside the next phase.

---

## 9. Alternatives considered and rejected

| Alternative | Where it is good enough | What it lacks | Verdict |
|---|---|---|---|
| A keyboard macro on Linux (for example `xdotool` + `xclip`): copy the selection, focus the chat tab, paste, press Enter, focus back | Removes most of the mouse use and the manual copy and paste. Takes one to two hours to build. | No context beyond the paste. Fragile when the window layout or the web UI changes. The focus still switches. The answers stay mediocre for the reasons in section 1. | **Build it tonight as a stopgap**, if the pain is acute. It is not the product. |
| A browser extension with an LLM sidebar and an "explain selection" menu | Removes the tab switch. Some extensions can read the visible page. | Little or no document context (chapter, earlier definitions, history). No anchored threads. Little control of the prompt or the model. Often a subscription. The browser PDF viewer often blocks extensions. | Good enough for occasional questions. Not for deep reading of a book. |
| Readwise Reader with its built-in assistant (select text, run a custom prompt) | The closest existing product: select-and-ask, custom prompts, highlights, export. | A subscription. Limited control of the context (no running chapter summary or Q&A memory that you design). No local models. Keyboard flow is the vendor's, not the user's. | **Try it for an evening before the build.** If it is good enough, the custom tool must beat it on context and keyboard flow, or it is not worth the time. |
| NotebookLM | Grounded answers over the whole source, with citations. Good for "what does the book say about X". | Chat-first, not reading-first. No selection-to-ask inside a keyboard-driven reader. The user uploads the book to the cloud. No control of prompts or model. | Use it as a complement for whole-book questions. Not a replacement. |
| Zotero 7 or Obsidian with community AI plugins (for example Zotero GPT; Obsidian PDF plugins with an AI plugin) | Good for academic papers in a reference manager. Some plugins support selection-to-ask. | Plugin quality and maintenance vary. The context is usually only the selection. Obsidian needs several plugins glued together. Weak for long books. | Reasonable for papers. Weak for books. |
| Adobe Acrobat AI Assistant | Integrated in the PDF reader, with whole-document Q&A. | Paid add-on. No choice of model, no prompt control, no export of the Q&A in a useful form. Acrobat has no native Linux version, and this machine runs Linux. | Reject. |
| Upload the whole PDF to a chat app (a project in a web chat UI), then paste passages | The model sees the whole book, so the context problem is partly solved. | The copy-paste and the focus switch remain. Retrieval over the upload is opaque. History is one rolling chat. | Better answers than a bare paste, same physical pain. Reject as the solution. |

**What the custom tool gains:** a keyboard flow designed for this user's hands; layered context that the user controls and can see; anchored threads that become marginalia; the memory of past questions; free choice of provider, including a local model; a visible cost per ask; and an export in plain Markdown that the user owns.

**What it costs:** a weekend for Phase 0 and a few weeks of evenings for Phase 1. Also continued maintenance of provider adapters.

---

## 10. Success metrics

The app logs these metrics locally. No metric leaves the machine.

| Metric | How to measure | Old workflow (estimate) | Target |
|---|---|---|---|
| Keystrokes per preset ask, after the selection | Count key events between the selection and the request | 3–4 key chords + 4 mouse movements + 2 clicks | ≤2 keystrokes, 0 mouse events |
| Keystrokes per free ask, excluding the question text | Same | Same as above | ≤3 |
| Pointer events per session that the app requires | Count pointer events in the app. Tag the events that the user made by choice (for example scrolling). | Many per ask | 0 required |
| Overhead per ask: from the decision to ask to the request sent | Selection start → request sent | 10–15 s | <3 s |
| Time to first token | Request sent → first token | (web UI) | <1.5 s median |
| Time to resume reading | End of answer stream → next page scroll or next selection | Includes the switch back to the PDF tab | <10 s median |
| Answer usefulness, explicit | Optional one-key rating after the answer: 1 = useful, 2 = not useful | — | ≥80% useful |
| Answer usefulness, implicit | Share of Explain threads that need a "clarify that" follow-up. Re-asks on the same passage within 2 minutes. | — | Follow-up rate <35%. A rising rate means that the context or the prompts are weak. |
| Cost per reading hour | From the cost readout | Subscription | The user decides a ceiling. The app reports against it. |
| Reading throughput | Read pages per session, compared with the user's estimate before the tool | — | Not lower than before. The aim is understanding, not speed. |

Review the metrics after the first two weeks. If the implicit usefulness is poor, inspect the "context used" lines of the bad answers first. The cause is usually a missing referent or a missing definition, which section 2 can fix.

---

## 11. Open questions for the user

1. **Which API keys do you have, and which provider do you prefer?** Note: a ChatGPT or Grok web subscription usually does not include API access. The app uses API keys and pays per token. Phase 0 supports one provider, so the answer decides which adapter comes first.
2. **Do you want a local model?** This machine appears to have an NVIDIA GPU. A local model behind an OpenAI-compatible endpoint can run the fast role (summaries, glossary) at no token cost, and perhaps the strong role too.
3. **Where do your PDFs come from?** Local files, public URLs, or sites behind a login (for example a library proxy or a subscription book site)? PDFs behind a login can change the architecture from a standalone app to a browser extension.
4. **What do you read most: books in a single column, or academic papers in two columns? Are the PDFs scanned? Do math and figures matter?** Two columns affect paragraph segmentation. Scanned PDFs need OCR. Math and figures move the vision feature from Phase 2 to Phase 1.
5. **Where do your notes go today?** For example an Obsidian vault, a folder of Markdown files, Anki, or nowhere. The answer decides the export format and the priority of the export.
