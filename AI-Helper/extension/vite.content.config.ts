import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  // ASCII-only output: Chrome refuses content scripts containing raw U+FFFF etc.
  esbuild: { charset: 'ascii' },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'chrome114',
    sourcemap: true,
    lib: {
      entry: resolve(__dirname, 'src/content/index.ts'),
      name: 'AITestSolverContent',
      formats: ['iife'],
      fileName: () => 'content.js',
    },
  },
});
