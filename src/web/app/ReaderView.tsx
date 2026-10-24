import { useSignalEffect } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import type { DocId, ReadingState } from '../../shared/types.ts';
import * as api from '../api/client.ts';
import { AnswerPane } from '../chat/AnswerPane.tsx';
import { mode } from '../commands/modes.ts';
import { Viewer } from '../viewer/index.ts';
import { AskBox } from './AskBox.tsx';
import { CheatCard } from './CheatCard.tsx';
import { HintStrip } from './HintStrip.tsx';

import { Palette } from './Palette.tsx';
import { askOpen, doc, helpOpen, memory, paletteOpen, paneHidden, showNotice, staged, threadIds, threads } from './session.ts';
import { StatusLine } from './StatusLine.tsx';

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

export function ReaderView() {
  const d = doc.value;
  const container = useRef<HTMLDivElement>(null);
  useViewer(d?.id ?? '', container);
  const reading = mode.value === 'READER';

  return (
    <div class={`reader${paneHidden.value ? ' pane-hidden' : ''}`}>
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
      </aside>
      <div class="bottom">
        <HintStrip />
        <StatusLine />
      </div>
      {askOpen.value && <AskBox />}
      {paletteOpen.value && <Palette />}
      <CheatCard />
    </div>
  );
}
