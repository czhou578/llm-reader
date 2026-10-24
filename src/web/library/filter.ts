import type { LibraryEntry } from '../../shared/types.ts';

/** Type-to-filter: every word of the query must occur in the file name or the title (case-insensitive). */
export function filterEntries(entries: readonly LibraryEntry[], query: string): LibraryEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...entries];
  return entries.filter((e) => {
    const hay = `${e.name} ${e.title ?? ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
