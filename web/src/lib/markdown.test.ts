import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from './markdown';

/** Strip tags to see what text is actually visible to the reader. */
const visible = (html: string) => html.replace(/<[^>]+>/g, '');

test('math inside a table cell renders as KaTeX, not leaked SVG path text', () => {
  // The exact failure class from Maitriser-Les-Maths p.26: a √ radical in a table cell used to
  // spill KaTeX's SVG <path> coordinates (…400000v40…) as visible text.
  const md = ['| m | conclusion |', '| --- | --- |', '| $\\frac{\\sqrt{2}}{2}$ | racine double |'].join('\n');
  const html = renderMarkdown(md);

  assert.match(html, /<td/, 'the table itself must render');
  assert.match(html, /katex/, 'the cell math must render as KaTeX, not raw source');
  assert.doesNotMatch(visible(html), /400000v40/, 'KaTeX SVG path data must not leak into the cell text');
  assert.doesNotMatch(visible(html), /c0\.7,0,35\.3/, 'no coordinate fragments in the visible text');
});

test('a bare √ in a table cell does not leak path data either', () => {
  const md = ['| a | b |', '| --- | --- |', '| $\\sqrt{2}$ | + |'].join('\n');
  assert.doesNotMatch(visible(renderMarkdown(md)), /400000v40/);
});

test('paragraph math still typesets (no regression)', () => {
  const html = renderMarkdown('La valeur est $\\frac{1-\\sqrt{2}}{2}$ ici.');
  assert.match(html, /katex/, 'paragraph math should render');
  assert.doesNotMatch(visible(html), /400000v40/);
  assert.match(visible(html), /La valeur est/, 'surrounding prose is preserved');
});

test('display math and bare power-of-ten still render', () => {
  assert.match(renderMarkdown('$$x^2 + 1$$'), /katex/);
  assert.match(renderMarkdown('la masse 10^{-3} kg'), /katex/, 'bare power-of-ten is still typeset');
});

test('a table with no math is untouched', () => {
  const md = ['| x | y |', '| --- | --- |', '| 1 | 2 |'].join('\n');
  const html = renderMarkdown(md);
  assert.match(html, /<td[^>]*>1<\/td>/);
});

/**
 * Mistral drops math delimiters inside table cells: the same page writes `$V_1, V_2$` in prose and
 * `|  V_{1} | V_{2} |` in the table below it, which printed as literal `V_{1}` in the book. Nothing
 * is inferred by typesetting these — `V_{1}` IS the LaTeX for V₁; only the `$` was missing.
 */
test('bare subscripts in a table cell are typeset', () => {
  const html = renderMarkdown('|  P_{1} | P_{2} |\n| --- | --- |\n|  V_{1} | V_{2}  |', new Map());
  assert.ok(html.includes('katex'), 'the cells are typeset');
  assert.ok(!html.includes('V_{1}'), 'no raw LaTeX source is left visible');
});

test('a bare subscript without braces is typeset', () => {
  const html = renderMarkdown('Soit F_3 = { a_1, a_2 }', new Map());
  assert.ok(html.includes('katex'));
  assert.ok(!/>[^<]*a_1/.test(html), 'a_1 is not left as literal text');
});

/** The guard that matters most: this pass must never touch ordinary prose or identifiers. */
test('underscores in words and markdown emphasis are NOT touched', () => {
  const snake = renderMarkdown('the snake_case name and file_1.txt here', new Map());
  assert.ok(snake.includes('snake_case'), 'snake_case survives');
  assert.ok(snake.includes('file_1.txt'), 'file_1.txt survives');
  assert.ok(!snake.includes('katex'), 'nothing was typeset');

  const em = renderMarkdown('a _mot_ souligné', new Map());
  assert.ok(/<em>mot<\/em>/.test(em), 'markdown emphasis still works');
  assert.ok(!em.includes('katex'));
});

test('an undelimited LaTeX command run is typeset', () => {
  const html = renderMarkdown("D'où : q = \\sqrt[k+1]{\\frac{b}{a}}", new Map());
  assert.ok(html.includes('katex'), 'the root is typeset');
  assert.ok(!html.includes('\\frac'), 'no raw \\frac is left visible');
});

/** KaTeX is the arbiter: what it refuses must survive untouched, never be replaced by a guess. */
test('text KaTeX cannot parse is left exactly as it was', () => {
  const html = renderMarkdown('un \\notacommand{x} ici', new Map());
  assert.ok(html.includes('\\notacommand{x}'), 'invalid LaTeX is preserved verbatim');
});

test('math already inside delimiters is untouched by the bare passes', () => {
  const html = renderMarkdown('$V_1, V_2$ et $V_3$', new Map());
  assert.ok(html.includes('katex'));
  assert.ok(!html.includes('$'), 'delimiters are consumed exactly once');
});

/** From p.196: `|  x_{i} | n_{i} | n_{i}x_{i}  |` — a trailing-boundary lookahead left this whole
 *  cell as raw source, because two subscripted identifiers butt together with nothing between. */
test('adjacent subscripted identifiers both typeset (n_{i}x_{i})', () => {
  const html = renderMarkdown('|  x_{i} | n_{i} | n_{i}x_{i}  |\n| --- | --- | --- |\n| 10 | 3 | 30 |', new Map());
  assert.ok(!html.includes('n_{i}'), 'no raw source left in the cell');
  assert.ok(!html.includes('x_{i}'));
});

test('an unbraced subscript is not split mid-number (x_12)', () => {
  const html = renderMarkdown('valeur x_12 ici', new Map());
  assert.ok(html.includes('x_12'), 'x_12 is left alone rather than typeset as x_1 followed by 2');
});

/** `lim_{-1}` must not be mistaken for an `m_{-1}` subscript hiding inside the word "lim". */
test('a subscript inside a word is not typeset', () => {
  const html = renderMarkdown('car lim_{-1} vaut ∞', new Map());
  assert.ok(html.includes('lim_{-1}'), 'the word survives intact');
});

/**
 * Ordering regression (p.103): the sub/superscript pass used to stash the `q^{3}` inside
 * `\frac{x}{q^{3}}` before the command pass could claim the whole expression, leaving KaTeX a
 * placeholder it could not parse — so `\frac` printed as source with a stray typeset q³ beside it.
 * Whole expressions must be claimed before their parts.
 */
test('an undelimited \\frac containing an exponent renders whole', () => {
  const html = renderMarkdown('la raison : \\frac{x}{q^{3}} ici', new Map());
  assert.ok(!html.includes('\\frac'), 'the fraction is typeset, not left as source');
  assert.ok(html.includes('katex'));
});
