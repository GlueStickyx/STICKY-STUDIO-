// Local persistence in IndexedDB: the project as JSON, and each sample's original file bytes.
// Every call tolerates storage being unavailable (private windows, blocked site data).
import type { Project } from './types';

let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open('sticky-studio', 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('audio'); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}

async function tx<T>(store: 'kv' | 'audio', mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
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
