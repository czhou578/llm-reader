import { h, render } from 'preact';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// Scaffold entry. The viewer, commands, and chat panes from DESIGN.md go under src/web/.
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

async function main(): Promise<void> {
  const health = await fetch('/api/health').then((r) => r.json()).catch(() => null);
  render(
    h('main', null, [
      h('h1', null, 'llm-reader'),
      h('p', null, `PDF.js ${pdfjs.version}`),
      h('p', null, health ? `server ok (${health.node})` : 'server not reachable'),
    ]),
    document.getElementById('app')!,
  );
}

void main();
