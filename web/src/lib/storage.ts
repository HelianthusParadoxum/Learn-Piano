/** Local library of pieces, stored in IndexedDB (everything stays in the browser). */
import { DEFAULT_SETTINGS, type PieceSettings } from './model';

export interface PieceRecord {
  id: string;
  title: string;
  composer: string;
  createdAt: number;
  updatedAt: number;
  sourceName: string;
  sourceType: 'pdf' | 'musicxml' | 'example';
  /** Original MusicXML (recognized or uploaded), without generated fingering. */
  musicXml: string;
  pdf?: Blob;
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

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function listPieces(): Promise<PieceRecord[]> {
  const all = await tx<PieceRecord[]>('readonly', (s) => s.getAll() as IDBRequest<PieceRecord[]>);
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getPiece(id: string): Promise<PieceRecord | undefined> {
  return tx<PieceRecord | undefined>('readonly', (s) => s.get(id) as IDBRequest<PieceRecord | undefined>);
}

export async function savePiece(rec: PieceRecord): Promise<void> {
  await tx('readwrite', (s) => s.put({ ...rec, updatedAt: Date.now() }));
}

export async function deletePiece(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id));
}

export function newPieceRecord(partial: Pick<PieceRecord, 'title' | 'composer' | 'sourceName' | 'sourceType' | 'musicXml'> & { pdf?: Blob }): PieceRecord {
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
