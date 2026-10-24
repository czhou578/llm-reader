import { bindingsFor, LAYOUTS, keyLabel } from '../commands/keymap.ts';
import { COMMAND_LABELS, CORE_COMMANDS } from '../commands/labels.ts';
import type { Mode } from '../commands/modes.ts';
import { helpOpen, layoutName } from './session.ts';
import { keepFocus } from './StatusLine.tsx';

/** The keys of a mode, grouped by command id: Map("ask.preset:explain" → "Enter, e"). */
function keysByCommand(m: Mode): Map<string, string> {
  const byCommand = new Map<string, string[]>();
  for (const [key, id] of bindingsFor(LAYOUTS[layoutName.value], m)) {
    if (key === 'Shift+Tab') continue;
    byCommand.set(id, [...(byCommand.get(id) ?? []), keyLabel(key)]);
  }
  return new Map([...byCommand].map(([id, keys]) => [id, keys.join(', ')]));
}

function KeyTable({ title, keys, ids }: { title: string; keys: Map<string, string>; ids: string[] }) {
  return (
    <section>
      <h3>{title}</h3>
      <dl>
        {ids.map((id) => (
          <div key={id} class="key-row">
            <dt>
              <kbd>{keys.get(id)}</kbd>
            </dt>
            <dd>{COMMAND_LABELS[id] ?? id}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** `?` toggles this card. It lists the ten core keys first, then the other keys by mode. */
export function CheatCard() {
  if (!helpOpen.value) return null;
  const normal = keysByCommand('NORMAL');
  const reader = keysByCommand('READER');
  const ask = keysByCommand('ASK');
  const core = CORE_COMMANDS.filter((id) => normal.has(id));
  const more = [...normal.keys()].filter((id) => !core.includes(id));
  return (
    <div class="cheat-card" role="dialog" aria-label="Keys">
      <header>
        <h2>Keys · {layoutName.value} layout</h2>
        <span class="muted">? or Esc closes · type :layout home for the vim-style layout</span>
        <button type="button" class="cheat-close" aria-label="Close" title="Close (Esc)" onMouseDown={keepFocus} onClick={() => (helpOpen.value = false)}>
          ×
        </button>
      </header>
      <div class="cheat-columns">
        <KeyTable title="The core loop" keys={normal} ids={core} />
        <KeyTable title="More keys (PDF)" keys={normal} ids={more} />
        <KeyTable title="Answer pane (READER)" keys={reader} ids={[...reader.keys()]} />
        <KeyTable title="Ask box (Shift+Enter adds a line)" keys={ask} ids={[...ask.keys()]} />
      </div>
      <p class="muted cheat-mouse">
        Mouse: point at text, then press <kbd>s</kbd> for its sentence, <kbd>Space</kbd> for its paragraph, or{' '}
        <kbd>d</kbd> to extend the selection to it. No click is needed. A click selects a sentence, and a triple-click
        selects its paragraph.
      </p>
    </div>
  );
}
