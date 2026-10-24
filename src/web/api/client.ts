// Typed wrappers for the server HTTP API (docs/v0-contract.md, "Server HTTP API").
// The URLs are relative: Vite proxies /api to 127.0.0.1:7777 in dev, and the server serves dist/ in production.
import type {
  ClientConfig,
  CreateThreadRequest,
  DocId,
  Document,
  LibraryEntry,
  ReadingState,
  RunEvent,
  StartRunRequest,
  StartRunResponse,
  Thread,
  UsageSummary,
} from '../../shared/types.ts';

/** An error response from the server, or a network failure (status 0). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT';
  json?: unknown;
  body?: BodyInit;
  keepalive?: boolean;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  let body = opts.body;
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method: opts.method ?? 'GET', headers, body, keepalive: opts.keepalive });
  } catch (err) {
    throw new ApiError(0, 'network', `The server is not reachable (${String(err)}).`);
  }
  if (!res.ok) {
    let code = `http_${res.status}`;
    let message = `${res.status} ${res.statusText}`;
    try {
      const data = (await res.json()) as { error?: { code?: string; message?: string } };
      if (data.error?.code) code = data.error.code;
      if (data.error?.message) message = data.error.message;
    } catch {
      // The body is not JSON. Keep the status text.
    }
    throw new ApiError(res.status, code, message);
  }
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

export const getConfig = () => request<ClientConfig>('/config');

export const getLibrary = () => request<LibraryEntry[]>('/library');

export const openDocByPath = (path: string) => request<Document>('/docs/open', { method: 'POST', json: { path } });

export function uploadDoc(file: File): Promise<Document> {
  const form = new FormData();
  form.append('file', file, file.name);
  return request<Document>('/docs', { method: 'POST', body: form });
}

export const getDoc = (id: DocId) => request<Document>(`/docs/${enc(id)}`);

export const docFileUrl = (id: DocId) => `/api/docs/${enc(id)}/file`;

/** Returns null when the server has no stored state for the document (404). */
export async function getState(id: DocId): Promise<ReadingState | null> {
  try {
    return await request<ReadingState>(`/docs/${enc(id)}/state`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/** `keepalive` lets the request finish while the page unloads. */
export const putState = (id: DocId, state: ReadingState, keepalive = false) =>
  request<ReadingState>(`/docs/${enc(id)}/state`, { method: 'PUT', json: state, keepalive });

export const listThreads = (docId: DocId) => request<Thread[]>(`/docs/${enc(docId)}/threads`);

export const createThread = (docId: DocId, req: CreateThreadRequest) =>
  request<Thread>(`/docs/${enc(docId)}/threads`, { method: 'POST', json: req });

export const getThread = (id: string) => request<Thread>(`/threads/${enc(id)}`);

export const startRun = (threadId: string, req: StartRunRequest) =>
  request<StartRunResponse>(`/threads/${enc(threadId)}/runs`, { method: 'POST', json: req });

export const cancelRun = (runId: string) => request<{ ok: true }>(`/runs/${enc(runId)}/cancel`, { method: 'POST' });

export const getUsageSummary = (docId?: DocId) =>
  request<UsageSummary>(`/usage/summary${docId ? `?docId=${enc(docId)}` : ''}`);

const RUN_EVENT_TYPES = ['run.start', 'delta', 'usage', 'run.end', 'error'] as const;

/**
 * Streams the events of one run. The generator ends after `run.end` or `error`.
 * EventSource reconnects by itself and sends Last-Event-ID on a reconnect. It cannot set that header on the first
 * connection, so an explicit `lastEventId` goes in the query string as `?lastEventId=`.
 * A `return()` on the generator (for example a `break` in `for await`) closes the connection.
 */
export async function* runEvents(runId: string, lastEventId?: string): AsyncGenerator<RunEvent> {
  const qs = lastEventId ? `?lastEventId=${enc(lastEventId)}` : '';
  const source = new EventSource(`/api/runs/${enc(runId)}/events${qs}`);
  const queue: RunEvent[] = [];
  let wake: (() => void) | null = null;
  let finished = false;

  const push = (ev: RunEvent) => {
    queue.push(ev);
    if (ev.type === 'run.end' || ev.type === 'error') {
      finished = true;
      source.close();
    }
    wake?.();
  };

  for (const type of RUN_EVENT_TYPES) {
    source.addEventListener(type, (raw: Event) => {
      // The name "error" is also the EventSource connection error. That event is not a MessageEvent with data.
      if (!(raw instanceof MessageEvent) || typeof raw.data !== 'string') {
        if (type === 'error' && source.readyState === EventSource.CLOSED && !finished) {
          push({ type: 'error', code: 'stream_closed', message: 'The answer stream closed.', retryable: true, partialKept: true });
        }
        return;
      }
      try {
        const data = JSON.parse(raw.data) as Record<string, unknown>;
        push({ ...data, type } as RunEvent);
      } catch {
        push({ type: 'error', code: 'bad_event', message: `The server sent a bad "${type}" event.`, retryable: false, partialKept: true });
      }
    });
  }

  try {
    while (true) {
      const next = queue.shift();
      if (next) {
        yield next;
        if (next.type === 'run.end' || next.type === 'error') return;
        continue;
      }
      await new Promise<void>((resolve) => (wake = resolve));
      wake = null;
    }
  } finally {
    source.close();
  }
}
