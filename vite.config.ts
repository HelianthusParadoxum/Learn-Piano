import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.API_URL || 'http://localhost:8000';

// `vite build --mode artifact` makes the edition published as a Claude artifact (no server; recognition by Claude)
export default defineConfig(({ mode }) => ({
  root: 'web',
  base: './',
  plugins: [react()],
  build: {
    outDir: mode === 'artifact' ? '../dist-artifact' : '../dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2500,
  },
  server: {
    port: 5173,
    proxy: { '/api': apiTarget },
  },
  test: {
    root: '.',
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
  },
}));
