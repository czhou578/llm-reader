// The first-run aids: the hint strip shows for the first ten sessions.
const KEY = 'llm-reader.sessions';
const HINT_SESSIONS = 10;
const CARD_KEY = 'llm-reader.cheat-card-shown';

let sessions = 0;

/** Counts this page load as one session. Call once at boot. */
export function countSession(): void {
  try {
    sessions = Number(localStorage.getItem(KEY) ?? '0') + 1;
    localStorage.setItem(KEY, String(sessions));
  } catch {
    sessions = 1;
  }
}

export function showHintStrip(): boolean {
  return sessions <= HINT_SESSIONS;
}

/** True once per browser. Unused in v0: the card no longer opens by itself, because it covers the PDF. `?` opens it. */
export function takeFirstRunCard(): boolean {
  try {
    if (localStorage.getItem(CARD_KEY)) return false;
    localStorage.setItem(CARD_KEY, '1');
    return true;
  } catch {
    return false;
  }
}
