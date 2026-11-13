/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TARGET?: 'web' | 'artifact';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** CDN URLs of third-party libraries (artifact edition only; empty strings in the web edition). */
declare const __CDN_OSMD__: string;
declare const __CDN_PDF_WORKER__: string;
declare const __CDN_PDF_WASM__: string;
