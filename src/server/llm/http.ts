import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { redact } from '../log.ts';
import { DriverError } from './types.ts';

// Shared HTTP and SSE helpers for the drivers: raw fetch plus eventsource-parser.

export async function postJson(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw err;
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    throw new DriverError('network', `cannot reach ${new URL(url).host}${cause ? ` (${cause})` : ''}`, true);
  }
  if (!res.ok) throw await httpError(res);
  if (!res.body) throw new DriverError('provider_error', 'empty response body', true, res.status);
  return res;
}

async function httpError(res: Response): Promise<DriverError> {
  const text = (await res.text().catch(() => '')).slice(0, 2000);
  let detail = text;
  try {
    const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    detail = (typeof j.error === 'string' ? j.error : j.error?.message) ?? j.message ?? text;
  } catch {
    // not JSON
  }
  const msg = redact(`${res.status} from provider${detail ? `: ${detail}` : ''}`);
  const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
  const s = res.status;
  if (s === 429) return new DriverError('rate_limited', msg, true, s, retryAfter);
  if (s === 529) return new DriverError('overloaded', msg, true, s, retryAfter);
  if (s >= 500) return new DriverError('provider_error', msg, true, s, retryAfter);
  if (s === 401 || s === 403) return new DriverError('auth', msg, false, s);
  if (s === 404) return new DriverError('not_found', msg, false, s);
  return new DriverError('bad_request', msg, false, s);
}

function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/** Yield each SSE message of a response body. */
export async function* sseMessages(res: Response): AsyncGenerator<EventSourceMessage> {
  const queue: EventSourceMessage[] = [];
  const parser = createParser({ onEvent: (m) => queue.push(m) });
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(value);
      while (queue.length) yield queue.shift()!;
    }
    parser.feed('\n\n'); // flush a final event without a trailing blank line
    while (queue.length) yield queue.shift()!;
  } finally {
    reader.releaseLock();
  }
}

export function parseData(m: EventSourceMessage): Record<string, unknown> {
  try {
    return JSON.parse(m.data) as Record<string, unknown>;
  } catch {
    throw new DriverError('bad_stream', `unparsable stream frame: ${m.data.slice(0, 200)}`, false);
  }
}
