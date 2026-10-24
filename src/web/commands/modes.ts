import { signal } from '@preact/signals';

// DESIGN.md 5.3. HINT and SEARCH are Phase 1, so v0 has four modes.
export type Mode = 'NORMAL' | 'ASK' | 'READER' | 'PALETTE';

export const mode = signal<Mode>('NORMAL');

/** In these modes a text input has focus, and only a few keys are commands. */
export const TEXT_MODES: ReadonlySet<Mode> = new Set<Mode>(['ASK', 'PALETTE']);
