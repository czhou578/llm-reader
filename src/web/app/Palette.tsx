import { useLayoutEffect, useRef } from 'preact/hooks';
import { PALETTE_COMMANDS, paletteDraft } from './palette.ts';
import { paletteOpen } from './session.ts';

/** The `:` prompt. Enter runs, Tab completes, Esc closes; the dispatcher binds those keys. */
export function Palette() {
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => input.current?.focus(), []);
  if (!paletteOpen.value) return null;
  const word = paletteDraft.value.trim().split(/\s+/)[0] ?? '';
  const matches = PALETTE_COMMANDS.filter((c) => c.name.startsWith(word.toLowerCase()));
  return (
    <div class="palette" role="dialog" aria-label="Command prompt">
      <div class="palette-row">
        <span class="palette-colon">:</span>
        <input
          ref={input}
          value={paletteDraft.value}
          aria-label="Command"
          spellcheck={false}
          autocomplete="off"
          onInput={(e) => (paletteDraft.value = e.currentTarget.value)}
        />
      </div>
      <ul class="palette-list">
        {matches.map((c) => (
          <li key={c.name}>
            <code>{c.usage}</code> <span class="muted">{c.help}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
