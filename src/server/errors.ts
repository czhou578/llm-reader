import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** An error with an HTTP status and a stable code. The app turns it into `{ error: { code, message } }`. */
export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what: string): HttpError => new HttpError(404, 'not_found', `${what} not found`);
export const badRequest = (message: string): HttpError => new HttpError(400, 'bad_request', message);
