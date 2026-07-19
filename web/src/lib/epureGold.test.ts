import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEpureIr, type EpureIR } from './epureIr';
import { toPixelH, toPixelV, dist } from './epureMath';
import { reconstruct } from './epureReconstruct';

/**
 * The flagship end-to-end check, with zero model involvement anywhere: reconstruct E61(a) from
 * its hand-authored IR and require the computed fold to land ON the rabattu positions the book's
 * author drew with a compass in 1960-something. If the closed-form math and the plate agree, the
 * whole exact half of the pipeline — calibration, lifting, hinge, rotation, branch choice — is
 * validated against an independent construction of the same figure.
 *
 * Tolerances are asymmetric on purpose: A and B are tight (≤10px), C is looser (≤25px) because
 * the PLATE's own C_R is imprecise — its swing drifts 17px along the hinge, which a true
 * rabattement cannot do (see the note in fig01a.json). The reconstruction is held to the
 * geometry, not to the drawing's compass error.
 */

const IR_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../figures/dessin-scientifique/ir');

function loadIr(name: string): EpureIR {
  const raw = JSON.parse(readFileSync(path.join(IR_DIR, name), 'utf8'));
  const val = validateEpureIr(raw);
  assert.ok(val.ok, `IR ${name} invalid: ${val.ok ? '' : JSON.stringify(val.errors)}`);
  return (val as { ok: true; ir: EpureIR }).ir;
}

test('E61(a): the computed fold lands on the plate’s drawn rabattu', () => {
  const ir = loadIr('fig01a.json');
  const recon = reconstruct(ir);

  assert.equal(recon.fatal, false);
  assert.deepEqual(recon.warnings, []);
  const fold = recon.fold!;

  const gold: Record<string, { x: number; y: number; tol: number }> = {
    A: { x: 235, y: 461, tol: 10 },
    B: { x: 434, y: 494, tol: 10 },
    C: { x: 342, y: 730, tol: 25 }, // the plate's own C_R carries ~17px of compass drift
  };
  for (const [id, g] of Object.entries(gold)) {
    const px = toPixelH(recon.frame, fold.rabattu.get(id)!);
    const residual = Math.hypot(px.x - g.x, px.y - g.y);
    assert.ok(residual <= g.tol, `${id}_R off by ${residual.toFixed(1)}px (tol ${g.tol})`);
  }

  // A sits on the hinge: it barely moves. The authored A is ~3px off the drawn hinge line, and
  // a 122° swing on a 3px radius travels a ~5.4px chord — hence 8, not 0.
  assert.ok(dist(fold.rabattu.get('A')!, recon.points.get('A')!) < 8);

  // Every rabattu point lies at height 0, so its V projection sits ON the ground line — the
  // plate says the same thing with its B^V_R / C^V_R labels drawn on the LT.
  for (const id of ['A', 'B', 'C']) {
    const pv = toPixelV(recon.frame, fold.rabattu.get(id)!);
    assert.ok(Math.abs(pv.y - ir.groundLine.a.y) < 6, `${id}_R V-projection off the LT by ${Math.abs(pv.y - ir.groundLine.a.y).toFixed(1)}px`);
    assert.ok(Math.abs(fold.rabattu.get(id)!.z) < 6);
  }

  // The fold is rigid: the flattened triangle IS the true shape.
  const AB3d = dist(recon.points.get('A')!, recon.points.get('B')!);
  const ABflat = dist(fold.rabattu.get('A')!, fold.rabattu.get('B')!);
  assert.ok(Math.abs(AB3d - ABflat) < 1e-6);
});

test('E61(b): frontal hinge — the fold onto πV lands on the drawn rabattu', () => {
  const ir = loadIr('fig02b.json');
  const recon = reconstruct(ir);
  assert.equal(recon.fatal, false);
  assert.deepEqual(recon.warnings, []);
  const gold: Record<string, { x: number; y: number }> = {
    A: { x: 115, y: 185 }, B: { x: 233, y: 237 }, C: { x: 271, y: 44 },
  };
  for (const [id, g] of Object.entries(gold)) {
    const px = toPixelV(recon.frame, recon.fold!.rabattu.get(id)!);
    const residual = Math.hypot(px.x - g.x, px.y - g.y);
    assert.ok(residual <= 10, `${id}_R off by ${residual.toFixed(1)}px`);
    // Landed IN πV: depth ≈ 0 for every rabattu point.
    assert.ok(Math.abs(recon.fold!.rabattu.get(id)!.y) < 8);
  }
});

test('E61(c): a de-bout hinge drawn vertical — the fold onto πH sends B and C to opposite sides', () => {
  const ir = loadIr('fig02c.json');
  const recon = reconstruct(ir);
  assert.equal(recon.fatal, false);
  assert.deepEqual(recon.warnings, []);
  const gold: Record<string, { x: number; y: number }> = {
    A: { x: 520, y: 312 }, B: { x: 398, y: 457 }, C: { x: 598, y: 382 },
  };
  for (const [id, g] of Object.entries(gold)) {
    const px = toPixelH(recon.frame, recon.fold!.rabattu.get(id)!);
    const residual = Math.hypot(px.x - g.x, px.y - g.y);
    assert.ok(residual <= 10, `${id}_R off by ${residual.toFixed(1)}px`);
    assert.ok(Math.abs(recon.fold!.rabattu.get(id)!.z) < 8);
  }
  // B (above πH) and C (below) swing through the same fold to opposite sides of the hinge —
  // the plate draws exactly this, and it only happens when signed heights are handled right.
  const axisX = recon.fold!.axisPoint.x;
  assert.ok(recon.fold!.rabattu.get('B')!.x < axisX);
  assert.ok(recon.fold!.rabattu.get('C')!.x > axisX);
});
