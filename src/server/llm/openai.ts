import type { ChatEvent } from '../../shared/types.ts';
import { parseData, postJson, sseMessages } from './http.ts';
import { DriverError, type ChatDriver, type DriverRequest, type ResolvedProfile } from './types.ts';

// OpenAI-compatible chat completions over raw fetch (OpenAI, vLLM, llama.cpp, Ollama, OpenRouter, ...).

export const openaiDriver: ChatDriver = {
  kind: 'openai-compatible',
  async *stream(profile: ResolvedProfile, req: DriverRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
    if (profile.api_key_env && !profile.apiKey) {
      throw new DriverError('missing_key', `set ${profile.api_key_env} for profile "${profile.name}"`, false);
    }
    const messages: { role: string; content: string }[] = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    for (const m of req.messages) messages.push({ role: m.role, content: m.content });
    const body: Record<string, unknown> = {
      model: profile.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.maxTokens !== undefined) body['max_tokens'] = req.maxTokens;
    if (req.temperature !== undefined) body['temperature'] = req.temperature;
    const headers: Record<string, string> = {};
    if (profile.apiKey) headers['authorization'] = `Bearer ${profile.apiKey}`;

    const res = await postJson(`${profile.base_url}/chat/completions`, headers, body, signal);
    let finish: 'stop' | 'length' | 'other' | null = null;
    let sawDone = false;
    for await (const m of sseMessages(res)) {
      if (m.data.trim() === '[DONE]') {
        sawDone = true;
        break;
      }
      const data = parseData(m);
      if (data['error']) {
        const e = data['error'] as { message?: string } | string;
        throw new DriverError('provider_error', typeof e === 'string' ? e : (e.message ?? 'stream error'), true);
      }
      const choice = (data['choices'] as { delta?: { content?: string | null }; finish_reason?: string | null }[] | undefined)?.[0];
      const text = choice?.delta?.content;
      if (text) yield { type: 'delta', text };
      if (choice?.finish_reason) {
        const r = choice.finish_reason;
        finish = r === 'stop' ? 'stop' : r === 'length' ? 'length' : 'other';
      }
      const u = data['usage'] as
        | { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
        | null
        | undefined;
      if (u) {
        const ev: ChatEvent = { type: 'usage' };
        if (u.prompt_tokens !== undefined) ev.inputTokens = u.prompt_tokens;
        if (u.completion_tokens !== undefined) ev.outputTokens = u.completion_tokens;
        if (u.prompt_tokens_details?.cached_tokens !== undefined) ev.cachedInputTokens = u.prompt_tokens_details.cached_tokens;
        yield ev;
      }
    }
    // Some servers close without [DONE]; a finish_reason still marks a complete answer.
    if (!sawDone && finish === null) throw new DriverError('bad_stream', 'the stream ended without [DONE]', true);
    yield { type: 'done', finishReason: finish ?? 'stop' };
  },
};
