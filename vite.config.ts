import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// The SPA lives in src/web. In development, Vite serves it on 5173 and proxies /api to the server on 7777.
export default defineConfig({
  root: 'src/web',
  plugins: [preact()],
  build: { outDir: '../../dist', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:7777' },
  },
});
