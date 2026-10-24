import type { Context } from 'hono';
import type { ServerConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import { HttpError } from '../errors.ts';
import type { RunManager } from '../runs.ts';

/** What the route modules share. */
export interface AppDeps {
  config: ServerConfig;
  db: Db;
  runs: RunManager;
  /** ISO time of the server start; the "session" in the usage summary. */
  startedAt: string;
  /** The port the server listens on. Set after listen, because tests use port 0. */
  port: { value: number };
}

export async function readJson<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, 'bad_json', 'the request body must be JSON');
  }
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
