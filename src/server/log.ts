// Logging with key redaction (DESIGN.md 7.8). All server output goes through here.

let secrets: string[] = [];

export function setSecrets(values: string[]): void {
  secrets = values.filter((v) => v.length >= 8);
}

/** Remove known keys and common key shapes from a string. */
export function redact(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join('[redacted]');
  return out
    .replace(/(authorization["']?\s*[:=]\s*["']?bearer\s+)[^\s"',]+/gi, '$1[redacted]')
    .replace(/(x-api-key["']?\s*[:=]\s*["']?)[^\s"',]+/gi, '$1[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted]');
}

function fmt(args: unknown[]): string {
  return redact(
    args
      .map((a) => (a instanceof Error ? (a.stack ?? a.message) : typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' '),
  );
}

let quiet = false;
export function setQuiet(q: boolean): void {
  quiet = q;
}

export const log = {
  info: (...args: unknown[]): void => {
    if (!quiet) console.log(fmt(args));
  },
  warn: (...args: unknown[]): void => {
    if (!quiet) console.warn(fmt(args));
  },
  error: (...args: unknown[]): void => {
    console.error(fmt(args));
  },
};
