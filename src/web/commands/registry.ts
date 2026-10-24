// The command registry. Every key binding names a command id; the handler does the work.
// Ids follow DESIGN.md 5.7, for example `cursor.next_paragraph` and `ask.preset:explain`.

export type CommandHandler = () => void | Promise<void>;

const handlers = new Map<string, CommandHandler>();

/** Registers a handler. A second registration of the same id replaces the first. Returns an unregister function. */
export function register(id: string, handler: CommandHandler): () => void {
  handlers.set(id, handler);
  return () => {
    if (handlers.get(id) === handler) handlers.delete(id);
  };
}

export function has(id: string): boolean {
  return handlers.has(id);
}

/** Runs a command. Returns false when no handler has the id. Errors go to `onError`. */
export function run(id: string): boolean {
  const handler = handlers.get(id);
  if (!handler) return false;
  try {
    const result = handler();
    if (result instanceof Promise) result.catch((err: unknown) => onError(id, err));
  } catch (err) {
    onError(id, err);
  }
  return true;
}

let onError: (id: string, err: unknown) => void = (id, err) => console.error(`command ${id} failed`, err);

export function setErrorHandler(fn: (id: string, err: unknown) => void): void {
  onError = fn;
}
