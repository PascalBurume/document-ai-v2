import type { DocFile, OcrConfig } from './types';

/**
 * A real OCR run is expensive (paid, per page) and the PDF behind it is large — often tens of
 * megabytes as a data URI. That rules out localStorage. So the whole session (documents, their
 * parsed results, and the config) is checkpointed to IndexedDB, which restores the finished
 * result on the next page load with zero clicks and no second API call.
 *
 * Persistence is a convenience, never a correctness requirement: a browser that forbids
 * IndexedDB (private mode, locked-down enterprise profile) must still run OCR — it just won't
 * remember across reloads. But a failure is REPORTED (saveSession throws) rather than swallowed:
 * hours of paid figure redraws silently failing to save is the one thing worse than not saving.
 */

const DB = 'docai';
const STORE = 'session';
const KEY = 'current';

/**
 * The document bytes, stored ONCE per document and never rewritten by a checkpoint.
 *
 * This split is what makes checkpointing affordable. The session record used to carry each
 * document's `dataUri` inline, so every change to any document — every figure redraw, every label
 * check, every keystroke in the Edit tab — structured-cloned the entire PDF (tens of megabytes)
 * back to disk. A figure sweep writes hundreds of times; that is how a long sweep exhausts memory
 * or quota and takes the whole session's progress with it. The bytes never change, so they are
 * written when the document arrives and only referenced afterwards.
 */
const BLOBS = 'docBlobs';

/**
 * The session is the *last* thing you had open. The library — everything you have ever finished —
 * used to live here too, in the two stores below. It does not any more: it lives on the server, in
 * SQLite (server/src/library.ts), and these two remain only so the one-time migration can find what
 * a browser already has and hand it over.
 *
 * IndexedDB is scoped to an ORIGIN, and this UI is served from more than one — :5174 standalone,
 * :5173 inside Relire, :8787 built. Process a book on one and the library reads empty on the next,
 * while the paid run sits in `.cache/` and the hand corrections in `.edits/`, keyed and intact. The
 * home screen would report "2 pages hand-corrected" (read from the server) directly above an empty
 * grid (read from that browser). Nothing was lost; it was only unreachable. A library that a change
 * of URL, of browser, or of cleared profile can hide is not storage — so it moved to the server.
 *
 * The SESSION stays here, deliberately. "Which documents are open, on which tab, at which page" is
 * a property of this window; it *should* die with the profile, and it is the one thing here that
 * costs nothing to rebuild.
 */
const LIB = 'library';
const INDEX = 'libraryIndex';

/**
 * Where you were looking, not just what you had open. Restoring the documents but not the view is
 * what makes a browser tab-discard (a locked screen is enough) feel like the app restarted: the
 * book comes back, but on the first tab at page 1, and someone reading page 300 of the Book has to
 * find their way back by hand. `tab` is a plain string on purpose — the Tab union lives in App, and
 * the store must not depend on the UI. The restore validates it.
 */
export interface SessionView {
  tab: string;
  page: number;
  zoom: number;
  fitWidth: boolean;
}

export interface Session {
  docs: DocFile[];
  activeId: string | null;
  config: OcrConfig;
  view?: SessionView;
}

/** What the picker shows. Deliberately free of `dataUri` and `result`: listing the library must
 *  never move a PDF, so the server sends only this. */
export interface LibraryMeta {
  key: string;
  name: string;
  sizeBytes: number;
  pageCount: number;
  pagesProcessed: number;
  model: string;
  savedAt: number;
  /** Small first-page JPEG data URL (~10–25KB) for the library card. Optional: entries saved
   *  before thumbnails existed lack it until the home screen backfills them. */
  thumb?: string;
  /** False when the entry is filed but its bytes never finished uploading. */
  hasBytes?: boolean;
}

export interface LibraryEntry {
  meta: LibraryMeta;
  doc: DocFile;
  config: OcrConfig;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 3);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Guarded rather than unconditional: an existing v1 database already has `session`, a v2 one
      // also has the library, and a fresh one has nothing. All must end at the same schema.
      for (const name of [STORE, LIB, INDEX, BLOBS]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** What the checkpoint stores per document: everything except the bytes, which live in BLOBS. */
type StoredDoc = Omit<DocFile, 'dataUri' | 'running' | 'error' | 'progress'> & { dataUri?: string };

/**
 * Checkpoint the session. THROWS on failure — the caller surfaces it. A quota error here means
 * every figure redrawn since the last good save is memory-only; that has to be visible, not a
 * console line. The document bytes are written once per document and referenced afterwards.
 */
export async function saveSession(session: Session): Promise<void> {
  const db = await open();
  try {
    // Never persist transient run state. A reload should restore a finished result, not a
    // half-run whose progress callbacks are gone and can therefore never complete.
    const docs: StoredDoc[] = session.docs.map((d) => ({
      id: d.id,
      name: d.name,
      sizeBytes: d.sizeBytes,
      mime: d.mime,
      sourceType: d.sourceType,
      pageCount: d.pageCount,
      result: d.result,
      libKey: d.libKey,
    }));

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE, BLOBS], 'readwrite');
      const blobs = tx.objectStore(BLOBS);
      // Write each document's bytes only if they are not already there: the bytes are immutable,
      // so re-writing them on every checkpoint is pure cost. `getKey` reads the key alone, never
      // the megabytes behind it.
      for (const d of session.docs) {
        const probe = blobs.getKey(d.id);
        probe.onsuccess = () => {
          if (probe.result === undefined) blobs.put(d.dataUri, d.id);
        };
      }
      // Drop bytes belonging to documents that are no longer open.
      const keys = blobs.getAllKeys();
      keys.onsuccess = () => {
        const live = new Set(session.docs.map((d) => d.id));
        for (const k of keys.result as string[]) if (!live.has(k)) blobs.delete(k);
      };
      tx.objectStore(STORE).put({ ...session, docs }, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('the browser aborted the save (storage is likely full)'));
    });
  } finally {
    db.close();
  }
}

export async function loadSession(): Promise<Session | null> {
  try {
    const db = await open();
    const session = await new Promise<Session | null>((resolve, reject) => {
      const tx = db.transaction([STORE, BLOBS], 'readonly');
      const req = tx.objectStore(STORE).get(KEY);
      const blobs = tx.objectStore(BLOBS);
      req.onsuccess = () => {
        const stored = req.result as (Session & { docs: StoredDoc[] }) | undefined;
        if (!stored?.docs?.length) return resolve(null);
        // Re-join each document with its bytes. A session written before the split carries its
        // `dataUri` inline — keep it, so upgrading never loses the document that is already open.
        const docs: DocFile[] = [];
        let pending = stored.docs.length;
        for (const [i, d] of stored.docs.entries()) {
          if (d.dataUri) {
            docs[i] = d as DocFile;
            if (--pending === 0) resolve({ ...stored, docs: docs.filter(Boolean) });
            continue;
          }
          const bReq = blobs.get(d.id);
          bReq.onsuccess = () => {
            // A document whose bytes are gone cannot be rendered or re-run, so it is dropped
            // rather than restored as a broken row.
            if (typeof bReq.result === 'string') docs[i] = { ...(d as DocFile), dataUri: bReq.result };
            if (--pending === 0) resolve({ ...stored, docs: docs.filter(Boolean) });
          };
          bReq.onerror = () => {
            if (--pending === 0) resolve({ ...stored, docs: docs.filter(Boolean) });
          };
        }
      };
      req.onerror = () => reject(req.error);
    });
    db.close();
    return session;
  } catch {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve) => {
      const tx = db.transaction([STORE, BLOBS], 'readwrite');
      tx.objectStore(STORE).delete(KEY);
      // The library keeps its own copy of every finished document, so clearing the workspace's
      // bytes never costs a paid result.
      tx.objectStore(BLOBS).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch {
    /* persistence is best-effort */
  }
}

/* ---------------------------------------------------------------- library */

/**
 * Keyed by CONTENT, exactly like the server's disk cache — so the same scan re-dropped under a
 * different filename is the same library entry, and re-running a document replaces its entry
 * instead of piling up a near-duplicate. Falls back to name+size where SubtleCrypto is absent
 * (non-secure origin): a weaker key still dedupes the common case, and a collision here costs a
 * re-run, never a wrong result.
 */
export async function contentKey(doc: Pick<DocFile, 'name' | 'sizeBytes' | 'dataUri'>): Promise<string> {
  const payload = doc.dataUri.slice(doc.dataUri.indexOf(',') + 1);
  try {
    const bytes = new TextEncoder().encode(payload);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return `${doc.name}:${doc.sizeBytes}`;
  }
}

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`/api/library${path}`, init);
  const data = await res.json().catch(() => ({ error: `Server returned ${res.status}.` }));
  if (!res.ok) throw new Error(data.error ?? `Server returned ${res.status}.`);
  return data;
}

function put(path: string, body: unknown): Promise<any> {
  return api(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * A finished document, filed on the server — the durable copy that outlives the workspace, the
 * browser profile, and the origin it was processed on. THROWS on a storage failure so the caller
 * can say so: this is where a paid OCR run and hours of figure redraws come to rest, and a save
 * that quietly did nothing is indistinguishable from one that worked, right up until the day you
 * go looking for the document and it is gone.
 *
 * Two requests, but only the first time. The entry (metadata, config, result) is small and is
 * rewritten on every save; the bytes are tens of megabytes and never change, so the server replies
 * `needsBytes` only when it hasn't got them — on the first save of a document, or if the store was
 * cleared underneath us. Sending the PDF on every figure-sweep save would be the same mistake the
 * session checkpoint already learned not to make.
 */
export async function saveToLibrary(
  doc: DocFile,
  config: OcrConfig,
  savedAt = Date.now(),
  thumb?: string,
): Promise<string | null> {
  if (!doc.result) return null;
  const key = doc.libKey ?? (await contentKey(doc));
  // Never persist transient run state (`running`, `error`, `progress`), for the same reason the
  // session doesn't: a reload should restore a finished result, not a half-run whose progress
  // callbacks are gone and can therefore never complete.
  const stored = {
    name: doc.name,
    sizeBytes: doc.sizeBytes,
    mime: doc.mime,
    sourceType: doc.sourceType,
    pageCount: doc.pageCount,
    result: doc.result,
  };
  const { needsBytes } = (await put(`/${key}`, { doc: stored, config, savedAt, thumb })) as {
    needsBytes: boolean;
  };
  if (needsBytes) await put(`/${key}/blob`, { dataUri: doc.dataUri });
  return key;
}

/** Metadata only — cheap enough to call on every mount, and it never moves a PDF. Newest first. */
export async function listLibrary(): Promise<LibraryMeta[]> {
  try {
    const { entries } = (await api('')) as { entries: LibraryMeta[] };
    return entries;
  } catch {
    return []; // the server is the library; if it is down there is nothing to show, not an error
  }
}

/** The full document, with the result that was already paid for. */
export async function loadFromLibrary(key: string): Promise<LibraryEntry | null> {
  try {
    const entry = (await api(`/${key}`)) as { meta: LibraryMeta; doc: Omit<DocFile, 'id'>; config: OcrConfig };
    // The server stores no `id`: ids belong to a workspace, and the caller assigns a fresh one.
    return { ...entry, doc: { ...entry.doc, id: '' } };
  } catch {
    return null;
  }
}

/**
 * Attach a thumbnail to an already-filed entry (the backfill path for entries that predate
 * thumbnails). Touches metadata only — the megabytes stay where they are.
 */
export async function updateLibraryThumb(key: string, thumb: string): Promise<void> {
  try {
    await put(`/${key}/thumb`, { thumb });
  } catch {
    /* a missing thumbnail is a cosmetic loss; never fail a save over one */
  }
}

export async function deleteFromLibrary(key: string): Promise<void> {
  await api(`/${key}`, { method: 'DELETE' });
}

/**
 * Hand any library this browser still holds to the server, once.
 *
 * The library used to live in IndexedDB. A change of storage engine must never be the reason
 * someone's work disappears — so on first load every local entry is uploaded, and the old stores
 * are emptied only after the server has confirmed each one. Entries already on the server win: they
 * are newer than anything we are importing. Failures are left alone and retried next load, because
 * the alternative is deleting the only copy of a paid result on the strength of one bad request.
 */
export async function migrateLegacyLibrary(): Promise<number> {
  let migrated = 0;
  try {
    const db = await open();
    const legacy = await new Promise<LibraryEntry[]>((resolve) => {
      const tx = db.transaction(LIB, 'readonly');
      const req = tx.objectStore(LIB).getAll();
      req.onsuccess = () => resolve((req.result as LibraryEntry[]) ?? []);
      req.onerror = () => resolve([]);
    });
    if (!legacy.length) {
      db.close();
      return 0;
    }

    const onServer = new Set((await listLibrary()).map((m) => m.key));
    for (const entry of legacy) {
      const key = entry.meta?.key ?? entry.doc?.libKey;
      if (!key || !entry.doc?.dataUri || !entry.doc?.result) continue;
      try {
        if (!onServer.has(key)) {
          await saveToLibrary({ ...entry.doc, libKey: key }, entry.config, entry.meta?.savedAt, entry.meta?.thumb);
          migrated++;
        }
        await new Promise<void>((resolve) => {
          const tx = db.transaction([LIB, INDEX], 'readwrite');
          tx.objectStore(LIB).delete(key);
          tx.objectStore(INDEX).delete(key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        });
      } catch {
        /* keep the local copy and try again next load */
      }
    }
    db.close();
    if (migrated) console.info(`library: moved ${migrated} entr${migrated === 1 ? 'y' : 'ies'} to the server`);
  } catch {
    /* no legacy store, or no IndexedDB at all — nothing to move */
  }
  return migrated;
}
