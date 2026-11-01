// Scroll control for the answer pane. The pane registers its scroll element here, so commands can drive it.
// Rule: a new answer scrolls into view, and the pane follows the end of the stream as text arrives. A user scroll
// stops the follow for the rest of that answer.

let pane: HTMLElement | null = null;
let pinnedId: string | null = null;
let userScrolled = false;
let lastSetTop = -1;

export function setPaneElement(el: HTMLElement | null): void {
  pane = el;
}

export function paneElement(): HTMLElement | null {
  return pane;
}

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function messageTop(el: Element): number {
  if (!pane) return 0;
  return el.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
}

/** Follows a message until the user scrolls: its start comes into view, then the pane keeps its end visible. */
export function pinMessage(messageId: string): void {
  pinnedId = messageId;
  userScrolled = false;
  applyPin();
}

/** Call after each render. Each delta makes the message longer, so the pane scrolls to the end of the stream. */
export function applyPin(): void {
  if (!pane || !pinnedId || userScrolled) return;
  const el = pane.querySelector(`[data-msg="${CSS.escape(pinnedId)}"]`);
  if (!el) return;
  const bottom = Math.max(0, pane.scrollHeight - pane.clientHeight);
  if (Math.abs(pane.scrollTop - bottom) > 1) pane.scrollTop = bottom;
  lastSetTop = pane.scrollTop;
}

/** The pane calls this on `scroll`. A scroll that the pin did not cause is a user scroll. */
export function onPaneScroll(): void {
  if (pane && Math.abs(pane.scrollTop - lastSetTop) > 2) userScrolled = true;
}

export function onUserScrollIntent(): void {
  userScrolled = true;
}

function lineHeight(): number {
  if (!pane) return 29;
  const value = parseFloat(getComputedStyle(pane).lineHeight);
  return Number.isFinite(value) ? value : 29;
}

export function scrollLines(lines: number): void {
  if (!pane) return;
  userScrolled = true;
  pane.scrollBy({ top: lines * lineHeight(), behavior: reducedMotion() ? 'auto' : 'smooth' });
}

/** Scrolls by whole screens and keeps one line of overlap. */
export function scrollScreens(screens: number): void {
  if (!pane) return;
  userScrolled = true;
  const step = Math.max(pane.clientHeight - lineHeight(), lineHeight());
  pane.scrollBy({ top: screens * step, behavior: reducedMotion() ? 'auto' : 'smooth' });
}

/** Moves the top of the pane to the next (1) or the previous (-1) message of the expanded thread. */
export function jumpMessage(dir: 1 | -1): boolean {
  if (!pane) return false;
  const tops = [...pane.querySelectorAll('.thread.expanded [data-msg]')].map(messageTop).map((t) => Math.max(0, t - 12));
  const current = pane.scrollTop;
  const target = dir > 0 ? tops.find((t) => t > current + 4) : [...tops].reverse().find((t) => t < current - 4);
  if (target === undefined) return false;
  userScrolled = true;
  pane.scrollTo({ top: target, behavior: reducedMotion() ? 'auto' : 'smooth' });
  return true;
}

/** Scrolls a thread into view, for example after a click on a collapsed thread. */
export function revealThread(threadId: string): void {
  if (!pane) return;
  const el = pane.querySelector(`[data-thread="${CSS.escape(threadId)}"]`);
  if (!el) return;
  userScrolled = true;
  pane.scrollTo({ top: Math.max(0, messageTop(el) - 12), behavior: reducedMotion() ? 'auto' : 'smooth' });
}
