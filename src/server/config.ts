import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { AppConfig, ClientConfig, ProfileConfig, ProviderKind } from '../shared/types.ts';

// Loads the config (README "Configuration"). The file holds the NAME of a key variable, never a key.

/** Server-side profile: the shared ProfileConfig plus options that only the server reads. */
export interface ServerProfile extends ProfileConfig {
  /** Anthropic `output_config.effort`. Omitted from the request when unset. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface ServerConfig extends AppConfig {
  profiles: Record<string, ServerProfile>;
}

export interface LoadedConfig {
  config: ServerConfig;
  /** The config file that was read, or null when the built-in defaults apply. */
  path: string | null;
  /** The path that was looked up, also when no file exists there. */
  lookupPath: string;
}

export class ConfigError extends Error {}

const PROVIDERS: ProviderKind[] = ['anthropic', 'openai-compatible', 'mock'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

export function defaultProfiles(): Record<string, ServerProfile> {
  return {
    claude: {
      provider: 'anthropic',
      base_url: 'https://api.anthropic.com',
      model: 'claude-opus-5-5',
      api_key_env: 'ANTHROPIC_API_KEY',
    },
    local: { provider: 'openai-compatible', base_url: 'http://127.0.0.1:8000/v1', model: 'local' },
    mock: { provider: 'mock', model: 'mock-1' },
  };
}

export function configLookupPath(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['LLM_READER_CONFIG'];
  if (fromEnv) return resolve(expandHome(fromEnv));
  return join(homedir(), '.config', 'llm-reader', 'config.toml');
}

/** The secrets file: KEY=value lines. It sits next to the config file unless LLM_READER_SECRETS names another path. */
export function secretsLookupPath(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['LLM_READER_SECRETS'];
  if (fromEnv) return resolve(expandHome(fromEnv));
  return join(dirname(configLookupPath(env)), 'secrets.env');
}

export interface SecretsResult {
  path: string;
  loaded: boolean;
  /** Set when other users can read the file. */
  warning?: string;
}

/**
 * Load the secrets file into process.env. Only this process sees the values, so a key in the file does not reach
 * Claude Code or other tools in the shell. A variable that is already set in the environment wins over the file.
 */
export function loadSecretsFile(env: NodeJS.ProcessEnv = process.env): SecretsResult {
  const path = secretsLookupPath(env);
  if (!existsSync(path)) return { path, loaded: false };
  const result: SecretsResult = { path, loaded: true };
  if ((statSync(path).mode & 0o077) !== 0) result.warning = `${path} is readable by other users. Run: chmod 600 ${path}`;
  try {
    process.loadEnvFile(path);
  } catch (err) {
    throw new ConfigError(`cannot read ${path}: ${(err as Error).message}`);
  }
  return result;
}

/** Read and validate the config. A missing file gives the defaults; a broken file throws ConfigError. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const lookupPath = configLookupPath(env);
  let raw: Record<string, unknown> = {};
  let path: string | null = null;
  let text: string | null = null;
  try {
    text = readFileSync(lookupPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new ConfigError(`cannot read ${lookupPath}: ${String(err)}`);
  }
  if (text !== null) {
    try {
      raw = parseToml(text) as Record<string, unknown>;
    } catch (err) {
      throw new ConfigError(`${lookupPath}: ${(err as Error).message}`);
    }
    path = lookupPath;
  }
  return { config: buildConfig(raw, env, path ?? '<defaults>'), path, lookupPath };
}

/** Merge a parsed TOML object over the defaults. Exported for tests. */
export function buildConfig(raw: Record<string, unknown>, env: NodeJS.ProcessEnv, where = '<config>'): ServerConfig {
  const fail = (msg: string): never => {
    throw new ConfigError(`${where}: ${msg}`);
  };
  const table = (v: unknown, name: string): Record<string, unknown> => {
    if (v === undefined) return {};
    if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(`[${name}] must be a table`);
    return v as Record<string, unknown>;
  };
  const str = (v: unknown, name: string): string | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== 'string') fail(`${name} must be a string`);
    return v as string;
  };
  const num = (v: unknown, name: string): number | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${name} must be a number`);
    return v as number;
  };

  const profiles = defaultProfiles();
  for (const [name, value] of Object.entries(table(raw['profiles'], 'profiles'))) {
    const p = table(value, `profiles.${name}`);
    // Keys come only from the environment. A literal key in the file is an error, not a fallback.
    if ('api_key' in p) fail(`profiles.${name}.api_key is not supported; set api_key_env to the name of a variable`);
    const provider = str(p['provider'], `profiles.${name}.provider`) ?? fail(`profiles.${name}.provider is required`);
    if (!PROVIDERS.includes(provider as ProviderKind)) fail(`profiles.${name}.provider must be one of ${PROVIDERS.join(', ')}`);
    const model = str(p['model'], `profiles.${name}.model`) ?? (provider === 'mock' ? 'mock-1' : fail(`profiles.${name}.model is required`));
    const profile: ServerProfile = { provider: provider as ProviderKind, model };
    const baseUrl = str(p['base_url'], `profiles.${name}.base_url`);
    if (baseUrl) profile.base_url = baseUrl.replace(/\/+$/, '');
    else if (provider === 'anthropic') profile.base_url = 'https://api.anthropic.com';
    else if (provider === 'openai-compatible') fail(`profiles.${name}.base_url is required`);
    const keyEnv = str(p['api_key_env'], `profiles.${name}.api_key_env`);
    if (keyEnv) profile.api_key_env = keyEnv;
    else if (provider === 'anthropic') profile.api_key_env = 'ANTHROPIC_API_KEY';
    const maxTokens = num(p['max_tokens'], `profiles.${name}.max_tokens`);
    if (maxTokens !== undefined) profile.max_tokens = maxTokens;
    const effort = str(p['effort'], `profiles.${name}.effort`);
    if (effort !== undefined) {
      if (!EFFORTS.includes(effort)) fail(`profiles.${name}.effort must be one of ${EFFORTS.join(', ')}`);
      profile.effort = effort as ServerProfile['effort'];
    }
    if (p['pricing'] !== undefined) {
      const pr = table(p['pricing'], `profiles.${name}.pricing`);
      const pricing: NonNullable<ProfileConfig['pricing']> = {};
      for (const k of ['input', 'cache_read', 'output'] as const) {
        const v = num(pr[k], `profiles.${name}.pricing.${k}`);
        if (v !== undefined) pricing[k] = v;
      }
      profile.pricing = pricing;
    }
    profiles[name] = profile;
  }

  const fallbackRole = env['ANTHROPIC_API_KEY'] ? 'claude' : 'mock';
  const rolesRaw = table(raw['roles'], 'roles');
  const roles = {
    strong: str(rolesRaw['strong'], 'roles.strong') ?? fallbackRole,
    fast: str(rolesRaw['fast'], 'roles.fast') ?? fallbackRole,
  };
  for (const [role, name] of Object.entries(roles)) {
    if (!profiles[name]) fail(`roles.${role} names an unknown profile "${name}"`);
  }

  const serverRaw = table(raw['server'], 'server');
  const portEnv = env['PORT'] ? Number(env['PORT']) : undefined;
  const port = portEnv ?? num(serverRaw['port'], 'server.port') ?? 7777;
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`invalid port ${port}`);
  const bind = str(serverRaw['bind'], 'server.bind') ?? '127.0.0.1';
  // The security model assumes a loopback bind (DESIGN.md 7.8).
  if (bind !== '127.0.0.1' && bind !== 'localhost') fail('server.bind must be 127.0.0.1');

  const storageRaw = table(raw['storage'], 'storage');
  const dataDir = env['LLM_READER_DATA_DIR'] || str(storageRaw['data_dir'], 'storage.data_dir') || '~/.local/share/llm-reader';
  const booksDir = env['LLM_READER_BOOKS_DIR'] || str(storageRaw['books_dir'], 'storage.books_dir') || '~/books';

  const readerRaw = table(raw['reader'], 'reader');
  const notesRaw = table(raw['notes'], 'notes');
  const notesFile = str(notesRaw['file'], 'notes.file');

  const config: ServerConfig = {
    server: { bind: '127.0.0.1', port },
    roles,
    profiles,
    storage: { data_dir: resolve(expandHome(dataDir)), books_dir: resolve(expandHome(booksDir)) },
    reader: {
      profile: (str(readerRaw['profile'], 'reader.profile') ?? '').trim(),
      budget_tokens: num(readerRaw['budget_tokens'], 'reader.budget_tokens') ?? 6000,
    },
  };
  if (notesFile) config.notes = { file: resolve(expandHome(notesFile)) };
  return config;
}

/** The key for a profile, read from its environment variable. undefined when the profile has none. */
export function resolveKey(profile: ProfileConfig, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!profile.api_key_env) return undefined;
  const v = env[profile.api_key_env];
  return v ? v : undefined;
}

/** True when the profile can run: mock, a keyless local server, or a key that is set. */
export function hasKey(profile: ProfileConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  if (profile.provider === 'mock' || !profile.api_key_env) return true;
  return resolveKey(profile, env) !== undefined;
}

export function toClientConfig(config: ServerConfig, env: NodeJS.ProcessEnv = process.env): ClientConfig {
  const profiles: ClientConfig['profiles'] = {};
  for (const [name, p] of Object.entries(config.profiles)) {
    profiles[name] = { provider: p.provider, model: p.model, hasKey: hasKey(p, env) };
  }
  return { roles: config.roles, profiles, booksDir: config.storage.books_dir, readerProfile: config.reader.profile };
}

/** All key values known to the config, for log redaction. */
export function knownSecrets(config: ServerConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  const out = new Set<string>();
  for (const p of Object.values(config.profiles)) {
    const k = resolveKey(p, env);
    if (k && k.length >= 8) out.add(k);
  }
  return [...out];
}

