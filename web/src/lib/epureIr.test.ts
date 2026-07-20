import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEpureIr, type EpureIR } from './epureIr';
import { DESSIN_SCIENTIFIQUE_IR } from './figures/dessinScientifiqueIr';

/**
 * The validator is the gate between a reading (hand-authored today, vision tomorrow) and the
 * deterministic reconstructor. Everything the reconstructor assumes without checking — unique
 * ids, both projections present, a usable hinge — must be refused HERE, with an error path a
 * human can act on, because past this gate a bad IR turns into confident wrong 3D.
 */

function minimalRabattement(): EpureIR {
  return {
    version: 1,
    source: { book: 'test', n: 1, page: 0, blockId: 'b0' },
    units: 'px',
    imageSize: { width: 100, height: 100 },
    groundLine: { a: { x: 0, y: 50 }, b: { x: 100, y: 50 } },
    points: [
      { id: 'A', v: { x: 10, y: 40 }, h: { x: 10, y: 60 } },
      { id: 'B', v: { x: 50, y: 20 }, h: { x: 50, y: 80 } },
      { id: 'C', v: { x: 80, y: 30 }, h: { x: 80, y: 70 } },
    ],
    segments: [
      { from: 'A', to: 'B', view: 'v' },
      { from: 'A', to: 'B', view: 'h' },
    ],
    operation: {
      kind: 'rabattement_plane',
      hingeKind: 'horizontal',
      hinge: { aH: { x: 0, y: 55 }, bH: { x: 100, y: 90 } },
      planePoints: ['A', 'B', 'C'],
    },
  };
}

test('every shipped IR passes the validator (self-consistency of generated data)', () => {
  for (const [key, irs] of Object.entries(DESSIN_SCIENTIFIQUE_IR)) {
    for (const ir of irs) {
      const res = validateEpureIr(ir);
      assert.ok(res.ok, `${key} fig ${ir.source.n}${ir.source.sub ?? ''}: ${res.ok ? '' : JSON.stringify(res.errors)}`);
    }
  }
});

test('accepts a well-formed rabattement IR', () => {
  const res = validateEpureIr(minimalRabattement());
  assert.equal(res.ok, true);
});

test('rejects duplicate point ids, pointing at the offender', () => {
  const ir = minimalRabattement();
  ir.points.push({ id: 'A', v: { x: 1, y: 1 }, h: { x: 1, y: 1 } });
  const res = validateEpureIr(ir);
  assert.equal(res.ok, false);
  if (!res.ok) assert.ok(res.errors.some((e) => e.path === 'points[3].id' && e.message.includes('duplicate')));
});

test('rejects an operation referencing a missing point', () => {
  const ir = minimalRabattement();
  (ir.operation as { planePoints: string[] }).planePoints = ['A', 'B', 'Z'];
  const res = validateEpureIr(ir);
  assert.equal(res.ok, false);
  if (!res.ok) assert.ok(res.errors.some((e) => e.path === 'operation.planePoints[2]' && e.message.includes('unknown point "Z"')));
});

test('rejects a moving point that has only one projection', () => {
  const ir = minimalRabattement();
  ir.points[2] = { id: 'C', v: { x: 80, y: 30 }, h: null };
  const res = validateEpureIr(ir);
  assert.equal(res.ok, false);
  if (!res.ok) assert.ok(res.errors.some((e) => e.message.includes('both projections')));
});

test('rejects a degenerate ground line', () => {
  const ir = minimalRabattement();
  ir.groundLine = { a: { x: 5, y: 5 }, b: { x: 5.5, y: 5 } };
  const res = validateEpureIr(ir);
  assert.equal(res.ok, false);
  if (!res.ok) assert.ok(res.errors.some((e) => e.path === 'groundLine' && e.message.includes('degenerate')));
});

test('rejects coordinates authored outside the source SVG viewBox', () => {
  const ir = minimalRabattement();
  ir.points[0].v = { x: 140, y: 20 };
  const res = validateEpureIr(ir);
  assert.equal(res.ok, false);
  if (!res.ok) assert.ok(res.errors.some((e) => e.path === 'points[0].v' && e.message.includes('outside imageSize')));
});

test('rejects a rabattu key that is not a plane point', () => {
  const ir = minimalRabattement();
  (ir.operation as { rabattu?: unknown }).rabattu = { view: 'h', points: { Z: { x: 1, y: 1 } } };
  const res = validateEpureIr(ir);
  assert.equal(res.ok, false);
  if (!res.ok) assert.ok(res.errors.some((e) => e.path === 'operation.rabattu.points.Z'));
});

test('rejects a horizontal hinge missing its H pair', () => {
  const ir = minimalRabattement();
  (ir.operation as { hinge: unknown }).hinge = { aV: { x: 0, y: 50 } };
  const res = validateEpureIr(ir);
  assert.equal(res.ok, false);
  if (!res.ok) assert.ok(res.errors.some((e) => e.path === 'operation.hinge' && e.message.includes('aH and bH')));
});

test('rejects non-finite coordinates', () => {
  const ir = minimalRabattement();
  ir.points[0].v = { x: Number.NaN, y: 40 };
  const res = validateEpureIr(ir);
  assert.equal(res.ok, false);
  if (!res.ok) assert.ok(res.errors.some((e) => e.path === 'points[0].v'));
});
