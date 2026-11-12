import { useEffect, useState, useSyncExternalStore } from 'react';
import { player, type PlayerState } from './audio';

export function usePlayerState(): PlayerState {
  return useSyncExternalStore(player.subscribe, player.getState);
}

export interface Route {
  page: 'home' | 'piece';
  pieceId?: string;
  tab?: 'guide' | 'score' | 'pdf';
  step?: number;
}

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'piece' && parts[1]) {
    const tab = (parts[2] as Route['tab']) || 'guide';
    const step = parts[3] ? Math.max(1, parseInt(parts[3], 10) || 1) : undefined;
    return { page: 'piece', pieceId: decodeURIComponent(parts[1]), tab, step };
  }
  return { page: 'home' };
}

export function routeHash(r: Route): string {
  if (r.page === 'piece' && r.pieceId) {
    const base = `#/piece/${encodeURIComponent(r.pieceId)}/${r.tab ?? 'guide'}`;
    return r.tab === 'guide' || !r.tab ? `${base}/${r.step ?? 1}` : base;
  }
  return '#/';
}

export function navigate(r: Route) {
  const h = routeHash(r);
  if (location.hash !== h) location.hash = h;
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

/** useState that remembers its value in localStorage (shared across blocks and pieces). */
export function usePersistentState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem('lp:' + key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = (v: T) => {
    setValue(v);
    try {
      localStorage.setItem('lp:' + key, JSON.stringify(v));
    } catch {
      /* quota / private mode */
    }
  };
  return [value, set];
}
