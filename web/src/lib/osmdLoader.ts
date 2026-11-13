import type * as OSMD from 'opensheetmusicdisplay';
import { IS_ARTIFACT } from './platform';

let loading: Promise<typeof OSMD> | null = null;

/**
 * Loads OpenSheetMusicDisplay. The web edition bundles it; the artifact edition loads the library's
 * own file from the CDN as a classic script (it is a UMD bundle that registers a global).
 */
export function loadOsmd(): Promise<typeof OSMD> {
  if (loading) return loading;
  if (!IS_ARTIFACT) {
    loading = import('opensheetmusicdisplay');
    return loading;
  }
  loading = new Promise((resolve, reject) => {
    const existing = (globalThis as unknown as { opensheetmusicdisplay?: typeof OSMD }).opensheetmusicdisplay;
    if (existing) return resolve(existing);
    const script = document.createElement('script');
    script.src = __CDN_OSMD__;
    script.async = true;
    script.onload = () => {
      const lib = (globalThis as unknown as { opensheetmusicdisplay?: typeof OSMD }).opensheetmusicdisplay;
      if (lib) resolve(lib);
      else reject(new Error('OpenSheetMusicDisplay did not load'));
    };
    script.onerror = () => {
      loading = null;
      reject(new Error('Не удалось загрузить библиотеку нотной графики (нет связи с cdn.jsdelivr.net)'));
    };
    document.head.appendChild(script);
  });
  return loading;
}
