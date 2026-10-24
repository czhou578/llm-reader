// The minimal `:` prompt (PALETTE mode): `open`, `page <n>`, `help`, `layout left|home`, `pane`.
import { signal } from '@preact/signals';
import { mode } from '../commands/modes.ts';
import { navigateToLibrary } from './router.ts';
import { doc, helpOpen, memory, paletteOpen, paneHidden, setLayout, showNotice } from './session.ts';

export const paletteDraft = signal('');

export const PALETTE_COMMANDS: { name: string; usage: string; help: string }[] = [
  { name: 'open', usage: 'open', help: 'Go to the library' },
  { name: 'page', usage: 'page <n>', help: 'Go to page n (the printed label when the PDF has one)' },
  { name: 'help', usage: 'help', help: 'Show the keys' },
  { name: 'layout', usage: 'layout left|home', help: 'Change the key layout' },
  { name: 'pane', usage: 'pane', help: 'Show or hide the answer pane' },
];

export function openPalette(): void {
  paletteDraft.value = '';
  paletteOpen.value = true;
  mode.value = 'PALETTE';
}

export function closePalette(): void {
  paletteOpen.value = false;
  mode.value = 'NORMAL';
  memory.viewer?.focus();
}

export function completePalette(): void {
  const word = paletteDraft.value.trimStart();
  if (word.includes(' ')) return;
  const match = PALETTE_COMMANDS.find((c) => c.name.startsWith(word.toLowerCase()));
  if (match) paletteDraft.value = `${match.name} `;
}

/** Finds the 0-based page index for user input: a printed label first, then a 1-based number. */
export function resolvePage(input: string, pageLabels: readonly string[] | null | undefined, pageCount: number): number | null {
  const byLabel = pageLabels?.indexOf(input) ?? -1;
  if (byLabel >= 0) return byLabel;
  const n = Number.parseInt(input, 10);
  if (!Number.isFinite(n) || n < 1 || n > pageCount) return null;
  return n - 1;
}

export function runPalette(): void {
  const [name = '', ...args] = paletteDraft.value.trim().split(/\s+/);
  const cmd = PALETTE_COMMANDS.find((c) => c.name === name.toLowerCase()) ?? PALETTE_COMMANDS.find((c) => name && c.name.startsWith(name));
  closePalette();
  switch (cmd?.name) {
    case 'open':
      return navigateToLibrary();
    case 'page': {
      const d = doc.value;
      const page = d && args[0] ? resolvePage(args[0], d.pageLabels, d.pageCount) : null;
      if (page === null) return showNotice(`No page "${args[0] ?? ''}". Type page and a number.`);
      return memory.viewer?.goToPage(page);
    }
    case 'help':
      helpOpen.value = true;
      return;
    case 'layout':
      if (args[0] !== 'left' && args[0] !== 'home') return showNotice('Type layout left or layout home.');
      setLayout(args[0]);
      return showNotice(`Key layout: ${args[0]}.`);
    case 'pane':
      paneHidden.value = !paneHidden.value;
      return;
    default:
      if (name) showNotice(`Unknown command "${name}". Commands: ${PALETTE_COMMANDS.map((c) => c.name).join(', ')}.`, 5000);
  }
}
