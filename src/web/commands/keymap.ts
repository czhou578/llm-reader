// Key bindings as data (DESIGN.md 5.4 `left` layout, 5.7 `home` layout) and the pure key resolver.
import type { Mode } from './modes.ts';

export type LayoutName = 'left' | 'home';

/** Mode → key descriptor → command id. Key descriptors come from `keyDescriptor`. */
export type Layout = Record<Mode, Record<string, string>>;

// Keys in NORMAL and READER that are the same in both layouts.
const SHARED_GLOBAL: Record<string, string> = {
  Tab: 'focus.toggle_pane',
  'Shift+Tab': 'focus.toggle_pane',
  ':': 'palette.open',
  '?': 'help.toggle',
  Enter: 'ask.preset:explain',
  e: 'ask.preset:explain',
  r: 'ask.regenerate',
};

const NORMAL_RARE: Record<string, string> = {
  Escape: 'app.back',
  "'": 'position.jump_back',
  '\\': 'pane.toggle',
  '.': 'ask.repeat',
  ArrowDown: 'view.scroll_down',
  ArrowUp: 'view.scroll_up',
  PageDown: 'view.page_down',
  PageUp: 'view.page_up',
  '=': 'view.zoom_in',
  '+': 'view.zoom_in',
  '-': 'view.zoom_out',
  p: 'selection.toggle_paragraph',
  'Ctrl+o': 'library.upload',
};

const READER_RARE: Record<string, string> = {
  Escape: 'app.back',
  y: 'reader.copy_thread',
  ']': 'reader.next_message',
  '[': 'reader.prev_message',
  ArrowDown: 'reader.scroll_down',
  ArrowUp: 'reader.scroll_up',
  PageDown: 'reader.page_down',
  PageUp: 'reader.page_up',
};

const ASK: Record<string, string> = {
  Enter: 'ask.send',
  Tab: 'ask.toggle_target',
  'Shift+Tab': 'ask.toggle_target',
  Escape: 'ask.cancel',
  // Shift+Enter has no binding on purpose: the textarea inserts the newline itself.
};

const PALETTE: Record<string, string> = {
  Enter: 'palette.run',
  Tab: 'palette.complete',
  'Shift+Tab': 'palette.complete',
  Escape: 'palette.close',
};

export const LAYOUTS: Record<LayoutName, Layout> = {
  left: {
    NORMAL: {
      ...SHARED_GLOBAL,
      ...NORMAL_RARE,
      ' ': 'cursor.next_paragraph',
      q: 'cursor.prev_paragraph',
      s: 'cursor.next_sentence',
      w: 'cursor.prev_sentence',
      d: 'selection.extend',
      a: 'selection.shrink',
      c: 'ask.preset:define',
      v: 'ask.open',
    },
    READER: {
      ...SHARED_GLOBAL,
      ...READER_RARE,
      s: 'reader.scroll_down',
      w: 'reader.scroll_up',
      ' ': 'reader.page_down',
      q: 'reader.page_up',
      c: 'ask.preset:define',
      v: 'ask.open',
    },
    ASK,
    PALETTE,
  },
  home: {
    NORMAL: {
      ...SHARED_GLOBAL,
      ...NORMAL_RARE,
      ' ': 'cursor.next_paragraph',
      b: 'cursor.prev_paragraph',
      j: 'cursor.next_sentence',
      k: 'cursor.prev_sentence',
      l: 'selection.extend',
      h: 'selection.shrink',
      d: 'ask.preset:define',
      a: 'ask.open',
      c: 'run.cancel',
    },
    READER: {
      ...SHARED_GLOBAL,
      ...READER_RARE,
      j: 'reader.scroll_down',
      k: 'reader.scroll_up',
      ' ': 'reader.page_down',
      b: 'reader.page_up',
      d: 'ask.preset:define',
      a: 'ask.open',
      c: 'run.cancel',
    },
    ASK,
    PALETTE,
  },
};

/** Commands that may run on key auto-repeat. All others (presets, asks, toggles) ignore `event.repeat`. */
const REPEATABLE: ReadonlySet<string> = new Set([
  'cursor.next_paragraph',
  'cursor.prev_paragraph',
  'cursor.next_sentence',
  'cursor.prev_sentence',
  'selection.extend',
  'selection.shrink',
  'view.scroll_down',
  'view.scroll_up',
  'view.page_down',
  'view.page_up',
  'view.zoom_in',
  'view.zoom_out',
  'reader.scroll_down',
  'reader.scroll_up',
  'reader.page_down',
  'reader.page_up',
]);

/** The parts of a KeyboardEvent that the resolver reads. `inTextInput` is true when an input or a textarea has focus. */
export interface KeyLike {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  inTextInput?: boolean;
}

/**
 * Builds the lookup string for a key: "s", "?", " ", "Enter", "Shift+Enter", "Ctrl+o".
 * For a printable character, Shift is already part of the character ("?" not "Shift+/"), so the descriptor drops it.
 */
export function keyDescriptor(ev: KeyLike): string {
  const printable = ev.key.length === 1;
  const key = printable && (ev.ctrlKey || ev.metaKey || ev.altKey) ? ev.key.toLowerCase() : ev.key;
  let prefix = '';
  if (ev.ctrlKey) prefix += 'Ctrl+';
  if (ev.altKey) prefix += 'Alt+';
  if (ev.metaKey) prefix += 'Meta+';
  if (ev.shiftKey && !printable) prefix += 'Shift+';
  return prefix + key;
}

/** Returns the command id for a key in a mode, or null when the key is not ours (the browser keeps its default). */
export function resolveKey(layout: Layout, mode: Mode, ev: KeyLike): string | null {
  if (ev.isComposing) return null;
  const desc = keyDescriptor(ev);
  const textMode = mode === 'ASK' || mode === 'PALETTE';
  // A letter never runs a NORMAL or READER action while a text input has focus (DESIGN.md 5.4).
  if (ev.inTextInput && !textMode) return null;
  const id = layout[mode][desc] ?? null;
  if (id === null) return null;
  if (ev.repeat && !REPEATABLE.has(id)) return null;
  return id;
}

/** All bindings of a mode as [key descriptor, command id] pairs. Single keys come before named keys like PageDown. */
export function bindingsFor(layout: Layout, mode: Mode): [string, string][] {
  const rank = (desc: string) => (desc.length === 1 ? 0 : desc === 'Enter' || desc === 'Escape' || desc === 'Tab' ? 1 : 2);
  return Object.entries(layout[mode]).sort((a, b) => rank(a[0]) - rank(b[0]));
}

/** A readable key name for help text: " " → "Space", "Escape" → "Esc". */
export function keyLabel(desc: string): string {
  const names: Record<string, string> = {
    ' ': 'Space',
    Escape: 'Esc',
    ArrowDown: 'Down',
    ArrowUp: 'Up',
  };
  return names[desc] ?? desc;
}
