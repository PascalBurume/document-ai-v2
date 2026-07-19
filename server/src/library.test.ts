import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { OcrConfig } from './types.js';

/**
 * The library is where a paid OCR run and hours of paid figure redraws come to rest. Losing an entry
 * costs real money to rebuild, and losing it SILENTLY costs more — you find out weeks later, looking
 * for a book that isn't there. So the store has to be boring and correct.
 *
 * Point it at a throwaway database BEFORE importing the module: `getDb()` reads LIBRARY_DB at call
 * time precisely so a test never touches the real library on this machine.
 */
const DIR = mkdtempSync(path.join(tmpdir(), 'docai-library-'));
process.env.LIBRARY_DB = path.join(DIR, 'library.db');

const { listMeta, readEntry, writeEntry, writeBlob, hasBytes, updateThumb, remove, stats, pickEvictions } =
  await import('./library.js');

const KEY = 'a'.repeat(64); // a plausible content hash
const OTHER = 'b'.repeat(64);

const DEFAULT_CONFIG: OcrConfig = {
  model: 'mistral-ocr-latest',
  pages: '',
  extractImages: true,
  extractHeader: false,
  extractFooter: false,
  boundingBoxes: true,
  tableMode: 'markdown_embedded',
  confidence: 'none',
  annotateImages: false,
  responseFormat: false,
  jsonSchema: '',
  annotationPrompt: '',
};

const doc = (name = 'chimie.pdf', pages = 2) => ({
  name,
  sizeBytes: 1234,
  mime: 'application/pdf',
  sourceType: 'document_url',
  pageCount: pages,
  result: { pagesProcessed: pages, model: 'mistral-ocr-latest', pages: [{ index: 0, markdown: '# La matiere' }] },
});

const file = (key: string, name?: string, savedAt = Date.now()) => {
  writeEntry(key, { doc: doc(name), config: DEFAULT_CONFIG, savedAt });
  writeBlob(key, 'data:application/pdf;base64,JVBERi0xLjQK');
};

/* ---------------------------------------------------------------- eviction */

const meta = (key: string, savedAt: number) => ({ key, savedAt });

test('library: under the cap, nothing is evicted', () => {
  assert.deepEqual(pickEvictions([meta('a', 3), meta('b', 1)], 3), []);
});

test('library: evicts the oldest, keeps the newest', () => {
  assert.deepEqual(pickEvictions([meta('old', 1), meta('new', 3), meta('mid', 2)], 2), ['old']);
});

test('library: eviction does not mutate the list it is given', () => {
  const metas = [meta('old', 1), meta('new', 3)];
  pickEvictions(metas, 1);
  assert.deepEqual(metas.map((m) => m.key), ['old', 'new']);
});

/* ---------------------------------------------------------------- storage */

test('library: an entry round-trips whole, bytes and result included', () => {
  file(KEY);
  const entry = readEntry(KEY);
  assert.ok(entry);
  assert.equal(entry.doc.name, 'chimie.pdf');
  assert.equal(entry.doc.dataUri, 'data:application/pdf;base64,JVBERi0xLjQK');
  assert.equal(entry.doc.libKey, KEY);
  assert.equal((entry.doc.result as { pagesProcessed: number }).pagesProcessed, 2);
  assert.deepEqual(entry.config, DEFAULT_CONFIG);
});

test('library: the bytes are asked for once, then never again', () => {
  const first = writeEntry(OTHER, { doc: doc(), config: DEFAULT_CONFIG, savedAt: 1 });
  assert.equal(first.needsBytes, true, 'a new document must upload its bytes');
  writeBlob(OTHER, 'data:application/pdf;base64,AAAA');

  const second = writeEntry(OTHER, { doc: doc(), config: DEFAULT_CONFIG, savedAt: 2 });
  assert.equal(second.needsBytes, false, 'a figure-sweep save must not re-send the whole PDF');
});

test('library: a re-save replaces the entry rather than duplicating it', () => {
  file(KEY, 'chimie.pdf');
  file(KEY, 'renamed.pdf');
  const mine = listMeta().filter((m) => m.key === KEY);
  assert.equal(mine.length, 1, 'content-keyed: the same document is one entry');
  assert.equal(mine[0].name, 'renamed.pdf');
});

test('library: listing never carries the bytes', () => {
  file(KEY);
  const meta = listMeta().find((m) => m.key === KEY)!;
  assert.ok(!('dataUri' in meta), 'the picker must not move megabytes to paint a card');
  assert.ok(!('result' in meta));
  assert.equal(meta.hasBytes, true);
});

test('library: newest first', () => {
  writeEntry(KEY, { doc: doc(), config: DEFAULT_CONFIG, savedAt: 100 });
  writeEntry(OTHER, { doc: doc(), config: DEFAULT_CONFIG, savedAt: 200 });
  const keys = listMeta().map((m) => m.key);
  assert.ok(keys.indexOf(OTHER) < keys.indexOf(KEY));
});

test('library: a re-save without a thumbnail keeps the one already stored', () => {
  file(KEY);
  updateThumb(KEY, 'data:image/jpeg;base64,THUMB');
  writeEntry(KEY, { doc: doc(), config: DEFAULT_CONFIG, savedAt: Date.now() }); // no thumb passed
  assert.equal(listMeta().find((m) => m.key === KEY)!.thumb, 'data:image/jpeg;base64,THUMB');
});

test('library: an entry whose bytes never arrived is not handed back as a broken row', () => {
  const orphan = 'c'.repeat(64);
  writeEntry(orphan, { doc: doc(), config: DEFAULT_CONFIG, savedAt: 1 });
  assert.equal(readEntry(orphan), null, 'no bytes means nothing to render or re-run');
  assert.equal(listMeta().find((m) => m.key === orphan)!.hasBytes, false, 'but the list says so honestly');
  remove(orphan);
});

test('library: bytes cannot be filed for an entry that does not exist', () => {
  assert.throws(() => writeBlob('d'.repeat(64), 'data:application/pdf;base64,AAAA'), /file the entry before/);
});

test('library: removing an entry takes its bytes with it', () => {
  file(OTHER);
  assert.equal(hasBytes(OTHER), true);
  remove(OTHER);
  assert.equal(readEntry(OTHER), null);
  assert.equal(hasBytes(OTHER), false, 'orphaned megabytes no eviction would ever collect');
});

test('library: an unknown document reads as null, never throws', () => {
  assert.equal(readEntry('e'.repeat(64)), null);
});

test('library: a key that is not a content hash is rejected', () => {
  assert.throws(() => readEntry('../../etc/passwd'), /Invalid library key/);
  assert.throws(() => readEntry(''), /Invalid library key/);
  assert.throws(() => writeEntry('a/b', { doc: doc(), config: DEFAULT_CONFIG, savedAt: 1 }), /Invalid library key/);
});

test('library: the cap is enforced on write, oldest first', () => {
  // Stamps deliberately far in the future: these 30 must outrank every entry the tests above filed
  // with a real `Date.now()`, or "the newest survives" would be asserting about someone else's row.
  const base = 9_000_000_000_000;
  for (let i = 0; i < 30; i++) {
    const key = i.toString(16).padStart(64, '0');
    writeEntry(key, { doc: doc(`doc-${i}.pdf`), config: DEFAULT_CONFIG, savedAt: base + i });
    writeBlob(key, 'data:application/pdf;base64,AAAA');
  }
  const metas = listMeta();
  assert.equal(metas.length, 24, 'the library is bounded');
  assert.equal(metas[0].name, 'doc-29.pdf', 'the newest survives');
  assert.ok(!metas.some((m) => m.name === 'doc-0.pdf'), 'the oldest is gone');
});

test('library: stats counts what is filed', () => {
  const s = stats();
  assert.equal(s.documents, listMeta().length);
  assert.ok(s.pages > 0);
  assert.ok(s.bytes > 0);
});
