import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { LibraryEntry } from '../../shared/types.ts';
import * as api from '../api/client.ts';
import { navigateToDoc } from '../app/router.ts';
import { config, notice, showNotice } from '../app/session.ts';
import { filterEntries } from './filter.ts';
import { pickAndOpen } from './upload.ts';

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatDate(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

async function openEntry(entry: LibraryEntry): Promise<void> {
  try {
    const id = entry.docId ?? (await api.openDocByPath(entry.path)).id;
    await navigateToDoc(id);
  } catch (err) {
    showNotice(`Cannot open ${entry.name}: ${err instanceof Error ? err.message : String(err)}`, 5000);
  }
}

/** The library: recent documents and the PDFs in books_dir. Type to filter, arrows move, Enter opens. */
export function Library() {
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    api.getLibrary().then(setEntries, (err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  // Ctrl+O opens the file picker. The listener is on window, so it works without focus in the input.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'o') {
        ev.preventDefault();
        void pickAndOpen();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, []);

  useLayoutEffect(() => input.current?.focus(), []);

  const shown = entries ? filterEntries(entries, query) : [];
  const index = Math.min(selected, Math.max(0, shown.length - 1));

  useLayoutEffect(() => {
    list.current?.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  }, [index, query]);

  const onKeyDown = (ev: KeyboardEvent) => {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      setSelected(Math.min(index + 1, shown.length - 1));
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      setSelected(Math.max(index - 1, 0));
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const entry = shown[index];
      if (entry) void openEntry(entry);
    } else if (ev.key === 'Escape') {
      setQuery('');
      setSelected(0);
    }
  };

  return (
    <main class="library">
      <header class="library-head">
        <h1>llm-reader</h1>
        <p class="muted">
          Type to filter · <kbd>↑</kbd> <kbd>↓</kbd> move · <kbd>Enter</kbd> opens · <kbd>Ctrl+O</kbd> opens a file · or
          drop a PDF here
        </p>
      </header>
      <input
        ref={input}
        class="library-filter"
        type="search"
        placeholder="Filter by name or title"
        aria-label="Filter the library"
        value={query}
        onInput={(e) => {
          setQuery(e.currentTarget.value);
          setSelected(0);
        }}
        onKeyDown={onKeyDown}
      />
      {error && <p class="error">Cannot load the library: {error}</p>}
      {!entries && !error && <p class="muted">Loading…</p>}
      {entries && shown.length === 0 && (
        <p class="muted">
          {entries.length === 0
            ? `No PDFs yet. Put PDFs in ${config.value?.booksDir ?? 'books_dir'}, press Ctrl+O, or drop a file here.`
            : 'No match.'}
        </p>
      )}
      <ul class="library-list" ref={list} role="listbox" aria-label="Documents">
        {shown.map((e, i) => (
          <li
            key={e.path}
            role="option"
            aria-selected={i === index}
            class={i === index ? 'selected' : ''}
            onClick={() => void openEntry(e)}
            onMouseMove={() => i !== index && setSelected(i)}
          >
            <span class="entry-title">
              {e.docId && <span class="entry-known" title="Opened before">●</span>}
              {e.title || e.name}
            </span>
            <span class="entry-meta muted">
              {e.title ? `${e.name} · ` : ''}
              {formatSize(e.byteSize)}
              {e.lastOpenedAt ? ` · opened ${formatDate(e.lastOpenedAt)}` : ` · ${formatDate(e.mtime)}`}
            </span>
          </li>
        ))}
      </ul>
      {notice.value && <div class="library-notice" aria-live="polite">{notice.value}</div>}
    </main>
  );
}
