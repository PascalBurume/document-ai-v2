import { add, scale, sub, type Vec3 } from './epureMath';
import type { Vec2 } from './epureIr';

export type DiagnosticSource = 'v' | 'h';

/** One mathematically valid line of positions preserving a projection read from the plate. */
export interface DiagnosticLocus {
  id: string;
  diagnosticId: string;
  label: string;
  kind: 'missing' | 'unpaired';
  /** Projection that remains fixed while the opposite coordinate moves along this locus. */
  source: DiagnosticSource;
  a: Vec3;
  b: Vec3;
  plate: {
    known: { view: DiagnosticSource; at: Vec2 };
    assumed: { view: DiagnosticSource; a: Vec2; b: Vec2 };
  };
}

/** Presentation-only choice. It never enters the deterministic Reconstruction or EpureIR. */
export interface ManualAssumption {
  diagnosticId: string;
  locusId: string;
  t: number;
  confirmed: boolean;
}

export type FigureAssumptions = Record<string, ManualAssumption>;
export type AssumptionStore = Record<string, FigureAssumptions>;

export function clampAssumptionT(t: number): number {
  return Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0.5;
}

export function pointOnLocus(locus: Pick<DiagnosticLocus, 'a' | 'b'>, t: number): Vec3 {
  return add(locus.a, scale(sub(locus.b, locus.a), clampAssumptionT(t)));
}

export function pointOnPlateLocus(locus: DiagnosticLocus, t: number): Vec2 {
  const q = clampAssumptionT(t);
  return {
    x: locus.plate.assumed.a.x + (locus.plate.assumed.b.x - locus.plate.assumed.a.x) * q,
    y: locus.plate.assumed.a.y + (locus.plate.assumed.b.y - locus.plate.assumed.a.y) * q,
  };
}

/** Missing-view diagnostics have exactly one honest locus, so expose its hollow midpoint handle. */
export function defaultAssumptions(loci: DiagnosticLocus[]): FigureAssumptions {
  const grouped = new Map<string, DiagnosticLocus[]>();
  for (const locus of loci) grouped.set(locus.diagnosticId, [...(grouped.get(locus.diagnosticId) ?? []), locus]);
  const out: FigureAssumptions = {};
  for (const [diagnosticId, options] of grouped) {
    if (options.length !== 1 || options[0].kind !== 'missing') continue;
    out[diagnosticId] = { diagnosticId, locusId: options[0].id, t: 0.5, confirmed: false };
  }
  return out;
}

export function chooseLocus(
  assumptions: FigureAssumptions,
  locus: DiagnosticLocus,
  current?: ManualAssumption,
): FigureAssumptions {
  return {
    ...assumptions,
    [locus.diagnosticId]: {
      diagnosticId: locus.diagnosticId,
      locusId: locus.id,
      t: current?.diagnosticId === locus.diagnosticId ? clampAssumptionT(current.t) : 0.5,
      confirmed: current?.locusId === locus.id ? current.confirmed : false,
    },
  };
}

export function updateAssumption(
  assumptions: FigureAssumptions,
  diagnosticId: string,
  patch: Partial<Pick<ManualAssumption, 't' | 'confirmed'>>,
): FigureAssumptions {
  const current = assumptions[diagnosticId];
  if (!current) return assumptions;
  return {
    ...assumptions,
    [diagnosticId]: {
      ...current,
      ...patch,
      t: patch.t === undefined ? current.t : clampAssumptionT(patch.t),
    },
  };
}

export function assumptionsEqual(a: FigureAssumptions, b: FigureAssumptions): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  return ak.length === bk.length && ak.every((key) => {
    const x = a[key], y = b[key];
    return Boolean(y) && x.diagnosticId === y.diagnosticId && x.locusId === y.locusId && x.t === y.t && x.confirmed === y.confirmed;
  });
}
