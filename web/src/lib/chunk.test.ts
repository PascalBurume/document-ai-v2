import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remapPages } from './api';
import { parsePageRange } from './pages';

/**
 * A chunked run splits the PDF, OCRs each chunk, and stitches the pages back together.
 * If the stitching is off by one, every page is silently mislabelled and the markdown is
 * attributed to the wrong scan — unfalsifiable, and invisible on screen.
 */

test('remap: chunk-local page numbers become original document pages', () => {
  // Chunk 3 of a book: its pages 0,1,2 are really pages 24,25,26.
  const pages = [{ index: 0 }, { index: 1 }, { index: 2 }];
  assert.deepEqual(remapPages(pages, [24, 25, 26]), [{ index: 24 }, { index: 25 }, { index: 26 }]);
});

test('remap: a non-contiguous page range keeps its real page numbers', () => {
  // "1,5,9" -> indices [0,4,8]. The chunk holds 3 pages; they are NOT 0,1,2.
  const pages = [{ index: 0 }, { index: 1 }, { index: 2 }];
  assert.deepEqual(remapPages(pages, [0, 4, 8]), [{ index: 0 }, { index: 4 }, { index: 8 }]);
});

test('remap: the first chunk is not a special case', () => {
  assert.deepEqual(remapPages([{ index: 0 }], [0]), [{ index: 0 }]);
});

test('remap: a page the chunk never contained is dropped, not mapped to undefined', () => {
  const pages = [{ index: 0 }, { index: 7 }];
  assert.deepEqual(remapPages(pages, [12, 13]), [{ index: 12 }], 'index 7 has no counterpart');
});

test('remap: extra fields on a page survive the renumbering', () => {
  const pages = [{ index: 1, markdown: 'hello', blocks: [] }] as any;
  assert.deepEqual(remapPages(pages, [40, 41]), [{ index: 41, markdown: 'hello', blocks: [] }] as any);
});

test('chunking a whole 100-page book covers every page exactly once, in order', () => {
  const all = Array.from({ length: 100 }, (_, i) => i);
  const perChunk = 12;

  const merged: { index: number }[] = [];
  for (let i = 0; i < all.length; i += perChunk) {
    const indices = all.slice(i, i + perChunk);
    // Each chunk's OCR response numbers its own pages from 0.
    const chunkPages = indices.map((_, k) => ({ index: k }));
    merged.push(...remapPages(chunkPages, indices));
  }

  assert.equal(merged.length, 100);
  assert.deepEqual(merged.map((p) => p.index), all, 'no gaps, no duplicates, no off-by-one at boundaries');
});

test('client page range agrees with the 1-based UI', () => {
  assert.deepEqual(parsePageRange('1-4,8'), [0, 1, 2, 3, 7]);
  assert.equal(parsePageRange(''), null, 'empty means every page');
  assert.throws(() => parsePageRange('0'), /Invalid page/);
});
