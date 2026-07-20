import { useEffect, useMemo, useRef, useState } from 'react';
import type { DocFile } from '../lib/types';
import { epureFacts, epureFiguresFor } from '../lib/epureCatalog';
import { figureSetFor, type AuthoredFigure } from '../lib/authoredFigures';
import { reconstruct } from '../lib/epureReconstruct';
import { buildEpureScene } from '../lib/epureScene';
import { ALL_LAYERS, EpureViewer, type EpureLayers, type EpureView } from './EpureViewer';
import { EpurePlate } from './EpurePlate';
import { EpurePlateViewer } from './EpurePlateViewer';
import { plateDiagnosticsFor } from '../lib/plateDiagnostics';
import { EpureStage, LEGEND } from './EpureStage';

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
const ENDS = {
  plate: { d: 0, f: 1, view: 'planche' as EpureView },
  space: { d: 1, f: 0, view: 'espace' as EpureView },
};

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

  // Every hand-redrawn figure in the book, keyed `pageIndex:blockId`. Most figures have a clean
  // redraw but NOT a 3D reconstruction (only rabattements/true-lengths do); the redraw is the
  // visualization we show beside the scan so that every figure page has something to compare, not
  // just the four with 3D.
  const figSet = useMemo(() => figureSetFor(doc), [doc.name, doc.pageCount]); // eslint-disable-line react-hooks/exhaustive-deps
  const figurePages = useMemo(() => {
    const s = new Set<number>();
    if (figSet) for (const k of Object.keys(figSet)) s.add(Number(k.slice(0, k.indexOf(':'))));
    return [...s].sort((a, b) => a - b);
  }, [figSet]);
  const pageFigures = useMemo<[string, AuthoredFigure][]>(() => {
    if (!figSet) return [];
    return Object.entries(figSet)
      .filter(([k]) => Number(k.slice(0, k.indexOf(':'))) === page - 1)
      .map(([k, f]) => [k.slice(k.indexOf(':') + 1), f]);
  }, [figSet, page]);

  // Every plate the book draws that has NO 3D reconstruction — construction plates (traces,
  // faisceaux), profile lines, curves, degenerate épures. They are still redrawn by hand and shown
  // in 2D beside the scan; this second index makes each one reachable directly, instead of only by
  // stepping page to page. Nothing here is 3D — it is honest about which plates the geometry can't lift.
  const keys3d = useMemo(() => new Set(figures.map((f) => `${f.pageIndex}:${f.blockId}`)), [figures]);
  const figures2d = useMemo(() => {
    if (!figSet) return [] as { key: string; pageIndex: number; blockId: string; label: string; has3d: boolean }[];
    return Object.entries(figSet)
      .map(([k, f]) => {
        const pageIndex = Number(k.slice(0, k.indexOf(':')));
        const blockId = k.slice(k.indexOf(':') + 1);
        const plate = /(?:Épures?|Planche)\s+(E\s*\d+)/.exec(f.caption ?? '')?.[1];
        return { key: k, pageIndex, blockId, label: plate ?? '2D', has3d: keys3d.has(k) };
      })
      // A plate belongs in the 2D index if it has no 3D (its only view), OR it carries a red-point
      // diagnostic worth zooming into even though it also reconstructs in 3D (E 82/86/87).
      .filter((e) => !e.has3d || plateDiagnosticsFor(e.pageIndex, e.blockId))
      .sort((a, b) => a.pageIndex - b.pageIndex || a.label.localeCompare(b.label));
  }, [figSet, keys3d]);
  // A 2D plate the reader explicitly opened from the index. It is shown full even on a page that
  // also carries a 3D figure, so a construction plate sharing a sheet with a rabattement is still
  // reachable. Gated by page so paging away drops back to the normal behaviour.
  const current2d = figures2d.find((f) => f.key === selected && f.pageIndex === page - 1) ?? null;
  const fig2d = current2d && figSet ? figSet[current2d.key] : null;

  const [foldT, setFoldT] = useState(1);
  const [dihedralT, setDihedralT] = useState(0);
  /** The change-of-plane unfold: 1 = auxiliary in space, 0 = swung flat (the drawn auxiliary). */
  const [auxT, setAuxT] = useState(1);
  /** Which end the scene is resting at (or heading to). The camera follows it — it is not its own state. */
  const [end, setEnd] = useState<keyof typeof ENDS>('space');
  const [layers, setLayers] = useState<EpureLayers>(ALL_LAYERS);
  const [hovered, setHovered] = useState<string | null>(null);
  /** Full-screen stage. Same state throughout, so it opens and closes exactly where the tab is. */
  const [full, setFull] = useState(false);

  const built = useMemo(() => {
    if (!current) return null;
    const recon = reconstruct(current.ir);
    return { recon, scene: recon.fatal ? null : buildEpureScene(current.ir, recon), facts: epureFacts(current.ir) };
  }, [current]);

  // Where the animation starts from, without making the animation restart whenever it moves.
  const from = useRef({ d: dihedralT, f: foldT });
  from.current = { d: dihedralT, f: foldT };

  // Travel to whichever end was asked for. On open that is the whole demonstration: the sheet is
  // flat (d=0, f=1) and stands up into space, with the rabattu swinging back into its own plane on
  // the way — the relation between the drawing and the solid, shown in 1.4s instead of explained in
  // a paragraph nobody reads. Afterwards the same path serves the toggle.
  //
  // No run-once guard: StrictMode double-mounts effects, and a ref flipped by the first, cancelled
  // run would silently swallow the animation.
  const hasScene = Boolean(built?.scene);
  useEffect(() => {
    if (!hasScene) return;
    const to = ENDS[end];
    const a = from.current;
    if (a.d === to.d && a.f === to.f) return; // already there — switching figures should not replay the show
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min((now - t0) / 1400, 1);
      const s = t * t * (3 - 2 * t); // smoothstep
      setDihedralT(a.d + (to.d - a.d) * s);
      setFoldT(a.f + (to.f - a.f) * s);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // The figure, not the built scene: this plays when the reader opens an épure, and must not
    // replay because something upstream handed us an equal scene in a new object.
  }, [current?.key, hasScene, end]);

  // The page-linked index: every reconstructable épure in the book, each labelled with its page.
  // Picking one navigates the scan there (App owns `page`), so it doubles as "which pages have 3D".
  const index = figures.length > 0 && (
    <div className="epure-index">
      <span className="muted">3D :</span>
      {figures.map((f) => (
        <button
          key={f.key}
          className={`epure-index-chip${current && f.key === current.key ? ' on' : ''}`}
          onClick={() => onSelect(f.key)}
          title={`Aller à la page ${f.pageIndex + 1}`}
        >
          {f.label} <span className="pg">p.{f.pageIndex + 1}</span>
        </button>
      ))}
    </div>
  );

  // The 2D companion index: every plate the geometry can't lift (clickable to its hand redraw), plus
  // the three lifted plates whose annotated plate carries the red diagnostic points (marked ●).
  const index2d = figures2d.length > 0 && (
    <div className="epure-index epure-index-2d">
      <span className="muted">2D :</span>
      {figures2d.map((f) => (
        <button
          key={f.key}
          className={`epure-index-chip flat${f.has3d ? ' annot' : ''}${current2d?.key === f.key ? ' on' : ''}`}
          onClick={() => {
            onPage(f.pageIndex + 1);
            onSelect(f.key);
          }}
          title={
            f.has3d
              ? `Planche annotée — coordonnées de la reconstruction 3D, en rouge (page ${f.pageIndex + 1})`
              : `Planche 2D redessinée — pas de reconstruction 3D (page ${f.pageIndex + 1})`
          }
        >
          {f.has3d && <span className="dot">●</span>} {f.label} <span className="pg">p.{f.pageIndex + 1}</span>
        </button>
      ))}
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

  if (figures.length === 0 && figurePages.length === 0)
    return <p className="note pad">Aucune figure lue dans ce document.</p>;

  // A 2D plate opened from the « 2D » index: show its hand redraw full, with the same two indexes
  // and the stepper. This wins over the page's 3D figure, so a construction plate that shares a sheet
  // with a rabattement is still reachable — and it is labelled for what it is, not dressed up as 3D.
  if (fig2d) {
    return (
      <div className="epure-tab">
        <div className="epure-bar">
          {index}
          {index2d}
          <span className="spacer" />
          {stepper}
        </div>
        <p className="note epure-2d-note">
          {current2d?.has3d ? (
            <>
              Planche annotée. Les points <strong style={{ color: '#d12f2f' }}>rouges</strong> sont les
              coordonnées relevées qui ont permis la reconstruction 3D — chaque sommet sur ses projections V et H.
            </>
          ) : (
            <>
              Planche redessinée à la main, à comparer au scan à gauche. Cette figure n’a <strong>pas</strong> de
              reconstruction 3D. Les points <strong style={{ color: '#d12f2f' }}>rouges</strong> montrent où la
              lecture bute : ● relevé, ○ projections V/H non concordantes, ✕ projection absente de la planche.
            </>
          )}
        </p>
        <AuthoredFigureView fig={fig2d} pageIndex={current2d!.pageIndex} blockId={current2d!.key.slice(current2d!.key.indexOf(':') + 1)} />
      </div>
    );
  }

  // No 3D on this page — but most figure pages still have a hand-redrawn figure, and THAT is the
  // visualization to read beside the scan. So the tab shows it rather than an apology; the scan is
  // already in the left pane, so this completes the side-by-side for every figure, not just the four.
  if (!current || !built) {
    return (
      <div className="epure-tab">
        <div className="epure-bar">
          {index}
          {index2d}
          <span className="spacer" />
          {stepper}
        </div>
        {pageFigures.length > 0 ? (
          <>
            <p className="note epure-2d-note">
              Figure redessinée à la main, à comparer au scan à gauche. Ce type de figure n’a pas de
              reconstruction 3D — seuls les rabattements et vraies grandeurs en ont une (les quatre sous « 3D »).
            </p>
            {pageFigures.map(([blockId, fig]) => (
              <AuthoredFigureView key={blockId} fig={fig} pageIndex={page - 1} blockId={blockId} />
            ))}
          </>
        ) : (
          <p className="note pad">
            Aucune figure sur la page {page}. « ▶ » saute à la figure suivante ; « 3D » ouvre une reconstruction.
          </p>
        )}
      </div>
    );
  }

  const fold = built.scene?.fold;
  const foldDeg = fold ? Math.abs((foldT * fold.angle * 180) / Math.PI) : 0;
  const changePlane = built.scene?.changePlane;
  const onPlate = end === 'plate';

  return (
    <div className="epure-tab">
      <div className="epure-bar">
        {index}
        {index2d}
        <span className="spacer" />
        {stepper}
        {built.recon.warnings.map((w, i) => (
          <span key={i} className="chip flag" title={w.message}>
            ⚠ {w.code}
          </span>
        ))}
        {built.scene && (
          <button className="btn tiny ghost" onClick={() => setFull(true)} title="Ouvrir la vue 3D en plein écran">
            ⛶ Plein écran
          </button>
        )}
      </div>

      {built.scene && full ? (
        <EpureStage
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
          view={ENDS[end].view}
          onPlate={onPlate}
          onToggleEnd={() => setEnd(onPlate ? 'space' : 'plate')}
          hoveredId={hovered}
          onHoverPoint={setHovered}
          foldDeg={foldDeg}
          hasFold={Boolean(fold)}
          warnings={built.recon.warnings.map((w) => w.message)}
          onClose={() => setFull(false)}
        />
      ) : built.scene ? (
        <>
          <EpureViewer
            scene={built.scene}
            foldT={foldT}
            dihedralT={dihedralT}
            auxT={auxT}
            layers={layers}
            view={ENDS[end].view}
            hoveredId={hovered}
            onHoverPoint={setHovered}
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
              onClick={() => setEnd(onPlate ? 'space' : 'plate')}
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
        <p className="note">
          Cette lecture ne se reconstruit pas : {built.recon.warnings.map((w) => w.message).join(' — ')}
        </p>
      )}

      <p className="note epure-hint">glisser : orbiter · molette : zoom · clic droit : déplacer · double-clic : recentrer</p>
      {built.recon.warnings.some((w) => w.code === 'incomplete') && (
        <p className="note epure-2d-note">
          Reconstruction <strong>partielle</strong>. Les points{' '}
          <strong style={{ color: '#d12f2f' }}>rouges</strong> sont les coordonnées relevées ; une{' '}
          <strong style={{ color: '#d12f2f' }}>droite rouge</strong> marque une coordonnée que la planche ne fixe
          pas — projection non tracée (la droite = positions possibles le long de l’axe manquant) ou projections
          V/H incohérentes (deux droites qui ne se coupent pas). Aucune position n’est inventée.{' '}
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

/**
 * One hand-redrawn figure, shown as the visualization for a page that has no 3D reconstruction. The
 * SVG is authored and checked in (trusted), and it is a RECONSTRUCTION, not evidence — the scan in
 * the left pane stays the reference, which is why they are read side by side.
 *
 * Drawn in a three.js canvas (`EpurePlateViewer`) rather than injected as static SVG, so a dense
 * construction plate can be zoomed and panned to read its points and thin lines. It falls back to the
 * inline SVG if the drawing can't be parsed.
 */
function AuthoredFigureView({ fig, pageIndex, blockId }: { fig: AuthoredFigure; pageIndex: number; blockId: string }) {
  return (
    <figure className="epure-figure">
      <EpurePlateViewer svg={fig.svg} points={plateDiagnosticsFor(pageIndex, blockId)} />
      <p className="note epure-hint">molette : zoom · glisser : déplacer · double-clic : recentrer</p>
      {fig.caption && <figcaption className="note">{fig.caption}</figcaption>}
      {fig.omissions && fig.omissions.length > 0 && (
        <p className="note">Non lus, laissés de côté plutôt que devinés : {fig.omissions.join(' ; ')}</p>
      )}
    </figure>
  );
}
