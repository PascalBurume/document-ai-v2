/**
 * Which figures have a hand-authored épure IR — and therefore a computable 3D reconstruction.
 *
 * Same binding discipline as the authored SVGs: an IR is keyed to the exact book (name + page
 * count) and the exact block it was read from, so a reconstruction can never render under some
 * other document's figure.
 */

import type { DocFile } from './types';
import type { EpureIR } from './epureIr';
import { matchesDessinScientifique } from './authoredFigures';
import { DESSIN_SCIENTIFIQUE_IR } from './figures/dessinScientifiqueIr';
import { reconstruct } from './epureReconstruct';
import { dist } from './epureMath';

const CATALOGS: { match: (doc: DocFile) => boolean; irs: Record<string, EpureIR[]> }[] = [
  { match: matchesDessinScientifique, irs: DESSIN_SCIENTIFIQUE_IR },
];

/** IRs for one figure block; empty when the figure has none (most figures, for now). */
export function epureIrsFor(doc: DocFile, pageIndex: number, blockId: string): EpureIR[] {
  const cat = CATALOGS.find((c) => c.match(doc));
  return cat?.irs[`${pageIndex}:${blockId}`] ?? [];
}

/** One entry per reconstructable sub-figure, in page order — the Épure tab's worklist. */
export interface EpureFigure {
  pageIndex: number;
  blockId: string;
  ir: EpureIR;
  /** Stable across renders and sessions: identifies one sub-figure of one block. */
  key: string;
  /** « E 61 (a) » — what the reader sees on the picker. */
  label: string;
}

/**
 * The plate number, taken from the authored caption — the only place it exists.
 *
 * `source.n` is the figure's index in figures.json, NOT the plate: E 61 is spread across fig01
 * (a) and fig02 (b, c), so deriving a plate number from `n` would put a wrong number on screen.
 */
function plateLabel(ir: EpureIR): string {
  const sub = ir.source.sub ? ` (${ir.source.sub})` : '';
  // The book names its plates two ways — « Épure E 61 » and « Planche E 65 » — so accept both.
  const plate = /(?:Épures?|Planche)\s+(E\s*\d+)/.exec(ir.source.caption ?? '')?.[1];
  return plate ? `${plate}${sub}` : `fig ${ir.source.n}${sub}`;
}

/**
 * Every épure in a document, flattened out of the catalog's own keys.
 *
 * Read from the catalog rather than by walking the document's blocks, which means this answers
 * before a single OCR call: the IR and the plate are both checked in, and the book is identified
 * by name and page count. Nothing in the 3D path needs the OCR result.
 */
export function epureFiguresFor(doc: DocFile): EpureFigure[] {
  const cat = CATALOGS.find((c) => c.match(doc));
  if (!cat) return [];
  const out: EpureFigure[] = [];
  for (const [key, irs] of Object.entries(cat.irs)) {
    const [page, blockId] = [Number(key.slice(0, key.indexOf(':'))), key.slice(key.indexOf(':') + 1)];
    for (const ir of irs) {
      if (reconstruct(ir).fatal) continue;
      out.push({
        pageIndex: page,
        blockId,
        ir,
        key: `${key}#${ir.source.sub ?? ir.source.n}`,
        label: plateLabel(ir),
      });
    }
  }
  return out.sort((a, b) => a.pageIndex - b.pageIndex || a.label.localeCompare(b.label));
}

/** True when the document has any reconstructable épure — gates the Épure tab. */
export function docHasEpures(doc: DocFile): boolean {
  return epureFiguresFor(doc).length > 0;
}

// The inputs are static (shipped IRs), so whether a block's reconstructions are usable is
// decided once, not on every render.
const usable = new Map<string, boolean>();

/** True when the block has at least one IR whose reconstruction is not fatally broken. */
export function epureAvailable(doc: DocFile, pageIndex: number, blockId: string): boolean {
  const irs = epureIrsFor(doc, pageIndex, blockId);
  if (!irs.length) return false;
  const key = `${pageIndex}:${blockId}`;
  let ok = usable.get(key);
  if (ok === undefined) {
    ok = irs.some((ir) => !reconstruct(ir).fatal);
    usable.set(key, ok);
  }
  return ok;
}

/** One computed statement about a figure. `pointId` is set when the fact is about one point. */
export interface EpureFact {
  text: string;
  pointId?: string;
}

/**
 * The reconstruction, stated as facts — in French, because these are French-language books.
 * Every number here is closed-form geometry over the hand-read IR.
 *
 * Two readers: the teaching model (via `epureFactsFr`), which gets arithmetic instead of
 * re-guessing the drawing, and the reader of the Épure tab, who gets the same numbers on screen.
 * They must be the same facts — a panel that disagreed with the prompt would be a second claim
 * about the figure, which is the one thing this pipeline exists not to produce.
 */
export function epureFacts(ir: EpureIR): EpureFact[] {
  const recon = reconstruct(ir);
  if (recon.fatal) return [];
  const facts: EpureFact[] = [];

  const op = ir.operation;
  if (op.kind === 'rabattement_plane' && recon.fold) {
    const hinge =
      op.hingeKind === 'horizontal'
        ? 'une droite horizontale du plan (le rabattement se fait sur le plan horizontal π^H)'
        : op.hingeKind === 'frontal'
          ? 'une frontale du plan (le rabattement se fait sur le plan vertical π^V)'
          : 'une droite verticale (le plan tourne jusqu’à devenir frontal)';
    facts.push({ text: `Opération : rabattement du polygone ${op.planePoints.join('')} autour de la charnière — ${hinge}.` });
    facts.push({ text: `Angle de rabattement calculé : ${Math.abs((recon.fold.angle * 180) / Math.PI).toFixed(1)}°.` });
    const fixed = op.planePoints.filter((id) => !recon.fold!.movingIds.includes(id));
    if (fixed.length) facts.push({ text: `Point(s) SUR la charnière (immobiles) : ${fixed.join(', ')}.` });
    for (let i = 0; i < op.planePoints.length; i++) {
      const a = op.planePoints[i];
      const b = op.planePoints[(i + 1) % op.planePoints.length];
      const pa = recon.points.get(a);
      const pb = recon.points.get(b);
      if (pa && pb) facts.push({ text: `Vraie grandeur de ${a}${b} : ${dist(pa, pb).toFixed(0)} unités du dessin.` });
    }
    facts.push({ text: 'Le polygone rabattu est en VRAIE GRANDEUR : le rabattement est une rotation rigide.' });
  } else if (op.kind === 'line_true_length' && recon.trueLength !== undefined) {
    facts.push({ text: `Vraie grandeur du segment ${op.from}${op.to} : ${recon.trueLength.toFixed(0)} unités du dessin.` });
  }

  for (const [id, p] of recon.points) {
    facts.push({
      text: `${id} : cote (hauteur) ${p.z.toFixed(0)}, éloignement ${p.y.toFixed(0)} (unités du dessin).`,
      pointId: id,
    });
  }
  return facts;
}

/**
 * The same facts as one block of prose, for the explanation prompt.
 *
 * The exact string is load-bearing: it rides in the prompt, and explanations disk-cache under a
 * hash of it, so any drift here silently re-bills every figure that was already paid for. A test
 * pins the output.
 */
export function epureFactsFr(ir: EpureIR): string {
  return epureFacts(ir)
    .map((f) => f.text)
    .join('\n');
}
