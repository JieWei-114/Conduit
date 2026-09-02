import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5188,
    proxy: {
      // ws:true so the WebSocket-proxy endpoint upgrades through vite in dev
      '/api/ws': { target: 'ws://localhost:7788', ws: true },
      '/api': 'http://localhost:7788',
    },
  },
});
