import type { ChatEvent } from '../../shared/types.ts';
import { estimateTokens } from '../context/build.ts';
import type { ChatDriver, DriverRequest, ResolvedProfile } from './types.ts';

// The mock provider: a deterministic answer with no network, so the app runs without a key.

export interface MockOptions {
  chunkMs?: number; // delay per chunk; 20 ms by default
}

const PRESET_NAMES: [RegExp, string][] = [
  [/^Task: Explain the selected passage\./m, 'explain'],
  [/^Task: Define the terms/m, 'define'],
  [/^Task: Answer the reader's question/m, 'ask'],
  [/^Follow-up on the same passage/m, 'follow-up'],
];

/** The answer text the mock streams for a request. Exported for tests. */
export function mockAnswer(req: DriverRequest): string {
  const last = req.messages[req.messages.length - 1]?.content ?? '';
  const preset = PRESET_NAMES.find(([re]) => re.test(last))?.[1] ?? 'ask';
  // The passage is in turn 1 for a follow-up, and in the last turn for a new ask.
  const turn1 = req.messages[0]?.content ?? '';
  const passage = /selected passage:\n"""\n([\s\S]*?)\n"""/.exec(turn1)?.[1] ?? '';
  const words = passage.split(/\s+/).filter(Boolean);
  const head = words.slice(0, 8).join(' ') + (words.length > 8 ? ' …' : '');
  return (
    `**Mock answer (${preset}).** The passage starts with "${head}". ` +
    'This is a fixed reply from the mock provider, so the app runs with no network and no key. ' +
    'Each word arrives as a separate chunk to show the streaming path.'
  );
}

export function createMockDriver(opts: MockOptions = {}): ChatDriver {
  const chunkMs = opts.chunkMs ?? 20;
  return {
    kind: 'mock',
    async *stream(_profile: ResolvedProfile, req: DriverRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
      const text = mockAnswer(req);
      const chunks = text.match(/\S+\s*/g) ?? [];
      for (const chunk of chunks) {
        await sleep(chunkMs, signal);
        yield { type: 'delta', text: chunk };
      }
      const input = estimateTokens((req.system ?? '') + req.messages.map((m) => m.content).join(''));
      yield { type: 'usage', inputTokens: input, outputTokens: Math.ceil(chunks.length * 1.3), cachedInputTokens: 0 };
      yield { type: 'done', finishReason: 'stop' };
    },
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
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
