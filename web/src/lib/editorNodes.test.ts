import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePageToNodes,
  serializeNodes,
  formulaSrc,
  effectiveMarkdown,
  isEdited,
  isAtom,
} from './editorNodes';

/**
 * The whole editor rests on the split being lossless. If these fail, editing prose could silently
 * rewrite a formula — the exact class of damage this project exists to prevent.
 */
const roundTrips = (md: string) => assert.equal(serializeNodes(parsePageToNodes(md)), md);

const kinds = (md: string) => parsePageToNodes(md).map((n) => n.kind);

test('round-trip: plain prose', () => {
  roundTrips('Une phrase normale.\n\nUn deuxième paragraphe.');
});

test('round-trip: inline and display formulas', () => {
  roundTrips('Si $\\frac{1-\\sqrt{2}}{2} < m$ alors $$x^2 + 1 = 0$$ donc \\(a\\) et \\[b\\].');
});

test('round-trip: images and tables', () => {
  roundTrips('Avant\n\n![img-0.jpeg](img-0.jpeg)\n\n| x | y |\n| --- | --- |\n| 1 | 2 |\n\nAprès');
});

test('round-trip: the real p.26 shape (math inside a table)', () => {
  const md = [
    '- Si $\\frac{1-\\sqrt{2}}{2} < m < \\frac{1+\\sqrt{2}}{2}$ alors $\\Delta > 0$',
    '',
    '|  x | -∞ | x₁ | x₂ | +∞  |',
    '| --- | --- | --- | --- | --- |',
    '|  f(x) | + | 0 | - | 0  |',
    '',
    'S = ]x₁, x₂[',
  ].join('\n');
  roundTrips(md);
});

test('round-trip: the real p.7 TOC shape (single-newline list structure)', () => {
  const md = '# TABLE DES MATIERES\n\n# CHAPITRE I : NOTIONS 1\n\nI.1. Raisonnement 1\nI.2. Recurrence 2\n\n';
  roundTrips(md);
});

test('round-trip: empty and atom-only pages', () => {
  assert.deepEqual(parsePageToNodes(''), []);
  roundTrips('$x$');
  roundTrips('![a](b)');
});

test('display math is not chewed up by the inline-$ rule', () => {
  const nodes = parsePageToNodes('$$a+b$$');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].kind, 'formula');
  assert.equal(nodes[0].display, true);
  assert.equal(nodes[0].tex, 'a+b');
});

test('a formula carries its tex; an image carries alt and ref', () => {
  const f = parsePageToNodes('x $a^2$ y')[1];
  assert.equal(f.kind, 'formula');
  assert.equal(f.tex, 'a^2');
  assert.equal(f.display, false);

  const img = parsePageToNodes('![the figure](img-3.jpeg)')[0];
  assert.equal(img.kind, 'image');
  assert.equal(img.alt, 'the figure');
  assert.equal(img.ref, 'img-3.jpeg');
});

test('an image inside a table is claimed by the table, not double-counted', () => {
  // Table pattern has priority; the point is only that the split stays lossless.
  roundTrips('| a | b |\n| --- | --- |\n| ![x](y) | 2 |');
});

test('prose around atoms stays editable text', () => {
  assert.deepEqual(kinds('Soit $x$ un réel.'), ['text', 'formula', 'text']);
  assert.deepEqual(parsePageToNodes('Soit $x$ un réel.').map(isAtom), [false, true, false]);
});

test('formulaSrc rebuilds the right delimiters', () => {
  assert.equal(formulaSrc('a+b', false), '$a+b$');
  assert.equal(formulaSrc('a+b', true), '$$a+b$$');
  // An edited formula must round-trip back through the parser as one formula node.
  roundTrips(`Soit ${formulaSrc('\\sqrt{2}', false)} ici.`);
});

test('effectiveMarkdown prefers the edit; the OCR original is untouched', () => {
  const page = { markdown: 'ocr text', editedMarkdown: undefined as string | undefined };
  assert.equal(effectiveMarkdown(page), 'ocr text');
  assert.equal(isEdited(page), false);

  const edited = { markdown: 'ocr text', editedMarkdown: 'fixed text' };
  assert.equal(effectiveMarkdown(edited), 'fixed text');
  assert.equal(isEdited(edited), true);
  assert.equal(edited.markdown, 'ocr text', 'the evidence must never be rewritten');
});

test('an edit identical to the OCR is not counted as an edit', () => {
  assert.equal(isEdited({ markdown: 'same', editedMarkdown: 'same' }), false);
});
