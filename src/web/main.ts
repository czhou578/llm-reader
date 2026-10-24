// Boot: render the shell, fetch the config, then show the document from `?doc=<id>` or the library.
import './styles/app.css';
import { h, render } from 'preact';
import * as api from './api/client.ts';
import { App } from './app/App.tsx';
import { registerCommands } from './app/commands.ts';
import { countSession } from './app/hints.ts';
import { route } from './app/router.ts';
import { bootError, config, layoutName, view } from './app/session.ts';
import { installDispatcher } from './commands/dispatcher.ts';

async function boot(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) throw new Error('index.html has no #app element');
  render(h(App, null), root);

  countSession();
  registerCommands();
  installDispatcher({ layout: () => layoutName.value, active: () => view.value === 'reader' });
  window.addEventListener('popstate', () => void route());

  try {
    config.value = await api.getConfig();
  } catch (err) {
    bootError.value = `The server is not reachable: ${err instanceof Error ? err.message : String(err)}`;
    view.value = 'error';
    return;
  }
  await route();
}

void boot();
