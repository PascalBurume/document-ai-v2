import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * A correction is the one artifact here that cannot be regenerated — re-run the OCR and you get the
 * machine's guess back, never the sentence a person fixed. So the store has to be boring and correct.
 *
 * Point the store at a throwaway database BEFORE importing the module: `getDb()` reads EDITS_DB at call
 * time precisely so a test never touches the real corrections on this machine.
 */
const DIR = mkdtempSync(path.join(tmpdir(), 'docai-edits-'));
process.env.EDITS_DB = path.join(DIR, 'edits.db');

const { readEdits, writeEdit, editTimes, stats } = await import('./edits.js');

const KEY = 'a'.repeat(64); // a plausible content hash
const OTHER = 'b'.repeat(64);

test('edits: a correction round-trips, keyed by page', () => {
  writeEdit(KEY, 3, '# La matière corrigée');
  assert.equal(readEdits(KEY)['3'], '# La matière corrigée');
});

test('edits: pages are independent and a second write updates in place', () => {
  writeEdit(KEY, 3, 'v1');
  writeEdit(KEY, 4, 'page four');
  writeEdit(KEY, 3, 'v2');
  const map = readEdits(KEY);
  assert.equal(map['3'], 'v2', 'a re-edit replaces, never duplicates');
  assert.equal(map['4'], 'page four');
});

test('edits: documents do not bleed into each other', () => {
  writeEdit(KEY, 1, 'from A');
  writeEdit(OTHER, 1, 'from B');
  assert.equal(readEdits(KEY)['1'], 'from A');
  assert.equal(readEdits(OTHER)['1'], 'from B');
});

test('edits: null reverts one page, and the last revert leaves no trace', () => {
  writeEdit(OTHER, 1, 'temporary');
  writeEdit(OTHER, 2, 'kept');
  writeEdit(OTHER, 1, null);
  assert.equal(readEdits(OTHER)['1'], undefined);
  assert.equal(readEdits(OTHER)['2'], 'kept');

  writeEdit(OTHER, 2, null);
  assert.deepEqual(readEdits(OTHER), {}, 'reverting the last page clears the document entirely');
});

test('edits: an unknown document reads as empty, never throws', () => {
  assert.deepEqual(readEdits('f'.repeat(64)), {});
});

test('edits: a key that is not a content hash is rejected', () => {
  assert.throws(() => writeEdit('../../etc/passwd', 0, 'x'), /Invalid edit key/);
  assert.throws(() => writeEdit('', 0, 'x'), /Invalid edit key/);
  assert.throws(() => readEdits('a/b'), /Invalid edit key/);
});

test('edits: stats counts documents and corrected pages', () => {
  writeEdit(KEY, 3, 'kept for stats');
  const s = stats();
  assert.ok(s.documents >= 1);
  assert.ok(s.pages >= 1);
});

test('edits: stats breaks pages down per document', () => {
  writeEdit(KEY, 3, 'page three');
  writeEdit(KEY, 5, 'page five');
  writeEdit(OTHER, 0, 'other doc');
  const s = stats();
  assert.ok(s.byDocument[KEY] >= 2, 'both corrected pages of KEY are counted');
  assert.ok(s.byDocument[OTHER] >= 1);
  assert.equal(
    Object.values(s.byDocument).reduce((a, b) => a + b, 0),
    s.pages,
    'per-document counts sum to the total',
  );
  assert.equal(Object.keys(s.byDocument).length, s.documents);
});

test('edits: a correction records when it was made', () => {
  const before = Date.now();
  writeEdit(KEY, 9, 'timed');
  const at = editTimes(KEY)['9'];
  assert.ok(at >= before && at <= Date.now(), 'updated_at is stamped on write');
});

test('edits: text with newlines, unicode and markdown survives the round trip', () => {
  const md = '# Titre à accents\n\n$\\frac{\\sqrt{2}}{2}$ — « quotes » …\n\n| a | b |\n| --- | --- |\n';
  writeEdit(KEY, 7, md);
  assert.equal(readEdits(KEY)['7'], md);
});

/**
 * The store used to be one JSON file per document. Changing the storage engine must never be the
 * reason someone's corrections vanish.
 */
test('edits: legacy JSON files are migrated into the database, not dropped', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'docai-migrate-'));
  const legacyKey = 'c'.repeat(64);
  writeFileSync(path.join(dir, `${legacyKey}.json`), JSON.stringify({ '2': 'legacy correction' }));

  process.env.EDITS_DB = path.join(dir, 'edits.db'); // a new path -> reopen -> migration runs
  const fresh = await import('./edits.js');
  assert.equal(fresh.readEdits(legacyKey)['2'], 'legacy correction', 'the old correction is in the DB');

  const left = readdirSync(dir);
  assert.ok(left.includes(`${legacyKey}.json.migrated`), 'the original file is kept, renamed');
  assert.ok(!existsSync(path.join(dir, `${legacyKey}.json`)), 'and not re-imported on the next open');
});
