import { useMemo, useRef, useState } from 'react';
import type { DocFile } from '../lib/types';
import { epureCoverageFor, epureFacts, epureFiguresFor } from '../lib/epureCatalog';
import { reconstruct } from '../lib/epureReconstruct';
import { buildEpureScene } from '../lib/epureScene';
import {
  chooseLocus,
  defaultAssumptions,
  updateAssumption,
  type AssumptionStore,
  type DiagnosticLocus,
  type FigureAssumptions,
} from '../lib/epureAssumptions';
import { ALL_LAYERS, EpureViewer, type EpureLayers, type EpureView } from './EpureViewer';
import { EpurePlate } from './EpurePlate';
import { EpureStage, LEGEND } from './EpureStage';
import { summarizeReconstructionWarnings } from '../lib/epureWorkspace';

interface Props {
  doc: DocFile;
  /**
   * Current 1-based document page. The tab shows the épure(s) that live on THIS scan page, so paging
   * the document moves the 3D with it; picking a figure from the index navigates the scan to its page.
   */
  page: number;
  /** Move the document to a page — the figure stepper walks between every page that carries a figure. */
  onPage: (p: number) => void;
  /** Which sub-figure is open; `EpureFigure.key`. Owned by App so Convert can jump straight here. */
  selected: string | null;
  onSelect: (key: string) => void;
}

/**
 * The two ends of the tab's one idea. Everything between them is reachable by dragging — orbit
 * with the mouse, scrub the two sliders — so there are no buttons for it.
 *
 * These two are the exception, and only because of the camera. Flat, the scene is the printed
 * plate, and the claim it makes is that it MATCHES the plate beside it — which is a claim about
 * lengths, so it has to be read square-on. Orbiting there by hand lands near the plan view, and
 * near is a foreshortening the eye cannot see but the check depends on.
 */
/**
 * The épure workbench: the reading on its plate, the 3D it determines, and the numbers that come
 * out — computed, never asserted. Nothing on this screen came from a model. The épure fully
 * determines the 3D, so there is no depth estimation anywhere in this path, which is why the
 * warnings are surfaced rather than smoothed over: when this view is wrong, the READING is wrong.
 *
 * The two sliders are two different constructions, and the tab keeps them straight:
 *
 *   dièdre       the sheet itself. At 0 the scene is flat and IS the plate beside it — so the
 *                Planche view is a check anyone can run by looking, not a decoration.
 *   rabattement  the figure's plane swung onto its projection plane, giving true size.
 *
 * An arbitrary pair of the two is a superposition of two constructions with no joint meaning, so
 * the presets always move them together; the sliders are for scrubbing between those states.
 */
export function EpureTab({ doc, page, onPage, selected, onSelect }: Props) {
  // Keyed on what the catalog actually binds to, not the whole document: a redraw or an OCR patch
  // makes a new doc object every time, and rebuilding `current` from it would re-run the intro
  // animation underneath a reader who is in the middle of looking at something.
  const figures = useMemo(() => epureFiguresFor(doc), [doc.name, doc.pageCount]); // eslint-disable-line react-hooks/exhaustive-deps
  // The 3D is bound to the page you are on. It shows the épure(s) on THIS scan page — most pages
  // have none, and that is honest (only a hand-read figure gets a reconstruction). `selected` only
  // disambiguates when a single page holds several sub-figures (E61 b and c share one sheet).
  const onThisPage = useMemo(() => figures.filter((f) => f.pageIndex === page - 1), [figures, page]);
  const current = onThisPage.find((f) => f.key === selected) ?? onThisPage[0] ?? null;

  const figurePages = useMemo(() => {
    return [...new Set(figures.map((figure) => figure.pageIndex))].sort((a, b) => a - b);
  }, [figures]);

  const [foldT, setFoldT] = useState(1);
  const [dihedralT, setDihedralT] = useState(0);
  /** The change-of-plane unfold: 1 = auxiliary in space, 0 = swung flat (the drawn auxiliary). */
  const [auxT, setAuxT] = useState(1);
  const [view, setView] = useState<EpureView>('isometric');
  const [layers, setLayers] = useState<EpureLayers>(ALL_LAYERS);
  const [hovered, setHovered] = useState<string | null>(null);
  /** Full-screen stage. Same state throughout, so it opens and closes exactly where the tab is. */
  const [full, setFull] = useState(false);
  /** The complete catalog is useful for navigation, but should not permanently consume the view. */
  const [indexOpen, setIndexOpen] = useState(false);
  /** Manual red points live only for this mounted document tab; they never touch IR or storage. */
  const [assumptionStore, setAssumptionStore] = useState<AssumptionStore>({});
  const launchButton = useRef<HTMLButtonElement>(null);

  const built = useMemo(() => {
    if (!current) return null;
    const recon = reconstruct(current.ir);
    return { recon, scene: recon.fatal ? null : buildEpureScene(current.ir, recon), facts: epureFacts(current.ir) };
  }, [current]);

  const assumptionDefaults = useMemo(
    () => defaultAssumptions(built?.scene?.diagnostics?.loci ?? []),
    [built?.scene],
  );
  const currentAssumptions: FigureAssumptions = current
    ? { ...assumptionDefaults, ...(assumptionStore[current.key] ?? {}) }
    : {};

  const setFigureAssumptions = (update: (current: FigureAssumptions) => FigureAssumptions) => {
    if (!current) return;
    setAssumptionStore((store) => ({
      ...store,
      [current.key]: update({ ...assumptionDefaults, ...(store[current.key] ?? {}) }),
    }));
  };

  const chooseDiagnosticLocus = (locus: DiagnosticLocus) => {
    setFigureAssumptions((state) => chooseLocus(state, locus, state[locus.diagnosticId]));
  };

  const changeAssumption = (diagnosticId: string, t: number, confirmed: boolean) => {
    setFigureAssumptions((state) => updateAssumption(state, diagnosticId, { t, confirmed }));
  };

  const resetAssumptions = () => {
    if (!current) return;
    setAssumptionStore((store) => ({ ...store, [current.key]: assumptionDefaults }));
  };

  // Opening the full workspace is deliberately explicit. Scrolling the document changes `current`,
  // but must never pull the reader away from the page into the Atelier 3D.
  const closeWorkspace = () => {
    setFull(false);
    window.requestAnimationFrame(() => launchButton.current?.focus());
  };

  // The page-linked index: every reconstructable épure in the book, each labelled with its page.
  // Picking one navigates the scan there (App owns `page`), so it doubles as "which pages have 3D".
  const index = figures.length > 0 && (
    <div className={`epure-index${indexOpen ? ' open' : ''}`} aria-label="Figures 3D">
      <button
        className="epure-index-toggle"
        onClick={() => setIndexOpen((open) => !open)}
        aria-expanded={indexOpen}
        aria-controls="epure-figure-catalog"
      >
        <span>Figures 3D</span>
        <span className="epure-index-count">{figures.length}</span>
        {current && <span className="epure-index-current">{current.label} · p.{current.pageIndex + 1}</span>}
        <span className="epure-index-chevron" aria-hidden="true">⌄</span>
      </button>
      {indexOpen && <div id="epure-figure-catalog" className="epure-index-list">
        {figures.map((f) => {
          const coverage = epureCoverageFor(doc, f.pageIndex, f.blockId);
          const status = coverage?.status === 'partial' ? 'partial' : 'exact';
          return (
            <button
              key={f.key}
              className={`epure-index-chip ${status}${current && f.key === current.key ? ' on' : ''}`}
              onClick={() => {
                onSelect(f.key);
                setIndexOpen(false);
              }}
              title={`${status === 'partial' ? 'Reconstruction partielle avec loci rouges' : 'Reconstruction exacte'} · page ${f.pageIndex + 1}`}
            >
              <span className="status-dot" aria-hidden="true" />
              {f.label} <span className="pg">p.{f.pageIndex + 1}</span>
            </button>
          );
        })}
      </div>}
    </div>
  );

  // Step through EVERY figure page in order — skipping the text-only pages between them — so the
  // visualization stays glued to the scan whichever figure you walk to, 3D or redraw.
  const curIdx0 = page - 1;
  const prevFig = [...figurePages].reverse().find((p) => p < curIdx0);
  const nextFig = figurePages.find((p) => p > curIdx0);
  const figRank = figurePages.indexOf(curIdx0);
  const stepper = figurePages.length > 0 && (
    <div className="epure-stepper">
      <button className="btn tiny ghost" disabled={prevFig === undefined} onClick={() => prevFig !== undefined && onPage(prevFig + 1)} title="Figure précédente">
        ◀
      </button>
      <span className="muted">{figRank >= 0 ? `figure ${figRank + 1} / ${figurePages.length}` : `${figurePages.length} figures`}</span>
      <button className="btn tiny ghost" disabled={nextFig === undefined} onClick={() => nextFig !== undefined && onPage(nextFig + 1)} title="Figure suivante">
        ▶
      </button>
    </div>
  );

  // A scan page can contain several independent drawings. Keep its local choices visible so the
  // second reconstruction is not hidden inside the complete 63-figure catalog.
  const pageFigures = onThisPage.length > 1 && (
    <div className="epure-page-figures" role="group" aria-label={`Figures 3D de la page ${page}`}>
      <span>Sur cette page</span>
      {onThisPage.map((figure) => (
        <button
          key={figure.key}
          className={figure.key === current?.key ? 'on' : ''}
          aria-pressed={figure.key === current?.key}
          onClick={() => onSelect(figure.key)}
          title={`Afficher ${figure.label} — dessin source ${figure.blockId}`}
        >
          {figure.label}
        </button>
      ))}
    </div>
  );

  if (figures.length === 0)
    return <p className="note pad">Aucune figure lue dans ce document.</p>;

  // No 3D on this page — but most figure pages still have a hand-redrawn figure, and THAT is the
  // visualization to read beside the scan. So the tab shows it rather than an apology; the scan is
  // already in the left pane, so this completes the side-by-side for every figure, not just the four.
  if (!current || !built) {
    return (
      <div className="epure-tab">
        <div className="epure-bar">
          {index}
          <span className="spacer" />
          {stepper}
        </div>
        <p className="note pad">
          Aucune figure 3D sur la page {page}. « ▶ » saute à la figure suivante ou choisissez une figure ci-dessus.
        </p>
      </div>
    );
  }

  const fold = built.scene?.fold;
  const foldDeg = fold ? Math.abs((foldT * fold.angle * 180) / Math.PI) : 0;
  const changePlane = built.scene?.changePlane;
  const onPlate = view === 'planche';
  const warningSummaries = summarizeReconstructionWarnings(built.recon.warnings);

  return (
    <div className="epure-tab">
      <div className="epure-bar">
        {index}
        {pageFigures}
        <span className="spacer" />
        {stepper}
        {warningSummaries.map((warning) => (
          <span key={warning.code} className="chip flag" title={warning.detail}>
            ⚠ {warning.label}
          </span>
        ))}
        {built.scene && (
          <button ref={launchButton} className="btn tiny ghost" onClick={() => setFull(true)} title="Ouvrir l’atelier 2D vers 3D">
            ◇ Atelier 3D
          </button>
        )}
      </div>

      {built.scene && full ? (
        <EpureStage
          doc={doc}
          figures={figures}
          current={current}
          onSelect={onSelect}
          scene={built.scene}
          foldT={foldT}
          onFoldT={setFoldT}
          dihedralT={dihedralT}
          onDihedralT={setDihedralT}
          auxT={auxT}
          onAuxT={setAuxT}
          hasAux={Boolean(changePlane)}
          layers={layers}
          onLayers={setLayers}
          view={view}
          onView={setView}
          hoveredId={hovered}
          onHoverPoint={setHovered}
          hasFold={Boolean(fold)}
          warnings={built.recon.warnings}
          assumptions={currentAssumptions}
          onChooseLocus={chooseDiagnosticLocus}
          onAssumptionChange={changeAssumption}
          onResetAssumptions={resetAssumptions}
          onClose={closeWorkspace}
        />
      ) : built.scene ? (
        <>
          <EpureViewer
            scene={built.scene}
            foldT={foldT}
            dihedralT={dihedralT}
            auxT={auxT}
            layers={layers}
            view={view}
            hoveredId={hovered}
            onHoverPoint={setHovered}
            assumptions={currentAssumptions}
            onAssumptionChange={changeAssumption}
          />

          <div className="epure-foldrow">
            <span className="muted">dièdre</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.005}
              value={dihedralT}
              onChange={(e) => setDihedralT(Number(e.target.value))}
              aria-label="Ouverture du dièdre"
            />
            <code>{(dihedralT * 90).toFixed(0)}°</code>
            <button
              className="btn tiny ghost"
              onClick={() => {
                if (onPlate) {
                  setView('isometric');
                  setDihedralT(1);
                  setFoldT(0);
                } else {
                  setView('planche');
                  setDihedralT(0);
                  setFoldT(fold ? 1 : 0);
                }
              }}
              title={
                onPlate
                  ? 'Rouvrir le dièdre : la figure dans l’espace.'
                  : 'Rabattre π^H sur π^V et regarder de face : la planche telle qu’imprimée. Elle doit correspondre au dessin ci-dessous — sinon la lecture est fausse.'
              }
            >
              {onPlate ? '⤢ Espace' : '⊞ Planche'}
            </button>
          </div>
          {fold && (
            <div className="epure-foldrow">
              <span className="muted">rabattement</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.005}
                value={foldT}
                onChange={(e) => setFoldT(Number(e.target.value))}
                aria-label="Angle de rabattement"
              />
              <code>{foldDeg.toFixed(0)}°</code>
            </div>
          )}
          {changePlane && (
            <div className="epure-foldrow">
              <span className="muted">changement de plan</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.005}
                value={auxT}
                onChange={(e) => setAuxT(Number(e.target.value))}
                aria-label="Rabattement du plan auxiliaire"
              />
              <code>{(auxT * 90).toFixed(0)}°</code>
            </div>
          )}

          <div className="epure-legend">
            {LEGEND.map((l) => (
              <label key={l.key} className={layers[l.key] ? '' : 'off'}>
                <input
                  type="checkbox"
                  checked={layers[l.key]}
                  onChange={(e) => setLayers({ ...layers, [l.key]: e.target.checked })}
                />
                <span className="sw" style={{ background: l.swatch }} />
                {l.label}
              </label>
            ))}
          </div>

          <div className="epure-split">
            <section>
              <h4 className="epure-h">La lecture, sur la planche</h4>
              <EpurePlate
                doc={doc}
                ir={current.ir}
                pageIndex={current.pageIndex}
                blockId={current.blockId}
                hoveredId={hovered}
                onHoverPoint={setHovered}
                scene={built.scene}
                assumptions={currentAssumptions}
              />
              <p className="note">
                Les points tels qu’ils ont été lus, en pixels. Tout le reste en découle — et ne vaut pas mieux.
              </p>
            </section>
            <section>
              <h4 className="epure-h">Ce qui se calcule</h4>
              <ul className="epure-facts">
                {built.facts.map((f, i) => (
                  <li
                    key={i}
                    className={f.pointId && f.pointId === hovered ? 'on' : ''}
                    onMouseEnter={() => f.pointId && setHovered(f.pointId)}
                    onMouseLeave={() => f.pointId && setHovered(null)}
                  >
                    {f.text}
                  </li>
                ))}
              </ul>
              {built.scene.trueLength !== undefined && (
                <p className="note">Vraie grandeur : {built.scene.trueLength.toFixed(1)} px du dessin.</p>
              )}
            </section>
          </div>
        </>
      ) : (
        <div className="epure-state-card error">
          <span className="state-dot" />
          <div>
            <strong>Reconstruction impossible</strong>
            <small>{built.recon.warnings.map((w) => w.message).join(' — ')}</small>
          </div>
        </div>
      )}

      <p className="note epure-hint">glisser : orbiter · molette : zoom · clic droit : déplacer · double-clic : recentrer</p>
      {built.recon.warnings.some((w) => w.code === 'incomplete') && (
        <p className="note epure-2d-note">
          Reconstruction <strong>partielle</strong>. Les points{' '}
          <strong style={{ color: '#d12f2f' }}>rouges</strong> sont les coordonnées relevées ; une{' '}
          <strong style={{ color: '#d12f2f' }}>droite rouge</strong> marque une coordonnée que la planche ne fixe
          pas — projection non tracée (la droite = positions possibles le long de l’axe manquant) ou projections
          V/H incohérentes (deux droites qui ne se coupent pas). Un point rouge confirmé reste une{' '}
          <strong>hypothèse utilisateur</strong> et ne participe pas aux mesures exactes.{' '}
          {built.recon.warnings
            .filter((w) => w.code === 'incomplete')
            .map((w) => w.message)
            .join(' · ')}
        </p>
      )}
      {current.ir.source.caption && <p className="note">{current.ir.source.caption}</p>}
      <p className="note">
        Reconstruction <strong>calculée</strong> depuis la lecture manuelle de la figure redessinée — géométrie pure,
        aucun modèle. Elle vaut ce que vaut la lecture ; le scan reste la référence.
      </p>
    </div>
  );
}
