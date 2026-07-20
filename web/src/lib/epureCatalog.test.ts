import { test } from 'node:test';
import assert from 'node:assert/strict';
import { epureCoverageFor, epureFacts, epureFactsFr, epureFiguresFor, epureFiguresForSourceBlock } from './epureCatalog';
import { DESSIN_SCIENTIFIQUE_IR, DESSIN_SCIENTIFIQUE_STATUS } from './figures/dessinScientifiqueIr';
import { reconstruct } from './epureReconstruct';
import { figureSetFor } from './authoredFigures';
import type { Block, DocFile } from './types';

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
    ['E 61 (a)', 'E 61 (b)', 'E 61 (c)', 'E 61 (d)', 'E 62', 'E 63', 'E 64', 'E 65', 'E 66', 'E 67', 'E 68', 'E 69', 'E 70', 'E 71', 'E 72', 'E 73', 'E 74', 'E 75', 'E 76', 'E 77', 'fig 20', 'fig 21', 'E 80 (a)', 'E 80 (c)', 'E 80 (d)', 'fig 25', 'fig 26', 'fig 27', 'fig 28', 'fig 29 (b)', 'fig 30', 'fig 31', 'E 82', 'fig 33', 'E 85', 'E 86', 'E 87', 'E 88', 'fig 38', 'E 90', 'E 90', 'fig 41', 'fig 42', 'fig 43', 'fig 44', 'fig 45', 'fig 46', 'E 91', 'E 92', 'E 93', 'E 94', 'E 95', 'E 96', 'E 97', 'E 98', 'E 99', 'E 100', 'E 101', 'E 102', 'E 103', 'E 104', 'E 104', 'fig 62'],
  );
});

test('the catalog binds to the exact book, and answers before any OCR', () => {
  // No result on the doc at all — the IR and the plate are checked in, so the 3D needs no OCR.
  assert.equal(epureFiguresFor(doc()).length, 63);
  assert.equal(epureFiguresFor(doc({ pageCount: 50 })).length, 0, 'wrong page count is a different book');
  assert.equal(epureFiguresFor(doc({ name: 'notions-de-chimie-6.pdf' })).length, 0);
});

test('an extracted-image alias selects the 3D bound to the same source region', () => {
  const blocks = [
    { id: 'p40-b0', type: 'image', bbox: { x: 24, y: 55, w: 653, h: 422 }, text: 'upper' },
    { id: 'p40-b1', type: 'image', bbox: { x: 36, y: 531, w: 663, h: 434 }, text: 'lower' },
    { id: 'p40-i1', type: 'image', bbox: { x: 36, y: 531, w: 663, h: 434 }, text: 'img-1.jpeg' },
  ] as Block[];
  assert.deepEqual(
    epureFiguresForSourceBlock(doc(), 40, 'p40-i1', blocks).map((figure) => figure.label),
    ['E 97'],
  );
  assert.deepEqual(
    epureFiguresForSourceBlock(doc(), 40, 'p40-b0', blocks).map((figure) => figure.label),
    ['E 96'],
  );
});

test('the generated status inventory is the UI source for exact and partial coverage', () => {
  assert.equal(DESSIN_SCIENTIFIQUE_STATUS.length, 62);
  assert.equal(epureCoverageFor(doc(), 21, 'p21-b1')?.status, 'partial', 'fig 25 exposes incompatible recalls');
  assert.equal(epureCoverageFor(doc(), 20, 'p20-b8')?.status, 'exact', 'fig 23 has an exact point lift');
  assert.equal(epureCoverageFor(doc(), 19, 'p19-b17')?.status, 'partial', 'fig 21 exposes missing centres as red loci');
  assert.deepEqual(
    DESSIN_SCIENTIFIQUE_STATUS.reduce<Record<string, number>>((counts, entry) => {
      counts[entry.status] = (counts[entry.status] ?? 0) + 1;
      return counts;
    }, {}),
    { exact: 38, partial: 24 },
    'every numbered figure now opens an exact or partial 3D workspace',
  );
  for (const coverage of DESSIN_SCIENTIFIQUE_STATUS) {
    const figures = epureFiguresFor(doc()).filter((entry) => entry.pageIndex === coverage.pageIndex && entry.blockId === coverage.blockId);
    const hasWarning = figures.some((entry) => reconstruct(entry.ir).warnings.length > 0);
    assert.equal(coverage.status, hasWarning ? 'partial' : 'exact', `fig ${coverage.n} status reflects its reconstruction warnings`);
  }
  assert.equal(epureCoverageFor(doc({ name: 'other.pdf' }), 21, 'p21-b1'), null);
});

test('every IR overlay uses the authored SVG outer viewBox', () => {
  const authored = figureSetFor(doc());
  assert.ok(authored);
  for (const [key, irs] of Object.entries(DESSIN_SCIENTIFIQUE_IR)) {
    const svg: string | undefined = authored[key]?.svg;
    assert.ok(svg, `${key} authored SVG missing`);
    const match: RegExpMatchArray | null = svg.match(/viewBox=["']0 0 ([\d.]+) ([\d.]+)["']/);
    assert.ok(match, `${key} has no readable viewBox`);
    for (const ir of irs) {
      assert.deepEqual(ir.imageSize, { width: Number(match[1]), height: Number(match[2]) }, `fig ${ir.source.n} overlay frame`);
    }
  }
});

test('former 2D-only construction plates open partial 3D with red unresolved loci', () => {
  const expected = [
    [19, 'p19-b17'],
    [31, 'p31-b1'],
    [31, 'p31-b4'],
    [32, 'p32-b9'],
    [33, 'p33-b2'],
  ] as const;
  const figures = epureFiguresFor(doc());
  for (const [pageIndex, blockId] of expected) {
    const figure = figures.find((entry) => entry.pageIndex === pageIndex && entry.blockId === blockId);
    assert.ok(figure, `${pageIndex}:${blockId} is routed to the 3D workspace`);
    const reconstruction = reconstruct(figure.ir);
    assert.equal(reconstruction.fatal, false);
    assert.ok(reconstruction.warnings.some((warning) => warning.code === 'incomplete'));
    assert.ok((reconstruction.diagnostics?.rays.length ?? 0) > 0, 'unresolved coordinates produce red 3D loci');
  }
});
