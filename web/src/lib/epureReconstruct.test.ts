import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EpureIR, Vec2 } from './epureIr';
import { add, calibrateFrame, cross, dist, dot, normalize, rotateAboutAxis, scale, sub, toPixelH, toPixelV, type Vec3, v3 } from './epureMath';
import { reconstruct } from './epureReconstruct';

/**
 * The reconstructor is the exact half of the pipeline, so it is tested the exact way: build a
 * KNOWN 3D configuration, project it through a frame into an IR (the same double projection a
 * book plate encodes), and require the reconstruction to give the 3D back — through a tilted
 * ground line, about a hinge at non-zero height, on whichever side the gold says. Any looseness
 * here would let a bad reading masquerade as a good reconstruction.
 */

/** Project a 3D scene through a frame into IR points (what the épure's author does on paper). */
function project(groundLine: { a: Vec2; b: Vec2 }, pts: Record<string, Vec3>) {
  const frame = calibrateFrame(groundLine);
  return Object.entries(pts).map(([id, p]) => ({
    id,
    v: toPixelV(frame, p),
    h: toPixelH(frame, p),
  }));
}

function baseIr(groundLine: { a: Vec2; b: Vec2 }, pts: Record<string, Vec3>): EpureIR {
  return {
    version: 1,
    source: { book: 'synthetic', n: 0, page: 0, blockId: 'b0' },
    units: 'px',
    imageSize: { width: 800, height: 800 },
    groundLine,
    points: project(groundLine, pts),
    segments: [],
    operation: { kind: 'point_projection', points: Object.keys(pts) },
  };
}

const TILTED = { a: { x: 50, y: 300 }, b: { x: 650, y: 280 } };

test('round-trip lift through a tilted frame recovers 3D to 1e-9', () => {
  const pts = { A: v3(100, 40, 70), B: v3(250, 90, 20), C: v3(400, 10, 120) };
  const recon = reconstruct(baseIr(TILTED, pts));
  assert.equal(recon.warnings.length, 0);
  for (const [id, expected] of Object.entries(pts)) {
    const got = recon.points.get(id)!;
    assert.ok(dist(got, expected) < 1e-9, `${id}: off by ${dist(got, expected)}`);
  }
  // Inverse maps invert exactly
  const frame = recon.frame;
  const pxV = toPixelV(frame, recon.points.get('B')!);
  const irB = baseIr(TILTED, pts).points.find((p) => p.id === 'B')!;
  assert.ok(Math.hypot(pxV.x - irB.v!.x, pxV.y - irB.v!.y) < 1e-9);
});

test('a broken recall line yields exactly one warning and an averaged abscissa', () => {
  const gl = { a: { x: 0, y: 400 }, b: { x: 700, y: 400 } }; // horizontal: pixel x IS the abscissa
  const ir = baseIr(gl, { A: v3(100, 50, 60), B: v3(300, 30, 90) });
  ir.points.find((p) => p.id === 'A')!.v!.x += 12;
  const recon = reconstruct(ir);
  const flags = recon.warnings.filter((w) => w.code === 'recall-mismatch');
  assert.equal(flags.length, 1);
  assert.ok(Math.abs(flags[0].magnitudePx! - 12) < 1e-9);
  assert.ok(Math.abs(recon.points.get('A')!.x - 106) < 1e-9); // (112 + 100) / 2
});

/** A plane figure hinged on a horizontal line at height 200 — the arbitrary-height case. */
function rabattementFixture() {
  const A0 = v3(0, 100, 200);
  const d = v3(1, 0.5, 0); // horizontal direction (z = 0), oblique in H
  const q = v3(0, -0.4, 1); // out-of-plane-of-πH direction; span(d, q) is the moving plane
  const at = (a: number, b: number) => v3(A0.x + a * d.x + b * q.x, A0.y + a * d.y + b * q.y, A0.z + a * d.z + b * q.z);
  const pts = { A: at(50, 0), B: at(200, 150), C: at(30, 220) }; // A is ON the hinge
  const gl = { a: { x: 0, y: 500 }, b: { x: 700, y: 500 } };
  const frame = calibrateFrame(gl);
  const ir = baseIr(gl, pts);
  ir.operation = {
    kind: 'rabattement_plane',
    hingeKind: 'horizontal',
    hinge: {
      aH: toPixelH(frame, A0),
      bH: toPixelH(frame, at(300, 0)),
      aV: toPixelV(frame, A0),
      bV: toPixelV(frame, at(300, 0)),
    },
    planePoints: ['A', 'B', 'C'],
  };
  return { ir, pts, A0, frame };
}

test('rabattement about a horizontal hinge at z=200 lands flat AT 200, not 0', () => {
  const { ir, pts } = rabattementFixture();
  const recon = reconstruct(ir);
  assert.equal(recon.fatal, false);
  assert.equal(recon.warnings.filter((w) => w.code === 'not-coplanar').length, 0);
  const fold = recon.fold!;
  for (const id of ['A', 'B', 'C']) {
    assert.ok(Math.abs(fold.rabattu.get(id)!.z - 200) < 1e-6, `${id} lands at z=${fold.rabattu.get(id)!.z}`);
  }
  // A sits on the hinge: excluded from the moving set, fixed in place
  assert.deepEqual(fold.movingIds.sort(), ['B', 'C']);
  assert.ok(dist(fold.rabattu.get('A')!, recon.points.get('A')!) < 1e-9);
  // Rigid: true lengths preserved through the fold
  const AB = dist(pts.A, pts.B);
  assert.ok(Math.abs(dist(fold.rabattu.get('A')!, fold.rabattu.get('B')!) - AB) < 1e-6);
});

test('collinear plane points are fatal', () => {
  const { ir } = rabattementFixture();
  const pts = { A: v3(0, 100, 200), B: v3(100, 120, 250), C: v3(200, 140, 300) }; // one straight line
  ir.points = project(ir.groundLine, pts);
  const recon = reconstruct(ir);
  assert.equal(recon.fatal, true);
  assert.ok(recon.warnings.some((w) => w.code === 'collinear'));
});

test('gold rabattu on either side selects the matching fold branch', () => {
  const { ir, frame } = rabattementFixture();
  const free = reconstruct(ir); // no gold: some branch
  const fold = free.fold!;
  const other = fold.angle > 0 ? fold.angle - Math.PI : fold.angle + Math.PI;

  const goldFor = (ang: number) => {
    const points: Record<string, Vec2> = {};
    for (const id of ['A', 'B', 'C']) {
      points[id] = toPixelH(frame, rotateAboutAxis(free.points.get(id)!, fold.axisPoint, fold.axisDir, ang));
    }
    return { view: 'h' as const, points };
  };

  for (const ang of [fold.angle, other]) {
    const withGold = structuredClone(ir);
    (withGold.operation as { rabattu?: unknown }).rabattu = goldFor(ang);
    const recon = reconstruct(withGold);
    assert.ok(Math.abs(recon.fold!.angle - ang) < 1e-9, `expected branch ${ang}, got ${recon.fold!.angle}`);
    assert.equal(recon.warnings.filter((w) => w.code === 'rabattu-vs-authored').length, 0);
  }
});

test('a gold rabattu the fold cannot reach is flagged, not absorbed', () => {
  const { ir } = rabattementFixture();
  (ir.operation as { rabattu?: unknown }).rabattu = {
    view: 'h',
    points: { B: { x: 9999, y: 9999 } }, // nowhere near either branch
  };
  const recon = reconstruct(ir);
  assert.ok(recon.warnings.some((w) => w.code === 'rabattu-vs-authored'));
});

test('line_true_length returns the analytic distance', () => {
  const pts = { A: v3(100, 40, 70), B: v3(250, 90, 20) };
  const ir = baseIr(TILTED, pts);
  ir.operation = { kind: 'line_true_length', from: 'A', to: 'B' };
  const recon = reconstruct(ir);
  assert.ok(Math.abs(recon.trueLength! - Math.hypot(150, 50, 50)) < 1e-9);
});

/**
 * A cube-ish solid cut by the plane y = 20. The three plane points and the section vertices all
 * sit at depth 20 (`offPlaneShift` on S2 lets a test lift one vertex OFF the plane). Projecting a
 * genuinely coplanar section and asking the reconstruction to confirm it is the same round-trip
 * discipline as the rest of this file: a wrong reading must not pass as a valid section.
 */
function sectionFixture(offPlaneShift = 0): EpureIR {
  const solid = {
    A: v3(80, 0, 0), B: v3(300, 0, 0), C: v3(300, 60, 0), D: v3(80, 60, 0),
    E: v3(80, 0, 160), F: v3(300, 0, 160), G: v3(300, 60, 160), H: v3(80, 60, 160),
  };
  const plane = { P0: v3(90, 20, 10), P1: v3(290, 20, 10), P2: v3(90, 20, 150) };
  const section = { S1: v3(140, 20, 30), S2: v3(260, 20 + offPlaneShift, 30), S3: v3(200, 20, 130) };
  const gl = { a: { x: 40, y: 400 }, b: { x: 700, y: 400 } };
  const ir = baseIr(gl, { ...solid, ...plane, ...section });
  ir.operation = {
    kind: 'solid_section',
    solid: Object.keys(solid),
    planePoints: ['P0', 'P1', 'P2'],
    section: Object.keys(section),
  };
  return ir;
}

test('solid_section: a coplanar section reports the cut with no warning', () => {
  const recon = reconstruct(sectionFixture());
  assert.equal(recon.fatal, false);
  assert.equal(recon.warnings.filter((w) => w.code === 'section-off-plane').length, 0);
  assert.ok(recon.section, 'section reported');
  assert.deepEqual(recon.section!.polygon, ['S1', 'S2', 'S3']);
  assert.ok(Math.abs(Math.abs(recon.section!.normal.y) - 1) < 1e-9, 'normal is the depth axis');
});

test('solid_section: a section vertex off the cutting plane is flagged with its magnitude', () => {
  const recon = reconstruct(sectionFixture(25));
  const w = recon.warnings.find((w) => w.code === 'section-off-plane');
  assert.ok(w, 'section-off-plane fired');
  assert.ok(Math.abs(w!.magnitudePx! - 25) < 1e-6, `magnitude ${w!.magnitudePx}`);
});

test('solid_section: collinear cutting-plane points are fatal', () => {
  const ir = sectionFixture();
  (ir.operation as { planePoints: [string, string, string] }).planePoints = ['A', 'B', 'E'];
  // A, B, E are three cube corners; force collinearity by putting E on the A→B line.
  const eb = ir.points.find((p) => p.id === 'E')!;
  const ab = ir.points.find((p) => p.id === 'B')!;
  eb.v = { ...ab.v! };
  eb.h = { ...ab.h! };
  const recon = reconstruct(ir);
  assert.equal(recon.fatal, true);
  assert.ok(recon.warnings.some((w) => w.code === 'collinear'));
});

/**
 * A change of frontal plane (replaced='v'): the object is fixed, L′ is a line drawn in πH, and the
 * auxiliary view is DERIVED. The test builds L′ from two z=0 anchors so the new-plane math has a
 * known ground line, then checks the two invariants the family stands on — heights are preserved,
 * the auxiliary lands on the new plane — and that the authored auxiliary gold-check behaves like
 * the rabattu one (selects the unfold side, flags an unreachable reading).
 */
function changePlaneFixture(): { ir: EpureIR; pts: Record<string, Vec3> } {
  const pts = { A: v3(120, 40, 90), B: v3(300, 80, 40), C: v3(430, 20, 130), D: v3(210, 110, 70) };
  const gl = { a: { x: 40, y: 400 }, b: { x: 700, y: 400 } };
  const frame = calibrateFrame(gl);
  const ir = baseIr(gl, pts);
  const La3 = v3(60, 30, 0), Lb3 = v3(500, 160, 0); // L′ lives in πH (z=0)
  ir.operation = {
    kind: 'change_of_plane',
    replaced: 'v',
    newGroundLine: { a: toPixelH(frame, La3), b: toPixelH(frame, Lb3) },
    points: Object.keys(pts),
  };
  return { ir, pts };
}

test('change_of_plane: the auxiliary projection preserves heights and lands on the new plane', () => {
  const { ir, pts } = changePlaneFixture();
  const cp = reconstruct(ir).changePlane!;
  assert.equal(cp.preserved, 'z');
  for (const [id, P] of Object.entries(pts)) {
    const a = cp.auxProj.get(id)!;
    assert.ok(Math.abs(a.z - P.z) < 1e-9, `${id}: height not preserved`);
    const off =
      (a.x - cp.axisPoint.x) * cp.planeNormal.x +
      (a.y - cp.axisPoint.y) * cp.planeNormal.y +
      (a.z - cp.axisPoint.z) * cp.planeNormal.z;
    assert.ok(Math.abs(off) < 1e-9, `${id}: not on the new plane`);
  }
});

test('change_of_plane: authored auxiliary picks the matching unfold side, with no warning', () => {
  const { ir } = changePlaneFixture();
  const base = reconstruct(ir);
  const cp = base.changePlane!;
  const frame = base.frame;
  for (const ang of [Math.PI / 2, -Math.PI / 2]) {
    const gold: Record<string, Vec2> = {};
    for (const [id, P] of cp.auxProj) gold[id] = toPixelH(frame, rotateAboutAxis(P, cp.axisPoint, cp.axisDir, ang));
    const withGold = structuredClone(ir);
    (withGold.operation as { auxiliary?: unknown }).auxiliary = gold;
    const r = reconstruct(withGold);
    assert.ok(Math.abs(r.changePlane!.unfoldAngle - ang) < 1e-9, `expected ${ang}, got ${r.changePlane!.unfoldAngle}`);
    assert.equal(r.warnings.filter((w) => w.code === 'aux-vs-authored').length, 0);
  }
});

test('change_of_plane: an unreachable authored auxiliary is flagged, not absorbed', () => {
  const { ir } = changePlaneFixture();
  (ir.operation as { auxiliary?: unknown }).auxiliary = { A: { x: 9999, y: 9999 } };
  assert.ok(reconstruct(ir).warnings.some((w) => w.code === 'aux-vs-authored'));
});

/**
 * A double change of plane brings an OBLIQUE plane figure to true shape — which a single change
 * cannot. The 3D points stay fixed; the test lays a regular hexagon on an oblique plane, projects
 * it, and hands the reconstructor the two ground lines a draughtsman would use: L′ parallel to the
 * horizontal trace (turning the plane edge-on) and L″ parallel to that edge (making the plane
 * parallel to the new plane). The second auxiliary must then reproduce the figure's REAL distances
 * — the defining property of a true-shape view — and the gold check must behave like the others.
 */
function doubleChangeFixture() {
  const gl = { a: { x: 0, y: 400 }, b: { x: 800, y: 400 } };
  const frame = calibrateFrame(gl);
  const m = normalize(v3(0.3, 0.5, 1)); // oblique plane normal
  const e1 = normalize(cross(m, v3(0, 0, 1))); // orthonormal in-plane basis
  const e2 = cross(m, e1);
  const C = v3(400, 120, 150);
  const r = 90;
  const ids = ['A', 'B', 'C', 'D', 'E', 'F'];
  const pts: Record<string, Vec3> = {};
  ids.forEach((id, i) => {
    const th = (i * Math.PI) / 3;
    pts[id] = add(C, add(scale(e1, r * Math.cos(th)), scale(e2, r * Math.sin(th))));
  });

  const ir = baseIr(gl, pts);
  // Change 1: L′ ∥ the horizontal projection of m ⇒ the plane goes edge-on in aux-1.
  const axisDir1 = normalize(v3(m.x, m.y, 0));
  const Q1 = v3(150, 300, 0); // any point of πH (z = 0); position only translates
  const newGroundLine1 = { a: toPixelH(frame, Q1), b: toPixelH(frame, add(Q1, scale(axisDir1, 120))) };
  // Reproduce change-1 internals to place L″ and force the +90° unfold via an auxiliary-1 gold.
  const n1 = normalize(cross(axisDir1, v3(0, 0, 1)));
  const proj1 = (P: Vec3) => sub(P, scale(n1, dot(n1, sub(P, Q1))));
  const ang1 = Math.PI / 2;
  const auxiliary1: Record<string, Vec2> = {};
  for (const id of ids) auxiliary1[id] = toPixelH(frame, rotateAboutAxis(proj1(pts[id]), Q1, axisDir1, ang1));
  // Change 2: L″ ∥ the plane's edge line (cross(m, n1)), a line of π1′, given in the drawn frame.
  const edgeDir = normalize(cross(m, n1));
  const R = proj1(pts['A']); // a point of π1′
  const toDrawn = (P: Vec3) => toPixelH(frame, rotateAboutAxis(P, Q1, axisDir1, ang1)); // π1′ → πH
  const newGroundLine2 = { a: toDrawn(R), b: toDrawn(add(R, scale(edgeDir, 120))) };

  ir.operation = { kind: 'double_change_of_plane', replaced1: 'v', newGroundLine1, newGroundLine2, points: ids, auxiliary1 };
  return { ir, pts, ids };
}

test('double_change_of_plane: the second auxiliary reproduces the figure\'s true shape', () => {
  const { ir, pts, ids } = doubleChangeFixture();
  const d = reconstruct(ir).doubleChangePlane!;
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const real = dist(pts[ids[i]], pts[ids[j]]);
      const shape = dist(d.auxProj2.get(ids[i])!, d.auxProj2.get(ids[j])!);
      assert.ok(Math.abs(real - shape) < 1e-6, `${ids[i]}${ids[j]}: true shape ${shape.toFixed(3)} vs real ${real.toFixed(3)}`);
    }
});

test('double_change_of_plane: unfolding to the sheet is rigid (distances survive both folds)', () => {
  const { ir, ids } = doubleChangeFixture();
  const d = reconstruct(ir).doubleChangePlane!;
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const space = dist(d.auxProj2.get(ids[i])!, d.auxProj2.get(ids[j])!);
      const flat = dist(d.trueFlat.get(ids[i])!, d.trueFlat.get(ids[j])!);
      assert.ok(Math.abs(space - flat) < 1e-6, `${ids[i]}${ids[j]}: unfold not rigid`);
    }
});

test('double_change_of_plane: the drawn true shape is the gold — matching passes, garbage flags', () => {
  const { ir } = doubleChangeFixture();
  const base = reconstruct(ir).doubleChangePlane!;
  const frame = calibrateFrame(ir.groundLine);
  const gold: Record<string, Vec2> = {};
  for (const [id, P] of base.trueFlat) gold[id] = toPixelH(frame, P);
  const good = structuredClone(ir);
  (good.operation as { trueShape?: unknown }).trueShape = gold;
  assert.equal(reconstruct(good).warnings.filter((w) => w.code === 'true-shape-vs-authored').length, 0);
  const bad = structuredClone(ir);
  (bad.operation as { trueShape?: unknown }).trueShape = { A: { x: 9999, y: 9999 } };
  assert.ok(reconstruct(bad).warnings.some((w) => w.code === 'true-shape-vs-authored'));
});
