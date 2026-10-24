import { describe, expect, it } from 'vitest';
import { firstSentence, renderMarkdown } from '../../src/web/chat/markdown.ts';

const hasDom = typeof window !== 'undefined';

describe('markdown pipeline', () => {
  it('renders basic Markdown', () => {
    const html = renderMarkdown('**bold** and a list:\n\n- one\n- two');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<li>one</li>');
  });

  it('does not emit a script element', () => {
    const html = renderMarkdown('Hello <script>alert(1)</script> world');
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('&lt;script&gt;');
  });

  it('does not emit an element with an onerror attribute', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">');
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<[^>]+\sonerror=/i);
  });

  it('drops javascript: links', () => {
    const html = renderMarkdown('[click](javascript:alert(1))');
    expect(html).not.toContain('href="javascript:');
  });

  it.skipIf(!hasDom)('DOMPurify strips script and onerror from HTML', async () => {
    const { defaultSanitize } = await import('../../src/web/chat/markdown.ts');
    const out = defaultSanitize('<p>a<script>alert(1)</script><img src="x" onerror="alert(1)"></p>');
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toContain('onerror');
  });

  it('runs a custom sanitizer before the math goes in', () => {
    const seen: string[] = [];
    const html = renderMarkdown('Area $x^2$ here', (h) => {
      seen.push(h);
      return h;
    });
    expect(seen[0]).toContain('<span data-math="0"></span>');
    expect(seen[0]).not.toContain('katex');
    expect(html).toContain('class="katex"');
  });

  it('renders $x^2$ with KaTeX', () => {
    const html = renderMarkdown('The square $x^2$ grows.');
    expect(html).toContain('class="katex"');
    expect(html).toContain('<math');
    expect(html).not.toContain('$x^2$');
  });

  it('renders $$…$$ as display math, also over several lines', () => {
    expect(renderMarkdown('$$E = mc^2$$')).toContain('katex-display');
    expect(renderMarkdown('Before\n\n$$\n\\int_0^1 x\\,dx\n$$\n\nAfter')).toContain('katex-display');
  });

  it('keeps prices and code spans as text', () => {
    const html = renderMarkdown('It costs $5 and $10. Use `$x$` in code.');
    expect(html).not.toContain('katex');
    expect(html).toContain('$5 and $10');
    expect(html).toContain('<code>$x$</code>');
  });

  it('keeps an escaped dollar as text', () => {
    expect(renderMarkdown('a \\$x$ b')).not.toContain('katex');
  });

  it('cannot forge a math placeholder from the answer text', () => {
    const html = renderMarkdown('<span data-math="0"></span> and $y$');
    expect(html).toContain('&lt;span data-math');
    expect((html.match(/class="katex"/g) ?? []).length).toBe(1);
  });

  it('extracts the first sentence as plain text', () => {
    expect(firstSentence('**The passage** says that Z sums states. Then it goes on.')).toBe('The passage says that Z sums states.');
  });
});
