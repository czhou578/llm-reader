// One capture-phase keydown listener on window. It maps keys to commands through the keymap.
import { LAYOUTS, resolveKey, type LayoutName } from './keymap.ts';
import { mode } from './modes.ts';
import { has, run } from './registry.ts';

export function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'file', 'color'].includes(target.type);
  }
  return false;
}

export interface DispatcherOptions {
  layout: () => LayoutName;
  /** The dispatcher acts only while this returns true (the reader view). Other views handle their own keys. */
  active: () => boolean;
}

/** Installs the listener. Returns a function that removes it. */
export function installDispatcher(opts: DispatcherOptions): () => void {
  const onKeyDown = (ev: KeyboardEvent) => {
    if (!opts.active()) return;
    const id = resolveKey(LAYOUTS[opts.layout()], mode.value, {
      key: ev.key,
      shiftKey: ev.shiftKey,
      ctrlKey: ev.ctrlKey,
      altKey: ev.altKey,
      metaKey: ev.metaKey,
      repeat: ev.repeat,
      isComposing: ev.isComposing,
      inTextInput: isTextInput(ev.target),
    });
    if (id === null || !has(id)) {
      // An ignored auto-repeat of a key we own must not fall through to the browser (Space would scroll).
      if (ev.repeat && id === null && ownsKey(opts.layout(), ev)) ev.preventDefault();
      return;
    }
    // preventDefault only for keys we own. stopPropagation keeps the PDF.js viewer from also acting on the key.
    ev.preventDefault();
    ev.stopPropagation();
    run(id);
  };
  window.addEventListener('keydown', onKeyDown, { capture: true });
  return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
}

function ownsKey(layout: LayoutName, ev: KeyboardEvent): boolean {
  if (isTextInput(ev.target)) return false;
  return resolveKey(LAYOUTS[layout], mode.value, { key: ev.key, shiftKey: ev.shiftKey, ctrlKey: ev.ctrlKey, altKey: ev.altKey, metaKey: ev.metaKey }) !== null;
}
