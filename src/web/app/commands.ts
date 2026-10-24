// Binds the command ids of the keymap to their handlers.
import { register, setErrorHandler } from '../commands/registry.ts';
import { mode } from '../commands/modes.ts';
import { threadToMarkdown } from '../chat/export.ts';
import { jumpMessage, paneElement, scrollLines, scrollScreens } from '../chat/paneControl.ts';
import { pickAndOpen } from '../library/upload.ts';
import { cancelActiveRun, closeAskBox, openAskBox, preset, regenerate, repeatLast, sendAskBox, toggleAskTarget } from './ask.ts';
import { closePalette, completePalette, openPalette, runPalette } from './palette.ts';
import { activeThread, doc, helpOpen, memory, paneHidden, showNotice, threads } from './session.ts';
import { threadNumber } from './target.ts';

// The viewer's scrollBy takes lines. A screen is about this many lines; the viewer owns the real line height.
const SCREEN_LINES = 15;

export function focusPdf(): void {
  mode.value = 'NORMAL';
  memory.viewer?.focus();
}

export function focusAnswerPane(): void {
  paneHidden.value = false;
  mode.value = 'READER';
  // The pane may have been hidden. Wait for the render before the focus.
  requestAnimationFrame(() => paneElement()?.focus({ preventScroll: true }));
}

async function copyThread(): Promise<void> {
  const thread = activeThread.value;
  if (!thread) return showNotice('No thread to copy.');
  const text = threadToMarkdown(thread, threadNumber(threads.value, thread.id), doc.value?.title);
  try {
    await navigator.clipboard.writeText(text);
    showNotice(`Thread #${threadNumber(threads.value, thread.id)} copied as Markdown.`);
  } catch {
    showNotice('The clipboard is not available.');
  }
}

/** Registers every command. Returns a function that removes them. */
export function registerCommands(): () => void {
  const v = () => memory.viewer;
  const handlers: Record<string, () => void | Promise<void>> = {
    'app.back': () => {
      if (helpOpen.value) {
        helpOpen.value = false;
        return;
      }
      if (mode.value === 'READER') return focusPdf();
      if (cancelActiveRun()) return;
      v()?.collapseSelection();
    },
    'focus.toggle_pane': () => (mode.value === 'READER' ? focusPdf() : focusAnswerPane()),
    'focus.pdf': focusPdf,
    'help.toggle': () => {
      helpOpen.value = !helpOpen.value;
    },
    'pane.toggle': () => {
      paneHidden.value = !paneHidden.value;
      if (paneHidden.value && mode.value === 'READER') focusPdf();
    },

    'cursor.next_paragraph': () => void v()?.nextParagraph(),
    'cursor.prev_paragraph': () => void v()?.prevParagraph(),
    'cursor.next_sentence': () => void v()?.nextSentence(),
    'cursor.prev_sentence': () => void v()?.prevSentence(),
    'selection.extend': () => void v()?.extendSelection(),
    'selection.shrink': () => void v()?.shrinkSelection(),
    'selection.toggle_paragraph': () => v()?.toggleParagraph(),
    'position.jump_back': () => v()?.jumpBack(),
    'view.scroll_down': () => v()?.scrollBy(3),
    'view.scroll_up': () => v()?.scrollBy(-3),
    'view.page_down': () => v()?.scrollBy(SCREEN_LINES),
    'view.page_up': () => v()?.scrollBy(-SCREEN_LINES),
    'view.zoom_in': () => v()?.zoomIn(),
    'view.zoom_out': () => v()?.zoomOut(),
    'library.upload': pickAndOpen,

    'ask.preset:explain': () => preset('explain'),
    'ask.preset:define': () => preset('define'),
    'ask.open': openAskBox,
    'ask.repeat': repeatLast,
    'ask.regenerate': regenerate,
    'ask.send': sendAskBox,
    'ask.toggle_target': toggleAskTarget,
    'ask.cancel': closeAskBox,
    'run.cancel': () => {
      if (!cancelActiveRun()) showNotice('No answer is streaming.');
    },

    'reader.scroll_down': () => scrollLines(3),
    'reader.scroll_up': () => scrollLines(-3),
    'reader.page_down': () => scrollScreens(1),
    'reader.page_up': () => scrollScreens(-1),
    'reader.next_message': () => void jumpMessage(1),
    'reader.prev_message': () => void jumpMessage(-1),
    'reader.copy_thread': copyThread,

    'palette.open': openPalette,
    'palette.run': runPalette,
    'palette.complete': completePalette,
    'palette.close': closePalette,
  };
  setErrorHandler((id, err) => {
    console.error(`command ${id} failed`, err);
    showNotice(`${id} failed: ${err instanceof Error ? err.message : String(err)}`, 5000);
  });
  const offs = Object.entries(handlers).map(([id, fn]) => register(id, fn));
  return () => offs.forEach((off) => off());
}
