/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TARGET?: 'web' | 'artifact';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
