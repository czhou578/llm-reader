import type { MiddlewareHandler } from 'hono';
import { HttpError } from './errors.ts';

// DNS-rebinding and cross-site checks (DESIGN.md 7.8). The session cookie is deferred to Phase 1.

const DEV_PORT = 5173; // the Vite dev server; its proxy keeps the browser's Host header

export function allowedHosts(port: number): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `127.0.0.1:${DEV_PORT}`, `localhost:${DEV_PORT}`]);
}

export function allowedOrigins(port: number): Set<string> {
  return new Set([...allowedHosts(port)].map((h) => `http://${h}`));
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function hostAndOriginCheck(port: { value: number }): MiddlewareHandler {
  return async (c, next) => {
    const host = (c.req.header('host') ?? '').toLowerCase();
    if (!allowedHosts(port.value).has(host)) throw new HttpError(403, 'bad_host', 'requests must use 127.0.0.1 or localhost');
    if (!SAFE_METHODS.has(c.req.method)) {
      // A browser sends Origin on every cross-site POST. No Origin means a non-browser client (curl, the CLI).
      const origin = c.req.header('origin');
      if (origin !== undefined && !allowedOrigins(port.value).has(origin.toLowerCase())) {
        throw new HttpError(403, 'bad_origin', 'cross-origin requests are not allowed');
      }
    }
    await next();
  };
}
