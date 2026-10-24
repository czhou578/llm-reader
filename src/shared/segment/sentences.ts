// Sentence split: Intl.Segmenter plus a merge rule for known abbreviations (architecture.md 2.3 step 7).

/** Tokens that end with a period but do not end a sentence. Compared in lower case. */
export const ABBREVIATIONS: ReadonlySet<string> = new Set([
  'e.g.', 'i.e.', 'al.', 'cf.', 'vs.', 'viz.', 'fig.', 'figs.', 'eq.', 'eqs.', 'tab.', 'sec.', 'secs.', 'ch.',
  'chap.', 'app.', 'ref.', 'refs.', 'no.', 'nos.', 'vol.', 'pp.', 'p.', 'ed.', 'eds.', 'approx.', 'resp.',
  'dr.', 'mr.', 'mrs.', 'ms.', 'prof.', 'st.', 'jr.', 'sr.', 'thm.', 'lem.', 'def.', 'prop.', 'cor.',
]);

const segmenters = new Map<string, Intl.Segmenter>();

function segmenterFor(lang: string): Intl.Segmenter {
  let seg = segmenters.get(lang);
  if (!seg) {
    try {
      seg = new Intl.Segmenter(lang, { granularity: 'sentence' });
    } catch {
      seg = new Intl.Segmenter('en', { granularity: 'sentence' }); // a bad language tag from PDF metadata
    }
    segmenters.set(lang, seg);
  }
  return seg;
}

/** True when the text ends with a token that does not end a sentence. */
export function endsWithAbbreviation(text: string): boolean {
  const tokens = text.trimEnd().split(/\s+/);
  const last = (tokens[tokens.length - 1] ?? '').replace(/^[([{"'“‘]+/, '');
  if (!last.endsWith('.')) return false;
  if (/^\p{Lu}\.$/u.test(last)) return true; // a single capital initial, e.g. "J. Smith"
  const lower = last.toLowerCase();
  if (ABBREVIATIONS.has(lower)) return true;
  // "et al." is two tokens; "al." alone is in the set, so this case is covered.
  return false;
}

/**
 * Split text[start, end) into sentence spans. The spans exclude leading and trailing white space.
 * Offsets are relative to `text`.
 */
export function splitSentences(text: string, start: number, end: number, lang = 'en'): [number, number][] {
  const slice = text.slice(start, end);
  const raw: [number, number][] = [];
  for (const seg of segmenterFor(lang).segment(slice)) {
    let a = seg.index;
    let b = seg.index + seg.segment.length;
    while (a < b && /\s/.test(slice[a]!)) a++;
    while (b > a && /\s/.test(slice[b - 1]!)) b--;
    if (b > a) raw.push([a, b]);
  }
  const merged: [number, number][] = [];
  for (const span of raw) {
    const prev = merged[merged.length - 1];
    if (prev && endsWithAbbreviation(slice.slice(prev[0], prev[1]))) prev[1] = span[1];
    else merged.push([span[0], span[1]]);
  }
  return merged.map(([a, b]) => [a + start, b + start]);
}
