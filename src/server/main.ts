import { existsSync, readFileSync, realpathSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { knownSecrets, loadConfig, loadSecretsFile, type ServerConfig } from './config.ts';
import { openDb } from './db/index.ts';
import { markInterrupted } from './db/repo.ts';
import { HttpError } from './errors.ts';
import { defaultDrivers, type Drivers } from './llm/index.ts';
import { log, setQuiet, setSecrets } from './log.ts';
import { docRoutes } from './routes/docs.ts';
import type { AppDeps } from './routes/deps.ts';
import { metaRoutes } from './routes/meta.ts';
import { threadRoutes } from './routes/threads.ts';
import { RunManager, type RunManagerOptions } from './runs.ts';
import { hostAndOriginCheck } from './security.ts';

export type { AppDeps } from './routes/deps.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DIST_DIR = join(REPO_ROOT, 'dist');

export function hasDist(): boolean {
  return existsSync(join(DIST_DIR, 'index.html'));
}

export interface AppOptions {
  distDir?: string | null; // null turns static serving off; default: dist/ when it exists
  pingMs?: number;
}

/** The Hono app with all routes. Static `dist/` serving is on when the directory has an index.html. */
export function createApp(deps: AppDeps, opts: AppOptions = {}): Hono {
  const app = new Hono();
  app.use('*', hostAndOriginCheck(deps.port));

  app.route('/api', metaRoutes(deps));
  app.route('/api', docRoutes(deps));
  app.route('/api', threadRoutes(deps, opts.pingMs !== undefined ? { pingMs: opts.pingMs } : {}));
  app.all('/api/*', () => {
    throw new HttpError(404, 'not_found', 'no such API route');
  });

  const distDir = opts.distDir === undefined ? (hasDist() ? DIST_DIR : null) : opts.distDir;
  if (distDir) {
    app.use('/*', serveStatic({ root: distDir }));
    // SPA fallback: unknown non-API paths get index.html.
    const indexHtml = join(distDir, 'index.html');
    app.get('*', (c) => c.html(readFileSync(indexHtml, 'utf8')));
  }

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'not found' } }, 404));
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message } }, err.status);
    log.error(`${c.req.method} ${c.req.path} failed`, err);
    return c.json({ error: { code: 'internal', message: 'internal server error' } }, 500);
  });
  return app;
}

export interface StartOptions {
  config?: ServerConfig; // default: loadConfig()
  port?: number; // default: config.server.port; 0 picks a free port
  drivers?: Partial<Drivers>;
  runOptions?: RunManagerOptions;
  app?: AppOptions;
  quiet?: boolean;
}

export interface RunningServer {
  url: string;
  port: number;
  deps: AppDeps;
  app: Hono;
  close(): Promise<void>;
}

/** Open the store, mark stale runs interrupted, and listen on 127.0.0.1. */
export async function startServer(opts: StartOptions = {}): Promise<RunningServer> {
  if (opts.quiet) setQuiet(true);
  // A caller that passes a config (the tests) controls the environment itself.
  if (!opts.config) {
    const secrets = loadSecretsFile();
    if (secrets.warning) log.warn(secrets.warning);
    else if (secrets.loaded) log.info(`secrets loaded from ${secrets.path}`);
  }
  const config = opts.config ?? loadConfig().config;
  setSecrets(knownSecrets(config));
  const db = openDb(config.storage.data_dir);
  const stale = markInterrupted(db);
  if (stale) log.info(`marked ${stale} unfinished answer(s) as interrupted`);
  const drivers = { ...defaultDrivers(), ...opts.drivers };
  const runs = new RunManager(db, config, drivers, opts.runOptions);
  const deps: AppDeps = { config, db, runs, startedAt: new Date().toISOString(), port: { value: opts.port ?? config.server.port } };
  const app = createApp(deps, opts.app);

  const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const s = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: deps.port.value }, () => resolve(s));
    s.once('error', reject);
  });
  deps.port.value = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${deps.port.value}`;
  log.info(`llm-reader server on ${url} (data: ${config.storage.data_dir})`);

  return {
    url,
    port: deps.port.value,
    deps,
    app,
    close: async () => {
      await runs.shutdown();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Open SSE streams would hold close() forever.
        if ('closeAllConnections' in server) server.closeAllConnections();
      });
      db.close();
    },
  };
}

/** Start from the command line and close cleanly on SIGINT or SIGTERM. */
export async function runCli(): Promise<void> {
  let running: RunningServer;
  try {
    running = await startServer();
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const stop = (): void => {
    void running.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMain()) void runCli();
