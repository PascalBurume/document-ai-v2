import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSuspects, type SuspectKind } from './suspects';

/** Every suspect kind produced for a markdown string. */
function kinds(md: string): SuspectKind[] {
  return findSuspects(md).map((s) => s.kind);
}

/** The exact substrings the scan flagged, in order. */
function flagged(md: string): string[] {
  return findSuspects(md).map((s) => md.slice(s.start, s.end));
}

test('accent inconsistency: the same word bare and accented flags the minority form', () => {
  // "matière" appears twice, "matiere" once — the bare minority is the suspect.
  const md = 'La matière change. La matière chauffe. La matiere refroidit.';
  const hits = findSuspects(md).filter((s) => s.kind === 'accent');
  assert.equal(hits.length, 1);
  assert.equal(md.slice(hits[0].start, hits[0].end), 'matiere');
  assert.match(hits[0].note, /matière/);
});

test('accent inconsistency: a word only ever accented is NOT flagged', () => {
  const md = 'La matière et la matière encore.';
  assert.equal(kinds(md).filter((k) => k === 'accent').length, 0);
});

test('mojibake: replacement char and a UTF-8 mis-decode are caught', () => {
  assert.ok(kinds('le d�but').includes('mojibake'));
  assert.ok(kinds('composÃ©e').includes('mojibake'));
});

test('digit-in-word: an l/1 confusion is flagged but a chemistry formula is not', () => {
  assert.ok(flagged('un artic1e clair').includes('c1e'));
  // H2O / CO2 must stay clean — the whole point of the narrow rule.
  assert.equal(kinds("L'eau est H2O et le gaz CO2.").filter((k) => k === 'digit-in-word').length, 0);
});

test('garble: a vowel-less word is flagged', () => {
  assert.ok(kinds('the bcdfg word').includes('rare-ngram'));
  assert.equal(kinds('the chemistry word').filter((k) => k === 'rare-ngram').length, 0);
});

test('stray caps: a capital marooned mid-word is flagged', () => {
  assert.ok(kinds('la chiMie moderne').includes('stray-caps'));
  assert.equal(kinds('la Chimie moderne').filter((k) => k === 'stray-caps').length, 0);
});

test('code, math and page anchors are never flagged', () => {
  // bare "matiere" lives only inside code / math / a comment, next to accented forms in prose.
  const md = 'matière matière `matiere` $matiere$ <!-- matiere -->';
  assert.equal(kinds(md).filter((k) => k === 'accent').length, 0);
});

test('spans are sorted and non-overlapping', () => {
  const md = 'artic1e chiMie d�but bcdfg matière matiere';
  const s = findSuspects(md);
  for (let i = 1; i < s.length; i++) assert.ok(s[i].start >= s[i - 1].end, 'spans overlap or unsorted');
});

test('path-data: SVG/coordinate garbage emitted as text is flagged', () => {
  const garbage =
    's173,378,173,378c0.7,0,35.3,-71,104,-213c68.7,-142,137.5,-285,206.5 H400000v40H845.2724 M834 80h400000v40h-400000z';
  const hits = findSuspects(garbage).filter((s) => s.kind === 'path-data');
  assert.equal(hits.length >= 1, true, 'the coordinate run should be flagged');
});

test('path-data: ordinary numeric prose is NOT flagged', () => {
  const clean = [
    'Les valeurs sont 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15 et plus.', // number list (comma+space)
    'la première perd 14 000 hommes, la seconde 6 000 sur un total de 50 000 et 60 000.', // money
    'le point A(3, 5) et B(-2, 7,5) sur le repère; x1 = -3, x2 = 5,7.', // coordinates in prose
    '| x | -3 | 0 | 3 | +5 | -7 | 0 | +2 | -1 | 0 | +4 |', // a sign table
    'pi vaut 3,14159 et e vaut 2,71828 environ dans ce calcul précis.', // decimals
    // Real page-154 case: a digit list with no spaces, right before the next problem number.
    'Combien de nombres de 8 chiffres différents peut-on former avec les chiffres 0,1,2,3,4,5,6\n143. A l’occasion de son 20e anniversaire',
    'Les points sont (1,2),(3,4),(5,6),(7,8),(9,10),(11,12) sur le repère orthonormé.', // compact coord pairs
  ];
  for (const s of clean) {
    assert.equal(
      findSuspects(s).filter((h) => h.kind === 'path-data').length,
      0,
      `false positive on: ${s}`,
    );
  }
});

test('clean prose yields nothing', () => {
  assert.deepEqual(findSuspects('Une phrase parfaitement normale et correcte.'), []);
});

/**
 * The bare-radical class, found live in the Maitriser-Maths book: the same OCR pass emits
 * `\sqrt{x+6}` correctly in prose and then a bare `√x+6` inside table cells — 128 times across 29
 * pages. The overbar is what records the radicand's reach, so a bare glyph silently turns √(x+6)
 * into something a reader parses as (√x)+6. Unrecoverable from text; only findable.
 */
test('bare-radical: a √ typed as a character is flagged', () => {
  const s = findSuspects('|  √x+6 |  | 0 | + |');
  const hit = s.find((x) => x.kind === 'bare-radical');
  assert.ok(hit, 'the bare radical in a table cell is flagged');
  assert.ok(hit!.note.includes('overbar'), 'the note names what was lost');
});

test('bare-radical: the underline covers the radical and its reach, not a lone glyph', () => {
  const md = 'valeur √x+6 ici';
  const hit = findSuspects(md).find((x) => x.kind === 'bare-radical')!;
  assert.equal(md.slice(hit.start, hit.end), '√x+6');
});

test('bare-radical: a properly expressed \\sqrt is NOT flagged', () => {
  // The whole point: this fires only where the OCR failed to use LaTeX. `ignoreMask` covers math.
  assert.equal(findSuspects('$$\\sqrt{x+6} + \\sqrt{x+1} < \\sqrt{7x+4}$$').length, 0);
  assert.equal(findSuspects('inline $\\sqrt{2}$ math').filter((s) => s.kind === 'bare-radical').length, 0);
});

test('bare-radical: recall-biased — even an unambiguous √2 is flagged', () => {
  // Deliberate. Precision is not the trade this project makes: a glance costs nothing, a silently
  // regrouped inequality costs the book.
  assert.equal(findSuspects('x = -√2/2 alors').filter((s) => s.kind === 'bare-radical').length, 1);
});
