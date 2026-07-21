import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAuthoredFigures } from './authoredFigures';
import type { Block, DocFile, OcrPage } from './types';

const table: Block = {
  id: 'p318-b1', type: 'table', bbox: { x: 0, y: 0, w: 10, h: 10 }, text: '| A | B |\n|---|---|\n|1|2|',
};
const page: OcrPage = { index: 318, markdown: table.text, width: 1, height: 1, words: [], blocks: [table] };
const book = (name: string, pageCount: number): DocFile => ({
  id: 'd', name, pageCount, result: { pages: [page] },
} as DocFile);

test('the four missing table curves bind only to the exact 570-page maths book and block', () => {
  const patched = applyAuthoredFigures(book('866518263-Maitriser-Les-Maths-5.pdf', 570));
  assert.equal(patched.result?.pages[0].blocks[0].authoredTableFigures?.length, 4);
  const wrongBook = applyAuthoredFigures(book('other.pdf', 570));
  assert.equal(wrongBook.result?.pages[0].blocks[0].authoredTableFigures, undefined);
  const wrongEdition = applyAuthoredFigures(book('866518263-Maitriser-Les-Maths-5.pdf', 569));
  assert.equal(wrongEdition.result?.pages[0].blocks[0].authoredTableFigures, undefined);
});
