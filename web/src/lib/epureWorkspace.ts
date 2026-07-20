import type { EpureLayers, EpureView } from '../components/EpureViewer';
import type { ReconWarning } from './epureReconstruct';

/** The four teaching stops in the 2D -> 3D demonstration. */
export type EpureWorkspaceStep = 'plate' | 'projections' | 'space' | 'trueSize';

export interface EpureWorkspacePose {
  dihedralT: number;
  foldT: number;
  auxT: number;
  view: EpureView;
}

export const WORKSPACE_STEPS: { id: EpureWorkspaceStep; label: string; shortLabel: string }[] = [
  { id: 'plate', label: 'Planche 2D', shortLabel: '2D' },
  { id: 'projections', label: 'Projections', shortLabel: 'Proj.' },
  { id: 'space', label: 'Figure 3D', shortLabel: '3D' },
  { id: 'trueSize', label: 'Vraie grandeur', shortLabel: 'V.G.' },
];

/**
 * One source of truth for buttons and playback. `foldT=1` is the rabattu/true-size state;
 * `dihedralT=0` is the printed sheet and `1` is the open Monge dihedral.
 */
export function workspacePose(step: EpureWorkspaceStep, hasFold: boolean, hasAux: boolean): EpureWorkspacePose {
  switch (step) {
    case 'plate':
      return { dihedralT: 0, foldT: hasFold ? 1 : 0, auxT: hasAux ? 0 : 1, view: 'planche' };
    case 'projections':
      return { dihedralT: 0.55, foldT: hasFold ? 1 : 0, auxT: hasAux ? 0.45 : 1, view: 'isometric' };
    case 'trueSize':
      return { dihedralT: 1, foldT: hasFold ? 1 : 0, auxT: 1, view: 'isometric' };
    case 'space':
    default:
      return { dihedralT: 1, foldT: 0, auxT: 1, view: 'isometric' };
  }
}

export const LAYER_GROUPS: {
  id: string;
  label: string;
  keys: (keyof EpureLayers)[];
}[] = [
  { id: 'geometry', label: 'Géométrie', keys: ['spatial', 'section'] },
  { id: 'projections', label: 'Projections', keys: ['v', 'h', 'aux'] },
  { id: 'construction', label: 'Construction', keys: ['projectors', 'hinge', 'rabattu'] },
  { id: 'diagnostics', label: 'Diagnostics', keys: ['diagnostics'] },
  { id: 'labels', label: 'Noms', keys: ['labels'] },
];

export type ReconstructionStatus = 'exact' | 'partial' | 'two-d-only' | 'error';

export const RECONSTRUCTION_STATUS: Record<ReconstructionStatus, { label: string; detail: string }> = {
  exact: { label: 'Reconstruction exacte', detail: 'Calculée depuis les deux projections.' },
  partial: { label: 'Reconstruction partielle', detail: 'Coordonnée indéterminée ou contrôle géométrique à vérifier.' },
  'two-d-only': { label: 'Planche 2D uniquement', detail: 'La planche ne détermine pas un objet 3D unique.' },
  error: { label: 'Reconstruction impossible', detail: 'La lecture géométrique ne satisfait pas les contrôles.' },
};

export function reconstructionStatus(warningCodes: string[], fatal = false): ReconstructionStatus {
  if (fatal) return 'error';
  return warningCodes.length > 0 ? 'partial' : 'exact';
}

export interface ReconstructionWarningSummary {
  code: ReconWarning['code'];
  count: number;
  label: string;
  detail: string;
}

const BAR_WARNING_LABEL: Record<ReconWarning['code'], [string, string]> = {
  incomplete: ['coordonnée à compléter', 'coordonnées à compléter'],
  'recall-mismatch': ['report V/H à vérifier', 'reports V/H à vérifier'],
  collinear: ['alignement dégénéré', 'alignements dégénérés'],
  'not-coplanar': ['coplanarité à vérifier', 'coplanarités à vérifier'],
  'rabattu-off-plane': ['rabattement hors plan', 'rabattements hors plan'],
  'rabattu-vs-authored': ['rabattement à vérifier', 'rabattements à vérifier'],
  'section-off-plane': ['section à vérifier', 'sections à vérifier'],
  'aux-vs-authored': ['vue auxiliaire à vérifier', 'vues auxiliaires à vérifier'],
  'true-shape-vs-authored': ['vraie grandeur à vérifier', 'vraies grandeurs à vérifier'],
  unsupported: ['construction non résolue', 'constructions non résolues'],
};

/** One compact badge per warning kind; point-by-point evidence stays in the inspector. */
export function summarizeReconstructionWarnings(warnings: ReconWarning[]): ReconstructionWarningSummary[] {
  const groups = new Map<ReconWarning['code'], ReconWarning[]>();
  for (const warning of warnings) groups.set(warning.code, [...(groups.get(warning.code) ?? []), warning]);
  return [...groups.entries()].map(([code, members]) => ({
    code,
    count: members.length,
    label: `${members.length} ${BAR_WARNING_LABEL[code][members.length === 1 ? 0 : 1]}`,
    detail: members.map((warning) => warning.message).join('\n'),
  }));
}
