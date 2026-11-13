/** Local library of pieces, stored in IndexedDB (everything stays in the browser). */
import { DEFAULT_SETTINGS, type PieceSettings } from './model';

export interface PieceRecord {
  id: string;
  title: string;
  composer: string;
  createdAt: number;
  updatedAt: number;
  sourceName: string;
  sourceType: 'pdf' | 'musicxml' | 'example' | 'image';
  /** MusicXML of the piece (recognized or uploaded, with the user's note fixes), without generated fingering. */
  musicXml: string;
  /** The recognized MusicXML before the first note fix (to undo all fixes). */
  recognizedXml?: string;
  /** Number of note fixes made in the app. */
  noteEdits?: number;
  pdf?: Blob;
  /** Rendered pages of the original (artifact edition: a PDF cannot be shown in the sandboxed page). */
  pages?: Blob[];
  /** How the notes were recognized. */
  recognizer?: 'audiveris' | 'claude';
  settings: PieceSettings;
  /** note.key → finger chosen by the user */
  overrides: Record<string, number>;
  /** learned blocks, keyed by measure range "start-end" */
  learned: string[];
  lastBlock?: number;
  measureCount?: number;
  blockCount?: number;
}

const DB_NAME = 'learn-piano';
const STORE = 'pieces';
let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * When IndexedDB is missing or refuses to work (private mode, a sandboxed frame), pieces are kept in
 * memory for the current visit only. `storageIsPersistent()` lets the UI say so.
 */
const memory = new Map<string, PieceRecord>();
let persistent = true;

export function storageIsPersistent() {
  return persistent;
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB blocked'));
    } catch (e) {
      reject(e);
    }
  });
  return dbPromise;
}

async function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Runs an IndexedDB operation; on failure switches to in-memory storage for the rest of the visit. */
async function withFallback<T>(idb: () => Promise<T>, mem: () => T): Promise<T> {
  if (persistent) {
    try {
      return await idb();
    } catch (e) {
      console.warn('IndexedDB unavailable, keeping pieces in memory', e);
      persistent = false;
    }
  }
  return mem();
}

export async function listPieces(): Promise<PieceRecord[]> {
  const all = await withFallback(
    () => tx<PieceRecord[]>('readonly', (s) => s.getAll() as IDBRequest<PieceRecord[]>),
    () => Array.from(memory.values()),
  );
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getPiece(id: string): Promise<PieceRecord | undefined> {
  return withFallback(
    () => tx<PieceRecord | undefined>('readonly', (s) => s.get(id) as IDBRequest<PieceRecord | undefined>),
    () => memory.get(id),
  );
}

export async function savePiece(rec: PieceRecord): Promise<void> {
  const next = { ...rec, updatedAt: Date.now() };
  memory.set(rec.id, next);
  await withFallback(
    async () => {
      await tx('readwrite', (s) => s.put(next));
    },
    () => undefined,
  );
}

export async function deletePiece(id: string): Promise<void> {
  memory.delete(id);
  await withFallback(
    async () => {
      await tx('readwrite', (s) => s.delete(id));
    },
    () => undefined,
  );
}

export function newPieceRecord(
  partial: Pick<PieceRecord, 'title' | 'composer' | 'sourceName' | 'sourceType' | 'musicXml'> &
    Partial<Pick<PieceRecord, 'pdf' | 'pages' | 'recognizer'>>,
): PieceRecord {
  const now = Date.now();
  return {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: now,
    updatedAt: now,
    settings: { ...DEFAULT_SETTINGS },
    overrides: {},
    learned: [],
    ...partial,
  };
}
