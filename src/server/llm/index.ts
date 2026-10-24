import type { ChatEvent, ProviderKind, Role } from '../../shared/types.ts';
import { resolveKey, type ServerConfig } from '../config.ts';
import { anthropicDriver } from './anthropic.ts';
import { createMockDriver } from './mock.ts';
import { openaiDriver } from './openai.ts';
import { DriverError, type ChatDriver, type DriverRequest, type ResolvedProfile } from './types.ts';

export type { ChatDriver, DriverRequest, ResolvedProfile } from './types.ts';
export { DriverError } from './types.ts';

export type Drivers = Record<ProviderKind, ChatDriver>;

export function defaultDrivers(): Drivers {
  return { anthropic: anthropicDriver, 'openai-compatible': openaiDriver, mock: createMockDriver() };
}

/** The profile that a role (or a profile name) points to, with its key from the environment. */
export function resolveProfile(config: ServerConfig, roleOrName: Role | string, env: NodeJS.ProcessEnv = process.env): ResolvedProfile {
  const name = roleOrName === 'strong' || roleOrName === 'fast' ? config.roles[roleOrName] : roleOrName;
  const profile = config.profiles[name];
  if (!profile) throw new DriverError('unknown_profile', `no profile named "${name}"`, false);
  const resolved: ResolvedProfile = { ...profile, name };
  const key = resolveKey(profile, env);
  if (key) resolved.apiKey = key;
  return resolved;
}

export interface RetryOptions {
  tries?: number; // total attempts, 3 by default
  baseMs?: number; // first backoff, 500 ms by default
  maxDelayMs?: number;
}

/**
 * Stream with retries. A retry happens only before the first delta, and only for retryable errors
 * (network, 429, 5xx, overloaded). After the first delta the error goes to the caller with the partial text.
 */
export async function* streamWithRetry(
  driver: ChatDriver,
  profile: ResolvedProfile,
  req: DriverRequest,
  signal: AbortSignal,
  opts: RetryOptions = {},
): AsyncGenerator<ChatEvent> {
  const tries = opts.tries ?? 3;
  const base = opts.baseMs ?? 500;
  const maxDelay = opts.maxDelayMs ?? 20_000;
  for (let attempt = 1; ; attempt++) {
    let sawDelta = false;
    try {
      for await (const ev of driver.stream(profile, req, signal)) {
        if (ev.type === 'delta') sawDelta = true;
        yield ev;
      }
      return;
    } catch (err) {
      const retryable = err instanceof DriverError ? err.retryable : !signal.aborted;
      if (signal.aborted || sawDelta || attempt >= tries || !retryable) throw err;
      const backoff = base * 2 ** (attempt - 1) * (0.5 + Math.random()); // jitter in [0.5, 1.5)
      const hinted = err instanceof DriverError ? err.retryAfterMs : undefined;
      await abortableSleep(Math.min(maxDelay, hinted ?? backoff), signal);
    }
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
