import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // The three.js addons (SVGLoader, Line2, CSS2DRenderer) deep-import `three`; without deduping,
  // Vite resolves those to a second module instance ("Multiple instances of Three.js") which can
  // break instanceof across the boundary. Pin every `three` import to one copy.
  resolve: { dedupe: ['three'] },
  server: {
    port: 5174,
    proxy: { '/api': 'http://localhost:8787' },
  },
});
