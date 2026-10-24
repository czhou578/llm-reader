import type { ChatEvent, ChatRequest, ProviderKind } from '../../shared/types.ts';
import type { ServerProfile } from '../config.ts';

// LLM adapter interface (DESIGN.md 7.5, docs/design/architecture.md 4.1).

/** A profile with its name and its key, ready for a driver. The key never leaves the server. */
export interface ResolvedProfile extends ServerProfile {
  name: string;
  apiKey?: string;
}

/** ChatRequest plus cache hints. Drivers that support prompt caching mark these message indexes. */
export interface DriverRequest extends ChatRequest {
  cacheHints?: { messageIndex: number }[];
}

export interface ChatDriver {
  readonly kind: ProviderKind;
  stream(profile: ResolvedProfile, req: DriverRequest, signal: AbortSignal): AsyncIterable<ChatEvent>;
}

export class DriverError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}
