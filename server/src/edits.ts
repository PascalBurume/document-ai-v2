import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Durable storage for human corrections (the Edit tab).
 *
 * Why this lives in `.edits/` and not `.cache/`:
 *
 * `.cache/` holds things that were PAID FOR but are REPRODUCIBLE — re-run the OCR and you get them
 * back. It is safe to delete, and people do delete it to reclaim disk or force a re-run. A human
 * correction is the opposite: cheap to store, and IRREPLACEABLE — nobody can re-derive the sentence a
 * person fixed by hand. Irreplaceable data must never live in a directory whose whole contract is
 * "safe to delete".
 *
 * Why SQLite (`node:sqlite`, built into Node — no dependency, no native build):
 * a write is transactional, so a crash mid-save cannot leave a half-written correction; the whole
 * store is one queryable file; and each row carries when it was last touched.
 *
 * What this is NOT: a `verified` state. A row records "a human typed this", nothing more — no
 * approval, no queue, no flags. That loop belongs to Relire's Review, and its absence here is the
 * point (the project inspection contract). This is a durable working copy, not a verdict.
 *
 * Keyed by CONTENT (the same document hash the browser library uses), so corrections follow the
 * document: the same scan re-dropped, another browser, another machine, a cleared IndexedDB — the
 * corrections are still attached to it.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.edits');

/** page index (0-based) -> the corrected markdown for that page. */
export type EditMap = Record<string, string>;

/** A content hash, and nothing else. With bound parameters there is no injection to fear here, but a
 *  key that is not a hash is a caller bug and should be loud rather than read as "no edits". */
function safeKey(key: string): string {
  if (!/^[a-f0-9]{16,128}$/i.test(key)) throw new Error('Invalid edit key.');
  return key.toLowerCase();
}

let db: DatabaseSync | null = null;
let dbPath: string | null = null;

/**
 * Open lazily, reading the path at CALL time — never at module load. This repo has already been bitten
 * once by a module-level `process.env` read capturing a value before `dotenv.config()` ran (the
 * model-environment import-order trap). It also lets a test point `EDITS_DB` at a throwaway file
 * instead of the real store.
 */
function getDb(): DatabaseSync {
  const wanted = process.env.EDITS_DB || path.join(ROOT, 'edits.db');
  if (db && dbPath === wanted) return db;
  if (db) db.close();

  mkdirSync(path.dirname(wanted), { recursive: true });
  db = new DatabaseSync(wanted);
  db.exec(`CREATE TABLE IF NOT EXISTS edits (
    doc_key    TEXT    NOT NULL,
    page_index INTEGER NOT NULL,
    markdown   TEXT    NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (doc_key, page_index)
  )`);
  dbPath = wanted;
  migrateJsonFiles(db, path.dirname(wanted));
  return db;
}

/**
 * One-time import of the original JSON-per-document store. A change of storage engine must never be
 * the reason someone's corrections disappear, so any legacy file is folded into the table and then
 * renamed `.migrated` rather than deleted — if this ever goes wrong, the original is still on disk.
 * Existing rows win: whatever is in the DB is newer than a file we already imported from.
 */
function migrateJsonFiles(handle: DatabaseSync, dir: string): void {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return; // no directory yet — nothing to migrate
  }
  if (!files.length) return;

  const insert = handle.prepare(
    `INSERT INTO edits (doc_key, page_index, markdown, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(doc_key, page_index) DO NOTHING`,
  );
  for (const file of files) {
    const key = file.replace(/\.json$/, '');
    if (!/^[a-f0-9]{16,128}$/i.test(key)) continue; // not one of ours
    try {
      const map = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as EditMap;
      const stamp = Date.now();
      for (const [pageIndex, markdown] of Object.entries(map)) {
        if (typeof markdown === 'string') insert.run(key.toLowerCase(), Number(pageIndex), markdown, stamp);
      }
      renameSync(path.join(dir, file), path.join(dir, `${file}.migrated`));
      console.log(`edits: migrated ${file} into the database`);
    } catch (err) {
      console.warn(`edits: could not migrate ${file}:`, (err as Error).message);
    }
  }
}

export function readEdits(key: string): EditMap {
  const k = safeKey(key);
  const rows = getDb()
    .prepare('SELECT page_index, markdown FROM edits WHERE doc_key = ?')
    .all(k) as { page_index: number; markdown: string }[];
  const map: EditMap = {};
  for (const row of rows) map[String(row.page_index)] = row.markdown;
  return map;
}

/**
 * Store (or clear) one page's correction. `markdown === null` reverts the page to the OCR original by
 * dropping the row, so "no edits" leaves no trace rather than an empty husk.
 */
export function writeEdit(key: string, pageIndex: number, markdown: string | null): EditMap {
  const k = safeKey(key);
  const handle = getDb();
  if (markdown == null) {
    handle.prepare('DELETE FROM edits WHERE doc_key = ? AND page_index = ?').run(k, pageIndex);
  } else {
    handle
      .prepare(
        `INSERT INTO edits (doc_key, page_index, markdown, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(doc_key, page_index) DO UPDATE SET markdown = excluded.markdown, updated_at = excluded.updated_at`,
      )
      .run(k, pageIndex, markdown, Date.now());
  }
  return readEdits(k);
}

/** When each page of a document was last corrected — page index -> epoch ms. */
export function editTimes(key: string): Record<string, number> {
  const rows = getDb()
    .prepare('SELECT page_index, updated_at FROM edits WHERE doc_key = ?')
    .all(safeKey(key)) as { page_index: number; updated_at: number }[];
  const out: Record<string, number> = {};
  for (const row of rows) out[String(row.page_index)] = row.updated_at;
  return out;
}

/**
 * What has been corrected on this machine. `byDocument` maps content hash -> corrected page count,
 * so the library view can badge every document with one request instead of one per entry.
 */
export function stats(): { documents: number; pages: number; byDocument: Record<string, number> } {
  try {
    const rows = getDb()
      .prepare('SELECT doc_key, COUNT(*) AS pages FROM edits GROUP BY doc_key')
      .all() as { doc_key: string; pages: number }[];
    const byDocument: Record<string, number> = {};
    let pages = 0;
    for (const row of rows) {
      byDocument[row.doc_key] = row.pages;
      pages += row.pages;
    }
    return { documents: rows.length, pages, byDocument };
  } catch {
    return { documents: 0, pages: 0, byDocument: {} };
  }
}
