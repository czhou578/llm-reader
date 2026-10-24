import { describe, expect, it } from 'vitest';
import { keyDescriptor, LAYOUTS, resolveKey, type KeyLike } from '../../src/web/commands/keymap.ts';
import type { Mode } from '../../src/web/commands/modes.ts';

const left = LAYOUTS.left;
const key = (k: string, extra: Partial<KeyLike> = {}): KeyLike => ({ key: k, ...extra });

describe('resolveKey, left layout', () => {
  const cases: [Mode, KeyLike, string | null][] = [
    ['NORMAL', key(' '), 'cursor.next_paragraph'],
    ['NORMAL', key('q'), 'cursor.prev_paragraph'],
    ['NORMAL', key('s'), 'cursor.next_sentence'],
    ['NORMAL', key('w'), 'cursor.prev_sentence'],
    ['NORMAL', key('d'), 'selection.extend'],
    ['NORMAL', key('a'), 'selection.shrink'],
    ['NORMAL', key('p'), 'selection.toggle_paragraph'],
    ['NORMAL', key('Enter'), 'ask.preset:explain'],
    ['NORMAL', key('e'), 'ask.preset:explain'],
    ['NORMAL', key('c'), 'ask.preset:define'],
    ['NORMAL', key('v'), 'ask.open'],
    ['NORMAL', key('.'), 'ask.repeat'],
    ['NORMAL', key('r'), 'ask.regenerate'],
    ['NORMAL', key('Escape'), 'app.back'],
    ['NORMAL', key('Tab'), 'focus.toggle_pane'],
    ['NORMAL', key('\\'), 'pane.toggle'],
    ['NORMAL', key("'"), 'position.jump_back'],
    ['NORMAL', key('?', { shiftKey: true }), 'help.toggle'],
    ['NORMAL', key(':', { shiftKey: true }), 'palette.open'],
    ['NORMAL', key('='), 'view.zoom_in'],
    ['NORMAL', key('-'), 'view.zoom_out'],
    ['NORMAL', key('o', { ctrlKey: true }), 'library.upload'],
    ['READER', key('s'), 'reader.scroll_down'],
    ['READER', key('w'), 'reader.scroll_up'],
    ['READER', key(' '), 'reader.page_down'],
    ['READER', key('q'), 'reader.page_up'],
    ['READER', key(']'), 'reader.next_message'],
    ['READER', key('['), 'reader.prev_message'],
    ['READER', key('y'), 'reader.copy_thread'],
    ['READER', key('Escape'), 'app.back'],
    ['READER', key('Tab'), 'focus.toggle_pane'],
    ['READER', key('e'), 'ask.preset:explain'],
    ['READER', key('c'), 'ask.preset:define'],
    ['READER', key('d'), null],
    ['ASK', key('Enter', { inTextInput: true }), 'ask.send'],
    ['ASK', key('Tab', { inTextInput: true }), 'ask.toggle_target'],
    ['ASK', key('Escape', { inTextInput: true }), 'ask.cancel'],
    ['PALETTE', key('Enter', { inTextInput: true }), 'palette.run'],
    ['PALETTE', key('Escape', { inTextInput: true }), 'palette.close'],
  ];
  it.each(cases)('%s %o → %s', (mode, ev, expected) => {
    expect(resolveKey(left, mode, ev)).toBe(expected);
  });
});

describe('resolveKey rules', () => {
  it('treats letters as text in ASK and PALETTE', () => {
    for (const k of ['s', 'e', 'c', 'v', ' ', 'q', '.', 'r']) {
      expect(resolveKey(left, 'ASK', key(k, { inTextInput: true }))).toBeNull();
      expect(resolveKey(left, 'PALETTE', key(k, { inTextInput: true }))).toBeNull();
    }
  });

  it('leaves Shift+Enter to the textarea in ASK mode', () => {
    expect(resolveKey(left, 'ASK', key('Enter', { shiftKey: true, inTextInput: true }))).toBeNull();
  });

  it('ignores every key in NORMAL and READER while a text input has focus', () => {
    expect(resolveKey(left, 'NORMAL', key('s', { inTextInput: true }))).toBeNull();
    expect(resolveKey(left, 'NORMAL', key('Enter', { inTextInput: true }))).toBeNull();
    expect(resolveKey(left, 'READER', key('y', { inTextInput: true }))).toBeNull();
  });

  it('ignores auto-repeat for presets and asks, but not for movement', () => {
    expect(resolveKey(left, 'NORMAL', key('Enter', { repeat: true }))).toBeNull();
    expect(resolveKey(left, 'NORMAL', key('c', { repeat: true }))).toBeNull();
    expect(resolveKey(left, 'NORMAL', key('v', { repeat: true }))).toBeNull();
    expect(resolveKey(left, 'NORMAL', key('.', { repeat: true }))).toBeNull();
    expect(resolveKey(left, 'READER', key('e', { repeat: true }))).toBeNull();
    expect(resolveKey(left, 'ASK', key('Enter', { repeat: true, inTextInput: true }))).toBeNull();
    expect(resolveKey(left, 'NORMAL', key('s', { repeat: true }))).toBe('cursor.next_sentence');
    expect(resolveKey(left, 'NORMAL', key(' ', { repeat: true }))).toBe('cursor.next_paragraph');
    expect(resolveKey(left, 'READER', key('s', { repeat: true }))).toBe('reader.scroll_down');
  });

  it('does not take browser shortcuts or shifted letters', () => {
    expect(resolveKey(left, 'NORMAL', key('c', { ctrlKey: true }))).toBeNull();
    expect(resolveKey(left, 'NORMAL', key('r', { metaKey: true }))).toBeNull();
    expect(resolveKey(left, 'NORMAL', key('S', { shiftKey: true }))).toBeNull();
  });

  it('ignores keys during IME composition', () => {
    expect(resolveKey(left, 'ASK', key('Enter', { isComposing: true, inTextInput: true }))).toBeNull();
  });

  it('builds key descriptors', () => {
    expect(keyDescriptor(key('?', { shiftKey: true }))).toBe('?');
    expect(keyDescriptor(key('Enter', { shiftKey: true }))).toBe('Shift+Enter');
    expect(keyDescriptor(key('O', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+o');
  });
});

describe('home layout', () => {
  const home = LAYOUTS.home;
  it('maps the vim-style keys of DESIGN.md 5.7', () => {
    expect(resolveKey(home, 'NORMAL', key('j'))).toBe('cursor.next_sentence');
    expect(resolveKey(home, 'NORMAL', key('k'))).toBe('cursor.prev_sentence');
    expect(resolveKey(home, 'NORMAL', key('b'))).toBe('cursor.prev_paragraph');
    expect(resolveKey(home, 'NORMAL', key('l'))).toBe('selection.extend');
    expect(resolveKey(home, 'NORMAL', key('d'))).toBe('ask.preset:define');
    expect(resolveKey(home, 'NORMAL', key('a'))).toBe('ask.open');
    expect(resolveKey(home, 'NORMAL', key('c'))).toBe('run.cancel');
    expect(resolveKey(home, 'READER', key('j'))).toBe('reader.scroll_down');
  });
});
