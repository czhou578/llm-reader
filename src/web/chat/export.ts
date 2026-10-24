// A thread as Markdown, for `y` in READER mode. v0 has no notes file, so the text goes to the clipboard.
import type { Thread } from '../../shared/types.ts';
import { pageLabel, PRESET_LABEL } from '../app/target.ts';

export function threadToMarkdown(thread: Thread, number: number, docTitle?: string): string {
  const head = [`#${number}`, pageLabel(thread.location), thread.location.section, docTitle].filter(Boolean).join(' · ');
  const out = [`## ${head}`, '', ...thread.passage.text.split('\n').map((line) => `> ${line}`), ''];
  for (const m of thread.messages) {
    if (m.role === 'user') {
      const label = m.preset && m.preset !== 'ask' ? PRESET_LABEL[m.preset] : null;
      out.push(label ? `**${label}**` : `**Q:** ${m.content}`, '');
    } else {
      out.push(m.content.trim() || '_(no answer)_', '');
    }
  }
  return out.join('\n').trimEnd() + '\n';
}
