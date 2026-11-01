import type { MiddlewareHandler } from 'hono';
import { HttpError } from './errors.ts';

// DNS-rebinding and cross-site checks (DESIGN.md 7.8). The session cookie is deferred to Phase 1.

const DEV_PORT = 5173; // the Vite dev server; its proxy keeps the browser's Host header

export function allowedHosts(port: number): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `127.0.0.1:${DEV_PORT}`, `localhost:${DEV_PORT}`]);
}

// A page on the user's own machine, on any port. VS Code port forwarding often lands the app on another local port,
// and the browser then sends that port in Origin. Other websites are still refused.
const LOOPBACK_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;

/** True for an Origin header that names a page on this machine. */
export function isLoopbackOrigin(origin: string): boolean {
  return LOOPBACK_ORIGIN.test(origin);
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function hostAndOriginCheck(port: { value: number }): MiddlewareHandler {
  return async (c, next) => {
    const host = (c.req.header('host') ?? '').toLowerCase();
    if (!allowedHosts(port.value).has(host)) throw new HttpError(403, 'bad_host', 'requests must use 127.0.0.1 or localhost');
    if (!SAFE_METHODS.has(c.req.method)) {
      // A browser sends Origin on every cross-site POST. No Origin means a non-browser client (curl, the CLI).
      const origin = c.req.header('origin');
      if (origin !== undefined && !isLoopbackOrigin(origin)) {
        throw new HttpError(403, 'bad_origin', 'cross-origin requests are not allowed: open the app from localhost or 127.0.0.1');
      }
    }
    await next();
  };
}
