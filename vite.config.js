import { defineConfig } from 'vite';

export default defineConfig({
  // host: true binds 0.0.0.0, so the console is reachable at http://<this-machine-ip>:5173
  // from anything on the same network. Drop back to '127.0.0.1' to keep it local.
  server: { port: 5173, host: true, strictPort: true },
  preview: { port: 4173, host: true, strictPort: true },
  build: {
    target: 'es2020',
    // three.js is the bulk of the bundle and is intentionally shipped whole
    chunkSizeWarningLimit: 900,
  },
});
