import { useEffect, useState } from 'preact/hooks';
import { Library } from '../library/Library.tsx';
import { isPdf, openFile } from '../library/upload.ts';
import { ReaderView } from './ReaderView.tsx';
import { bootError, view } from './session.ts';

function hasFiles(ev: DragEvent): boolean {
  return !!ev.dataTransfer && [...ev.dataTransfer.types].includes('Files');
}

/** Drag and drop of a PDF anywhere on the window opens it. */
function useDropToOpen(): boolean {
  const [over, setOver] = useState(false);
  useEffect(() => {
    let depth = 0;
    const enter = (ev: DragEvent) => {
      if (!hasFiles(ev)) return;
      depth++;
      setOver(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setOver(false);
    };
    const overFn = (ev: DragEvent) => {
      if (hasFiles(ev)) ev.preventDefault();
    };
    const drop = (ev: DragEvent) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      depth = 0;
      setOver(false);
      const file = [...(ev.dataTransfer?.files ?? [])].find(isPdf) ?? ev.dataTransfer?.files[0];
      if (file) void openFile(file);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', overFn);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', overFn);
      window.removeEventListener('drop', drop);
    };
  }, []);
  return over;
}

export function App() {
  const dropping = useDropToOpen();
  return (
    <>
      {view.value === 'boot' && <div class="boot muted">Loading…</div>}
      {view.value === 'error' && (
        <main class="boot">
          <h1>llm-reader</h1>
          <p class="error">{bootError.value}</p>
          <p class="muted">
            Start the server with <code>pnpm dev</code>, then reload this page.
          </p>
        </main>
      )}
      {view.value === 'library' && <Library />}
      {view.value === 'reader' && <ReaderView />}
      {dropping && <div class="drop-overlay">Drop a PDF to open it</div>}
    </>
  );
}
