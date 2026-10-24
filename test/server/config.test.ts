import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildConfig, ConfigError, loadConfig, toClientConfig } from '../../src/server/config.ts';
import { redact, setSecrets } from '../../src/server/log.ts';
import { tempDir } from './helpers.ts';

describe('config', () => {
  const dirs: { cleanup: () => void }[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => d.cleanup()));

  it('uses the defaults with mock roles when no file and no key exist', () => {
    const tmp = tempDir();
    dirs.push(tmp);
    const { config, path } = loadConfig({ LLM_READER_CONFIG: join(tmp.path, 'missing.toml') });
    expect(path).toBeNull();
    expect(config.roles).toEqual({ strong: 'mock', fast: 'mock' });
    expect(Object.keys(config.profiles).sort()).toEqual(['claude', 'local', 'mock']);
    expect(config.profiles['claude']).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5', api_key_env: 'ANTHROPIC_API_KEY' });
    expect(config.profiles['local']).toMatchObject({ provider: 'openai-compatible', base_url: 'http://127.0.0.1:8000/v1' });
    expect(config.server).toEqual({ bind: '127.0.0.1', port: 7777 });
    expect(config.storage.data_dir).toBe(join(homedir(), '.local/share/llm-reader'));
    expect(config.storage.books_dir).toBe(join(homedir(), 'books'));
    expect(config.reader.budget_tokens).toBe(6000);
  });

  it('uses the claude profile when ANTHROPIC_API_KEY is set', () => {
    const config = buildConfig({}, { ANTHROPIC_API_KEY: 'sk-ant-test-0123456789' });
    expect(config.roles).toEqual({ strong: 'claude', fast: 'claude' });
  });

  it('parses a TOML file, expands ~, and applies env overrides', () => {
    const tmp = tempDir();
    dirs.push(tmp);
    const file = join(tmp.path, 'config.toml');
    writeFileSync(
      file,
      `[server]
port = 8123

[roles]
strong = "claude"
fast = "local"

[profiles.claude]
provider = "anthropic"
model = "claude-opus-5-5"
api_key_env = "MY_KEY"

[profiles.claude.pricing]
input = 4.0
cache_read = 0.2
output = 20.0

[profiles.local]
provider = "openai-compatible"
base_url = "http://127.0.0.1:8000/v1/"
model = "qwen"

[storage]
data_dir = "~/somewhere"
books_dir = "~/pdfs"

[reader]
profile = "  I am an engineer.  "
`,
    );
    const { config, path } = loadConfig({ LLM_READER_CONFIG: file, LLM_READER_BOOKS_DIR: '/srv/books' });
    expect(path).toBe(file);
    expect(config.server.port).toBe(8123);
    expect(config.roles).toEqual({ strong: 'claude', fast: 'local' });
    expect(config.profiles['claude']!.pricing).toEqual({ input: 4, cache_read: 0.2, output: 20 });
    expect(config.profiles['claude']!.base_url).toBe('https://api.anthropic.com');
    expect(config.profiles['local']!.base_url).toBe('http://127.0.0.1:8000/v1'); // trailing slash removed
    expect(config.profiles['mock']).toBeDefined(); // defaults stay available
    expect(config.storage.data_dir).toBe(join(homedir(), 'somewhere'));
    expect(config.storage.books_dir).toBe('/srv/books');
    expect(config.reader.profile).toBe('I am an engineer.');
  });

  it('rejects bad files with a ConfigError', () => {
    expect(() => buildConfig({ roles: { strong: 'nope' } }, {})).toThrow(ConfigError);
    expect(() => buildConfig({ profiles: { x: { provider: 'gemini', model: 'm' } } }, {})).toThrow(/provider/);
    expect(() => buildConfig({ profiles: { x: { provider: 'anthropic', model: 'm', api_key: 'sk-x' } } }, {})).toThrow(/api_key_env/);
    expect(() => buildConfig({ server: { bind: '0.0.0.0' } }, {})).toThrow(/bind/);
    const tmp = tempDir();
    dirs.push(tmp);
    const file = join(tmp.path, 'bad.toml');
    writeFileSync(file, 'this is = = not toml');
    expect(() => loadConfig({ LLM_READER_CONFIG: file })).toThrow(ConfigError);
  });

  it('gives the browser models and hasKey, never a key', () => {
    const env = { ANTHROPIC_API_KEY: 'sk-ant-secret-value-123456' };
    const client = toClientConfig(buildConfig({}, env), env);
    expect(client.profiles['claude']).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5', hasKey: true });
    expect(client.profiles['mock']!.hasKey).toBe(true);
    expect(JSON.stringify(client)).not.toContain('sk-ant-secret');
    expect(toClientConfig(buildConfig({}, {}), {}).profiles['claude']!.hasKey).toBe(false);
  });

  it('redacts keys in log text', () => {
    setSecrets(['super-secret-key-value']);
    expect(redact('key=super-secret-key-value')).toBe('key=[redacted]');
    expect(redact('Authorization: Bearer abc.def')).toBe('Authorization: Bearer [redacted]');
    expect(redact('"x-api-key": "zzz"')).toBe('"x-api-key": "[redacted]"');
    setSecrets([]);
  });
});
