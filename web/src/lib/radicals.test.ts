import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectRadicands, restoreBareRadicals } from './radicals.js';

/**
 * The real shape of the failure, from p.32 of the Maitriser book: the OCR writes the inequality in
 * proper LaTeX and then bares the same three radicals inside the sign table under it.
 */
const P32 = `$$\\sqrt{x+6} + \\sqrt{x+1} < \\sqrt{7x+4}$$

|  x | -∞ | -6 | -1 | -4/7 | +∞  |
| --- | --- | --- | --- | --- | --- |
|  √x+6 |  | 0 | + | + | +  |
|  √x+1 |  |  | 0 | + | +  |
|  √7x+4 |  |  |  | 0 | +  |`;

const known = (md: string) => collectRadicands([{ index: 0, markdown: md, blocks: [] } as any]);

test('collectRadicands takes only radicands whose reach is in question', () => {
  const k = collectRadicands([{ index: 0, markdown: '$\\sqrt{x+6}$ $\\sqrt{2}$ $\\sqrt{7x+4}$', blocks: [] } as any]);
  assert.ok(k.has('x+6'));
  assert.ok(k.has('7x+4'));
  // A single-atom radicand must NOT be admitted: it teaches nothing, and it would let a stray
  // `\sqrt{x}` "corroborate" the x of `√x+6` and re-group the expression wrongly.
  assert.ok(!k.has('2'));
});

test('a bare radical is re-grouped from the document\'s own \\sqrt — the p.32 case', () => {
  const out = restoreBareRadicals(P32, known(P32));
  assert.equal(out.corroborated, 3, 'all three table labels are restored');
  assert.equal(out.ambiguous, 0);
  assert.ok(out.text.includes('$\\sqrt{x+6}$'), '√x+6 becomes \\sqrt{x+6}, not \\sqrt{x}+6');
  assert.ok(out.text.includes('$\\sqrt{7x+4}$'));
  assert.ok(out.text.includes('radical-restored'), 'and it is marked — this changes what a reader reads');
});

/**
 * The whole discipline of this repo in one test. `√1-cos²y` needs a grouping the text does not
 * record and the document never states. Inventing one would produce fluent, plausible, wrong
 * mathematics — so it must survive untouched.
 */
test('an uncorroborated ambiguous radical is LEFT ALONE, never guessed', () => {
  const md = 'On a √1-cos²y = x donc';
  const out = restoreBareRadicals(md, known(md));
  assert.equal(out.corroborated, 0);
  assert.equal(out.ambiguous, 1);
  assert.equal(out.text, md, 'the markdown is returned byte-for-byte');
});

test('an unambiguous atom is typeset silently — presentation, not a claim', () => {
  const out = restoreBareRadicals('x = -√2/2 alors', new Set<string>());
  assert.equal(out.atoms, 1);
  assert.equal(out.corroborated, 0);
  assert.ok(out.text.includes('$\\sqrt{2}$/2'), '√2/2 means (√2)/2 — typesetting says the same thing');
  assert.ok(!out.text.includes('radical-restored'), 'no mark: nothing was inferred');
});

test('√p(x) keeps its argument as the radicand', () => {
  const out = restoreBareRadicals('1er cas : √p(x) ≥ 0', new Set<string>());
  assert.ok(out.text.includes('$\\sqrt{p(x)}$'));
});

test('a radical already in LaTeX is never touched', () => {
  const md = '$$\\sqrt{x+6} + \\sqrt{x+1}$$';
  const out = restoreBareRadicals(md, known(md));
  assert.equal(out.text, md);
  assert.equal(out.atoms + out.corroborated + out.ambiguous, 0);
});

test('whitespace the OCR sprinkles in does not defeat the match', () => {
  const md = '$\\sqrt{x+6}$ and bare √x + 6 here';
  const out = restoreBareRadicals(md, known(md));
  assert.equal(out.corroborated, 1);
  // The whole `x + 6` is consumed, spaces and all — a stray `6` left behind would be a new error.
  assert.ok(out.text.includes('$\\sqrt{x+6}$</span> here'));
  assert.ok(!/6\s*here/.test(out.text.replace('\\sqrt{x+6}', '')), 'no orphaned operand');
});

test('the longest known radicand wins', () => {
  // With both `x+1` and `x+16` stated, `√x+16` must not be truncated to \sqrt{x+1}6.
  const md = '$\\sqrt{x+1}$ $\\sqrt{x+16}$ table: √x+16';
  const out = restoreBareRadicals(md, known(md));
  assert.ok(out.text.includes('$\\sqrt{x+16}$'));
  assert.ok(!out.text.includes('$\\sqrt{x+1}$6'));
});

test('pages without a radical are returned untouched and cheaply', () => {
  const md = 'aucune racine ici';
  assert.equal(restoreBareRadicals(md, new Set(['x+6'])).text, md);
});
