// Navigation between the library and a document. The URL holds `?doc=<id>`.
import type { DocId } from '../../shared/types.ts';
import * as api from '../api/client.ts';
import { mode } from '../commands/modes.ts';
import { refreshUsage } from './ask.ts';
import { activeRun, activeThreadId, askBox, doc, helpOpen, memory, paletteOpen, showNotice, staged, threads, view } from './session.ts';
import { latestThread } from './target.ts';

function docIdFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get('doc');
}

function resetReader(): void {
  doc.value = null;
  staged.value = null;
  threads.value = [];
  // Per-thread values of the closed document; each holds page text. A reload empties them too, and ask.ts falls back to the thread.
  memory.lastRequest.clear();
  memory.threadContext.clear();
  activeThreadId.value = null;
  activeRun.value = null;
  askBox.value = null;
  paletteOpen.value = false;
  helpOpen.value = false;
  mode.value = 'NORMAL';
}

/** Shows the view that the current URL names. */
export async function route(): Promise<void> {
  const id = docIdFromUrl();
  if (id) await loadDocument(id);
  else showLibrary();
}

function showLibrary(): void {
  resetReader();
  view.value = 'library';
  document.title = 'llm-reader';
}

async function loadDocument(id: DocId): Promise<void> {
  if (doc.value?.id === id && view.value === 'reader') return;
  resetReader();
  try {
    const d = await api.getDoc(id);
    doc.value = d;
    document.title = `${d.title} · llm-reader`;
    view.value = 'reader';
  } catch (err) {
    showLibrary();
    showNotice(`Cannot open the document: ${err instanceof Error ? err.message : String(err)}`, 5000);
    return;
  }
  try {
    const list = await api.listThreads(id);
    if (doc.value?.id !== id) return;
    threads.value = list;
    activeThreadId.value = latestThread(list)?.id ?? null;
  } catch (err) {
    showNotice(`Cannot load the threads: ${err instanceof Error ? err.message : String(err)}`, 5000);
  }
  void refreshUsage();
}

export async function navigateToDoc(id: DocId): Promise<void> {
  if (docIdFromUrl() !== id) window.history.pushState({}, '', `?doc=${encodeURIComponent(id)}`);
  await loadDocument(id);
}

export function navigateToLibrary(): void {
  if (docIdFromUrl() !== null) window.history.pushState({}, '', window.location.pathname);
  showLibrary();
}
