import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTable,
  serializeTable,
  addRow,
  removeRow,
  addColumn,
  removeColumn,
  setCell,
} from './tableGrid';

/** The real p.18 sign table from the maths book. */
const SIGN_TABLE = ['| m | -∞ | -1 | 3/11 | +∞ |', '| --- | --- | --- | --- | --- |', '| af(λ) | + | 0 | - | 0 |'].join('\n');

test('parse: header, alignment and rows come apart correctly', () => {
  const g = parseTable(SIGN_TABLE)!;
  assert.deepEqual(g.header, ['m', '-∞', '-1', '3/11', '+∞']);
  assert.deepEqual(g.rows, [['af(λ)', '+', '0', '-', '0']]);
  assert.deepEqual(g.align, ['none', 'none', 'none', 'none', 'none']);
});

test('round-trip: a well-formed table survives parse -> serialize', () => {
  assert.equal(serializeTable(parseTable(SIGN_TABLE)!), SIGN_TABLE);
});

test('alignment markers are preserved', () => {
  const src = ['| a | b | c |', '| :--- | :---: | ---: |', '| 1 | 2 | 3 |'].join('\n');
  const g = parseTable(src)!;
  assert.deepEqual(g.align, ['left', 'center', 'right']);
  assert.equal(serializeTable(g), src);
});

test('a ragged row is squared up to the header rather than losing cells', () => {
  const g = parseTable(['| a | b | c |', '| --- | --- | --- |', '| 1 |'].join('\n'))!;
  assert.deepEqual(g.rows, [['1', '', '']]);
});

test('an escaped pipe stays inside its cell', () => {
  const g = parseTable(['| a | b |', '| --- | --- |', '| x \\| y | z |'].join('\n'))!;
  assert.deepEqual(g.rows, [['x \\| y', 'z']]);
});

test('math in a cell is carried through untouched', () => {
  const g = parseTable(['| m | v |', '| --- | --- |', '| $\\frac{3}{11}$ | +∞ |'].join('\n'))!;
  assert.equal(g.rows[0][0], '$\\frac{3}{11}$');
  assert.match(serializeTable(g), /\$\\frac\{3\}\{11\}\$/);
});

test('not a table -> null, so the caller can fall back to the source instead of mangling it', () => {
  assert.equal(parseTable('just a paragraph'), null);
  assert.equal(parseTable('| a | b |'), null, 'a header with no separator is not a table');
  assert.equal(parseTable(''), null);
});

test('add/remove row', () => {
  const g = parseTable(SIGN_TABLE)!;
  const added = addRow(g, 1);
  assert.equal(added.rows.length, 2);
  assert.deepEqual(added.rows[1], ['', '', '', '', ''], 'a new row is blank and full width');
  assert.equal(removeRow(added, 1).rows.length, 1);
});

test('add/remove column keeps every row the same width', () => {
  const g = addColumn(parseTable(SIGN_TABLE)!, 5);
  assert.equal(g.header.length, 6);
  assert.equal(g.align.length, 6);
  assert.ok(g.rows.every((r) => r.length === 6));

  const back = removeColumn(g, 5);
  assert.equal(back.header.length, 5);
  assert.ok(back.rows.every((r) => r.length === 5));
  assert.equal(serializeTable(back), SIGN_TABLE, 'add then remove is a no-op');
});

test('the last column cannot be removed — that would stop being a table', () => {
  const one = parseTable(['| a |', '| --- |', '| 1 |'].join('\n'))!;
  assert.equal(removeColumn(one, 0).header.length, 1);
});

test('setCell edits a body cell; row -1 edits the header', () => {
  const g = parseTable(SIGN_TABLE)!;
  assert.equal(setCell(g, 0, 1, '±').rows[0][1], '±');
  assert.equal(setCell(g, -1, 0, 'M').header[0], 'M');
  assert.equal(g.rows[0][1], '+', 'the original grid is not mutated');
});

test('an edited grid serializes to a table markdown still parses as a table', () => {
  const edited = setCell(parseTable(SIGN_TABLE)!, 0, 2, '$\\infty$');
  const md = serializeTable(edited);
  assert.ok(parseTable(md), 'the output is still a valid table');
  assert.equal(parseTable(md)!.rows[0][2], '$\\infty$');
});
