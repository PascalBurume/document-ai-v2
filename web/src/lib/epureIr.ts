/**
 * Intermediate Representation of a Monge épure — frozen at version 1.
 *
 * The IR describes what a figure CONTAINS, in pixel space, with no 3D in it. It is the contract
 * between three worlds that must never mix: reading the figure (fuzzy — a human today, a vision
 * model later), reconstructing 3D from the reading (exact, closed-form — epureReconstruct.ts),
 * and rendering (EpureViewer). A reading produces an IR and nothing else; in particular it never
 * produces 3D coordinates, which is where a model would hallucinate.
 *
 * Every coordinate is in the authored SVG's pixel space (y grows down). The reconstructor
 * calibrates its own frame from the ground line, so the épure may be tilted or offset freely.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface IrPoint {
  /** Bare name — "A", "B", "O" — no view suffix; the view is the field it sits in. */
  id: string;
  /** Vertical-projection position (above the ground line), null when not drawn. */
  v: Vec2 | null;
  /** Horizontal-projection position (below the ground line), null when not drawn. */
  h: Vec2 | null;
  role?: 'vertex' | 'aux';
}

export interface IrSegment {
  from: string;
  to: string;
  view: 'v' | 'h';
  style?: 'solid' | 'recall' | 'hidden';
}

export type IrOperation =
  | { kind: 'point_projection'; points: string[] }
  | { kind: 'line_true_length'; from: string; to: string }
  | {
      kind: 'rabattement_plane';
      /** Which projection plane the figure folds onto (a horizontal hinge folds onto πH…). */
      hingeKind: 'horizontal' | 'frontal' | 'vertical';
      /**
       * Hinge endpoints as drawn, per view. A horizontal hinge needs its H pair (aH/bH); the V
       * pair may be omitted, which means the hinge sits ON the ground line — height 0 (E61a).
       * A frontal hinge mirrors that (V pair required); a vertical hinge needs one H point.
       */
      hinge: { aH?: Vec2; bH?: Vec2; aV?: Vec2; bV?: Vec2 };
      /** The moving figure, in polygon order. */
      planePoints: string[];
      /** Rabattu positions as AUTHORED on the sheet — gold data the reconstruction is checked against. */
      rabattu?: { view: 'v' | 'h'; points: Record<string, Vec2> };
    }
  | {
      /**
       * A cutting plane through a solid, producing a section polygon. The solid is lifted exactly
       * like `point_projection`; the plane is given by three of its own points and the section
       * vertices are ordinary two-view points. The falsifiable check is that every authored section
       * vertex, lifted from its OWN two projections, is coplanar with the three plane points.
       */
      kind: 'solid_section';
      /** The solid's vertices, elevated from their two projections. */
      solid: string[];
      /** Three non-collinear points defining the cutting plane; each drawn in both views. */
      planePoints: [string, string, string];
      /** The section polygon, in order; every vertex is an intersection point drawn in both views. */
      section: string[];
    }
  | {
      /**
       * Change of projection plane (changement de plan). One projection plane is replaced by a new
       * one, perpendicular to the RETAINED plane, meeting it along a new ground line L′. The object
       * never moves, so its 3D is already fixed by the two original views — the auxiliary view is
       * DERIVED, and the authored auxiliary is the strongest gold check in the system (a third,
       * independent reading the reconstruction must reproduce).
       */
      kind: 'change_of_plane';
      /**
       * Which plane is replaced. 'v' → a new frontal plane (πH kept, HEIGHTS preserved), L′ drawn
       * among the H projections. 'h' → a new horizontal plane (πV kept, DEPTHS preserved), L′ among
       * the V projections.
       */
      replaced: 'v' | 'h';
      /** The new ground line L′ as drawn, a line of the retained plane. */
      newGroundLine: { a: Vec2; b: Vec2 };
      /** Points carried into the auxiliary view; each needs both original projections. */
      points: string[];
      /** Auxiliary-view positions as AUTHORED beside L′ — gold the computed reprojection is checked against. */
      auxiliary?: Record<string, Vec2>;
    }
  | {
      /**
       * Double change of projection plane (double changement de plan) — the two successive changes
       * that bring an OBLIQUE plane figure to true shape, which a single change cannot. The object
       * never moves; each change is just another orthogonal projection of the same fixed 3D points.
       * Change 1 replaces one plane about L′ (exactly like `change_of_plane`), turning the plane
       * edge-on. Change 2 replaces the plane RETAINED by change 1, about a second ground line L″
       * drawn in the UNFOLDED auxiliary-1 view — the plane is now parallel to the new plane, so its
       * second auxiliary is the TRUE SHAPE. That true shape is the strongest gold in the system.
       */
      kind: 'double_change_of_plane';
      /** Which plane the FIRST change replaces; the second replaces whichever plane the first kept. */
      replaced1: 'v' | 'h';
      /** L′ as drawn among the retained-plane projections (a line of the retained plane). */
      newGroundLine1: { a: Vec2; b: Vec2 };
      /** L″ as drawn in the unfolded auxiliary-1 view (a line of the plane kept by change 1). */
      newGroundLine2: { a: Vec2; b: Vec2 };
      /** Points carried through both changes; each needs both original projections. */
      points: string[];
      /** Optional gold on the INTERMEDIATE (auxiliary-1) view, drawn beside L′. */
      auxiliary1?: Record<string, Vec2>;
      /** Gold on the FINAL true shape (auxiliary-2), drawn beside L″ — the falsifiable check. */
      trueShape?: Record<string, Vec2>;
    };

export interface EpureIR {
  version: 1;
  source: {
    book: string;
    /** Figure number in figures/dessin-scientifique/figures.json. */
    n: number;
    /** Sub-figure letter when one sheet holds several épures ("a", "b", …). */
    sub?: string;
    /** 0-based page index, as in OcrPage.index. */
    page: number;
    blockId: string;
    caption?: string;
  };
  units: 'px';
  /** From the SVG viewBox — lets a UI overlay the IR on the figure. */
  imageSize: { width: number; height: number };
  /** Ligne de terre as drawn; may be tilted. */
  groundLine: { a: Vec2; b: Vec2 };
  points: IrPoint[];
  segments: IrSegment[];
  operation: IrOperation;
  labels?: { text: string; anchor: Vec2; pointId?: string; view?: 'v' | 'h' }[];
  notes?: string[];
}

export interface IrIssue {
  path: string;
  message: string;
}

type Validation = { ok: true; ir: EpureIR } | { ok: false; errors: IrIssue[] };

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

function checkVec2(x: unknown, path: string, errors: IrIssue[]): x is Vec2 {
  if (!isObj(x) || !Number.isFinite(x.x) || !Number.isFinite(x.y)) {
    errors.push({ path, message: 'expected { x, y } with finite numbers' });
    return false;
  }
  return true;
}

/**
 * Structural + referential validation of an IR. Never throws — a malformed IR is data about the
 * reading, not an exception. Beyond shape it enforces the invariants the reconstructor assumes:
 * unique point ids, every referenced point exists, every point the operation moves has BOTH
 * projections (a single-view point is under-determined), and the hinge carries the pair its
 * kind requires.
 */
export function validateEpureIr(x: unknown): Validation {
  const errors: IrIssue[] = [];
  if (!isObj(x)) return { ok: false, errors: [{ path: '', message: 'IR must be an object' }] };

  if (x.version !== 1) errors.push({ path: 'version', message: 'must be 1' });
  if (x.units !== 'px') errors.push({ path: 'units', message: "must be 'px'" });

  const src = x.source;
  if (!isObj(src) || typeof src.book !== 'string' || !Number.isFinite(src.n) || !Number.isFinite(src.page) || typeof src.blockId !== 'string') {
    errors.push({ path: 'source', message: 'needs { book, n, page, blockId }' });
  }

  const size = x.imageSize;
  if (!isObj(size) || !Number.isFinite(size.width) || !Number.isFinite(size.height)) {
    errors.push({ path: 'imageSize', message: 'needs finite { width, height }' });
  }

  const gl = x.groundLine;
  if (isObj(gl) && checkVec2(gl.a, 'groundLine.a', errors) && checkVec2(gl.b, 'groundLine.b', errors)) {
    const a = gl.a as Vec2, b = gl.b as Vec2;
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1) errors.push({ path: 'groundLine', message: 'degenerate (shorter than 1px)' });
  } else if (!isObj(gl)) {
    errors.push({ path: 'groundLine', message: 'needs { a, b }' });
  }

  const ids = new Map<string, { v: boolean; h: boolean }>();
  if (!Array.isArray(x.points)) {
    errors.push({ path: 'points', message: 'must be an array' });
  } else {
    x.points.forEach((p, i) => {
      if (!isObj(p) || typeof p.id !== 'string' || p.id === '') {
        errors.push({ path: `points[${i}].id`, message: 'must be a non-empty string' });
        return;
      }
      if (ids.has(p.id)) errors.push({ path: `points[${i}].id`, message: `duplicate id "${p.id}"` });
      const v = p.v === null ? null : checkVec2(p.v, `points[${i}].v`, errors) ? (p.v as Vec2) : null;
      const h = p.h === null ? null : checkVec2(p.h, `points[${i}].h`, errors) ? (p.h as Vec2) : null;
      if (p.v === undefined) errors.push({ path: `points[${i}].v`, message: 'must be a Vec2 or null (not omitted)' });
      if (p.h === undefined) errors.push({ path: `points[${i}].h`, message: 'must be a Vec2 or null (not omitted)' });
      ids.set(p.id, { v: v !== null, h: h !== null });
    });
  }

  const requireBothViews = (id: string, path: string) => {
    const entry = ids.get(id);
    if (!entry) errors.push({ path, message: `references unknown point "${id}"` });
    else if (!entry.v || !entry.h) errors.push({ path, message: `point "${id}" needs both projections (v and h) — a single view is under-determined` });
  };

  if (!Array.isArray(x.segments)) {
    errors.push({ path: 'segments', message: 'must be an array' });
  } else {
    x.segments.forEach((s, i) => {
      if (!isObj(s) || typeof s.from !== 'string' || typeof s.to !== 'string' || (s.view !== 'v' && s.view !== 'h')) {
        errors.push({ path: `segments[${i}]`, message: "needs { from, to, view: 'v'|'h' }" });
        return;
      }
      for (const end of [s.from, s.to] as string[]) {
        if (!ids.has(end)) errors.push({ path: `segments[${i}]`, message: `references unknown point "${end}"` });
      }
    });
  }

  const op = x.operation;
  if (!isObj(op) || typeof op.kind !== 'string') {
    errors.push({ path: 'operation', message: 'needs { kind }' });
  } else if (op.kind === 'point_projection') {
    if (!Array.isArray(op.points) || op.points.length === 0) {
      errors.push({ path: 'operation.points', message: 'must be a non-empty array' });
    } else {
      op.points.forEach((id, i) => typeof id === 'string' && requireBothViews(id, `operation.points[${i}]`));
    }
  } else if (op.kind === 'line_true_length') {
    if (typeof op.from !== 'string' || typeof op.to !== 'string') {
      errors.push({ path: 'operation', message: 'needs { from, to }' });
    } else {
      requireBothViews(op.from, 'operation.from');
      requireBothViews(op.to, 'operation.to');
    }
  } else if (op.kind === 'rabattement_plane') {
    const kinds = ['horizontal', 'frontal', 'vertical'];
    if (!kinds.includes(op.hingeKind as string)) {
      errors.push({ path: 'operation.hingeKind', message: `must be one of ${kinds.join(', ')}` });
    }
    const hinge = op.hinge;
    if (!isObj(hinge)) {
      errors.push({ path: 'operation.hinge', message: 'must be an object' });
    } else {
      for (const key of ['aH', 'bH', 'aV', 'bV'] as const) {
        if (hinge[key] !== undefined) checkVec2(hinge[key], `operation.hinge.${key}`, errors);
      }
      // The pair the hinge kind requires: horizontal folds need the H drawing of the hinge,
      // frontal folds the V drawing; a vertical hinge is a point in H (its H "pair" may collapse).
      if (op.hingeKind === 'horizontal' && (!hinge.aH || !hinge.bH)) {
        errors.push({ path: 'operation.hinge', message: 'horizontal hinge needs aH and bH' });
      }
      if (op.hingeKind === 'frontal' && (!hinge.aV || !hinge.bV)) {
        errors.push({ path: 'operation.hinge', message: 'frontal hinge needs aV and bV' });
      }
      if (op.hingeKind === 'vertical' && !hinge.aH) {
        errors.push({ path: 'operation.hinge', message: 'vertical hinge needs aH (its H trace point)' });
      }
    }
    if (!Array.isArray(op.planePoints) || op.planePoints.length < 3) {
      errors.push({ path: 'operation.planePoints', message: 'needs at least 3 points' });
    } else {
      op.planePoints.forEach((id, i) => typeof id === 'string' && requireBothViews(id, `operation.planePoints[${i}]`));
    }
    if (op.rabattu !== undefined) {
      const r = op.rabattu;
      if (!isObj(r) || (r.view !== 'v' && r.view !== 'h') || !isObj(r.points)) {
        errors.push({ path: 'operation.rabattu', message: "needs { view: 'v'|'h', points }" });
      } else {
        const plane = Array.isArray(op.planePoints) ? (op.planePoints as string[]) : [];
        for (const [id, pos] of Object.entries(r.points)) {
          if (!plane.includes(id)) errors.push({ path: `operation.rabattu.points.${id}`, message: 'not in planePoints' });
          checkVec2(pos, `operation.rabattu.points.${id}`, errors);
        }
      }
    }
  } else if (op.kind === 'solid_section') {
    if (!Array.isArray(op.solid) || op.solid.length < 4) {
      errors.push({ path: 'operation.solid', message: 'needs at least 4 vertices' });
    } else {
      op.solid.forEach((id, i) => typeof id === 'string' && requireBothViews(id, `operation.solid[${i}]`));
    }
    if (!Array.isArray(op.planePoints) || op.planePoints.length !== 3) {
      errors.push({ path: 'operation.planePoints', message: 'needs exactly 3 points defining the cutting plane' });
    } else {
      op.planePoints.forEach((id, i) => typeof id === 'string' && requireBothViews(id, `operation.planePoints[${i}]`));
    }
    if (!Array.isArray(op.section) || op.section.length < 3) {
      errors.push({ path: 'operation.section', message: 'needs at least 3 section vertices' });
    } else {
      op.section.forEach((id, i) => typeof id === 'string' && requireBothViews(id, `operation.section[${i}]`));
    }
  } else if (op.kind === 'change_of_plane') {
    if (op.replaced !== 'v' && op.replaced !== 'h') {
      errors.push({ path: 'operation.replaced', message: "must be 'v' or 'h'" });
    }
    const l = op.newGroundLine;
    if (!isObj(l) || !checkVec2(l.a, 'operation.newGroundLine.a', errors) || !checkVec2(l.b, 'operation.newGroundLine.b', errors)) {
      errors.push({ path: 'operation.newGroundLine', message: 'needs { a, b }' });
    } else if (Math.hypot((l.b as Vec2).x - (l.a as Vec2).x, (l.b as Vec2).y - (l.a as Vec2).y) < 1) {
      errors.push({ path: 'operation.newGroundLine', message: 'degenerate (shorter than 1px)' });
    }
    if (!Array.isArray(op.points) || op.points.length === 0) {
      errors.push({ path: 'operation.points', message: 'must be a non-empty array' });
    } else {
      op.points.forEach((id, i) => typeof id === 'string' && requireBothViews(id, `operation.points[${i}]`));
    }
    if (op.auxiliary !== undefined) {
      if (!isObj(op.auxiliary)) {
        errors.push({ path: 'operation.auxiliary', message: 'must be an object' });
      } else {
        const carried = Array.isArray(op.points) ? (op.points as string[]) : [];
        for (const [id, pos] of Object.entries(op.auxiliary)) {
          if (!carried.includes(id)) errors.push({ path: `operation.auxiliary.${id}`, message: 'not in points' });
          checkVec2(pos, `operation.auxiliary.${id}`, errors);
        }
      }
    }
  } else if (op.kind === 'double_change_of_plane') {
    if (op.replaced1 !== 'v' && op.replaced1 !== 'h') {
      errors.push({ path: 'operation.replaced1', message: "must be 'v' or 'h'" });
    }
    for (const key of ['newGroundLine1', 'newGroundLine2'] as const) {
      const l = op[key];
      if (!isObj(l) || !checkVec2(l.a, `operation.${key}.a`, errors) || !checkVec2(l.b, `operation.${key}.b`, errors)) {
        errors.push({ path: `operation.${key}`, message: 'needs { a, b }' });
      } else if (Math.hypot((l.b as Vec2).x - (l.a as Vec2).x, (l.b as Vec2).y - (l.a as Vec2).y) < 1) {
        errors.push({ path: `operation.${key}`, message: 'degenerate (shorter than 1px)' });
      }
    }
    if (!Array.isArray(op.points) || op.points.length === 0) {
      errors.push({ path: 'operation.points', message: 'must be a non-empty array' });
    } else {
      op.points.forEach((id, i) => typeof id === 'string' && requireBothViews(id, `operation.points[${i}]`));
    }
    const carried = Array.isArray(op.points) ? (op.points as string[]) : [];
    for (const key of ['auxiliary1', 'trueShape'] as const) {
      const gold = op[key];
      if (gold === undefined) continue;
      if (!isObj(gold)) {
        errors.push({ path: `operation.${key}`, message: 'must be an object' });
      } else {
        for (const [id, pos] of Object.entries(gold)) {
          if (!carried.includes(id)) errors.push({ path: `operation.${key}.${id}`, message: 'not in points' });
          checkVec2(pos, `operation.${key}.${id}`, errors);
        }
      }
    }
  } else {
    errors.push({ path: 'operation.kind', message: `unknown kind "${op.kind}"` });
  }

  if (x.labels !== undefined) {
    if (!Array.isArray(x.labels)) errors.push({ path: 'labels', message: 'must be an array' });
    else x.labels.forEach((l, i) => {
      if (!isObj(l) || typeof l.text !== 'string') errors.push({ path: `labels[${i}]`, message: 'needs { text, anchor }' });
      else checkVec2(l.anchor, `labels[${i}].anchor`, errors);
    });
  }

  return errors.length ? { ok: false, errors } : { ok: true, ir: x as unknown as EpureIR };
}
