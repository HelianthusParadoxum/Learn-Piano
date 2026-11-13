import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const apiTarget = process.env.API_URL || 'http://localhost:8000';

/**
 * The artifact edition (`vite build --mode artifact`) is published as a Claude artifact page. It
 * contains only this project's own code: third-party libraries are loaded, unmodified, from the
 * package files on cdn.jsdelivr.net (pinned to the installed versions) through an import map, and
 * React is replaced by Preact's compatible build, which ships browser-ready ES modules.
 */
function cdnUrls() {
  const version = (pkg: string) => JSON.parse(readFileSync(`node_modules/${pkg}/package.json`, 'utf8')).version as string;
  const jsd = (pkg: string, path: string) => `https://cdn.jsdelivr.net/npm/${pkg}@${version(pkg)}/${path}`;
  return {
    imports: {
      react: jsd('preact', 'compat/dist/compat.mjs'),
      'react-dom/client': jsd('preact', 'compat/client.mjs'),
      'react/jsx-runtime': jsd('preact', 'jsx-runtime/dist/jsxRuntime.mjs'),
      preact: jsd('preact', 'dist/preact.mjs'),
      'preact/hooks': jsd('preact', 'hooks/dist/hooks.mjs'),
      'preact/compat': jsd('preact', 'compat/dist/compat.mjs'),
      fflate: jsd('fflate', 'esm/browser.js'),
      'pdfjs-dist': jsd('pdfjs-dist', 'build/pdf.min.mjs'),
    },
    osmd: jsd('opensheetmusicdisplay', 'build/opensheetmusicdisplay.min.js'),
    pdfWorker: jsd('pdfjs-dist', 'build/pdf.worker.min.mjs'),
    pdfWasm: jsd('pdfjs-dist', 'wasm/'),
  };
}

/** In the artifact edition the bundled pdf.js worker is not used (the CDN copy is): emit nothing for it. */
function noBundledPdfWorker(): Plugin {
  return {
    name: 'no-bundled-pdf-worker',
    enforce: 'pre',
    resolveId(id) {
      if (id.startsWith('pdfjs-dist/build/pdf.worker')) return '\0empty-pdf-worker';
      return null;
    },
    load(id) {
      return id === '\0empty-pdf-worker' ? 'export default "";' : null;
    },
  };
}

function importMap(imports: Record<string, string>): Plugin {
  return {
    name: 'cdn-import-map',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) =>
        html.replace('<head>', `<head>\n    <script type="importmap">${JSON.stringify({ imports }, null, 1)}</script>`),
    },
  };
}

export default defineConfig(({ mode }) => {
  const artifact = mode === 'artifact';
  const cdn = artifact ? cdnUrls() : null;
  return {
    root: 'web',
    base: './',
    plugins: [react(), ...(cdn ? [importMap(cdn.imports), noBundledPdfWorker()] : [])],
    // the web edition serves piano samples and pdf.js decoders from web/public; the artifact edition ships no binaries
    publicDir: artifact ? false : 'public',
    define: {
      __CDN_OSMD__: JSON.stringify(cdn?.osmd ?? ''),
      __CDN_PDF_WORKER__: JSON.stringify(cdn?.pdfWorker ?? ''),
      __CDN_PDF_WASM__: JSON.stringify(cdn?.pdfWasm ?? ''),
    },
    build: {
      outDir: artifact ? '../dist-artifact' : '../dist',
      emptyOutDir: true,
      chunkSizeWarningLimit: 2500,
      // readable output for the published page
      minify: !artifact,
      // OpenSheetMusicDisplay is a UMD file loaded with a <script> tag (see osmdLoader.ts)
      rollupOptions: cdn ? { external: [...Object.keys(cdn.imports), 'opensheetmusicdisplay'] } : undefined,
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
  };
});
