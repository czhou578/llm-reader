import { useSignalEffect } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import type { DocId, ReadingState } from '../../shared/types.ts';
import * as api from '../api/client.ts';
import { AnswerPane } from '../chat/AnswerPane.tsx';
import { mode } from '../commands/modes.ts';
import { Icon } from '../library/icons.tsx';
import { Viewer } from '../viewer/index.ts';
import { AskBox, AskPrompt } from './AskBox.tsx';
import { CheatCard } from './CheatCard.tsx';
import { HintStrip } from './HintStrip.tsx';
import { Palette } from './Palette.tsx';
import { navigateToLibrary } from './router.ts';
import { askOpen, config, doc, memory, paletteOpen, paneHidden, showNotice, staged, threadIds, threads } from './session.ts';
import { keepFocus, StatusLine } from './StatusLine.tsx';

const SAVE_DELAY_MS = 1000;

/** Creates the viewer for one document, restores the reading position, and saves it on `position` events. */
function useViewer(docId: DocId, container: { current: HTMLDivElement | null }): void {
  useEffect(() => {
    const el = container.current;
    if (!el || !docId) return;
    const viewer = new Viewer(el);
    memory.viewer = viewer;
    memory.viewerContainer = el;

    let pending: ReadingState | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = (keepalive = false) => {
      clearTimeout(timer);
      if (!pending) return;
      const state = pending;
      pending = null;
      api.putState(docId, state, keepalive).catch(() => showNotice('Cannot save the reading position.'));
    };
    const onPageHide = () => flush(true);
    window.addEventListener('pagehide', onPageHide);

    const offs = [
      viewer.on('selection', (s) => (staged.value = s)),
      viewer.on('notice', (n) => showNotice(n.text)),
      viewer.on('position', (state) => {
        pending = state;
        clearTimeout(timer);
        timer = setTimeout(flush, SAVE_DELAY_MS);
      }),
    ];

    let closed = false;
    (async () => {
      const state = await api.getState(docId).catch(() => null);
      if (closed) return;
      await viewer.open(api.docFileUrl(docId), { state });
      if (closed) return;
      viewer.setAnchors(threads.peek().map((t) => t.passage));
      if (mode.peek() === 'NORMAL') viewer.focus();
    })().catch((err: unknown) => showNotice(`Cannot show the PDF: ${err instanceof Error ? err.message : String(err)}`, 6000));

    return () => {
      closed = true;
      offs.forEach((off) => off());
      flush(true);
      window.removeEventListener('pagehide', onPageHide);
      viewer.close();
      if (memory.viewer === viewer) {
        memory.viewer = null;
        memory.viewerContainer = null;
      }
    };
  }, [docId]);

  // Anchors change only when a thread is added. `threadIds` does not change on each streamed word.
  useSignalEffect(() => {
    void threadIds.value;
    memory.viewer?.setAnchors(threads.peek().map((t) => t.passage));
  });
}

/** The model that answers, from the strong role. The mock provider gets a warning color. */
function ModelBadge() {
  const c = config.value;
  const strong = c ? c.profiles[c.roles.strong] : undefined;
  if (!strong) return null;
  const mock = strong.provider === 'mock';
  return (
    <span class={`model-badge${mock ? ' model-mock' : ''}`} title={mock ? 'No API key is set, so the mock provider answers' : 'The model that answers'}>
      <Icon name="sparkle" size={14} />
      {mock ? 'mock answers · no API key' : strong.model}
    </span>
  );
}

export function ReaderView() {
  const d = doc.value;
  const container = useRef<HTMLDivElement>(null);
  useViewer(d?.id ?? '', container);
  const reading = mode.value === 'READER';

  return (
    <div class={`reader${paneHidden.value ? ' pane-hidden' : ''}`}>
      <header class="reader-top">
        <button type="button" class="back-button" title="Back to the library (:open)" aria-label="Back to the library" onMouseDown={keepFocus} onClick={() => navigateToLibrary()}>
          <Icon name="chevron-left" size={20} />
        </button>
        <h1 class="reader-title" title={d?.title}>
          {d?.title}
        </h1>
        <ModelBadge />
      </header>
      <section
        class={`pdf-pane${reading ? '' : ' focused'}`}
        aria-label="PDF"
        onFocusIn={() => {
          if (mode.peek() === 'READER') mode.value = 'NORMAL';
        }}
      >
        <div class="viewer-container" ref={container} tabIndex={0} />
      </section>
      <aside
        class={`answer-pane${reading ? ' focused' : ''}`}
        aria-label="Answers"
        onFocusIn={() => {
          if (mode.peek() === 'NORMAL') mode.value = 'READER';
        }}
      >
        <AnswerPane />
        <div class="ask-dock">{askOpen.value ? <AskBox /> : <AskPrompt />}</div>
      </aside>
      <div class="bottom">
        <HintStrip />
        <StatusLine />
      </div>
      {paletteOpen.value && <Palette />}
      <CheatCard />
    </div>
  );
}
