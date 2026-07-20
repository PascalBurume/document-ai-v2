import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EpureFigure } from '../lib/epureCatalog';
import { epureFacts } from '../lib/epureCatalog';
import type { EpureScene } from '../lib/epureScene';
import type { DiagnosticLocus, FigureAssumptions } from '../lib/epureAssumptions';
import type { DocFile } from '../lib/types';
import {
  LAYER_GROUPS,
  RECONSTRUCTION_STATUS,
  reconstructionStatus,
  workspacePose,
  WORKSPACE_STEPS,
  type EpureWorkspaceStep,
} from '../lib/epureWorkspace';
import { EpurePlate } from './EpurePlate';
import { EpureViewer, type EpureInteractionMode, type EpureLayers, type EpureView } from './EpureViewer';

/** The layers, with the semantic colour each one draws in. */
export const LEGEND: { key: keyof EpureLayers; label: string; swatch: string }[] = [
  { key: 'spatial', label: 'figure dans l’espace', swatch: '#111111' },
  { key: 'v', label: 'plan frontal πᵛ', swatch: '#2f5d7c' },
  { key: 'h', label: 'plan horizontal πᴴ', swatch: '#8a7a33' },
  { key: 'projectors', label: 'projetantes', swatch: '#9aa1aa' },
  { key: 'hinge', label: 'charnière', swatch: '#b3543a' },
  { key: 'rabattu', label: 'rabattement', swatch: '#b3543a' },
  { key: 'section', label: 'section', swatch: '#3f7d4f' },
  { key: 'aux', label: 'plan auxiliaire', swatch: '#7a4fa3' },
  { key: 'diagnostics', label: 'coordonnées incertaines', swatch: '#d12f2f' },
  { key: 'labels', label: 'noms des points', swatch: '#68707c' },
];

const LEGEND_BY_KEY = new Map(LEGEND.map((entry) => [entry.key, entry]));

const CAMERAS: { id: EpureView; label: string; icon: string }[] = [
  { id: 'isometric', label: 'Isométrique', icon: '◇' },
  { id: 'front', label: 'Face', icon: '▣' },
  { id: 'top', label: 'Dessus', icon: '▱' },
  { id: 'planche', label: 'Planche', icon: '⊞' },
];

const WARNING_LABEL: Record<string, string> = {
  incomplete: 'Coordonnée indéterminée',
  'recall-mismatch': 'Écart entre les projections V/H',
  'not-coplanar': 'Coplanarité à vérifier',
  'section-off-plane': 'Section hors du plan',
  'aux-vs-authored': 'Vue auxiliaire à vérifier',
  'rabattu-vs-authored': 'Rabattement à vérifier',
  'true-shape-vs-authored': 'Vraie grandeur à vérifier',
  collinear: 'Points alignés',
  unsupported: 'Construction non résolue',
};

interface Props {
  doc: DocFile;
  figures: EpureFigure[];
  current: EpureFigure;
  onSelect: (key: string) => void;
  scene: EpureScene;
  foldT: number;
  onFoldT: (t: number) => void;
  dihedralT: number;
  onDihedralT: (t: number) => void;
  auxT: number;
  onAuxT: (t: number) => void;
  hasAux: boolean;
  layers: EpureLayers;
  onLayers: (layers: EpureLayers) => void;
  view: EpureView;
  onView: (view: EpureView) => void;
  hoveredId: string | null;
  onHoverPoint: (id: string | null) => void;
  hasFold: boolean;
  warnings: { code: string; message: string }[];
  assumptions: FigureAssumptions;
  onChooseLocus: (locus: DiagnosticLocus) => void;
  onAssumptionChange: (diagnosticId: string, t: number, confirmed: boolean) => void;
  onResetAssumptions: () => void;
  onClose: () => void;
}

/** Full CAD-classroom workspace around the same deterministic scene used by the embedded preview. */
export function EpureStage({
  doc,
  figures,
  current,
  onSelect,
  scene,
  foldT,
  onFoldT,
  dihedralT,
  onDihedralT,
  auxT,
  onAuxT,
  hasAux,
  layers,
  onLayers,
  view,
  onView,
  hoveredId,
  onHoverPoint,
  hasFold,
  warnings,
  assumptions,
  onChooseLocus,
  onAssumptionChange,
  onResetAssumptions,
  onClose,
}: Props) {
  const [playing, setPlaying] = useState(false);
  const [activeStep, setActiveStep] = useState<EpureWorkspaceStep>('space');
  const [progress, setProgress] = useState(2 / 3);
  const [recenter, setRecenter] = useState(0);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [noticeVisible, setNoticeVisible] = useState(true);
  const [noticePaused, setNoticePaused] = useState(false);
  const [interactionMode, setInteractionMode] = useState<EpureInteractionMode>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const status = reconstructionStatus(warnings.map((warning) => warning.code));
  const statusCopy = RECONSTRUCTION_STATUS[status];
  const facts = useMemo(() => epureFacts(current.ir), [current]);
  const diagnosticGroups = useMemo(() => {
    const groups = new Map<string, DiagnosticLocus[]>();
    for (const locus of scene.diagnostics?.loci ?? []) {
      groups.set(locus.diagnosticId, [...(groups.get(locus.diagnosticId) ?? []), locus]);
    }
    return [...groups.entries()].map(([diagnosticId, loci]) => ({ diagnosticId, label: loci[0].label, kind: loci[0].kind, loci }));
  }, [scene]);
  const incompleteWarnings = warnings.filter((warning) => warning.code === 'incomplete').length;
  const confirmedAssumptions = diagnosticGroups.filter((group) => assumptions[group.diagnosticId]?.confirmed).length;
  const pendingAssumptions = diagnosticGroups.length - confirmedAssumptions;
  const spatialEdgeCount = scene.segments.filter((segment) => segment.kind === 'spatial').length;
  const sparseCompletion = incompleteWarnings > 0 && spatialEdgeCount === 0;
  const currentIndex = figures.findIndex((figure) => figure.key === current.key);
  const previous = currentIndex > 0 ? figures[currentIndex - 1] : null;
  const next = currentIndex >= 0 && currentIndex < figures.length - 1 ? figures[currentIndex + 1] : null;

  // The status remains permanently available in the top bar, but its detailed card should not
  // cover the geometry indefinitely. Hovering or focusing the card pauses the dismissal so the
  // copy and controls remain accessible to readers who need more time.
  useEffect(() => {
    setNoticeVisible(status === 'partial');
    setNoticePaused(false);
  }, [current.key, status]);

  useEffect(() => {
    if (status !== 'partial' || !noticeVisible || noticePaused) return;
    const timer = window.setTimeout(() => setNoticeVisible(false), 8000);
    return () => window.clearTimeout(timer);
  }, [current.key, noticePaused, noticeVisible, status]);

  const applyStep = useCallback(
    (step: EpureWorkspaceStep) => {
      const pose = workspacePose(step, hasFold, hasAux);
      setPlaying(false);
      setActiveStep(step);
      setProgress(WORKSPACE_STEPS.findIndex((entry) => entry.id === step) / (WORKSPACE_STEPS.length - 1));
      onDihedralT(pose.dihedralT);
      onFoldT(pose.foldT);
      onAuxT(pose.auxT);
      onView(pose.view);
    },
    [hasAux, hasFold, onAuxT, onDihedralT, onFoldT, onView],
  );

  // A new figure opens by demonstrating where its spatial reading came from. Respect reduced
  // motion: the complete 3D appears immediately instead of making motion a prerequisite.
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      applyStep('space');
      return;
    }
    const plate = workspacePose('plate', hasFold, hasAux);
    onDihedralT(plate.dihedralT);
    onFoldT(plate.foldT);
    onAuxT(plate.auxT);
    onView(plate.view);
    setActiveStep('plate');
    setProgress(0);
    const timer = window.setTimeout(() => setPlaying(true), 320);
    return () => window.clearTimeout(timer);
  }, [current.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // One continuous, pausable explanation. The controls and viewport are driven by the same four
  // poses as the step buttons, so playback cannot demonstrate a state the reader cannot revisit.
  useEffect(() => {
    if (!playing) return;
    const poses = WORKSPACE_STEPS.map((entry) => workspacePose(entry.id, hasFold, hasAux));
    const duration = 6200;
    const started = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min((now - started) / duration, 1);
      const scaled = p * (poses.length - 1);
      const index = Math.min(Math.floor(scaled), poses.length - 2);
      const local = scaled - index;
      const smooth = local * local * (3 - 2 * local);
      const from = poses[index];
      const to = poses[index + 1];
      const mix = (a: number, b: number) => a + (b - a) * smooth;
      onDihedralT(mix(from.dihedralT, to.dihedralT));
      onFoldT(mix(from.foldT, to.foldT));
      onAuxT(mix(from.auxT, to.auxT));
      onView(local < 0.45 ? from.view : to.view);
      setActiveStep(WORKSPACE_STEPS[local < 0.5 ? index : index + 1].id);
      setProgress(p);
      if (p < 1) raf = requestAnimationFrame(tick);
      else {
        setPlaying(false);
        setActiveStep('trueSize');
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, current.key, hasAux, hasFold, onAuxT, onDihedralT, onFoldT, onView]);

  useEffect(() => {
    workspaceRef.current?.querySelector<HTMLButtonElement>('.ew-back')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const focusable = [...(workspaceRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select, input:not(:disabled)') ?? [])]
          .filter((element) => element.offsetParent !== null);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
      if (event.key === ' ' && !['INPUT', 'SELECT', 'BUTTON'].includes((event.target as HTMLElement)?.tagName)) {
        event.preventDefault();
        setPlaying((value) => !value);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggleGroup = (keys: (keyof EpureLayers)[]) => {
    const enable = keys.some((key) => !layers[key]);
    onLayers({ ...layers, ...Object.fromEntries(keys.map((key) => [key, enable])) });
  };

  const revealInspector = (selector: '.ew-assumptions' | '.ew-warnings') => {
    setInspectorOpen(true);
    window.requestAnimationFrame(() => {
      inspectorRef.current?.querySelector<HTMLElement>(selector)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  };

  return (
    <div ref={workspaceRef} className="epure-workspace" role="dialog" aria-modal="true" aria-label={`Reconstruction 3D ${current.label}`}>
      <header className="ew-topbar">
        <button className="ew-icon-button ew-back" onClick={onClose} aria-label="Revenir au document">
          ← <span>Document</span>
        </button>
        <div className="ew-title">
          <span className="ew-kicker">Atelier 2D → 3D</span>
          <strong>{current.label}</strong>
        </div>
        <label className="ew-figure-select">
          <span>Figure</span>
          <select value={current.key} onChange={(event) => onSelect(event.target.value)}>
            {figures.map((figure) => (
              <option key={figure.key} value={figure.key}>
                {figure.label} · p.{figure.pageIndex + 1}
              </option>
            ))}
          </select>
        </label>
        <span className="ew-page">Page {current.pageIndex + 1}</span>
        {status === 'exact' ? (
          <span className="ew-status exact" title={statusCopy.detail}><i /> {statusCopy.label}</span>
        ) : (
          <button
            className={`ew-status ${status}${incompleteWarnings ? ' guided' : ''}`}
            title={noticeVisible ? `${statusCopy.detail} — ouvrir les contrôles` : `${statusCopy.detail} — afficher le résumé`}
            aria-expanded={noticeVisible}
            onClick={() => noticeVisible
              ? revealInspector(incompleteWarnings ? '.ew-assumptions' : '.ew-warnings')
              : setNoticeVisible(true)}
          >
            <i /> {incompleteWarnings ? 'Complétion guidée' : statusCopy.label}
          </button>
        )}
        <nav className="ew-cameras" aria-label="Vues de la caméra">
          {CAMERAS.map((camera) => (
            <button
              key={camera.id}
              className={view === camera.id || (view === 'espace' && camera.id === 'isometric') ? 'on' : ''}
              onClick={() => onView(camera.id)}
              title={`Vue ${camera.label}`}
              aria-pressed={view === camera.id}
            >
              <span aria-hidden="true">{camera.icon}</span> {camera.label}
            </button>
          ))}
        </nav>
        <button className="ew-icon-button" onClick={() => setRecenter((value) => value + 1)} title="Recentrer la caméra">
          ↺ <span>Recentrer</span>
        </button>
      </header>

      <aside className={`ew-source${sourceOpen ? ' open' : ''}`} aria-label="Planche source">
        <div className="ew-panel-head">
          <div>
            <span className="ew-kicker">Source vérifiable</span>
            <h2>Lecture sur la planche</h2>
          </div>
          <button className="ew-panel-close" onClick={() => setSourceOpen(false)} aria-label="Fermer la source">×</button>
        </div>
        <div className="ew-source-plate">
          <EpurePlate
            doc={doc}
            ir={current.ir}
            pageIndex={current.pageIndex}
            blockId={current.blockId}
            hoveredId={hoveredId}
            onHoverPoint={onHoverPoint}
            scene={scene}
            assumptions={assumptions}
          />
        </div>
        <p className="ew-help">Survolez un point pour le retrouver dans l’espace. Le scan reste la référence.</p>
        <div className="ew-figure-nav">
          <button disabled={!previous} onClick={() => previous && onSelect(previous.key)}>← Précédente</button>
          <span>{currentIndex + 1} / {figures.length}</span>
          <button disabled={!next} onClick={() => next && onSelect(next.key)}>Suivante →</button>
        </div>
      </aside>

      <main className="ew-viewport">
        <EpureViewer
          scene={scene}
          foldT={foldT}
          dihedralT={dihedralT}
          auxT={auxT}
          layers={layers}
          view={view}
          recenter={recenter}
          hoveredId={hoveredId}
          onHoverPoint={onHoverPoint}
          assumptions={assumptions}
          onAssumptionChange={onAssumptionChange}
          onInteractionMode={setInteractionMode}
        />
        <div className="ew-viewport-badge">
          <span className="dot v" /> πᵛ
          <span className="dot h" /> πᴴ
          <span className="dot spatial" /> figure 3D
        </div>
        {status === 'partial' && noticeVisible && (
          <section
            className={`ew-reconstruction-notice${incompleteWarnings ? ' actionable' : ' review'}`}
            role="status"
            onMouseEnter={() => setNoticePaused(true)}
            onMouseLeave={() => setNoticePaused(false)}
            onFocus={() => setNoticePaused(true)}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setNoticePaused(false);
            }}
          >
            <span className="ew-notice-icon" aria-hidden="true">✦</span>
            <div className="ew-notice-copy">
              <span className="ew-kicker">{incompleteWarnings ? 'Complétion 3D guidée' : 'Contrôle de reconstruction'}</span>
              <strong>{incompleteWarnings
                ? pendingAssumptions
                  ? sparseCompletion ? 'Construisez depuis les lieux possibles' : 'Complétez les points rouges'
                  : 'Hypothèses placées — reconstruction partielle'
                : 'Lecture géométrique à vérifier'}</strong>
              <p>
                {incompleteWarnings
                  ? pendingAssumptions
                    ? sparseCompletion
                      ? `Cette planche fixe un ancrage 3D mais pas un solide unique. Le moteur calcule ${pendingAssumptions} lieu${pendingAssumptions > 1 ? 'x' : ''} rouge${pendingAssumptions > 1 ? 's' : ''} ; la complétion assistée vous guide sans fabriquer de profondeur.`
                      : `La partie noire est calculée. ${pendingAssumptions} point${pendingAssumptions > 1 ? 's restent' : ' reste'} à placer sur ${pendingAssumptions > 1 ? 'les lieux rouges' : 'le lieu rouge'} — aucune profondeur n’est inventée.`
                    : 'Tous les points proposés ont été placés. Ils restent rouges et marqués comme hypothèses utilisateur ; les mesures exactes ne les absorbent pas.'
                  : `${warnings.length} contrôle${warnings.length > 1 ? 's dépassent' : ' dépasse'} la tolérance du tracé. La 3D reste visible, mais elle n’est pas présentée comme exacte.`}
              </p>
              <div className="ew-notice-legend" aria-label="Provenance de la géométrie">
                <span className="calculated">Calcul déterministe</span>
                {incompleteWarnings > 0 && <span className="guided">Guidage assisté</span>}
                {confirmedAssumptions > 0 && <span className="assumed">Hypothèse utilisateur</span>}
              </div>
              {diagnosticGroups.length > 0 && (
                <span className="ew-notice-progress">{confirmedAssumptions}/{diagnosticGroups.length} hypothèse{diagnosticGroups.length > 1 ? 's' : ''} confirmée{confirmedAssumptions > 1 ? 's' : ''}</span>
              )}
            </div>
            <button className="ew-notice-action" onClick={() => revealInspector(incompleteWarnings ? '.ew-assumptions' : '.ew-warnings')}>
              {incompleteWarnings ? (pendingAssumptions ? 'Placer les points' : 'Revoir les points') : 'Voir les contrôles'} →
            </button>
            <button className="ew-notice-close" onClick={() => setNoticeVisible(false)} aria-label="Masquer le résumé de reconstruction" title="Masquer">×</button>
          </section>
        )}
        <div className="ew-mobile-tools">
          <button onClick={() => setSourceOpen(true)}>▧ Source</button>
          <button onClick={() => setInspectorOpen(true)}>☷ Inspecteur</button>
        </div>
        <div className="ew-mouse-guide" aria-label="Commandes de la vue 3D">
          <span className={interactionMode === 'orbit' ? 'active' : ''}><i>↻</i><b>Glisser</b> orbiter</span>
          <span className={interactionMode === 'pan' ? 'active' : ''}><i>✥</i><b>Clic droit / ⇧</b> déplacer</span>
          <span className={interactionMode === 'zoom' ? 'active' : ''}><i>↕</i><b>Molette</b> zoomer</span>
          <span><i>2×</i><b>Double-clic</b> recentrer</span>
        </div>
      </main>

      <aside ref={inspectorRef} className={`ew-inspector${inspectorOpen ? ' open' : ''}`} aria-label="Inspecteur de la reconstruction">
        <div className="ew-panel-head">
          <div>
            <span className="ew-kicker">Inspecteur</span>
            <h2>Scène et mesures</h2>
          </div>
          <button className="ew-panel-close" onClick={() => setInspectorOpen(false)} aria-label="Fermer l’inspecteur">×</button>
        </div>

        <section className="ew-inspector-section">
          <h3>Calques</h3>
          {LAYER_GROUPS.map((group) => {
            const enabled = group.keys.filter((key) => layers[key]).length;
            return (
              <div className="ew-layer-group" key={group.id}>
                <button className="ew-layer-group-title" onClick={() => toggleGroup(group.keys)}>
                  <span>{group.label}</span><small>{enabled}/{group.keys.length}</small>
                </button>
                {group.keys.map((key) => {
                  const item = LEGEND_BY_KEY.get(key)!;
                  return (
                    <label key={key} className={!layers[key] ? 'off' : ''}>
                      <input type="checkbox" checked={layers[key]} onChange={(event) => onLayers({ ...layers, [key]: event.target.checked })} />
                      <span className="sw" style={{ background: item.swatch }} />
                      {item.label}
                    </label>
                  );
                })}
              </div>
            );
          })}
        </section>

        <section className="ew-inspector-section ew-measures">
          <h3>Ce qui se calcule</h3>
          <ul>
            {facts.map((fact, index) => (
              <li
                key={index}
                className={fact.pointId && fact.pointId === hoveredId ? 'on' : ''}
                onMouseEnter={() => fact.pointId && onHoverPoint(fact.pointId)}
                onMouseLeave={() => fact.pointId && onHoverPoint(null)}
              >
                {fact.text}
              </li>
            ))}
          </ul>
        </section>

        {diagnosticGroups.length > 0 && (
          <section className="ew-inspector-section ew-assumptions">
            <div className="ew-assumption-heading">
              <div>
                <h3>Points à compléter</h3>
                <p>Le moteur calcule les lieux rouges ; le guidage explique le choix. Seule votre validation crée une hypothèse.</p>
              </div>
              <button onClick={onResetAssumptions}>Réinitialiser</button>
            </div>
            {diagnosticGroups.map((group) => {
              const assumption = assumptions[group.diagnosticId];
              return (
                <div className="ew-assumption-card" key={group.diagnosticId}>
                  <div className="ew-assumption-title">
                    <strong>{group.label}</strong>
                    <span className={assumption?.confirmed ? 'confirmed' : ''}>
                      {assumption?.confirmed ? 'Hypothèse utilisateur' : assumption ? 'À placer' : 'Projection à choisir'}
                    </span>
                  </div>
                  {group.kind === 'unpaired' && (
                    <div className="ew-source-choice" role="group" aria-label={`Projection à conserver pour ${group.label}`}>
                      {group.loci.map((locus) => (
                        <button
                          key={locus.id}
                          className={assumption?.locusId === locus.id ? 'on' : ''}
                          onClick={() => onChooseLocus(locus)}
                          aria-pressed={assumption?.locusId === locus.id}
                        >
                          Conserver {locus.source.toUpperCase()}
                        </button>
                      ))}
                    </div>
                  )}
                  {assumption && (
                    <>
                      <label className="ew-assumption-slider">
                        <span>Position sur la ligne</span>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.005}
                          value={assumption.t}
                          onChange={(event) => onAssumptionChange(group.diagnosticId, Number(event.target.value), assumption.confirmed)}
                          aria-label={`Position supposée du point ${group.label}`}
                        />
                        <output>{Math.round(assumption.t * 100)}%</output>
                      </label>
                      {!assumption.confirmed && (
                        <button
                          className="ew-confirm-assumption"
                          onClick={() => onAssumptionChange(group.diagnosticId, assumption.t, true)}
                        >
                          Confirmer ce point rouge
                        </button>
                      )}
                    </>
                  )}
                </div>
              );
            })}
            <p className="ew-assumption-note">Les hypothèses restent rouges, exclues des mesures exactes et limitées à cette session.</p>
          </section>
        )}

        {warnings.length > 0 && (
          <section className="ew-inspector-section ew-warnings">
            <div className="ew-warning-heading">
              <div><h3>Contrôles de reconstruction</h3><p>Ces écarts restent visibles : le moteur ne les corrige jamais silencieusement.</p></div>
              <span>{warnings.length}</span>
            </div>
            {warnings.map((warning, index) => (
              <article key={index}>
                <span aria-hidden="true">!</span>
                <div><strong>{WARNING_LABEL[warning.code] ?? warning.code}</strong><p>{warning.message}</p></div>
              </article>
            ))}
          </section>
        )}
      </aside>

      <footer className="ew-transport">
        <button
          className="ew-play"
          onClick={() => {
            if (!playing && progress >= 0.99) applyStep('plate');
            setPlaying((value) => !value);
          }}
          aria-label={playing ? 'Mettre l’animation en pause' : 'Lire la transformation 2D vers 3D'}
        >
          {playing ? 'Ⅱ' : '▶'}
        </button>
        <div className="ew-timeline">
          <div className="ew-track"><i style={{ width: `${progress * 100}%` }} /></div>
          <div className="ew-step-buttons">
            {WORKSPACE_STEPS.map((step) => (
              <button key={step.id} className={activeStep === step.id ? 'on' : ''} onClick={() => applyStep(step.id)}>
                <span>{step.shortLabel}</span>{step.label}
              </button>
            ))}
          </div>
        </div>
        <div className="ew-live-values">
          <span>Dièdre <b>{Math.round(dihedralT * 90)}°</b></span>
          {hasFold && <span>Rabattement <b>{Math.round(Math.abs((foldT * (scene.fold?.angle ?? 0) * 180) / Math.PI))}°</b></span>}
          {hasAux && <span>Plan auxiliaire <b>{Math.round(auxT * 90)}°</b></span>}
        </div>
      </footer>
    </div>
  );
}
