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

/**
 * Routes live in the URL hash as plain names (letters, digits, hyphens), so that they also work
 * inside a Claude artifact page, where only "#name" hashes pass between the page and its link:
 *   #home · #piece-<id>-step-<n> · #piece-<id>-score · #piece-<id>-original
 */
export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#/, '');
  const m = /^piece-([a-z0-9-]+?)-(step-(\d+)|score|original)$/i.exec(h);
  if (m) {
    const tab: Route['tab'] = m[2] === 'score' ? 'score' : m[2] === 'original' ? 'pdf' : 'guide';
    return { page: 'piece', pieceId: m[1], tab, step: m[3] ? Math.max(1, parseInt(m[3], 10) || 1) : undefined };
  }
  // links from the first version: #/piece/<id>/guide/3
  const parts = h.replace(/^\//, '').split('/').filter(Boolean);
  if (parts[0] === 'piece' && parts[1]) {
    const tab = (parts[2] as Route['tab']) || 'guide';
    const step = parts[3] ? Math.max(1, parseInt(parts[3], 10) || 1) : undefined;
    return { page: 'piece', pieceId: decodeURIComponent(parts[1]), tab, step };
  }
  return { page: 'home' };
}

export function routeHash(r: Route): string {
  if (r.page === 'piece' && r.pieceId) {
    if (r.tab === 'score') return `#piece-${r.pieceId}-score`;
    if (r.tab === 'pdf') return `#piece-${r.pieceId}-original`;
    return `#piece-${r.pieceId}-step-${r.step ?? 1}`;
  }
  return '#home';
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
