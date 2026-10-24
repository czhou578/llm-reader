import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// The SPA lives in src/web. In development, Vite serves it on 5173 and proxies /api to the server on 7777.
// changeOrigin sets the Host header to 127.0.0.1:7777, which the server's Host check accepts. The Origin header stays
// http://127.0.0.1:5173, which the server allows for state-changing requests. SSE streams pass through the proxy.
export default defineConfig({
  root: 'src/web',
  plugins: [preact()],
  build: { outDir: '../../dist', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      // The source folder src/web/api/ is also served under /api/ (for example /api/client.ts). Requests for .ts and
      // .tsx modules stay with Vite. All other /api/ requests go to the server.
      '^/api/(?!.*\\.tsx?(?:\\?|$))': { target: 'http://127.0.0.1:7777', changeOrigin: true, ws: false },
    },
  },
});
