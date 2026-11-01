// Answer Markdown → safe HTML. The pipeline:
//   1. markdown-it with raw HTML off. A math plugin turns `$…$` and `$$…$$` into placeholder spans.
//   2. DOMPurify sanitizes the HTML (browser only; see `defaultSanitize`).
//   3. The placeholder spans get the KaTeX output.
// KaTeX goes in after the sanitizer because DOMPurify drops the MathML <semantics> and <annotation> tags that KaTeX
// emits. The placeholders are real elements from our own renderer. Raw HTML is off, so the answer text cannot forge one.
import MarkdownItCtor, { type Env, type MarkdownIt, type StateBlock, type StateInline } from 'markdown-it';
import katex from 'katex';
import createDOMPurify from 'dompurify';

export type Sanitizer = (html: string) => string;

interface MathEnv extends Env {
  math: { tex: string; display: boolean }[];
}

const DOLLAR = 0x24;
const BACKSLASH = 0x5c;
const BACKTICK = 0x60;

function isSpace(code: number | undefined): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function isDigit(code: number | undefined): boolean {
  return code !== undefined && code >= 0x30 && code <= 0x39;
}

function pushMath(state: StateInline | StateBlock, tex: string, display: boolean, block: boolean): void {
  const env = state.env as MathEnv;
  const token = state.push(block ? 'math_block' : 'math_inline', 'span', 0);
  token.content = String(env.math.length);
  token.markup = display ? '$$' : '$';
  env.math.push({ tex, display });
}

/**
 * `$$…$$` or `$…$` inside a paragraph. An opening `$` before a space, or a closing `$` after a space or before a digit,
 * is plain text, so prices like "$5 and $10" stay text.
 */
function mathInline(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const start = state.pos;
  if (src.charCodeAt(start) !== DOLLAR) return false;
  const display = src.charCodeAt(start + 1) === DOLLAR;
  const open = display ? 2 : 1;
  if (!display && isSpace(src.charCodeAt(start + 1))) return false;

  let pos = start + open;
  while (pos < state.posMax) {
    const code = src.charCodeAt(pos);
    if (code === BACKSLASH) {
      pos += 2;
      continue;
    }
    // Math never crosses a code span. This keeps "$5 and `$x$`" as text and code.
    if (code === BACKTICK) return false;
    if (code === DOLLAR) {
      if (display) {
        if (src.charCodeAt(pos + 1) === DOLLAR) break;
      } else if (!isSpace(src.charCodeAt(pos - 1)) && !isDigit(src.charCodeAt(pos + 1))) {
        break;
      }
    }
    pos++;
  }
  if (pos >= state.posMax) return false;
  const tex = src.slice(start + open, pos);
  if (tex.trim() === '') return false;
  if (!silent) pushMath(state, tex, display, false);
  state.pos = pos + open;
  return true;
}

/** A block that starts with `$$` at the line start and ends with `$$` at a line end. */
function mathBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  let pos = (state.bMarks[startLine] ?? 0) + (state.tShift[startLine] ?? 0);
  let max = state.eMarks[startLine] ?? 0;
  if ((state.sCount[startLine] ?? 0) - state.blkIndent >= 4) return false;
  if (state.src.slice(pos, pos + 2) !== '$$') return false;
  pos += 2;

  let firstLine = state.src.slice(pos, max);
  let lastLine = '';
  let next = startLine;
  let found = false;
  if (firstLine.trim().endsWith('$$')) {
    firstLine = firstLine.trim().slice(0, -2);
    found = true;
  }
  while (!found) {
    next++;
    if (next >= endLine) break;
    pos = (state.bMarks[next] ?? 0) + (state.tShift[next] ?? 0);
    max = state.eMarks[next] ?? 0;
    if (pos < max && (state.tShift[next] ?? 0) < state.blkIndent) break;
    const line = state.src.slice(pos, max).trim();
    if (line.endsWith('$$')) {
      lastLine = line.slice(0, -2);
      found = true;
    }
  }
  if (!found) return false;
  if (silent) return true;

  const middle = next > startLine + 1 ? state.getLines(startLine + 1, next, state.tShift[startLine] ?? 0, true) : '';
  const tex = [firstLine, middle, lastLine].join('\n').trim();
  if (tex === '') return false;
  state.line = next + 1;
  pushMath(state, tex, true, true);
  const token = state.tokens[state.tokens.length - 1];
  if (token) token.map = [startLine, state.line];
  return true;
}

function createMarkdown(): MarkdownIt {
  const md = new MarkdownItCtor({ html: false, linkify: true, typographer: false });
  md.inline.ruler.after('escape', 'math_inline', mathInline);
  md.block.ruler.before('fence', 'math_block', mathBlock, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  md.renderer.rules.math_inline = (tokens, idx) => `<span data-math="${tokens[idx]?.content ?? ''}"></span>`;
  md.renderer.rules.math_block = (tokens, idx) =>
    `<div class="math-display"><span data-math="${tokens[idx]?.content ?? ''}"></span></div>\n`;
  return md;
}

let md: MarkdownIt | null = null;

// A streamed answer renders again on each frame, with the same formulas each time. KaTeX is the slow part, so keep
// its output. The oldest entry goes first when the cache is full.
const MATH_CACHE_MAX = 500;
const mathCache = new Map<string, string>();

function renderMath(item: { tex: string; display: boolean } | undefined): string {
  if (!item) return '';
  const key = `${item.display ? 'D' : 'I'}${item.tex}`;
  const hit = mathCache.get(key);
  if (hit !== undefined) return hit;
  const html = katex.renderToString(item.tex, {
    displayMode: item.display,
    throwOnError: false,
    strict: 'ignore',
    trust: false,
    output: 'htmlAndMathml',
  });
  if (mathCache.size >= MATH_CACHE_MAX) mathCache.delete(mathCache.keys().next().value!);
  mathCache.set(key, html);
  return html;
}

let purifier: ReturnType<typeof createDOMPurify> | null = null;

/**
 * DOMPurify needs a DOM. The instance is made on first use in the browser. In Node (the unit tests) there is no
 * window; then the output relies on markdown-it alone, which escapes all raw HTML because `html` is off.
 */
export function defaultSanitize(html: string): string {
  if (typeof window === 'undefined') return html;
  purifier ??= createDOMPurify(window);
  return purifier.sanitize(html);
}

/** Renders answer Markdown to HTML that is safe to put in innerHTML. */
export function renderMarkdown(src: string, sanitize: Sanitizer = defaultSanitize): string {
  md ??= createMarkdown();
  const env: MathEnv = { math: [] };
  const html = sanitize(md.render(src, env));
  if (env.math.length === 0) return html;
  return html.replace(/<span data-math="(\d+)"><\/span>/g, (_, i: string) => renderMath(env.math[Number(i)]));
}

/** The first sentence of a Markdown text as plain text, for one-line thread summaries. */
export function firstSentence(src: string, max = 140): string {
  const plain = src
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/\$\$[\s\S]*?(\$\$|$)/g, ' … ')
    .replace(/[#>*_`~]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const match = /^.*?[.!?](\s|$)/.exec(plain);
  const sentence = (match ? match[0] : plain).trim();
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}
