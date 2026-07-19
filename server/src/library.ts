import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OcrConfig } from './types.js';

/**
 * Durable storage for processed documents — the library.
 *
 * Why this moved out of the browser: the library used to live in IndexedDB, which is scoped to an
 * ORIGIN. Open the same app on :5174 having processed the book on :5173 (Relire mounts this UI as
 * its fourth tab), or in a second browser, or after a profile is cleared, and the library reads
 * empty while every expensive thing behind it — the paid OCR run in `.cache/`, the hand corrections
 * in `.edits/` — is sitting on disk, keyed and intact. The home screen said "2 pages hand-corrected"
 * (read from the server) directly above an empty document grid (read from that browser). The data
 * was never lost; it was only unreachable. Storage that survives the browser is the fix.
 *
 * Why `.library/` and not `.cache/`: `.cache/` is reproducible — delete it, re-run, pay again, get
 * it back — and its contract is "safe to delete". A library entry carries work that a re-run does
 * NOT reproduce: figure redraws, label checks and recovered text, each a paid vision call, none of
 * them derivable from the OCR response. Irreplaceable data must never live in a directory whose
 * whole contract is "safe to delete" (the same reasoning that put `.edits/` where it is).
 *
 * Keyed by CONTENT, exactly like `cacheKey` and the edit store: the same scan under a different
 * filename is the same entry, and a re-run replaces its entry instead of piling up a near-duplicate.
 *
 * What this is NOT: a queue, an approval, a `verified` state. A row records "this document was
 * processed on this machine", nothing more. That loop belongs to Relire's Review, and its absence
 * here is the point (CLAUDE.md). This is a filing cabinet, not a verdict.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.library');

/** Newest-first, and bounded: the library is a convenience cache, not an archive. */
export const MAX_ENTRIES = 24;

/** What the picker paints. Deliberately free of `dataUri` and `result` — see `listMeta`. */
export interface LibraryMeta {
  key: string;
  name: string;
  sizeBytes: number;
  pageCount: number;
  pagesProcessed: number;
  model: string;
  savedAt: number;
  /** Small first-page JPEG data URL (~10–25KB) for the library card. */
  thumb?: string;
  /** False when the metadata is filed but the document bytes are not here yet — see `writeEntry`. */
  hasBytes: boolean;
}

/** The document, minus the bytes and minus any transient run state. */
export interface StoredDoc {
  name: string;
  sizeBytes: number;
  mime: string;
  sourceType: string;
  pageCount: number;
  result: unknown;
}

export interface LibraryEntry {
  meta: LibraryMeta;
  doc: StoredDoc & { dataUri: string; libKey: string };
  config: OcrConfig;
}

/** A content hash, and nothing else. With bound parameters there is no injection to fear here, but a
 *  key that is not a hash is a caller bug and should be loud rather than read as "not in the library". */
function safeKey(key: string): string {
  if (!/^[a-f0-9]{16,128}$/i.test(key)) throw new Error('Invalid library key.');
  return key.toLowerCase();
}

let db: DatabaseSync | null = null;
let dbPath: string | null = null;

/**
 * Open lazily, reading the path at CALL time — never at module load. This repo has already been
 * bitten once by a module-level `process.env` read capturing a value before `dotenv.config()` ran
 * (the GROK_VISION_MODEL trap in figure.ts). It also lets a test point `LIBRARY_DB` at a throwaway
 * file instead of the real store.
 */
function getDb(): DatabaseSync {
  const wanted = process.env.LIBRARY_DB || path.join(ROOT, 'library.db');
  if (db && dbPath === wanted) return db;
  if (db) db.close();

  mkdirSync(path.dirname(wanted), { recursive: true });
  db = new DatabaseSync(wanted);
  // Rows here are whole PDFs, and eviction deletes 24 of them for every 24 filed. Without this,
  // SQLite keeps every freed page: the file grows to its high-water mark (24 books, comfortably a
  // gigabyte) and never gives an inch back, however few documents you are actually keeping. It must
  // be set BEFORE the tables exist — on an established database the pragma is inert until a full
  // VACUUM, which on a file this size is exactly the stall you would not want at startup.
  db.exec('PRAGMA auto_vacuum = FULL');
  // `blobs` is a separate table so that listing the library never reads a single PDF off disk: the
  // metadata rows stay small and scannable, and you pay the megabytes only for the entry you open.
  db.exec(`
    CREATE TABLE IF NOT EXISTS library (
      doc_key         TEXT    PRIMARY KEY,
      name            TEXT    NOT NULL,
      size_bytes      INTEGER NOT NULL,
      mime            TEXT    NOT NULL,
      source_type     TEXT    NOT NULL,
      page_count      INTEGER NOT NULL,
      pages_processed INTEGER NOT NULL,
      model           TEXT    NOT NULL,
      saved_at        INTEGER NOT NULL,
      thumb           TEXT,
      config          TEXT    NOT NULL,
      result          TEXT    NOT NULL
    );
    CREATE TABLE IF NOT EXISTS blobs (
      doc_key  TEXT PRIMARY KEY,
      data_uri TEXT NOT NULL
    );
  `);
  dbPath = wanted;
  return db;
}

interface MetaRow {
  doc_key: string;
  name: string;
  size_bytes: number;
  page_count: number;
  pages_processed: number;
  model: string;
  saved_at: number;
  thumb: string | null;
  has_bytes: number;
}

function toMeta(row: MetaRow): LibraryMeta {
  return {
    key: row.doc_key,
    name: row.name,
    sizeBytes: row.size_bytes,
    pageCount: row.page_count,
    pagesProcessed: row.pages_processed,
    model: row.model,
    savedAt: row.saved_at,
    thumb: row.thumb ?? undefined,
    hasBytes: row.has_bytes === 1,
  };
}

/**
 * Which entries to drop to stay under the cap. Pure, so the eviction rule is unit-tested rather than
 * inferred: the newest `max` are kept, everything older goes. Returns the keys to delete.
 */
export function pickEvictions(metas: { key: string; savedAt: number }[], max = MAX_ENTRIES): string[] {
  return [...metas]
    .sort((a, b) => b.savedAt - a.savedAt)
    .slice(max)
    .map((m) => m.key);
}

/** Metadata only — cheap enough to call on every mount. Newest first. */
export function listMeta(): LibraryMeta[] {
  const rows = getDb()
    .prepare(
      `SELECT l.doc_key, l.name, l.size_bytes, l.page_count, l.pages_processed, l.model, l.saved_at, l.thumb,
              (SELECT COUNT(*) FROM blobs b WHERE b.doc_key = l.doc_key) AS has_bytes
         FROM library l
        ORDER BY l.saved_at DESC`,
    )
    .all() as unknown as MetaRow[];
  return rows.map(toMeta);
}

/**
 * File a document's metadata, config and result. The BYTES are not written here: they are immutable
 * and enormous (tens of megabytes), while this row is rewritten every time a figure sweep finishes.
 * Sending the PDF back on each of those saves is pure cost — the same reasoning that split the bytes
 * out of the session checkpoint in the browser. The return value tells the caller whether this
 * document's bytes still need uploading, so the upload happens exactly once per document, and
 * happens again if the store is ever cleared underneath it.
 *
 * THROWS on a storage failure so the caller can say so: this is where a paid OCR run and hours of
 * figure redraws come to rest, and a save that quietly did nothing is indistinguishable from one
 * that worked, right up until the day you go looking for the document and it is gone.
 */
export function writeEntry(
  key: string,
  entry: { doc: StoredDoc; config: OcrConfig; savedAt: number; thumb?: string },
): { key: string; needsBytes: boolean } {
  const k = safeKey(key);
  const handle = getDb();

  // A re-save without a fresh thumbnail must not erase the one already stored.
  const thumb =
    entry.thumb ??
    ((handle.prepare('SELECT thumb FROM library WHERE doc_key = ?').get(k) as { thumb?: string } | undefined)?.thumb ??
      null);

  handle.exec('BEGIN');
  try {
    handle
      .prepare(
        `INSERT INTO library (doc_key, name, size_bytes, mime, source_type, page_count, pages_processed,
                              model, saved_at, thumb, config, result)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(doc_key) DO UPDATE SET
           name = excluded.name, size_bytes = excluded.size_bytes, mime = excluded.mime,
           source_type = excluded.source_type, page_count = excluded.page_count,
           pages_processed = excluded.pages_processed, model = excluded.model,
           saved_at = excluded.saved_at, thumb = excluded.thumb,
           config = excluded.config, result = excluded.result`,
      )
      .run(
        k,
        entry.doc.name,
        entry.doc.sizeBytes,
        entry.doc.mime,
        entry.doc.sourceType,
        entry.doc.pageCount,
        (entry.doc.result as { pagesProcessed?: number } | null)?.pagesProcessed ?? 0,
        (entry.doc.result as { model?: string } | null)?.model ?? '',
        entry.savedAt,
        thumb,
        JSON.stringify(entry.config),
        JSON.stringify(entry.doc.result),
      );

    // Evict inside the same transaction as the insert: a cap enforced in a second transaction can
    // be interrupted between the two, leaving the library permanently over its limit.
    const all = handle.prepare('SELECT doc_key AS key, saved_at AS savedAt FROM library').all() as unknown as {
      key: string;
      savedAt: number;
    }[];
    const stale = pickEvictions(all);
    for (const dead of stale) {
      handle.prepare('DELETE FROM library WHERE doc_key = ?').run(dead);
      handle.prepare('DELETE FROM blobs WHERE doc_key = ?').run(dead);
    }
    handle.exec('COMMIT');
    // Dropping something the user might come looking for is worth a line in the console.
    if (stale.length) console.info(`library: evicted ${stale.length} oldest entr${stale.length === 1 ? 'y' : 'ies'}`);
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }

  return { key: k, needsBytes: !hasBytes(k) };
}

export function hasBytes(key: string): boolean {
  const row = getDb().prepare('SELECT 1 AS n FROM blobs WHERE doc_key = ?').get(safeKey(key));
  return Boolean(row);
}

/**
 * The document bytes, written once per document and never rewritten. Rejected unless the metadata
 * row already exists: a blob with no entry is unreachable megabytes that no eviction would ever
 * collect, because eviction walks `library`.
 */
export function writeBlob(key: string, dataUri: string): void {
  const k = safeKey(key);
  const handle = getDb();
  const known = handle.prepare('SELECT 1 AS n FROM library WHERE doc_key = ?').get(k);
  if (!known) throw new Error('No library entry for that key — file the entry before its bytes.');
  handle
    .prepare('INSERT INTO blobs (doc_key, data_uri) VALUES (?, ?) ON CONFLICT(doc_key) DO UPDATE SET data_uri = excluded.data_uri')
    .run(k, dataUri);
}

/** The full document, with the result that was already paid for. Null when the bytes are missing:
 *  a document that cannot be rendered or re-run is not something to hand back as a broken row. */
export function readEntry(key: string): LibraryEntry | null {
  const k = safeKey(key);
  const handle = getDb();
  const row = handle
    .prepare(
      `SELECT l.doc_key, l.name, l.size_bytes, l.mime, l.source_type, l.page_count, l.pages_processed,
              l.model, l.saved_at, l.thumb, l.config, l.result,
              (SELECT COUNT(*) FROM blobs b WHERE b.doc_key = l.doc_key) AS has_bytes
         FROM library l WHERE l.doc_key = ?`,
    )
    .get(k) as unknown as (MetaRow & { mime: string; source_type: string; config: string; result: string }) | undefined;
  if (!row) return null;

  const blob = handle.prepare('SELECT data_uri FROM blobs WHERE doc_key = ?').get(k) as
    | { data_uri: string }
    | undefined;
  if (!blob) return null;

  return {
    meta: toMeta(row),
    config: JSON.parse(row.config) as OcrConfig,
    doc: {
      name: row.name,
      sizeBytes: row.size_bytes,
      mime: row.mime,
      sourceType: row.source_type,
      pageCount: row.page_count,
      result: JSON.parse(row.result),
      dataUri: blob.data_uri,
      libKey: row.doc_key,
    },
  };
}

/** Attach a thumbnail to an already-filed entry. Touches metadata only — the bytes stay unread. */
export function updateThumb(key: string, thumb: string): void {
  getDb().prepare('UPDATE library SET thumb = ? WHERE doc_key = ?').run(thumb, safeKey(key));
}

export function remove(key: string): void {
  const k = safeKey(key);
  const handle = getDb();
  handle.exec('BEGIN');
  try {
    handle.prepare('DELETE FROM library WHERE doc_key = ?').run(k);
    handle.prepare('DELETE FROM blobs WHERE doc_key = ?').run(k);
    handle.exec('COMMIT');
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }
}

/** What is filed on this machine. Powers the home screen's stats tiles. */
export function stats(): { documents: number; pages: number; bytes: number } {
  try {
    const row = getDb()
      .prepare(
        `SELECT COUNT(*) AS documents, COALESCE(SUM(pages_processed), 0) AS pages,
                COALESCE(SUM(size_bytes), 0) AS bytes FROM library`,
      )
      .get() as unknown as { documents: number; pages: number; bytes: number };
    return { documents: row.documents, pages: row.pages, bytes: row.bytes };
  } catch {
    return { documents: 0, pages: 0, bytes: 0 };
  }
}
