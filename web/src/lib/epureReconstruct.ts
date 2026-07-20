/**
 * Deterministic metric reconstruction of an épure from its IR — the exact half of the system.
 * Input: an IR (pixel space). Output: 3D points, the fold that produced the rabattu figure, and
 * structured warnings. No model anywhere; every number is closed-form geometry, so a wrong output
 * always traces back to a wrong READING (a bad IR), never to this stage guessing.
 *
 * Units stay in pixels throughout so the reconstruction can be compared exactly against the
 * authored gold positions drawn on the sheet; the scene builder rescales for display.
 */

import type { EpureIR, Vec2 } from './epureIr';
import {
  type Frame, type Vec3,
  calibrateFrame, cross, dist, dot, norm, normalize, rotateAboutAxis, s, scale, sub, toPixelH, toPixelV, u, v3,
} from './epureMath';

export interface ReconWarning {
  code:
    | 'recall-mismatch'
    | 'collinear'
    | 'not-coplanar'
    | 'rabattu-off-plane'
    | 'rabattu-vs-authored'
    | 'section-off-plane'
    | 'aux-vs-authored'
    | 'true-shape-vs-authored'
    | 'incomplete'
    | 'unsupported';
  message: string;
  magnitudePx?: number;
}

/** A red marker on the 3D scene: a lifted dot (found), or a locus ray for an undetermined coordinate. */
export interface ReconDiagnostics {
  dots: { diagnosticId: string; label: string; at: Vec3; kind: 'found' }[];
  rays: {
    id: string;
    diagnosticId: string;
    label: string;
    source: 'v' | 'h';
    a: Vec3;
    b: Vec3;
    kind: 'unpaired' | 'missing';
  }[];
}

export interface Reconstruction {
  frame: Frame;
  /** Lifted 3D positions, keyed by point id. World units = pixels. */
  points: Map<string, Vec3>;
  fold?: {
    axisPoint: Vec3;
    /** Unit direction. */
    axisDir: Vec3;
    /** Full fold angle, radians, signed; animate by rotating `movingIds` from 0 to this. */
    angle: number;
    movingIds: string[];
    /** Rotated positions at full fold. On-axis points appear here unchanged. */
    rabattu: Map<string, Vec3>;
  };
  trueLength?: number;
  /** A cutting plane through a solid: its normal, a point on it, and the section polygon ids. */
  section?: { normal: Vec3; origin: Vec3; polygon: string[] };
  /** A change of projection plane: the new plane (through L′), the auxiliary view, and its unfold. */
  changePlane?: {
    replaced: 'v' | 'h';
    axisPoint: Vec3;
    axisDir: Vec3;
    planeNormal: Vec3;
    /** Which coordinate the new plane preserves: heights (z) when replacing πV, depths (y) when πH. */
    preserved: 'z' | 'y';
    /** Orthogonal projections onto the new plane — the auxiliary view, in space. */
    auxProj: Map<string, Vec3>;
    /** The same, unfolded about L′ into the retained plane — this equals the drawn auxiliary view. */
    auxFlat: Map<string, Vec3>;
    /** Chosen unfold direction; the viewer animates a second dièdre from 0 to it. */
    unfoldAngle: number;
  };
  /**
   * A double change of plane: the intermediate (edge-on) auxiliary and the final TRUE SHAPE.
   * Both are orthogonal projections of the same fixed 3D points; `trueFlat` is the true shape
   * unfolded all the way back into the drawing plane (through both ground lines).
   */
  doubleChangePlane?: {
    replaced1: 'v' | 'h';
    /** Change 1 (about L′): plane normal, axis, unfold, and the edge-on auxiliary in space + drawn. */
    axisPoint1: Vec3;
    axisDir1: Vec3;
    planeNormal1: Vec3;
    unfoldAngle1: number;
    auxProj1: Map<string, Vec3>;
    auxFlat1: Map<string, Vec3>;
    /** Change 2 (about L″, a line of the plane kept by change 1): the true shape in space + drawn. */
    axisPoint2: Vec3;
    axisDir2: Vec3;
    planeNormal2: Vec3;
    unfoldAngle2: number;
    auxProj2: Map<string, Vec3>;
    trueFlat: Map<string, Vec3>;
  };
  /** Red annotations — coordinates behind the lift, and locus rays for the ones it can't determine. */
  diagnostics?: ReconDiagnostics;
  warnings: ReconWarning[];
  /** True when the reconstruction should not be shown at all (a mis-read figure, not a nuance). */
  fatal: boolean;
}

export interface ReconOptions {
  /** Max disagreement between the two projections' abscissae before flagging (shared recall line). */
  recallTolPx?: number;
  /**
   * Max distance from the landing plane for coplanarity / lands-flat checks. 8px: the hinge and
   * each vertex carry 2–3px of hand-measurement each (E61(b) accumulates 6.1px with a correct
   * reading), while an actually wrong reading misses by 30px and more.
   */
  flatTolPx?: number;
  /**
   * Max average residual against the authored rabattu positions. Generous by design: the plates
   * were constructed by hand with compass steps, and E61(a)'s own drawn C_R drifts 17px ALONG
   * the hinge (a true swing is exactly perpendicular) — so 10–20px at a far vertex is plate
   * noise, while a mis-read point shows up as 50px and more.
   */
  goldTolPx?: number;
}

const EPS = 1e-9;

export function reconstruct(ir: EpureIR, opts: ReconOptions = {}): Reconstruction {
  const recallTol = opts.recallTolPx ?? 6;
  const flatTol = opts.flatTolPx ?? 8;
  const goldTol = opts.goldTolPx ?? 25;

  const frame = calibrateFrame(ir.groundLine);
  const warnings: ReconWarning[] = [];
  const points = new Map<string, Vec3>();

  for (const p of ir.points) {
    if (!p.v || !p.h) continue; // single-view points carry labels but cannot be lifted
    const uV = u(frame, p.v);
    const uH = u(frame, p.h);
    const mismatch = Math.abs(uV - uH);
    if (mismatch > recallTol) {
      warnings.push({
        code: 'recall-mismatch',
        message: `point ${p.id}: projections disagree by ${mismatch.toFixed(1)}px along the ground line`,
        magnitudePx: mismatch,
      });
    }
    points.set(p.id, v3((uV + uH) / 2, s(frame, p.h), -s(frame, p.v)));
  }

  // Red diagnostic markers, in the reconstructor's frame. Nothing here enters `points`, so it never
  // changes the reconstruction — it only annotates it. A missing coordinate has one free axis, so it
  // is a locus RAY spanning the figure's box, never an invented point.
  let diagnostics: ReconDiagnostics | undefined;
  if (ir.diagnostics?.length) {
    const dots: ReconDiagnostics['dots'] = [];
    const rays: ReconDiagnostics['rays'] = [];
    const ys: number[] = [];
    const zs: number[] = [];
    for (const p of points.values()) {
      ys.push(p.y);
      zs.push(p.z);
    }
    for (const d of ir.diagnostics) {
      if (d.h) ys.push(s(frame, d.h));
      if (d.v) zs.push(-s(frame, d.v));
    }
    // Span the free axis over everything placeable, with a floor so a lone point still shows a ray.
    const span = (arr: number[]): [number, number] => {
      const lo = Math.min(0, ...arr);
      const hi = Math.max(0, ...arr);
      const mid = (lo + hi) / 2;
      const half = Math.max((hi - lo) / 2, 70) * 1.15;
      return [mid - half, mid + half];
    };
    const [yLo, yHi] = span(ys);
    const [zLo, zHi] = span(zs);
    for (const [index, d] of ir.diagnostics.entries()) {
      const diagnosticId = `d${index}`;
      if (d.kind === 'found' && d.v && d.h) {
        dots.push({ diagnosticId, label: d.label, kind: 'found', at: v3((u(frame, d.v) + u(frame, d.h)) / 2, s(frame, d.h), -s(frame, d.v)) });
      } else if (d.kind === 'missing') {
        if (d.v) rays.push({ id: `${diagnosticId}:v`, diagnosticId, label: d.label, source: 'v', kind: 'missing', a: v3(u(frame, d.v), yLo, -s(frame, d.v)), b: v3(u(frame, d.v), yHi, -s(frame, d.v)) });
        else if (d.h) rays.push({ id: `${diagnosticId}:h`, diagnosticId, label: d.label, source: 'h', kind: 'missing', a: v3(u(frame, d.h), s(frame, d.h), zLo), b: v3(u(frame, d.h), s(frame, d.h), zHi) });
        warnings.push({ code: 'incomplete', message: `${d.label} : ${d.note ?? 'projection non tracée — coordonnée indéterminée'}` });
      } else if (d.kind === 'unpaired' && d.v && d.h) {
        rays.push({ id: `${diagnosticId}:v`, diagnosticId, label: d.label, source: 'v', kind: 'unpaired', a: v3(u(frame, d.v), yLo, -s(frame, d.v)), b: v3(u(frame, d.v), yHi, -s(frame, d.v)) });
        rays.push({ id: `${diagnosticId}:h`, diagnosticId, label: d.label, source: 'h', kind: 'unpaired', a: v3(u(frame, d.h), s(frame, d.h), zLo), b: v3(u(frame, d.h), s(frame, d.h), zHi) });
        warnings.push({ code: 'incomplete', message: `${d.label} : ${d.note ?? 'projections V/H incohérentes'}` });
      }
    }
    diagnostics = { dots, rays };
  }

  const result: Reconstruction = { frame, points, diagnostics, warnings, fatal: false };
  const op = ir.operation;

  if (op.kind === 'point_projection') return result;

  if (op.kind === 'line_true_length') {
    const a = points.get(op.from);
    const b = points.get(op.to);
    if (a && b) result.trueLength = dist(a, b);
    return result;
  }

  if (op.kind === 'solid_section') {
    // The solid is already lifted by the loop above (same as point_projection). The cutting plane
    // is defined by three of its own points; the section polygon is a set of independently-lifted
    // points that MUST lie on that plane — that coplanarity is the falsifiable check.
    const [q0, q1, q2] = op.planePoints.map((id) => points.get(id));
    if (!q0 || !q1 || !q2) {
      warnings.push({ code: 'unsupported', message: 'a cutting-plane point could not be lifted' });
      result.fatal = true;
      return result;
    }
    const n = cross(sub(q1, q0), sub(q2, q0));
    if (norm(n) < 1) {
      warnings.push({ code: 'collinear', message: 'cutting-plane points are collinear — a point was mis-read' });
      result.fatal = true;
      return result;
    }
    const nu = normalize(n);
    let worst = 0;
    for (const id of op.section) {
      const S = points.get(id);
      if (!S) {
        warnings.push({ code: 'unsupported', message: `section vertex ${id} could not be lifted` });
        result.fatal = true;
        return result;
      }
      worst = Math.max(worst, Math.abs(dot(nu, sub(S, q0))));
    }
    if (worst > flatTol) {
      warnings.push({
        code: 'section-off-plane',
        message: `section vertices are not coplanar with the cutting plane (off by ${worst.toFixed(1)}px)`,
        magnitudePx: worst,
      });
    }
    result.section = { normal: nu, origin: q0, polygon: op.section };
    return result;
  }

  if (op.kind === 'change_of_plane') {
    // Lift L′ to a 3D line lying in the RETAINED plane (single-view marks, lifted like the hinge).
    // The new plane is perpendicular to the retained one, so it contains L′ and the preserved axis.
    const g = op.newGroundLine;
    let axisPoint: Vec3, axisDir: Vec3, planeNormal: Vec3;
    let preserved: 'z' | 'y';
    if (op.replaced === 'v') {
      // L′ is a line of πH (z=0); the new frontal plane is vertical, containing L′ and the z-axis.
      const La = v3(u(frame, g.a), s(frame, g.a), 0);
      const Lb = v3(u(frame, g.b), s(frame, g.b), 0);
      axisPoint = La;
      axisDir = normalize(sub(Lb, La));
      planeNormal = normalize(cross(axisDir, v3(0, 0, 1)));
      preserved = 'z';
    } else {
      // L′ is a line of πV (y=0); the new horizontal plane contains L′ and the y-axis.
      const La = v3(u(frame, g.a), 0, -s(frame, g.a));
      const Lb = v3(u(frame, g.b), 0, -s(frame, g.b));
      axisPoint = La;
      axisDir = normalize(sub(Lb, La));
      planeNormal = normalize(cross(axisDir, v3(0, 1, 0)));
      preserved = 'y';
    }

    const lifted = op.points.map((id) => ({ id, P: points.get(id) }));
    if (lifted.some((e) => !e.P)) {
      warnings.push({ code: 'unsupported', message: 'a point could not be carried into the auxiliary view' });
      result.fatal = true;
      return result;
    }
    // Orthogonal projection onto the new plane — the auxiliary image in space. Dropping the normal
    // component keeps the preserved coordinate (height for a frontal change, depth for a horizontal
    // one), which IS the metric content a change of plane conserves.
    const auxProj = new Map(
      (lifted as { id: string; P: Vec3 }[]).map(({ id, P }) => {
        const off = dot(planeNormal, sub(P, axisPoint));
        return [id, sub(P, scale(planeNormal, off))] as const;
      }),
    );

    // Unfold the new plane about L′ onto the retained plane (±90°); the authored auxiliary picks the
    // side, exactly as the rabattu does for a fold. Its residual is the falsifiability of the family.
    const foldFlat = (ang: number) =>
      new Map([...auxProj].map(([id, P]) => [id, rotateAboutAxis(P, axisPoint, axisDir, ang)] as const));
    const toPx = op.replaced === 'v' ? toPixelH : toPixelV;
    const candidates = [Math.PI / 2, -Math.PI / 2];
    let unfoldAngle = candidates[0];
    if (op.auxiliary) {
      const gold = op.auxiliary;
      const residual = (ang: number) => {
        const flat = foldFlat(ang);
        let sum = 0;
        for (const [id, px] of Object.entries(gold)) {
          const f = flat.get(id);
          if (f) sum += Math.hypot(toPx(frame, f).x - px.x, toPx(frame, f).y - px.y);
        }
        return sum;
      };
      const [r0, r1] = [residual(candidates[0]), residual(candidates[1])];
      unfoldAngle = r0 <= r1 ? candidates[0] : candidates[1];
      const perPoint = Math.min(r0, r1) / Math.max(1, Object.keys(gold).length);
      if (perPoint > goldTol) {
        warnings.push({
          code: 'aux-vs-authored',
          message: `computed auxiliary view misses the drawn one by ${perPoint.toFixed(1)}px per point`,
          magnitudePx: perPoint,
        });
      }
    }

    result.changePlane = {
      replaced: op.replaced,
      axisPoint,
      axisDir,
      planeNormal,
      preserved,
      auxProj,
      auxFlat: foldFlat(unfoldAngle),
      unfoldAngle,
    };
    return result;
  }

  if (op.kind === 'double_change_of_plane') {
    // Both changes are orthogonal projections of the SAME fixed 3D points — the object never moves.
    // Change 1 turns the oblique plane edge-on (about L′); change 2 (about L″, a line of the plane
    // change 1 kept) leaves the figure parallel to the new plane, so its second auxiliary is the
    // TRUE SHAPE. L″ is drawn in the UNFOLDED aux-1 view, so it is lifted in the kept plane and
    // folded up onto π1′ before it can define the second projection.
    const carried = op.points.map((id) => ({ id, P: points.get(id) }));
    if (carried.some((e) => !e.P)) {
      warnings.push({ code: 'unsupported', message: 'a point could not be carried into the auxiliary views' });
      result.fatal = true;
      return result;
    }
    const pts = carried as { id: string; P: Vec3 }[];

    // A ground line drawn in the kept plane, lifted to a 3D line of it. replaced1='v' keeps πH (z=0);
    // 'h' keeps πV (y=0).
    const liftGL = (g: { a: Vec2; b: Vec2 }) =>
      op.replaced1 === 'v'
        ? { a: v3(u(frame, g.a), s(frame, g.a), 0), b: v3(u(frame, g.b), s(frame, g.b), 0) }
        : { a: v3(u(frame, g.a), 0, -s(frame, g.a)), b: v3(u(frame, g.b), 0, -s(frame, g.b)) };
    const keptAxis = op.replaced1 === 'v' ? v3(0, 0, 1) : v3(0, 1, 0); // preserved coordinate axis
    const keptToPx = op.replaced1 === 'v' ? toPixelH : toPixelV;
    const proj = (P: Vec3, n: Vec3, q: Vec3) => sub(P, scale(n, dot(n, sub(P, q))));
    const cand = [Math.PI / 2, -Math.PI / 2];

    // Pick an unfold direction: minimise residual against the drawn gold if given, else land the
    // unfolded figure on the same side as the target (where its own construction is drawn).
    const pickSide = (
      make: (ang: number) => Map<string, Vec3>,
      gold: Record<string, Vec2> | undefined,
      target: Vec2,
    ): { ang: number; perPoint: number } => {
      if (gold && Object.keys(gold).length) {
        const resid = (ang: number) => {
          const flat = make(ang);
          let sum = 0, k = 0;
          for (const [id, px] of Object.entries(gold)) {
            const f = flat.get(id);
            if (f) { sum += Math.hypot(keptToPx(frame, f).x - px.x, keptToPx(frame, f).y - px.y); k++; }
          }
          return k ? sum / k : Infinity;
        };
        const r0 = resid(cand[0]), r1 = resid(cand[1]);
        return { ang: r0 <= r1 ? cand[0] : cand[1], perPoint: Math.min(r0, r1) };
      }
      const centroidDist = (ang: number) => {
        const flat = [...make(ang).values()];
        let sx = 0, sy = 0;
        for (const p of flat) { const px = keptToPx(frame, p); sx += px.x; sy += px.y; }
        return Math.hypot(sx / flat.length - target.x, sy / flat.length - target.y);
      };
      return { ang: centroidDist(cand[0]) <= centroidDist(cand[1]) ? cand[0] : cand[1], perPoint: NaN };
    };

    // ---- Change 1: about L′ (identical to a single change_of_plane) ----
    const g1 = liftGL(op.newGroundLine1);
    const axisPoint1 = g1.a;
    const axisDir1 = normalize(sub(g1.b, g1.a));
    const planeNormal1 = normalize(cross(axisDir1, keptAxis));
    const auxProj1 = new Map(pts.map(({ id, P }) => [id, proj(P, planeNormal1, axisPoint1)] as const));
    const unfold1 = (ang: number) =>
      new Map([...auxProj1].map(([id, P]) => [id, rotateAboutAxis(P, axisPoint1, axisDir1, ang)] as const));
    const l2mid: Vec2 = { x: (op.newGroundLine2.a.x + op.newGroundLine2.b.x) / 2, y: (op.newGroundLine2.a.y + op.newGroundLine2.b.y) / 2 };
    const s1 = pickSide(unfold1, op.auxiliary1, l2mid);
    const unfoldAngle1 = s1.ang;
    const auxFlat1 = unfold1(unfoldAngle1);
    if (op.auxiliary1 && Number.isFinite(s1.perPoint) && s1.perPoint > goldTol) {
      warnings.push({ code: 'aux-vs-authored', message: `intermediate auxiliary misses the drawn one by ${s1.perPoint.toFixed(1)}px per point`, magnitudePx: s1.perPoint });
    }

    // ---- Change 2: about L″, a line of the plane kept by change 1 (π1′) ----
    // L″ is drawn in the unfolded aux-1 view (the kept plane); fold it UP onto π1′ to get it in space.
    const g2flat = liftGL(op.newGroundLine2);
    const foldUp = (P: Vec3) => rotateAboutAxis(P, axisPoint1, axisDir1, -unfoldAngle1);
    const axisPoint2 = foldUp(g2flat.a);
    const axisDir2 = normalize(sub(foldUp(g2flat.b), axisPoint2));
    // π2′ ⟂ π1′ and contains L″ ⇒ spanned by axisDir2 and planeNormal1; its normal is their cross.
    const planeNormal2 = normalize(cross(axisDir2, planeNormal1));
    const auxProj2 = new Map(pts.map(({ id, P }) => [id, proj(P, planeNormal2, axisPoint2)] as const));
    // Unfold change 2 about L″ onto π1′, then carry that through the change-1 unfold to the sheet.
    const trueFlatFor = (ang2: number) =>
      new Map([...auxProj2].map(([id, P]) => {
        const ontoPi1 = rotateAboutAxis(P, axisPoint2, axisDir2, ang2);
        return [id, rotateAboutAxis(ontoPi1, axisPoint1, axisDir1, unfoldAngle1)] as const;
      }));
    const s2 = pickSide(trueFlatFor, op.trueShape, l2mid);
    const unfoldAngle2 = s2.ang;
    const trueFlat = trueFlatFor(unfoldAngle2);
    if (op.trueShape && Number.isFinite(s2.perPoint) && s2.perPoint > goldTol) {
      warnings.push({ code: 'true-shape-vs-authored', message: `computed true shape misses the drawn one by ${s2.perPoint.toFixed(1)}px per point`, magnitudePx: s2.perPoint });
    }

    result.doubleChangePlane = {
      replaced1: op.replaced1,
      axisPoint1, axisDir1, planeNormal1, unfoldAngle1, auxProj1, auxFlat1,
      axisPoint2, axisDir2, planeNormal2, unfoldAngle2, auxProj2, trueFlat,
    };
    return result;
  }

  // --- rabattement_plane ---

  // Lift the hinge to a 3D axis. A hinge whose "other view" pair is omitted sits IN the target
  // projection plane (E61a: Ch^V coincides with the ground line, so the hinge is at height 0).
  let axisPoint: Vec3;
  let axisDir: Vec3;
  let m: Vec3; // normal of the plane the figure lands on; the plane contains the axis
  const h = op.hinge;
  if (op.hingeKind === 'horizontal') {
    const zHinge = h.aV && h.bV ? -(s(frame, h.aV) + s(frame, h.bV)) / 2 : 0;
    axisPoint = v3(u(frame, h.aH!), s(frame, h.aH!), zHinge);
    axisDir = normalize(v3(u(frame, h.bH!) - u(frame, h.aH!), s(frame, h.bH!) - s(frame, h.aH!), 0));
    m = v3(0, 0, 1);
  } else if (op.hingeKind === 'frontal') {
    const yHinge = h.aH && h.bH ? (s(frame, h.aH) + s(frame, h.bH)) / 2 : 0;
    axisPoint = v3(u(frame, h.aV!), yHinge, -s(frame, h.aV!));
    axisDir = normalize(v3(u(frame, h.bV!) - u(frame, h.aV!), 0, -(s(frame, h.bV!) - s(frame, h.aV!))));
    m = v3(0, 1, 0);
  } else {
    // vertical hinge: a point in the H view, the axis rises perpendicular to πH; the figure
    // swings until frontal, landing on the frontal plane through the axis.
    axisPoint = v3(u(frame, h.aH!), s(frame, h.aH!), 0);
    axisDir = v3(0, 0, 1);
    m = v3(0, 1, 0);
  }

  const moving = op.planePoints.map((id) => ({ id, p: points.get(id) }));
  if (moving.some((e) => !e.p)) {
    warnings.push({ code: 'unsupported', message: 'a plane point could not be lifted' });
    result.fatal = true;
    return result;
  }
  const lifted = moving as { id: string; p: Vec3 }[];

  // Degenerate figure = a mis-read vertex, not a valid épure.
  if (lifted.length >= 3) {
    const [A, B, C] = [lifted[0].p, lifted[1].p, lifted[2].p];
    const area = norm(cross(sub(B, A), sub(C, A)));
    if (area < EPS * 1e6 || area < 1) {
      warnings.push({ code: 'collinear', message: 'plane points are collinear — a vertex was probably mis-read' });
      result.fatal = true;
      return result;
    }
  }

  // Landing on the plane means (R(φ)·w⊥)·m = 0, which reduces to a·cosφ + b·sinφ = 0 (the
  // axis-parallel component never leaves the plane since axis ⊥ m). One point fixes φ up to a
  // half-turn; every other point must agree — that agreement IS the coplanarity check.
  //
  // The angle comes from the point with the LARGEST swing radius, never merely the first one: a
  // point drawn on the hinge is 1–3px off it on a hand-measured plate, and that residue is pure
  // noise — an angle taken from it points anywhere (it cost E61(b)/(c) their reconstruction
  // before this picked B instead of A). The same 3px is the on-axis cutoff for what moves.
  const ON_AXIS_PX = 3;
  let angle: number | null = null;
  let bestRadius = 0;
  for (const { p } of lifted) {
    const w = sub(p, axisPoint);
    const wPerp = sub(w, scale(axisDir, dot(axisDir, w)));
    const radius = norm(wPerp);
    if (radius <= Math.max(ON_AXIS_PX, bestRadius)) continue;
    bestRadius = radius;
    angle = Math.atan2(-dot(wPerp, m), dot(cross(axisDir, wPerp), m));
  }
  if (angle === null) {
    warnings.push({ code: 'unsupported', message: 'every plane point lies on the hinge — nothing to fold' });
    result.fatal = true;
    return result;
  }

  const foldAll = (ang: number) => new Map(lifted.map(({ id, p }) => [id, rotateAboutAxis(p, axisPoint, axisDir, ang)]));

  const planeOffset = dot(m, axisPoint);
  const offPlane = (folded: Map<string, Vec3>) =>
    Math.max(...[...folded.values()].map((p) => Math.abs(dot(m, p) - planeOffset)));

  // Two candidates: fold to either side of the hinge. Both land a coplanar figure flat; the
  // authored rabattu (when present) says which side the book chose.
  const candidates = [angle, angle > 0 ? angle - Math.PI : angle + Math.PI];
  let best = candidates[0];
  if (op.rabattu) {
    const gold = op.rabattu;
    const toPx = gold.view === 'h' ? toPixelH : toPixelV;
    const residual = (ang: number) => {
      const folded = foldAll(ang);
      let sum = 0;
      for (const [id, px] of Object.entries(gold.points)) {
        const f = folded.get(id);
        if (f) sum += Math.hypot(toPx(frame, f).x - px.x, toPx(frame, f).y - px.y);
      }
      return sum;
    };
    const [r0, r1] = [residual(candidates[0]), residual(candidates[1])];
    best = r0 <= r1 ? candidates[0] : candidates[1];
    const perPoint = Math.min(r0, r1) / Math.max(1, Object.keys(gold.points).length);
    if (perPoint > goldTol) {
      warnings.push({
        code: 'rabattu-vs-authored',
        message: `reconstructed fold misses the drawn rabattu by ${perPoint.toFixed(1)}px per point`,
        magnitudePx: perPoint,
      });
    }
  } else {
    // No gold: fold away from the ground line (the book convention — the rabattu figure is drawn
    // clear of the other projection). "Away" = centroid deeper into the target plane's far side.
    const further = (ang: number) => {
      const folded = foldAll(ang);
      let acc = 0;
      for (const p of folded.values()) acc += op.hingeKind === 'horizontal' ? p.y : p.z;
      return acc;
    };
    best = further(candidates[0]) >= further(candidates[1]) ? candidates[0] : candidates[1];
  }

  const rabattu = foldAll(best);
  const flatMiss = offPlane(rabattu);
  if (flatMiss > flatTol) {
    // Not landing flat with the best shared angle means the "plane" points are not coplanar
    // with the hinge — again a reading problem, surfaced, never smoothed over.
    warnings.push({
      code: 'not-coplanar',
      message: `plane points are not coplanar with the hinge (off by ${flatMiss.toFixed(1)}px)`,
      magnitudePx: flatMiss,
    });
  }

  result.fold = {
    axisPoint,
    axisDir,
    angle: best,
    movingIds: lifted.filter(({ p }) => {
      const w = sub(p, axisPoint);
      return norm(sub(w, scale(axisDir, dot(axisDir, w)))) > ON_AXIS_PX;
    }).map((e) => e.id),
    rabattu,
  };
  return result;
}
