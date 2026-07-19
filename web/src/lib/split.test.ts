import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitPdf } from './split';

/**
 * The server's OCR cache is keyed by a hash of the bytes it is sent. For a document over the
 * inline limit those bytes are not the user's PDF — they are a chunk this module BUILDS. So if
 * the build is not byte-for-byte reproducible, the key changes on every upload, every chunk
 * misses, and a book that was already paid for is billed again, quietly, forever.
 *
 * That is not hypothetical: pdf-lib stamps a fresh CreationDate/ModificationDate by default, and
 * it is exactly what happened. This test is the guard — it fails if chunk building ever becomes
 * non-deterministic again.
 */

const PDF = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../backend/data/pdfs/test-chimie.pdf',
);

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function dataUri(): string {
  return `data:application/pdf;base64,${readFileSync(PDF).toString('base64')}`;
}

test('split: the same pages build byte-identical chunks every time', async () => {
  const uri = dataUri();

  const first = await splitPdf(uri, [0, 1]);
  // A second later — the window in which a wall-clock timestamp would differ.
  await new Promise((r) => setTimeout(r, 1100));
  const second = await splitPdf(uri, [0, 1]);

  assert.deepEqual(
    first.map((c) => c.indices),
    second.map((c) => c.indices),
    'chunk composition must be stable',
  );
  assert.deepEqual(
    first.map((c) => sha(c.base64)),
    second.map((c) => sha(c.base64)),
    'chunk BYTES must be stable — otherwise the OCR cache key changes on every upload and a paid book is re-billed',
  );
});

test('split: a page range selects only those pages', async () => {
  const chunks = await splitPdf(dataUri(), [1]);
  assert.deepEqual(chunks.flatMap((c) => c.indices), [1]);
});
