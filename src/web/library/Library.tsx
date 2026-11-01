import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { LibraryEntry } from '../../shared/types.ts';
import * as api from '../api/client.ts';
import { navigateToDoc } from '../app/router.ts';
import { config, notice, showNotice } from '../app/session.ts';
import { filterEntries } from './filter.ts';
import { Icon } from './icons.tsx';
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

/** A mouse press on a button must not take the focus from the filter input, so the next key still filters. */
const keepFocus = (ev: MouseEvent): void => ev.preventDefault();

interface Group {
  label: string;
  /** The folder on disk, shown next to the label. */
  path?: string;
  dateHead: string;
  dateOf: (e: LibraryEntry) => string | undefined;
  rows: { entry: LibraryEntry; index: number }[];
}

/** Documents opened before come first, then the other PDFs of books_dir. `index` is the position in the flat list. */
function groupEntries(shown: readonly LibraryEntry[], booksDir: string | undefined): Group[] {
  const recent: Group = { label: 'Recent', dateHead: 'Opened', dateOf: (e) => e.lastOpenedAt ?? e.mtime, rows: [] };
  const folder: Group = { label: 'Folder', path: booksDir, dateHead: 'Modified', dateOf: (e) => e.mtime, rows: [] };
  shown.forEach((entry, index) => (entry.docId ? recent : folder).rows.push({ entry, index }));
  return [recent, folder].filter((g) => g.rows.length > 0);
}

function countText(entries: LibraryEntry[] | null, shown: number): string {
  if (!entries) return '';
  const total = `${entries.length} document${entries.length === 1 ? '' : 's'}`;
  return shown === entries.length ? total : `${shown} of ${total}`;
}

/** The library: recent documents and the PDFs in books_dir. Type to filter, arrows move, Enter opens. */
export function Library() {
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

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
  const booksDir = config.value?.booksDir;
  const groups = groupEntries(shown, booksDir);

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
      <header class="library-top">
        <div class="library-brand">
          <span class="icon-box accent">
            <Icon name="book" />
          </span>
          <h1>llm-reader</h1>
        </div>
        <button type="button" class="open-file" title="Open a PDF file (Ctrl+O)" onMouseDown={keepFocus} onClick={() => void pickAndOpen()}>
          <Icon name="folder" />
          Open file…
          <span class="keys">
            <kbd>Ctrl</kbd>
            <kbd>O</kbd>
          </span>
        </button>
      </header>

      <section class="library-pane" aria-label="Documents">
        <div class="library-column">
          <div class="library-filter-wrap">
            <Icon name="search" />
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
          </div>

          {error && <p class="library-empty error">Cannot load the library: {error}</p>}
          {!entries && !error && <p class="library-empty muted">Loading…</p>}
          {entries && shown.length === 0 && (
            <p class="library-empty muted">
              {entries.length === 0 ? `No PDFs yet. Put PDFs in ${booksDir ?? 'books_dir'}, press Ctrl+O, or drop a file here.` : 'No match.'}
            </p>
          )}

          <div class="library-list" ref={list} role="listbox" aria-label="Documents">
            {groups.map((g) => (
              <div key={g.label} class="library-group" role="group" aria-label={g.label}>
                <div class="group-head" aria-hidden="true">
                  <span class="col-title">
                    {g.label}
                    {g.path && (
                      <span class="group-path" title={g.path}>
                        {g.path}
                      </span>
                    )}
                  </span>
                  <span class="col-size">Size</span>
                  <span class="col-date">{g.dateHead}</span>
                </div>
                {g.rows.map(({ entry: e, index: i }) => (
                  <div
                    key={e.path}
                    role="option"
                    aria-selected={i === index}
                    class={`entry${i === index ? ' selected' : ''}`}
                    onClick={() => void openEntry(e)}
                    onMouseMove={() => i !== index && setSelected(i)}
                  >
                    <span class="icon-box">
                      <Icon name="file" size={20} />
                    </span>
                    <span class="entry-text">
                      <span class="entry-title">{e.title || e.name}</span>
                      {e.title && <span class="entry-name">{e.name}</span>}
                    </span>
                    <span class="entry-size">{formatSize(e.byteSize)}</span>
                    <span class="entry-date">{formatDate(g.dateOf(e))}</span>
                    <kbd class="entry-enter" aria-hidden="true">
                      ↵
                    </kbd>
                  </div>
                ))}
              </div>
            ))}
          </div>

          <p class="drop-hint">
            <Icon name="download" />
            Drop a PDF here to open it
          </p>
        </div>
      </section>

      <footer class="status-line library-status">
        {notice.value ? (
          <span class="notice">{notice.value}</span>
        ) : (
          <span class="hints" aria-hidden="true">
            <span class="hint">Type to filter</span>
            <span class="hint">
              <kbd>↑</kbd>
              <kbd>↓</kbd> Move
            </span>
            <span class="hint">
              <kbd>↵</kbd> Open
            </span>
            <span class="hint">
              <kbd>Ctrl</kbd>
              <kbd>O</kbd> Open file
            </span>
          </span>
        )}
        <span class="doc-count">{countText(entries, shown.length)}</span>
        <span class="visually-hidden" aria-live="polite">
          {notice.value ?? ''}
        </span>
      </footer>
    </main>
  );
}
