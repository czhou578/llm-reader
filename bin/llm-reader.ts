#!/usr/bin/env -S npx tsx
// llm-reader CLI: `serve`, `open <path>`, `doctor`. Run as `pnpm llm-reader <cmd>`.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { ConfigError, expandHome, hasKey, loadConfig, loadSecretsFile, type SecretsResult } from '../src/server/config.ts';
import { hasDist, runCli } from '../src/server/main.ts';

const USAGE = `usage: llm-reader <command>

commands:
  serve          start the server on 127.0.0.1 (port from the config, or PORT)
  open <path>    open a PDF in the running server and print its URL
  doctor         print the config path, the data dir, and the profiles`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  // `serve` loads the secrets file again in startServer. A second load changes nothing.
  const secrets = loadSecretsFile();
  if (secrets.warning) console.warn(secrets.warning);
  switch (cmd) {
    case 'serve':
      await runCli();
      return -1; // keep running
    case 'open':
      return open(args[0]);
    case 'doctor':
      return doctor(secrets);
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      console.log(USAGE);
      return cmd === undefined ? 1 : 0;
    default:
      console.error(`unknown command: ${cmd}\n\n${USAGE}`);
      return 1;
  }
}

async function open(path: string | undefined): Promise<number> {
  if (!path) {
    console.error('usage: llm-reader open <path.pdf>');
    return 1;
  }
  const { config } = loadConfig();
  // The server takes only absolute paths, so resolve here. pnpm runs scripts in the package root
  // and puts the shell's directory in INIT_CWD.
  const abs = resolve(process.env['INIT_CWD'] ?? process.cwd(), expandHome(path));
  const api = `http://127.0.0.1:${config.server.port}/api`;
  let res: Response;
  try {
    res = await fetch(`${api}/docs/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: abs }),
    });
  } catch {
    console.error(`the server is not running on 127.0.0.1:${config.server.port}. Start it with \`pnpm dev\` or \`pnpm llm-reader serve\`.`);
    return 1;
  }
  const body = (await res.json().catch(() => null)) as { id?: string; title?: string; error?: { message: string } } | null;
  if (!res.ok || !body?.id) {
    console.error(`cannot open ${abs}: ${body?.error?.message ?? res.statusText}`);
    return 1;
  }
  // dist/ means `pnpm start`: the server serves the app. Otherwise the app is on the Vite dev server.
  const origin = hasDist() ? `http://127.0.0.1:${config.server.port}` : 'http://127.0.0.1:5173';
  const url = `${origin}/?doc=${body.id}`;
  console.log(`${body.title ?? abs}\n${url}`);
  try {
    const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined); // no xdg-open: the printed URL is enough
    child.unref();
  } catch {
    // ignore
  }
  return 0;
}

function doctor(secrets: SecretsResult): number {
  const loaded = loadConfig();
  const { config } = loaded;
  console.log(`config:    ${loaded.path ?? `${loaded.lookupPath} (not found; built-in defaults)`}`);
  console.log(`secrets:   ${secrets.path} (${secrets.loaded ? 'loaded' : 'not found'})`);
  console.log(`data dir:  ${config.storage.data_dir}`);
  console.log(`books dir: ${config.storage.books_dir}`);
  console.log(`server:    http://127.0.0.1:${config.server.port}`);
  console.log(`roles:     strong=${config.roles.strong} fast=${config.roles.fast}`);
  console.log('profiles:');
  for (const [name, p] of Object.entries(config.profiles)) {
    const key = p.provider === 'mock' ? 'no key needed' : p.api_key_env ? `${p.api_key_env} ${hasKey(p) ? 'set' : 'NOT SET'}` : 'no key';
    const effort = p.effort ? ` effort=${p.effort}` : '';
    console.log(`  ${name.padEnd(10)} ${p.provider.padEnd(18)} ${p.model}${effort}  (${key})`);
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (err) => {
    console.error(err instanceof ConfigError ? err.message : err);
    process.exitCode = 1;
  },
);
