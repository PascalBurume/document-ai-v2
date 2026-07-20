/**
 * Scene descriptor for the épure viewer — the last hand-off in the pipeline. It is fully
 * JSON-serializable and carries everything the renderer needs, so the viewer stays parametric:
 * written once, it serves every figure, and nothing downstream of this file knows what E61 is.
 *
 * This is also where pixel units die. The reconstructor works in pixels so its output can be
 * checked against the plate; the scene is rescaled to a ~10-unit box, translated only along the
 * ground line (πH must stay z=0 and πV y=0 — scaling and x-shifts preserve the planes, other
 * moves would not).
 */

import type { EpureIR } from './epureIr';
import type { Reconstruction, ReconWarning } from './epureReconstruct';
import type { DiagnosticLocus } from './epureAssumptions';
import { add, cross, dot, normalize, scale, sub, toPixelH, toPixelV, type Vec3, v3 } from './epureMath';

export type SegmentKind = 'spatial' | 'projectionV' | 'projectionH' | 'projector' | 'hinge' | 'sectionEdge' | 'projectionAux';

export interface EpureScene {
  version: 1;
  caption?: string;
  planes: { h: { min: Vec3; max: Vec3 }; v: { min: Vec3; max: Vec3 } };
  groundLine: { a: Vec3; b: Vec3 };
  /** Each point in space, with its image in each projection plane (`pv` in πV, `ph` in πH). */
  points: { id: string; p: Vec3; pv: Vec3; ph: Vec3 }[];
  segments: { a: Vec3; b: Vec3; kind: SegmentKind }[];
  /** Planar faces that can be filled without inventing topology (authored polygon or one closed loop). */
  faces?: { ids: string[]; points: Vec3[]; quality: 'exact' | 'approximate' }[];
  fold?: {
    axisPoint: Vec3;
    axisDir: Vec3;
    /** Full fold angle; the renderer animates by rotating `moving` from 0 to it. */
    angle: number;
    moving: { id: string; start: Vec3 }[];
    /** Face to fill while folding, as point ids in polygon order. */
    polygon: string[];
    /**
     * Which plane the rabattu figure lands on. The dièdre fold swings πH about the ground line,
     * so the renderer has to know whether this construction rides along with πH or stays in πV.
     * The authored rabattu says which side the book drew on; the hinge kind decides when it is absent.
     */
    onto: 'h' | 'v';
  };
  trueLength?: number;
  /** Dimension presentation for a line_true_length operation; geometry remains the original line. */
  trueLengthDimension?: { from: string; to: string; a: Vec3; b: Vec3; value: number };
  /**
   * A solid cut by a plane. `polygon` is the section face (already drawn as `sectionEdge` segments
   * too); `quad` is the cutting plane itself, a rectangle spanning the solid so the viewer can wash
   * it translucently — the visible "where the knife went through".
   */
  section?: {
    polygon: { id: string; at: Vec3 }[];
    quad: [Vec3, Vec3, Vec3, Vec3];
  };
  /**
   * A change of projection plane. Everything here is the SPACE state (auxT = 1); the viewer swings
   * it flat about `line` by `unfoldAngle` as the second dièdre closes, so at auxT = 0 it lies in the
   * retained plane and IS the drawn auxiliary view — the same flat-state-is-a-check the dièdre has.
   */
  changePlane?: {
    replaced: 'v' | 'h';
    axisPoint: Vec3;
    axisDir: Vec3;
    unfoldAngle: number;
    /** L′ as a drawn segment (fixed — the auxiliary swings about it). */
    line: { a: Vec3; b: Vec3 };
    /** The new plane, as a rectangle to wash. */
    quad: [Vec3, Vec3, Vec3, Vec3];
    /** Auxiliary points in space; the viewer rotates these about `line` for the unfold. */
    aux: { id: string; at: Vec3 }[];
    /** Which aux points join up (the figure's own edges, among carried points). */
    edges: [string, string][];
  };
  labels: { text: string; at: Vec3; kind: 'spatial' | 'v' | 'h'; pointId: string }[];
  /** Red annotations, rescaled into the scene box: dots on read vertices, locus rays for the missing. */
  diagnostics?: {
    dots: { diagnosticId: string; at: Vec3; label: string; kind: 'found' }[];
    loci: DiagnosticLocus[];
    /** Red dashed topology, visible only when its diagnostic endpoints are user-confirmed. */
    edges: {
      from: { kind: 'point' | 'diagnostic'; id: string };
      to: { kind: 'point' | 'diagnostic'; id: string };
    }[];
  };
  warnings: ReconWarning[];
}

const SUP: Record<string, string> = { v: 'ᵛ', h: 'ᴴ' };

export function buildEpureScene(ir: EpureIR, recon: Reconstruction): EpureScene {
  const pts = [...recon.points.entries()];
  const extra: Vec3[] = recon.fold ? [...recon.fold.rabattu.values(), recon.fold.axisPoint] : [];
  // The auxiliary view sits beside the figure (both its space and unfolded positions), so it must
  // count toward the bounds or the change-of-plane construction falls outside the framed box.
  if (recon.changePlane) {
    extra.push(...recon.changePlane.auxProj.values(), ...recon.changePlane.auxFlat.values(), recon.changePlane.axisPoint);
  }
  if (recon.doubleChangePlane) {
    const d = recon.doubleChangePlane;
    extra.push(
      ...d.auxProj1.values(), ...d.auxFlat1.values(), d.axisPoint1,
      ...d.auxProj2.values(), ...d.trueFlat.values(), d.axisPoint2,
    );
  }
  // Diagnostic markers must count toward the bounds too, or a locus ray falls outside the framed box.
  if (recon.diagnostics) {
    for (const dot of recon.diagnostics.dots) extra.push(dot.at);
    for (const ray of recon.diagnostics.rays) extra.push(ray.a, ray.b);
  }
  const all = [...pts.map(([, p]) => p), ...extra];

  // Bounds over everything that will be drawn, including each point's two projections.
  let min = v3(Infinity, 0, 0);
  let max = v3(-Infinity, 0, 0);
  for (const p of all) {
    min = v3(Math.min(min.x, p.x), Math.min(min.y, p.y, 0), Math.min(min.z, p.z, 0));
    max = v3(Math.max(max.x, p.x), Math.max(max.y, p.y, 0), Math.max(max.z, p.z, 0));
  }
  const extent = Math.max(max.x - min.x, max.y - min.y, max.z - min.z, 1);
  const k = 10 / extent;
  const xMid = (min.x + max.x) / 2;
  // Scale + x-translate only: both projection planes pass through the origin axes and survive.
  const map = (p: Vec3): Vec3 => v3((p.x - xMid) * k, p.y * k, p.z * k);

  const pad = 0.15 * 10;
  const lo = map(min);
  const hi = map(max);
  // Projection planes are reference planes, not tight object bounding boxes. A profile line has
  // almost no x-span; using only its bounds collapses πH/πV into ribbons and makes correct 3D look
  // wrong. Keep a classroom-sized ground-line span even for that degenerate but common case.
  const xHalf = Math.max(Math.abs(lo.x), Math.abs(hi.x)) + pad;
  const planeXHalf = Math.max(xHalf, 6.5);
  const planes = {
    h: { min: v3(-planeXHalf, Math.min(lo.y, 0) - pad, 0), max: v3(planeXHalf, hi.y + pad, 0) },
    v: { min: v3(-planeXHalf, 0, Math.min(lo.z, 0) - pad), max: v3(planeXHalf, 0, hi.z + pad) },
  };

  const points = pts.map(([id, p]) => {
    const q = map(p);
    return { id, p: q, pv: v3(q.x, 0, q.z), ph: v3(q.x, q.y, 0) };
  });
  const at = new Map(points.map((e) => [e.id, e.p]));

  const segments: EpureScene['segments'] = [];
  const labels: EpureScene['labels'] = [];

  // The spatial figure: each drawn edge, collapsed across views (the V and H drawings of an
  // edge are two projections of ONE segment in space).
  const seen = new Set<string>();
  for (const s of ir.segments) {
    if (s.style === 'recall') continue; // recall lines are a 2D bookkeeping device, not geometry
    const key = [s.from, s.to].sort().join('→');
    if (seen.has(key)) continue;
    seen.add(key);
    const a = at.get(s.from);
    const b = at.get(s.to);
    if (!a || !b) continue;
    segments.push({ a, b, kind: 'spatial' });
    segments.push({ a: v3(a.x, 0, a.z), b: v3(b.x, 0, b.z), kind: 'projectionV' });
    segments.push({ a: v3(a.x, a.y, 0), b: v3(b.x, b.y, 0), kind: 'projectionH' });
  }

  for (const { id, p, pv, ph } of points) {
    segments.push({ a: p, b: pv, kind: 'projector' });
    segments.push({ a: p, b: ph, kind: 'projector' });
    labels.push({ text: id, at: p, kind: 'spatial', pointId: id });
    labels.push({ text: `${id}${SUP.v}`, at: pv, kind: 'v', pointId: id });
    labels.push({ text: `${id}${SUP.h}`, at: ph, kind: 'h', pointId: id });
  }

  // A light face wash materially improves depth perception. The topology must still be authored or
  // mathematically unambiguous: a plane polygon, one closed loop, or all four triangular faces of a
  // complete tetrahedron. Approximate readings receive a distinct presentation quality downstream.
  const faceCandidates: string[][] = [];
  if (ir.operation.kind === 'rabattement_plane') {
    faceCandidates.push(ir.operation.planePoints);
  } else {
    const tetraIds = ir.operation.kind === 'solid_section'
      ? ir.operation.solid
      : ir.operation.kind === 'point_projection'
        ? ir.operation.points
        : [];
    if (tetraIds.length === 4) {
      const pairs = tetraIds.flatMap((from, i) => tetraIds.slice(i + 1).map((to) => [from, to] as const));
      if (pairs.every(([from, to]) => seen.has([from, to].sort().join('→')))) {
        faceCandidates.push(
          [tetraIds[0], tetraIds[1], tetraIds[2]],
          [tetraIds[0], tetraIds[1], tetraIds[3]],
          [tetraIds[0], tetraIds[2], tetraIds[3]],
          [tetraIds[1], tetraIds[2], tetraIds[3]],
        );
      }
    }
  }
  if (!faceCandidates.length && ir.operation.kind !== 'solid_section') {
    const adjacency = new Map<string, Set<string>>();
    for (const s of ir.segments) {
      if (s.style === 'recall' || !at.has(s.from) || !at.has(s.to)) continue;
      adjacency.set(s.from, new Set([...(adjacency.get(s.from) ?? []), s.to]));
      adjacency.set(s.to, new Set([...(adjacency.get(s.to) ?? []), s.from]));
    }
    const candidates = [...adjacency.keys()];
    if (candidates.length >= 3 && candidates.every((id) => adjacency.get(id)?.size === 2)) {
      const ordered = [candidates[0]];
      let previous = '';
      let current = candidates[0];
      while (ordered.length <= candidates.length) {
        const next = [...adjacency.get(current)!].find((id) => id !== previous);
        if (!next || next === ordered[0]) break;
        if (ordered.includes(next)) break;
        ordered.push(next);
        previous = current;
        current = next;
      }
      if (ordered.length === candidates.length && adjacency.get(current)?.has(ordered[0])) faceCandidates.push(ordered);
    }
  }
  const faces: NonNullable<EpureScene['faces']> = [];
  for (const ids of faceCandidates) {
    const facePoints = ids.map((id) => at.get(id)!).filter(Boolean);
    if (facePoints.length !== ids.length || facePoints.length < 3) continue;
    const faceNormal = cross(sub(facePoints[1], facePoints[0]), sub(facePoints[2], facePoints[0]));
    const normalLength = Math.sqrt(dot(faceNormal, faceNormal));
    const maxDeviation = facePoints.length === 3 || normalLength < 1e-9
      ? 0
      : Math.max(...facePoints.map((point) => Math.abs(dot(faceNormal, sub(point, facePoints[0])) / normalLength)));
    const authoredPlane = ir.operation.kind === 'rabattement_plane';
    if (!authoredPlane && maxDeviation > 0.55) continue;
    faces.push({
      ids,
      points: facePoints,
      quality: recon.warnings.length || maxDeviation >= 0.12 ? 'approximate' : 'exact',
    });
  }

  let fold: EpureScene['fold'];
  if (recon.fold && ir.operation.kind === 'rabattement_plane') {
    const axisPoint = map(recon.fold.axisPoint);
    // Direction is scale-invariant (uniform k), position is not.
    const axisDir = recon.fold.axisDir;
    fold = {
      axisPoint,
      axisDir,
      angle: recon.fold.angle,
      moving: recon.fold.movingIds.map((id) => ({ id, start: at.get(id)! })),
      polygon: ir.operation.planePoints,
      // A hinge in πH folds the figure onto πH, a frontal one onto πV; a vertical hinge turns the
      // plane frontal, so it lands on πV too. The authored rabattu overrides all of that — it is
      // what the book actually drew, and the reconstruction is checked against it.
      onto: ir.operation.rabattu?.view ?? (ir.operation.hingeKind === 'horizontal' ? 'h' : 'v'),
    };
    // Draw the hinge across the figure with some margin.
    const ts = ir.operation.planePoints.map((id) => {
      const p = at.get(id)!;
      return (p.x - axisPoint.x) * axisDir.x + (p.y - axisPoint.y) * axisDir.y + (p.z - axisPoint.z) * axisDir.z;
    });
    const t0 = Math.min(...ts, 0) - pad;
    const t1 = Math.max(...ts, 0) + pad;
    segments.push({
      a: v3(axisPoint.x + t0 * axisDir.x, axisPoint.y + t0 * axisDir.y, axisPoint.z + t0 * axisDir.z),
      b: v3(axisPoint.x + t1 * axisDir.x, axisPoint.y + t1 * axisDir.y, axisPoint.z + t1 * axisDir.z),
      kind: 'hinge',
    });
  }

  let section: EpureScene['section'];
  if (recon.section && ir.operation.kind === 'solid_section') {
    const poly = recon.section.polygon.map((id) => ({ id, at: at.get(id)! })).filter((e) => e.at);
    if (poly.length >= 3) {
      // Highlight the section outline as its own segment kind (drawn over the solid's own edges).
      for (let i = 0; i < poly.length; i++) {
        segments.push({ a: poly[i].at, b: poly[(i + 1) % poly.length].at, kind: 'sectionEdge' });
      }
      // The cutting plane as a rectangle spanning the solid + section, in the plane's own basis.
      // The normal direction survives the uniform scale (map is scale + x-translate), so recon's
      // pixel-space normal is still the scene normal after normalization.
      const nrm = normalize(recon.section.normal);
      let e1 = sub(poly[1].at, poly[0].at);
      e1 = normalize(sub(e1, scale(nrm, dot(nrm, e1))));
      const e2 = cross(nrm, e1);
      const region = [...poly.map((p) => p.at), ...ir.operation.solid.map((id) => at.get(id)!).filter(Boolean)];
      const center = scale(region.reduce((acc, p) => add(acc, p), v3(0, 0, 0)), 1 / region.length);
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const p of region) {
        const d = sub(p, center);
        const a = dot(d, e1), b = dot(d, e2);
        u0 = Math.min(u0, a); u1 = Math.max(u1, a); v0 = Math.min(v0, b); v1 = Math.max(v1, b);
      }
      const qp = 0.35; // scene-unit margin so the wash reads past the solid
      const corner = (a: number, b: number) => add(center, add(scale(e1, a), scale(e2, b)));
      section = {
        polygon: poly,
        quad: [corner(u0 - qp, v0 - qp), corner(u1 + qp, v0 - qp), corner(u1 + qp, v1 + qp), corner(u0 - qp, v1 + qp)],
      };
    }
  }

  // A change of plane renders the same way whether it is the whole operation or the SECOND change
  // of a double: an auxiliary figure hinged on its ground line, swinging between space and flat.
  const buildChangePlaneField = (cp: {
    replaced: 'v' | 'h';
    axisPoint: Vec3;
    axisDir: Vec3;
    planeNormal: Vec3;
    auxProj: Map<string, Vec3>;
    unfoldAngle: number;
  }): EpureScene['changePlane'] => {
    const axisPoint = map(cp.axisPoint);
    const axisDir = cp.axisDir; // scale-invariant under the uniform map
    const aux = [...cp.auxProj].map(([id, P]) => ({ id, at: map(P) }));
    const atAux = new Map(aux.map((e) => [e.id, e.at]));

    const seenA = new Set<string>();
    const edges: [string, string][] = [];
    for (const seg of ir.segments) {
      if (seg.style === 'recall') continue;
      if (!atAux.has(seg.from) || !atAux.has(seg.to)) continue;
      const key = [seg.from, seg.to].sort().join('→');
      if (seenA.has(key)) continue;
      seenA.add(key);
      edges.push([seg.from, seg.to]);
    }

    // L′ drawn across the auxiliary's own span (rotation commutes with the uniform map, so an axis
    // in mapped space rotates mapped points exactly as the pixel axis rotates pixel points).
    const ts = aux.map((e) => (e.at.x - axisPoint.x) * axisDir.x + (e.at.y - axisPoint.y) * axisDir.y + (e.at.z - axisPoint.z) * axisDir.z);
    const t0 = Math.min(...ts, 0) - pad;
    const t1 = Math.max(...ts, 0) + pad;
    const line = {
      a: v3(axisPoint.x + t0 * axisDir.x, axisPoint.y + t0 * axisDir.y, axisPoint.z + t0 * axisDir.z),
      b: v3(axisPoint.x + t1 * axisDir.x, axisPoint.y + t1 * axisDir.y, axisPoint.z + t1 * axisDir.z),
    };

    // The new plane, spanned by L′ and the in-plane direction ⟂ L′, sized to the aux points.
    const e2 = normalize(cross(cp.planeNormal, axisDir));
    const region = aux.map((e) => e.at);
    const center = scale(region.reduce((acc, p) => add(acc, p), v3(0, 0, 0)), 1 / Math.max(region.length, 1));
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const p of region) {
      const d = sub(p, center);
      const a = dot(d, axisDir), b = dot(d, e2);
      a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b);
    }
    const qp = 0.35;
    const corner = (a: number, b: number) => add(center, add(scale(axisDir, a), scale(e2, b)));
    return {
      replaced: cp.replaced,
      axisPoint,
      axisDir,
      unfoldAngle: cp.unfoldAngle,
      line,
      quad: [corner(a0 - qp, b0 - qp), corner(a1 + qp, b0 - qp), corner(a1 + qp, b1 + qp), corner(a0 - qp, b1 + qp)],
      aux,
      edges,
    };
  };

  let changePlane: EpureScene['changePlane'];
  if (recon.changePlane && ir.operation.kind === 'change_of_plane') {
    changePlane = buildChangePlaneField(recon.changePlane);
  } else if (recon.doubleChangePlane && ir.operation.kind === 'double_change_of_plane') {
    // Render the SECOND change (L″ → true shape); the figure's own space edges already show step 1.
    const d = recon.doubleChangePlane;
    changePlane = buildChangePlaneField({
      replaced: d.replaced1,
      axisPoint: d.axisPoint2,
      axisDir: d.axisDir2,
      planeNormal: d.planeNormal2,
      auxProj: d.auxProj2,
      unfoldAngle: d.unfoldAngle2,
    });
  }

  // Optional fields are OMITTED, not set to undefined — a scene must survive JSON round-trips
  // byte-for-byte (it is data, and the serializability test holds it to that).
  const scene: EpureScene = {
    version: 1,
    planes,
    groundLine: { a: v3(planes.h.min.x, 0, 0), b: v3(planes.h.max.x, 0, 0) },
    points,
    segments,
    labels,
    warnings: recon.warnings,
  };
  if (ir.source.caption !== undefined) scene.caption = ir.source.caption;
  if (faces.length) scene.faces = faces;
  if (fold) scene.fold = fold;
  if (recon.trueLength !== undefined) scene.trueLength = recon.trueLength;
  if (recon.trueLength !== undefined && ir.operation.kind === 'line_true_length') {
    const a = at.get(ir.operation.from), b = at.get(ir.operation.to);
    if (a && b) scene.trueLengthDimension = {
      from: ir.operation.from,
      to: ir.operation.to,
      a,
      b,
      value: recon.trueLength,
    };
  }
  if (section) scene.section = section;
  if (changePlane) scene.changePlane = changePlane;
  if (recon.diagnostics && (recon.diagnostics.dots.length || recon.diagnostics.rays.length)) {
    const diagnosticIdByLabel = new Map(
      (ir.diagnostics ?? []).map((diagnostic, index) => [diagnostic.label, `d${index}`]),
    );
    const endpoint = (ref: string) => {
      const split = ref.indexOf(':');
      const kind = ref.slice(0, split);
      const id = ref.slice(split + 1);
      return kind === 'point'
        ? { kind: 'point' as const, id }
        : { kind: 'diagnostic' as const, id: diagnosticIdByLabel.get(id)! };
    };
    scene.diagnostics = {
      dots: recon.diagnostics.dots.map((d) => ({ diagnosticId: d.diagnosticId, at: map(d.at), label: d.label, kind: d.kind })),
      loci: recon.diagnostics.rays.map((r) => {
        const known = r.source === 'v' ? toPixelV(recon.frame, r.a) : toPixelH(recon.frame, r.a);
        const assumedA = r.source === 'v' ? toPixelH(recon.frame, r.a) : toPixelV(recon.frame, r.a);
        const assumedB = r.source === 'v' ? toPixelH(recon.frame, r.b) : toPixelV(recon.frame, r.b);
        return {
          id: r.id,
          diagnosticId: r.diagnosticId,
          label: r.label,
          kind: r.kind,
          source: r.source,
          a: map(r.a),
          b: map(r.b),
          plate: {
            known: { view: r.source, at: known },
            assumed: { view: r.source === 'v' ? 'h' : 'v', a: assumedA, b: assumedB },
          },
        };
      }),
      edges: (ir.diagnosticEdges ?? []).map((edge) => ({ from: endpoint(edge.from), to: endpoint(edge.to) })),
    };
  }
  return scene;
}
