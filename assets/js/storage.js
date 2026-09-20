// Safe wrappers around localStorage / sessionStorage / IndexedDB. Every call is guarded:
// storage may be unavailable (private mode, quota, disabled cookies) and the app must keep
// working without it.

const memory = new Map();

function webStorage(kind) {
  try {
    const store = kind === 'session' ? globalThis.sessionStorage : globalThis.localStorage;
    if (!store) return null;
    const probe = '__probe__';
    store.setItem(probe, '1');
    store.removeItem(probe);
    return store;
  } catch {
    return null;
  }
}

export function storeGet(key, { session = false } = {}) {
  const store = webStorage(session ? 'session' : 'local');
  try {
    const raw = store ? store.getItem(key) : memory.get(key);
    return raw === null || raw === undefined ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

export function storeSet(key, value, { session = false } = {}) {
  const store = webStorage(session ? 'session' : 'local');
  try {
    const raw = JSON.stringify(value);
    if (store) store.setItem(key, raw); else memory.set(key, raw);
    return true;
  } catch {
    return false;
  }
}

export function storeRemove(key, { session = false } = {}) {
  const store = webStorage(session ? 'session' : 'local');
  try {
    if (store) store.removeItem(key); else memory.delete(key);
  } catch {
    // ignore
  }
}

// --- IndexedDB (large objects: climatology series per location) ---

const DB_NAME = 'ephemeride-climatique';
const DB_VERSION = 1;
const STORE = 'blobs';

function openDB() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('IndexedDB indisponible'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('ouverture IndexedDB impossible'));
    request.onblocked = () => reject(new Error('IndexedDB bloquée'));
  });
}

function withStore(mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let result;
    try {
      result = fn(store);
    } catch (err) {
      reject(err);
      return;
    }
    tx.oncomplete = () => {
      db.close();
      resolve(result && 'result' in result ? result.result : undefined);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error('transaction IndexedDB en échec'));
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error || new Error('transaction IndexedDB annulée'));
    };
  }));
}

export async function idbGet(key) {
  try {
    return await withStore('readonly', (store) => store.get(key));
  } catch {
    return memory.has(`idb:${key}`) ? memory.get(`idb:${key}`) : undefined;
  }
}

export async function idbSet(key, value) {
  try {
    await withStore('readwrite', (store) => store.put(value, key));
    return true;
  } catch {
    memory.set(`idb:${key}`, value);
    return false;
  }
}

export async function idbDelete(key) {
  try {
    await withStore('readwrite', (store) => store.delete(key));
  } catch {
    memory.delete(`idb:${key}`);
  }
}
