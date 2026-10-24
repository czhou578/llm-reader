import type { ChatEvent } from '../../shared/types.ts';
import { parseData, postJson, sseMessages } from './http.ts';
import { DriverError, type ChatDriver, type DriverRequest, type ResolvedProfile } from './types.ts';

// Anthropic Messages API over raw fetch: POST {base_url}/v1/messages with stream: true.

const EPHEMERAL = { type: 'ephemeral' } as const;
// Models that accept the server-side refusal fallback ("default" form) on the first-party API.
const FALLBACK_MODELS = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;

type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };

export const anthropicDriver: ChatDriver = {
  kind: 'anthropic',
  async *stream(profile: ResolvedProfile, req: DriverRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
    if (!profile.apiKey) {
      throw new DriverError('missing_key', `set ${profile.api_key_env ?? 'the API key variable'} for profile "${profile.name}"`, false);
    }
    const base = profile.base_url ?? 'https://api.anthropic.com';
    const hinted = new Set((req.cacheHints ?? []).map((h) => h.messageIndex));
    const body: Record<string, unknown> = {
      model: profile.model,
      max_tokens: req.maxTokens ?? 8192,
      stream: true,
      messages: req.messages.map((m, i) => ({
        role: m.role,
        content: hinted.has(i) ? [{ type: 'text', text: m.content, cache_control: EPHEMERAL }] : m.content,
      })),
    };
    // The system prompt is identical for all asks, so it is the first cache breakpoint.
    if (req.system) body['system'] = [{ type: 'text', text: req.system, cache_control: EPHEMERAL }];
    if (req.temperature !== undefined) body['temperature'] = req.temperature;
    if (profile.effort) body['output_config'] = { effort: profile.effort };
    const headers: Record<string, string> = { 'x-api-key': profile.apiKey, 'anthropic-version': '2023-06-01' };
    if (new URL(base).host === 'api.anthropic.com' && FALLBACK_MODELS.test(profile.model)) {
      headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
      body['fallbacks'] = 'default';
    }

    const res = await postJson(`${base}/v1/messages`, headers, body, signal);
    const usage = { input: 0, output: 0, cached: 0 };
    let finish: 'stop' | 'length' | 'other' = 'other';
    let ended = false;
    const absorb = (u: Usage | undefined): void => {
      if (!u) return;
      // input_tokens excludes cache reads and writes; the app counts all input and reports reads as cached.
      if (u.input_tokens !== undefined || u.cache_read_input_tokens !== undefined || u.cache_creation_input_tokens !== undefined) {
        const total = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        usage.input = Math.max(usage.input, total);
        usage.cached = Math.max(usage.cached, u.cache_read_input_tokens ?? 0);
      }
      if (u.output_tokens !== undefined) usage.output = Math.max(usage.output, u.output_tokens); // cumulative counts
    };

    for await (const m of sseMessages(res)) {
      const data = parseData(m);
      const type = (data['type'] as string | undefined) ?? m.event;
      if (type === 'message_start') {
        absorb((data['message'] as { usage?: Usage } | undefined)?.usage);
      } else if (type === 'content_block_delta') {
        const delta = data['delta'] as { type?: string; text?: string } | undefined;
        // Thinking and signature deltas are not part of the answer.
        if (delta?.type === 'text_delta' && delta.text) yield { type: 'delta', text: delta.text };
      } else if (type === 'message_delta') {
        absorb(data['usage'] as Usage | undefined);
        const reason = (data['delta'] as { stop_reason?: string } | undefined)?.stop_reason;
        finish = reason === 'end_turn' || reason === 'stop_sequence' ? 'stop' : reason === 'max_tokens' ? 'length' : 'other';
        // One merged usage event per run, so the usage table gets one row and no double counts.
        yield { type: 'usage', inputTokens: usage.input, outputTokens: usage.output, cachedInputTokens: usage.cached };
      } else if (type === 'message_stop') {
        ended = true;
        break;
      } else if (type === 'error') {
        const e = data['error'] as { type?: string; message?: string } | undefined;
        const overloaded = e?.type === 'overloaded_error' || e?.type === 'api_error';
        throw new DriverError(overloaded ? 'overloaded' : (e?.type ?? 'provider_error'), e?.message ?? 'stream error', overloaded);
      }
    }
    if (!ended) throw new DriverError('bad_stream', 'the stream ended before message_stop', true);
    yield { type: 'done', finishReason: finish };
  },
};
