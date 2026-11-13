/**
 * Where the app runs.
 *  - "web": served by our own Node server (server/server.mjs) — PDF recognition with Audiveris.
 *  - "artifact": published as a Claude artifact page (a shareable claude.ai link). There is no server:
 *    PDFs are recognized by Claude itself through the page's `sample` capability, and files are
 *    saved through the `downloads` capability.
 */
export const IS_ARTIFACT = import.meta.env.VITE_TARGET === 'artifact';

type Use = (name: string) => Promise<unknown>;

function claudeUse(): Use | null {
  const c = (window as unknown as { claude?: { use?: Use } }).claude;
  return c && typeof c.use === 'function' ? c.use.bind(c) : null;
}

/** Resolves a capability namespace of the artifact runtime, or null when unavailable. */
export async function useCapability<T>(name: string): Promise<T | null> {
  const use = claudeUse();
  if (!use) return null;
  try {
    return ((await use(name)) as T | null) ?? null;
  } catch {
    return null;
  }
}

interface Downloads {
  save(file: { filename: string; data: Blob | string }): Promise<unknown>;
}

/** Offers a file to the viewer. Returns false when the platform refused or the viewer declined. */
export async function saveFile(filename: string, content: string, type: string): Promise<boolean> {
  if (IS_ARTIFACT) {
    const downloads = await useCapability<Downloads>('downloads');
    if (!downloads) return false;
    try {
      await downloads.save({ filename, data: new Blob([content], { type }) });
      return true;
    } catch {
      return false;
    }
  }
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
