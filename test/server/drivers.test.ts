import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatEvent } from '../../src/shared/types.ts';
import { anthropicDriver } from '../../src/server/llm/anthropic.ts';
import { DriverError, streamWithRetry, type ChatDriver, type ResolvedProfile } from '../../src/server/llm/index.ts';
import { openaiDriver } from '../../src/server/llm/openai.ts';

// Each driver against a tiny fake provider that sends hand-written SSE frames in the provider's shape.

interface Captured {
  path: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

type Handler = (req: Captured, res: ServerResponse, n: number) => void;

let server: Server | null = null;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

async function fakeProvider(handler: Handler): Promise<{ base: string; requests: Captured[] }> {
  const requests: Captured[] = [];
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const captured = { path: req.url ?? '', headers: req.headers, body: JSON.parse(raw || '{}') as Record<string, unknown> };
      requests.push(captured);
      handler(captured, res, requests.length);
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  return { base: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, requests };
}

function sse(res: ServerResponse, frames: string[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const f of frames) res.write(f);
  res.end();
}

async function collect(driver: ChatDriver, profile: ResolvedProfile, opts: { retry?: boolean } = {}): Promise<ChatEvent[]> {
  const req = { system: 'SYS', messages: [{ role: 'user' as const, content: 'hi' }], maxTokens: 100, cacheHints: [{ messageIndex: 0 }] };
  const signal = new AbortController().signal;
  const out: ChatEvent[] = [];
  const it = opts.retry ? streamWithRetry(driver, profile, req, signal, { baseMs: 1 }) : driver.stream(profile, req, signal);
  for await (const ev of it) out.push(ev);
  return out;
}

const anthropicFrames = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-opus-5-5","stop_reason":null,"usage":{"input_tokens":100,"cache_read_input_tokens":50,"cache_creation_input_tokens":0,"output_tokens":1}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"secret"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
  'event: ping\ndata: {"type": "ping"}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
  // A frame split across two writes must still parse.
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_d',
  'elta","text":" world"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":12}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

describe('anthropic driver', () => {
  const profile = (base: string): ResolvedProfile => ({ name: 'claude', provider: 'anthropic', model: 'claude-x', base_url: base, apiKey: 'test-key-123456789' });

  it('sends the Messages API request and parses the stream', async () => {
    const { base, requests } = await fakeProvider((_req, res) => sse(res, anthropicFrames));
    const events = await collect(anthropicDriver, profile(base));
    expect(events).toEqual([
      { type: 'delta', text: 'Hello' },
      { type: 'delta', text: ' world' },
      { type: 'usage', inputTokens: 150, outputTokens: 12, cachedInputTokens: 50 },
      { type: 'done', finishReason: 'stop' },
    ]);
    const r = requests[0]!;
    expect(r.path).toBe('/v1/messages');
    expect(r.headers['x-api-key']).toBe('test-key-123456789');
    expect(r.headers['anthropic-version']).toBe('2023-06-01');
    expect(r.headers['anthropic-beta']).toBeUndefined(); // the fallback beta is only for the first-party host
    expect(r.body).toMatchObject({
      model: 'claude-x',
      max_tokens: 100,
      stream: true,
      system: [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }],
    });
    expect(r.body).not.toHaveProperty('temperature');
  });

  it('sends output_config.effort when the profile sets it', async () => {
    const { base, requests } = await fakeProvider((_req, res) => sse(res, anthropicFrames));
    await collect(anthropicDriver, { ...profile(base), effort: 'medium' } as ResolvedProfile);
    expect(requests[0]!.body['output_config']).toEqual({ effort: 'medium' });
    expect(requests[0]!.body).not.toHaveProperty('thinking'); // Opus 5.5 thinks adaptively; effort is the control
  });

  it('maps max_tokens to length and fails without a key', async () => {
    const frames = anthropicFrames.map((f) => f.replace('"end_turn"', '"max_tokens"'));
    const { base } = await fakeProvider((_req, res) => sse(res, frames));
    expect((await collect(anthropicDriver, profile(base))).at(-1)).toEqual({ type: 'done', finishReason: 'length' });
    const { apiKey: _k, ...noKey } = profile(base);
    await expect(collect(anthropicDriver, noKey)).rejects.toMatchObject({ code: 'missing_key', retryable: false });
  });

  it('retries 529 before the first delta, not 400', async () => {
    const { base, requests } = await fakeProvider((_req, res, n) => {
      if (n === 1) {
        res.writeHead(529, { 'content-type': 'application/json' });
        res.end('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
      } else sse(res, anthropicFrames);
    });
    const events = await collect(anthropicDriver, profile(base), { retry: true });
    expect(requests).toHaveLength(2);
    expect(events.filter((e) => e.type === 'delta')).toHaveLength(2);

    server!.close();
    const bad = await fakeProvider((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"invalid_request_error","message":"bad field"}}');
    });
    await expect(collect(anthropicDriver, profile(bad.base), { retry: true })).rejects.toMatchObject({ code: 'bad_request', message: '400 from provider: bad field' });
    expect(bad.requests).toHaveLength(1);
  });

  it('does not retry an error after the first delta', async () => {
    const frames = [
      ...anthropicFrames.slice(0, 7),
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
    ];
    const { base, requests } = await fakeProvider((_req, res) => sse(res, frames));
    const seen: ChatEvent[] = [];
    const run = async (): Promise<void> => {
      const req = { messages: [{ role: 'user' as const, content: 'hi' }] };
      for await (const ev of streamWithRetry(anthropicDriver, profile(base), req, new AbortController().signal, { baseMs: 1 })) seen.push(ev);
    };
    await expect(run()).rejects.toBeInstanceOf(DriverError);
    expect(requests).toHaveLength(1);
    expect(seen).toEqual([{ type: 'delta', text: 'Hello' }]);
  });
});

describe('openai-compatible driver', () => {
  const frames = [
    'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n',
    'data: {"id":"c1","choices":[{"index":0,"delta":{"reasoning_content":"thinking"}}]}\n\n',
    'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n',
    'data: {"id":"c1","choices":[{"index":0,"delta":{"content":" there"},"finish_reason":null}]}\n\n',
    'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":20,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":4}}}\n\n',
    'data: [DONE]\n\n',
  ];

  it('sends a chat completions request and parses the stream', async () => {
    const { base, requests } = await fakeProvider((_req, res) => sse(res, frames));
    const profile: ResolvedProfile = { name: 'local', provider: 'openai-compatible', model: 'qwen', base_url: `${base}/v1`, api_key_env: 'K', apiKey: 'sk-local-key-0123456789' };
    const events = await collect(openaiDriver, profile);
    expect(events).toEqual([
      { type: 'delta', text: 'Hi' },
      { type: 'delta', text: ' there' },
      { type: 'usage', inputTokens: 20, outputTokens: 5, cachedInputTokens: 4 },
      { type: 'done', finishReason: 'stop' },
    ]);
    const r = requests[0]!;
    expect(r.path).toBe('/v1/chat/completions');
    expect(r.headers['authorization']).toBe('Bearer sk-local-key-0123456789');
    expect(r.body).toMatchObject({
      model: 'qwen',
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 100,
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'hi' },
      ],
    });
  });

  it('sends no Authorization header without a key, and retries a 503', async () => {
    const { base, requests } = await fakeProvider((_req, res, n) => {
      if (n === 1) {
        res.writeHead(503);
        res.end('busy');
      } else sse(res, frames);
    });
    const profile: ResolvedProfile = { name: 'local', provider: 'openai-compatible', model: 'qwen', base_url: base };
    const events = await collect(openaiDriver, profile, { retry: true });
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.headers['authorization']).toBeUndefined();
  });

  it('stops on abort', async () => {
    const { base } = await fakeProvider((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(frames[2]); // one delta, then the server holds the stream open
    });
    const ctrl = new AbortController();
    const profile: ResolvedProfile = { name: 'local', provider: 'openai-compatible', model: 'qwen', base_url: base };
    const seen: ChatEvent[] = [];
    const run = async (): Promise<void> => {
      for await (const ev of openaiDriver.stream(profile, { messages: [{ role: 'user', content: 'x' }] }, ctrl.signal)) {
        seen.push(ev);
        ctrl.abort();
      }
    };
    await expect(run()).rejects.toThrow();
    expect(seen).toEqual([{ type: 'delta', text: 'Hi' }]);
    server!.closeAllConnections();
  });
});
