import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEpureIr, type EpureIR } from './epureIr';
import { reconstruct } from './epureReconstruct';
import { buildEpureScene } from './epureScene';
import { DESSIN_SCIENTIFIQUE_IR } from './figures/dessinScientifiqueIr';

/**
 * The scene descriptor is the renderer's ONLY input, so these tests pin its contract: it must be
 * a closed, serializable value (the viewer is parametric — any figure-specific knowledge leaking
 * past this point is a design break), the projection planes must still BE the projection planes
 * after rescaling, and the fold must exclude points that sit on the hinge.
 */

function e61a(): EpureIR {
  const ir = DESSIN_SCIENTIFIQUE_IR['2:p2-b11']?.[0];
  assert.ok(ir, 'E61(a) missing from the generated module — run npm run build:epure-ir');
  const val = validateEpureIr(ir);
  assert.ok(val.ok);
  return ir;
}

test('E61(a) scene: planes, hinge, fold, labels — and it survives JSON round-trip', () => {
  const ir = e61a();
  const scene = buildEpureScene(ir, reconstruct(ir));

  // Serializability contract — a scene must be data, nothing else.
  assert.deepEqual(JSON.parse(JSON.stringify(scene)), scene);

  // Rescaling must keep πH at z=0 and πV at y=0 (they are defined by the frame, not the figure).
  assert.equal(scene.planes.h.min.z, 0);
  assert.equal(scene.planes.h.max.z, 0);
  assert.equal(scene.planes.v.min.y, 0);
  assert.equal(scene.planes.v.max.y, 0);

  // Normalized to a ~10-unit box (padded planes may exceed it slightly).
  const spread = Math.max(...scene.points.map((p) => Math.abs(p.p.x)), ...scene.points.map((p) => Math.abs(p.p.y)));
  assert.ok(spread <= 11, `scene too large: ${spread}`);

  assert.ok(scene.segments.some((s) => s.kind === 'hinge'));
  assert.ok(scene.segments.some((s) => s.kind === 'projector'));
  assert.ok(scene.segments.some((s) => s.kind === 'projectionV'));

  const fold = scene.fold!;
  assert.ok(Math.abs(fold.angle) > 0.1);
  assert.deepEqual(fold.polygon, ['A', 'B', 'C']);
  // Every point of E61a is at least slightly off the drawn hinge (A by ~3px), so all three move;
  // what matters is that the moving set is exactly the off-axis subset the reconstructor chose.
  const recon = reconstruct(ir);
  assert.deepEqual(fold.moving.map((m) => m.id).sort(), [...recon.fold!.movingIds].sort());

  // One spatial + one V + one H label per lifted point.
  for (const id of ['A', 'B', 'C']) {
    assert.equal(scene.labels.filter((l) => l.pointId === id).length, 3);
  }
});

test('each point carries its images in the two planes', () => {
  const ir = e61a();
  const scene = buildEpureScene(ir, reconstruct(ir));

  // The layer groups put dots straight on pv/ph, so a drift here is a drift on screen.
  for (const { p, pv, ph } of scene.points) {
    assert.equal(pv.y, 0, 'πV is y=0');
    assert.equal(ph.z, 0, 'πH is z=0');
    assert.equal(pv.x, p.x);
    assert.equal(pv.z, p.z, 'the V image keeps the cote');
    assert.equal(ph.x, p.x);
    assert.equal(ph.y, p.y, 'the H image keeps the éloignement');
  }
});

test('E61(a) folds onto πH — the side the book drew its rabattu on', () => {
  const ir = e61a();
  assert.equal(buildEpureScene(ir, reconstruct(ir)).fold!.onto, 'h');
});

test('the dièdre fold lays πH out below the ligne de terre', () => {
  const ir = e61a();
  const scene = buildEpureScene(ir, reconstruct(ir));

  // What the renderer does to πH's group at dihedralT=0, in closed form and without three.js:
  // a rotation about the ground line (the x-axis) by -π/2. Children of that group all have z=0.
  const foldH = (p: { x: number; y: number; z: number }, th: number) => ({
    x: p.x,
    y: p.y * Math.cos(th) - p.z * Math.sin(th),
    z: p.y * Math.sin(th) + p.z * Math.cos(th),
  });

  for (const { pv, ph } of scene.points) {
    const flat = foldH(ph, -Math.PI / 2);
    assert.ok(Math.abs(flat.y) < 1e-9, 'the H image lands in the plane of the sheet (πV, y=0)');
    assert.ok(Math.abs(flat.z + ph.y) < 1e-9, 'at z = -éloignement');
    // The printed plate: H below the ligne de terre, V above it. If these ever land on the same
    // side, the sheet stops matching the book and the fold is rotating the wrong way.
    if (ph.y > 1e-9) assert.ok(flat.z < 0, 'H below the LT');
    if (pv.z > 1e-9) assert.ok(pv.z > 0, 'V above the LT');
  }
});

test('flat, the scene reproduces the plate it was read from', () => {
  // The claim the Planche view makes to the reader, checked: fold πH about the ground line and
  // every image lands back on the pixels the figure was read at. This is what makes the flat view
  // a check rather than a decoration — if a reading drifts, it stops matching the drawing, and
  // that is visible on screen next to the plate.
  //
  // The tolerance is the reading's own internal disagreement, not slack: the reconstructor
  // averages each point's abscissa between the two views, so a V/H recall mismatch of ~5px on the
  // hand-measured plate shows up as ~2.5px here. Distances from the ligne de terre are taken
  // straight from the IR and come back exact.
  for (const irs of Object.values(DESSIN_SCIENTIFIQUE_IR)) {
    for (const ir of irs) {
      const recon = reconstruct(ir);
      const scene = buildEpureScene(ir, recon);

      // Recover the scale and x-shift the scene builder applied, from a point it kept. Use a
      // point that is OFF the ground line (non-zero cote or éloignement) — a point on the LT has
      // p.y = p.z = 0, so recovering k from its depth would divide by zero (fig49's A sits on it).
      const off = [...recon.points.entries()].find(([, p]) => Math.abs(p.y) > 1e-6 || Math.abs(p.z) > 1e-6)!;
      const [id0, p0] = off;
      const s0 = scene.points.find((p) => p.id === id0)!;
      const k = Math.abs(p0.y) > 1e-6 ? s0.p.y / p0.y : s0.p.z / p0.z;
      const xMid = p0.x - s0.p.x / k;

      const g = ir.groundLine;
      const len = Math.hypot(g.b.x - g.a.x, g.b.y - g.a.y);
      const ux = (g.b.x - g.a.x) / len;
      const uy = (g.b.y - g.a.y) / len;
      // From an abscissa along the LT and a signed distance across it, back to plate pixels.
      const back = (x: number, signed: number) => {
        const u = x / k + xMid;
        return { x: g.a.x + u * ux - signed * uy, y: g.a.y + u * uy + signed * ux };
      };

      for (const sp of scene.points) {
        const irp = ir.points.find((p) => p.id === sp.id)!;
        // V keeps its cote above the line; H folds to éloignement below it.
        const v = back(sp.pv.x, -sp.p.z / k);
        const h = back(sp.ph.x, sp.p.y / k);
        const label = `fig${ir.source.n}${ir.source.sub ?? ''} ${sp.id}`;
        if (irp.v) assert.ok(Math.hypot(v.x - irp.v.x, v.y - irp.v.y) < 8, `${label} V drifted off the plate`);
        if (irp.h) assert.ok(Math.hypot(h.x - irp.h.x, h.y - irp.h.y) < 8, `${label} H drifted off the plate`);
      }
    }
  }
});

test('recall segments are 2D bookkeeping and never reach the scene', () => {
  const ir = structuredClone(e61a());
  ir.segments.push({ from: 'A', to: 'B', view: 'v', style: 'recall' });
  const before = buildEpureScene(e61a(), reconstruct(e61a())).segments.length;
  const after = buildEpureScene(ir, reconstruct(ir)).segments.length;
  assert.equal(after, before);
});

test('a change_of_plane scene carries a serializable auxiliary and stays in the ~10-unit box', () => {
  // A minimal synthetic change of frontal plane, built directly (no plate needed): three points
  // and an L′ drawn in πH. The scene must serialize byte-for-byte and expose the aux construction.
  const ir: EpureIR = {
    version: 1,
    source: { book: 'synthetic', n: 0, page: 0, blockId: 'b0' },
    units: 'px',
    imageSize: { width: 800, height: 800 },
    groundLine: { a: { x: 40, y: 400 }, b: { x: 760, y: 400 } },
    points: [
      { id: 'A', v: { x: 200, y: 320 }, h: { x: 200, y: 470 }, role: 'vertex' },
      { id: 'B', v: { x: 360, y: 300 }, h: { x: 360, y: 520 }, role: 'vertex' },
      { id: 'C', v: { x: 300, y: 250 }, h: { x: 300, y: 560 }, role: 'vertex' },
    ],
    segments: [
      { from: 'A', to: 'B', view: 'h' },
      { from: 'B', to: 'C', view: 'h' },
      { from: 'C', to: 'A', view: 'h' },
    ],
    operation: {
      kind: 'change_of_plane',
      replaced: 'v',
      newGroundLine: { a: { x: 120, y: 560 }, b: { x: 520, y: 620 } },
      points: ['A', 'B', 'C'],
    },
  };
  const val = validateEpureIr(ir);
  assert.ok(val.ok, val.ok ? '' : JSON.stringify(val.errors));
  const scene = buildEpureScene(ir, reconstruct(ir));
  assert.deepEqual(JSON.parse(JSON.stringify(scene)), scene);
  assert.ok(scene.changePlane, 'change_of_plane scene field present');
  assert.equal(scene.changePlane!.aux.length, 3);
  assert.equal(scene.changePlane!.edges.length, 3, 'three drawn edges among the carried points');
  const spread = Math.max(...scene.changePlane!.aux.map((a) => Math.max(Math.abs(a.at.x), Math.abs(a.at.y), Math.abs(a.at.z))));
  assert.ok(spread <= 11, `aux points outside the box: ${spread}`);
});
