import { useMemo } from 'react';
import type { EpureIR } from '../lib/epureIr';
import type { EpureScene } from '../lib/epureScene';
import { pointOnPlateLocus, type FigureAssumptions } from '../lib/epureAssumptions';
import type { DocFile } from '../lib/types';
import { figureSetFor } from '../lib/authoredFigures';

interface Props {
  doc: DocFile;
  ir: EpureIR;
  pageIndex: number;
  blockId: string;
  hoveredId: string | null;
  onHoverPoint: (id: string | null) => void;
  scene?: EpureScene;
  assumptions?: FigureAssumptions;
}

/**
 * The reading, drawn on the plate it was read from.
 *
 * `EpureIR.imageSize` has always carried the authored SVG's viewBox so that a UI could put the IR
 * back over the figure; this is that UI. It matters because the IR is the one hand-made step in an
 * otherwise closed-form pipeline — every downstream number is exact, and exactly as good as these
 * pixel positions. Showing them ON the drawing is what makes a misread point findable instead of a
 * silent 3D distortion.
 *
 * Nothing here is computed: these are the coordinates as written in the IR.
 */
export function EpurePlate({ doc, ir, pageIndex, blockId, hoveredId, onHoverPoint, scene, assumptions = {} }: Props) {
  const fig = figureSetFor(doc)?.[`${pageIndex}:${blockId}`];
  const { width, height } = ir.imageSize;

  const marks = useMemo(() => {
    const out: { id: string; x: number; y: number; view: 'v' | 'h' }[] = [];
    for (const p of ir.points) {
      if (p.v) out.push({ id: p.id, x: p.v.x, y: p.v.y, view: 'v' });
      if (p.h) out.push({ id: p.id, x: p.h.x, y: p.h.y, view: 'h' });
    }
    return out;
  }, [ir]);

  const assumptionMarks = useMemo(() => {
    const loci = scene?.diagnostics?.loci ?? [];
    const byId = new Map(loci.map((locus) => [locus.id, locus]));
    return Object.values(assumptions).flatMap((assumption) => {
      const locus = byId.get(assumption.locusId);
      if (!locus) return [];
      return [{ assumption, locus, missing: pointOnPlateLocus(locus, assumption.t) }];
    });
  }, [assumptions, scene]);

  const rabattu = ir.operation.kind === 'rabattement_plane' ? ir.operation.rabattu : undefined;
  // Radius scales with the plate so the target stays the same size whatever the viewBox.
  const r = Math.max(width, height) / 90;

  if (!fig) return <p className="note">Planche introuvable pour ce bloc.</p>;

  return (
    <div className="epure-plate">
      <div className="epure-plate-svg" dangerouslySetInnerHTML={{ __html: fig.svg }} />
      <svg className="epure-plate-overlay" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet">
        <line
          className="pl-lt"
          x1={ir.groundLine.a.x}
          y1={ir.groundLine.a.y}
          x2={ir.groundLine.b.x}
          y2={ir.groundLine.b.y}
        />
        {rabattu &&
          Object.entries(rabattu.points).map(([id, p]) => (
            <circle
              key={`r-${id}`}
              className={`pl-dot rabattu${hoveredId === id ? ' on' : ''}`}
              cx={p.x}
              cy={p.y}
              r={r}
              onMouseEnter={() => onHoverPoint(id)}
              onMouseLeave={() => onHoverPoint(null)}
            >
              <title>{`${id}ᴿ — rabattu tracé sur la planche`}</title>
            </circle>
          ))}
        {marks.map((m) => (
          <circle
            key={`${m.view}-${m.id}`}
            className={`pl-dot ${m.view}${hoveredId === m.id ? ' on' : ''}`}
            cx={m.x}
            cy={m.y}
            r={r}
            onMouseEnter={() => onHoverPoint(m.id)}
            onMouseLeave={() => onHoverPoint(null)}
          >
            <title>{`${m.id}${m.view === 'v' ? 'ᵛ' : 'ᴴ'} — lu à (${m.x}, ${m.y})`}</title>
          </circle>
        ))}
        {assumptionMarks.map(({ assumption, locus, missing }) => (
          <g key={locus.diagnosticId} className={`pl-assumption${assumption.confirmed ? ' confirmed' : ''}`}>
            <line
              className="pl-assumption-line"
              x1={locus.plate.known.at.x}
              y1={locus.plate.known.at.y}
              x2={missing.x}
              y2={missing.y}
            />
            <circle className="pl-assumption-known" cx={locus.plate.known.at.x} cy={locus.plate.known.at.y} r={r * 0.75} />
            <circle className="pl-assumption-point" cx={missing.x} cy={missing.y} r={r}>
              <title>
                {assumption.confirmed
                  ? `${locus.label} — hypothèse utilisateur, projection ${locus.plate.assumed.view.toUpperCase()}`
                  : `${locus.label} — position à choisir sur le locus rouge`}
              </title>
            </circle>
          </g>
        ))}
      </svg>
    </div>
  );
}
