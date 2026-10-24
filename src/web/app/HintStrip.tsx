import { bindingsFor, LAYOUTS, keyLabel } from '../commands/keymap.ts';
import { COMMAND_LABELS, HINT_COMMANDS } from '../commands/labels.ts';
import { mode } from '../commands/modes.ts';
import { showHintStrip } from './hints.ts';
import { layoutName } from './session.ts';

/** The first key bound to a command in a mode, for help text. */
export function keyFor(commandId: string, m = mode.value): string | null {
  const entry = bindingsFor(LAYOUTS[layoutName.value], m).find(([, id]) => id === commandId);
  return entry ? keyLabel(entry[0]) : null;
}

/** Five useful keys for the current mode. It shows for the first ten sessions. */
export function HintStrip() {
  if (!showHintStrip()) return null;
  const m = mode.value;
  return (
    <div class="hint-strip" aria-hidden="true">
      {HINT_COMMANDS[m].map((id) => {
        const key = keyFor(id, m);
        return key ? (
          <span key={id} class="hint">
            <kbd>{key}</kbd> {COMMAND_LABELS[id]}
          </span>
        ) : null;
      })}
      {(m === 'ASK' && (
        <span class="hint">
          <kbd>Shift+Enter</kbd> New line
        </span>
      )) ||
        ((m === 'NORMAL' || m === 'READER') && (
          <span class="hint">
            <kbd>?</kbd> All keys
          </span>
        ))}
    </div>
  );
}
