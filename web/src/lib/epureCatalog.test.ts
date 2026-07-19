import { test } from 'node:test';
import assert from 'node:assert/strict';
import { epureFacts, epureFactsFr, epureFiguresFor } from './epureCatalog';
import { DESSIN_SCIENTIFIQUE_IR } from './figures/dessinScientifiqueIr';
import type { DocFile } from './types';

/**
 * The catalog is the binding between a document and the readings that may be drawn over it, so
 * these tests pin the two things that go wrong silently: a prompt that drifts (and re-bills every
 * cached explanation), and a plate number invented from the wrong field.
 */

const doc = (over: Partial<DocFile> = {}): DocFile =>
  ({ id: 'd', name: '934002794-dessin-scientifique-6-Muselu.pdf', pageCount: 51, ...over }) as DocFile;

test('the facts handed to the model are byte-for-byte what they were', () => {
  // Captured from the implementation that produced every exp-<sha>.json on disk. Explanations are
  // cached under a hash of this prompt: if this string moves, every already-paid figure is re-billed.
  // Change it only deliberately, knowing that is the price.
  const expected = [
    'Opération : rabattement du polygone ABC autour de la charnière — une droite horizontale du plan (le rabattement se fait sur le plan horizontal π^H).',
    'Angle de rabattement calculé : 124.0°.',
    'Point(s) SUR la charnière (immobiles) : A.',
    'Vraie grandeur de AB : 201 unités du dessin.',
    'Vraie grandeur de BC : 257 unités du dessin.',
    'Vraie grandeur de CA : 296 unités du dessin.',
    'Le polygone rabattu est en VRAIE GRANDEUR : le rabattement est une rotation rigide.',
    'A : cote (hauteur) -3, éloignement 344 (unités du dessin).',
    'B : cote (hauteur) 70, éloignement 481 (unités du dessin).',
    'C : cote (hauteur) -136, éloignement 400 (unités du dessin).',
  ].join('\n');

  assert.equal(epureFactsFr(DESSIN_SCIENTIFIQUE_IR['2:p2-b11'][0]), expected);
});

test('the panel and the prompt state the same facts', () => {
  // Two readers, one set of numbers. A panel that disagreed with the prompt would be a second
  // claim about the figure.
  for (const irs of Object.values(DESSIN_SCIENTIFIQUE_IR)) {
    for (const ir of irs) {
      assert.equal(
        epureFacts(ir)
          .map((f) => f.text)
          .join('\n'),
        epureFactsFr(ir),
      );
    }
  }
});

test('per-point facts carry the point they describe', () => {
  const facts = epureFacts(DESSIN_SCIENTIFIQUE_IR['2:p2-b11'][0]);
  assert.deepEqual(
    facts.filter((f) => f.pointId).map((f) => f.pointId),
    ['A', 'B', 'C'],
  );
  // The operation lines are about the figure, not a point — they must not claim one.
  assert.ok(facts.some((f) => !f.pointId && f.text.startsWith('Opération')));
});

test('plate numbers come from the caption, not the figure index', () => {
  // E 61 spans fig01 (a) and fig02 (b, c): source.n is the index in figures.json, so deriving a
  // plate number from it would put "E 62" under two thirds of plate 61.
  assert.deepEqual(
    epureFiguresFor(doc()).map((f) => f.label),
    ['E 61 (a)', 'E 61 (b)', 'E 61 (c)', 'E 61 (d)', 'E 62', 'E 63', 'E 64', 'E 65', 'E 66', 'E 67', 'E 68', 'E 69', 'E 70', 'E 72', 'E 73', 'E 74', 'E 75', 'E 76', 'fig 20', 'fig 29 (b)', 'fig 30', 'fig 31', 'fig 33', 'fig 43', 'fig 44', 'E 93', 'E 94', 'E 95', 'E 97', 'E 99', 'E 100', 'E 102', 'E 103', 'E 104', 'E 104'],
  );
});

test('the catalog binds to the exact book, and answers before any OCR', () => {
  // No result on the doc at all — the IR and the plate are checked in, so the 3D needs no OCR.
  assert.equal(epureFiguresFor(doc()).length, 35);
  assert.equal(epureFiguresFor(doc({ pageCount: 50 })).length, 0, 'wrong page count is a different book');
  assert.equal(epureFiguresFor(doc({ name: 'notions-de-chimie-6.pdf' })).length, 0);
});
