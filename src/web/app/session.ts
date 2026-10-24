// App state as signals. Components read them; commands and the ask flow write them.
import { computed, signal } from '@preact/signals';
import type {
  AskContext,
  ClientConfig,
  Document,
  PresetId,
  StagedSelection,
  StartRunRequest,
  Thread,
  UsageSummary,
} from '../../shared/types.ts';
import type { ViewerApi } from '../viewer/api.ts';
import type { LayoutName } from '../commands/keymap.ts';
import { chooseTarget, type SentPreset } from './target.ts';

export type View = 'boot' | 'library' | 'reader' | 'error';

export interface RunState {
  runId: string;
  threadId: string;
  messageId: string;
  preset: PresetId;
  startedAt: number;
  state: 'streaming' | 'ready' | 'cancelled' | 'error';
  error?: string;
}

export interface AskBoxState {
  /** The typed question. */
  draft: string;
  /** 'follow-up' sends to `followThreadId`; 'new' creates a thread at the staged passage. */
  target: 'new' | 'follow-up';
  followThreadId: string | null;
  /** The staged selection when the box opened. Null when the box opened in READER mode with no staged passage. */
  staged: StagedSelection | null;
}

export const view = signal<View>('boot');
export const bootError = signal<string | null>(null);
export const config = signal<ClientConfig | null>(null);
export const doc = signal<Document | null>(null);
export const staged = signal<StagedSelection | null>(null);
export const threads = signal<Thread[]>([]);
export const activeThreadId = signal<string | null>(null);
export const activeRun = signal<RunState | null>(null);
export const usage = signal<UsageSummary | null>(null);
export const notice = signal<string | null>(null);
export const paneHidden = signal(false);
export const helpOpen = signal(false);
export const askBox = signal<AskBoxState | null>(null);
export const paletteOpen = signal(false);
export const layoutName = signal<LayoutName>(readLayout());
/** Seconds since the active run started. A timer ticks it while a run streams. */
export const runSeconds = signal(0);

export const activeThread = computed(() => threads.value.find((t) => t.id === activeThreadId.value) ?? null);
/** The ask box is open. Components that only need this do not re-render on each typed character. */
export const askOpen = computed(() => askBox.value !== null);
/** Changes only when a thread is added or removed, not on each streamed word. */
export const threadIds = computed(() => threads.value.map((t) => t.id).join(','));
export const stagedTarget = computed(() => chooseTarget(staged.value?.passage ?? null, threads.value));

// Values that do not drive rendering.
export const memory = {
  viewer: null as ViewerApi | null,
  /** The element the viewer renders into. The shell owns it. */
  viewerContainer: null as HTMLElement | null,
  lastPreset: null as PresetId | null,
  lastSent: null as SentPreset | null,
  /** The last request per thread, for `r`. */
  lastRequest: new Map<string, StartRunRequest>(),
  /** The ask context of the latest staged ask per thread, reused by READER-mode follow-ups. */
  threadContext: new Map<string, AskContext>(),
};

let noticeTimer: ReturnType<typeof setTimeout> | undefined;

/** Shows a short message in the status line for about three seconds. */
export function showNotice(text: string, ms = 3000): void {
  notice.value = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.value = null), ms);
}

function readLayout(): LayoutName {
  try {
    return localStorage.getItem('llm-reader.layout') === 'home' ? 'home' : 'left';
  } catch {
    return 'left';
  }
}

export function setLayout(name: LayoutName): void {
  layoutName.value = name;
  try {
    localStorage.setItem('llm-reader.layout', name);
  } catch {
    // Storage is not available. The layout lasts for this session only.
  }
}
