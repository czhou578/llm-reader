import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildConfig, loadSecretsFile, resolveKey, secretsLookupPath } from '../../src/server/config.ts';

// The secrets file keeps the API key out of the shell environment (README "Configuration").
describe('secrets file', () => {
  const dirs: string[] = [];
  const vars: string[] = [];
  afterEach(() => {
    for (const v of vars.splice(0)) delete process.env[v];
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tempFile = (body: string, mode = 0o600): string => {
    const dir = mkdtempSync(join(tmpdir(), 'lr-secrets-'));
    dirs.push(dir);
    const path = join(dir, 'secrets.env');
    writeFileSync(path, body);
    chmodSync(path, mode);
    return path;
  };

  it('sits next to the config file by default', () => {
    expect(secretsLookupPath({ LLM_READER_CONFIG: '/x/y/config.toml' })).toBe('/x/y/secrets.env');
    expect(secretsLookupPath({ LLM_READER_SECRETS: '/a/b.env' })).toBe('/a/b.env');
  });

  it('loads a key into process.env and a profile resolves it', () => {
    vars.push('LR_TEST_KEY_A');
    const path = tempFile('# comment\nLR_TEST_KEY_A=sk-test-123\n');
    const res = loadSecretsFile({ LLM_READER_SECRETS: path });
    expect(res).toEqual({ path, loaded: true });
    const config = buildConfig({ profiles: { claude: { provider: 'anthropic', model: 'claude-opus-5-5', api_key_env: 'LR_TEST_KEY_A', effort: 'medium' } }, roles: { strong: 'claude', fast: 'claude' } }, process.env);
    expect(resolveKey(config.profiles['claude']!)).toBe('sk-test-123');
    expect(config.profiles['claude']!.effort).toBe('medium');
  });

  it('does not override a variable that is already set', () => {
    vars.push('LR_TEST_KEY_B');
    process.env['LR_TEST_KEY_B'] = 'from-shell';
    loadSecretsFile({ LLM_READER_SECRETS: tempFile('LR_TEST_KEY_B=from-file\n') });
    expect(process.env['LR_TEST_KEY_B']).toBe('from-shell');
  });

  it('treats an empty value as no key', () => {
    vars.push('LR_TEST_KEY_C');
    loadSecretsFile({ LLM_READER_SECRETS: tempFile('LR_TEST_KEY_C=\n') });
    expect(resolveKey({ provider: 'anthropic', model: 'm', api_key_env: 'LR_TEST_KEY_C' })).toBeUndefined();
  });

  it('warns when other users can read the file, and reports a missing file', () => {
    vars.push('LR_TEST_KEY_D');
    const path = tempFile('LR_TEST_KEY_D=x\n', 0o644);
    expect(loadSecretsFile({ LLM_READER_SECRETS: path }).warning).toContain('chmod 600');
    expect(loadSecretsFile({ LLM_READER_SECRETS: path + '.missing' })).toEqual({ path: path + '.missing', loaded: false });
  });
});
