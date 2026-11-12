// Local persistence in IndexedDB: the working project, each sample's original file bytes, and the library
// (saved sounds and saved projects).
// Every call tolerates storage being unavailable (private windows, blocked site data).
import type { Project } from './types';

const STORES = ['kv', 'audio', 'libmeta', 'libaudio', 'projects'] as const;
type Store = (typeof STORES)[number];
let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open('sticky-studio', 2);
      r.onupgradeneeded = () => {
        // Version 1: kv + audio. Version 2 adds the library stores.
        for (const name of STORES) if (!r.result.objectStoreNames.contains(name)) r.result.createObjectStore(name);
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}

async function tx<T>(store: Store, mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const r = f(t.objectStore(store));
    t.oncomplete = () => res(r.result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

export async function saveProject(p: Project): Promise<boolean> {
  try { await tx('kv', 'readwrite', (s) => s.put(p, 'project')); return true; } catch { return false; }
}
export async function loadSavedProject(): Promise<Project | null> {
  try { const p = await tx<Project | undefined>('kv', 'readonly', (s) => s.get('project')); return p && p.version === 1 ? p : null; } catch { return null; }
}
export async function saveAudio(id: string, data: ArrayBuffer): Promise<boolean> {
  try { await tx('audio', 'readwrite', (s) => s.put(data, id)); return true; } catch { return false; }
}
export async function loadAudio(id: string): Promise<ArrayBuffer | null> {
  try { return (await tx<ArrayBuffer | undefined>('audio', 'readonly', (s) => s.get(id))) ?? null; } catch { return null; }
}
/** Ask the browser not to evict our data under storage pressure. */
export function requestPersistence() {
  try { navigator.storage?.persist?.(); } catch { /* optional */ }
}

// ---- Library: sounds and projects kept across sessions, outside any one project ----

export interface LibrarySound { id: string; name: string; tags: string[]; duration: number; bpm: number | null; added: number }
export interface SavedProject { id: string; name: string; saved: number; project: Project }

export async function listSounds(): Promise<LibrarySound[]> {
  try { return (await tx<LibrarySound[]>('libmeta', 'readonly', (s) => s.getAll())).sort((a, b) => b.added - a.added); } catch { return []; }
}
export async function putSound(meta: LibrarySound, audio?: ArrayBuffer): Promise<boolean> {
  try {
    if (audio) await tx('libaudio', 'readwrite', (s) => s.put(audio, meta.id));
    await tx('libmeta', 'readwrite', (s) => s.put(meta, meta.id));
    return true;
  } catch { return false; }
}
export async function soundAudio(id: string): Promise<ArrayBuffer | null> {
  try { return (await tx<ArrayBuffer | undefined>('libaudio', 'readonly', (s) => s.get(id))) ?? null; } catch { return null; }
}
export async function deleteSound(id: string): Promise<void> {
  try { await tx('libmeta', 'readwrite', (s) => s.delete(id)); await tx('libaudio', 'readwrite', (s) => s.delete(id)); } catch { /* nothing to delete */ }
}
export async function listProjects(): Promise<SavedProject[]> {
  try { return (await tx<SavedProject[]>('projects', 'readonly', (s) => s.getAll())).sort((a, b) => b.saved - a.saved); } catch { return []; }
}
export async function putProject(p: SavedProject): Promise<boolean> {
  try { await tx('projects', 'readwrite', (s) => s.put(p, p.id)); return true; } catch { return false; }
}
export async function deleteProject(id: string): Promise<void> {
  try { await tx('projects', 'readwrite', (s) => s.delete(id)); } catch { /* nothing to delete */ }
}
