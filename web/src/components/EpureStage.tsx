import { useEffect, useRef, useState } from 'react';
import type { EpureFigure } from '../lib/epureCatalog';
import type { EpureScene } from '../lib/epureScene';
import { EpureViewer, type EpureLayers, type EpureView } from './EpureViewer';

/** The layers, with the swatch each one draws in. Shared with the tab's inline legend. */
export const LEGEND: { key: keyof EpureLayers; label: string; swatch: string }[] = [
  { key: 'spatial', label: 'figure dans l’espace', swatch: '#111111' },
  { key: 'v', label: 'plan frontal πᵛ et proj.', swatch: '#2f5d7c' },
  { key: 'h', label: 'plan horizontal πᴴ et proj.', swatch: '#8a7a33' },
  { key: 'projectors', label: 'projetantes', swatch: '#b5b5b5' },
  { key: 'hinge', label: 'charnière', swatch: '#b3543a' },
  { key: 'rabattu', label: 'rabattement', swatch: '#b3543a' },
  { key: 'section', label: 'section', swatch: '#3f7d4f' },
  { key: 'aux', label: 'changement de plan', swatch: '#7a4fa3' },
  { key: 'diagnostics', label: 'relevé / coordonnée manquante', swatch: '#d12f2f' },
  { key: 'labels', label: 'noms', swatch: '#767676' },
];

interface Props {
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
  onLayers: (l: EpureLayers) => void;
  view: EpureView;
  /** True when resting at (or heading to) the flat plate. */
  onPlate: boolean;
  onToggleEnd: () => void;
  hoveredId: string | null;
  onHoverPoint: (id: string | null) => void;
  /** Rabattement swept so far, in degrees — display only. */
  foldDeg: number;
  hasFold: boolean;
  warnings: string[];
  onClose: () => void;
}

/**
 * The épure full-screen: the whole viewport is the drawing, and everything written on top of it —
 * the header plate, the layer panel, the hint — floats like annotations on a draughtsman's sheet.
 * Same scene, same state as the tab; this is a presentation, not a second model, so closing it
 * returns to the tab with every slider exactly where it was left.
 */
export function EpureStage({
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
  onPlate,
  onToggleEnd,
  hoveredId,
  onHoverPoint,
  foldDeg,
  hasFold,
  warnings,
  onClose,
}: Props) {
  const [playing, setPlaying] = useState(false);
  /** Bumped by « Recentrer » so the viewer re-applies the current view's home camera. */
  const [recenter, setRecenter] = useState(0);

  // The « Replier ▸ » loop: sweep the rabattement back and forth until paused, like scrubbing the
  // slider by hand. Reads foldT through a ref so a frame's own update doesn't restart the effect.
  const foldRef = useRef(foldT);
  foldRef.current = foldT;
  const dirRef = useRef(foldT > 0.5 ? -1 : 1);
  useEffect(() => {
    if (!playing || !hasFold) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      let t = foldRef.current + dirRef.current * dt * 0.55; // a full swing in ~1.8s
      if (t >= 1) {
        t = 1;
        dirRef.current = -1;
      } else if (t <= 0) {
        t = 0;
        dirRef.current = 1;
      }
      onFoldT(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, hasFold, onFoldT]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="epure-stage">
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
      />

      <div className="es-plate">
        <div className="no">Épure {current.label} · reconstruction</div>
        <h1>La figure dans l’espace</h1>
        <p>
          Les deux projections de Monge relevées dans l’espace, avec le rabattement du plan sur sa
          charnière pour la vraie grandeur.
        </p>
        {figures.length > 1 && (
          <div className="segmented es-figures">
            {figures.map((f) => (
              <button key={f.key} className={f.key === current.key ? 'on' : ''} onClick={() => onSelect(f.key)}>
                {f.label}
              </button>
            ))}
          </div>
        )}
        {warnings.map((w, i) => (
          <span key={i} className="chip flag">
            ⚠ {w}
          </span>
        ))}
      </div>

      <div className="es-panel">
        <h2>Afficher</h2>
        {LEGEND.map((l) => (
          <label key={l.key} className="row">
            <input
              type="checkbox"
              checked={layers[l.key]}
              onChange={(e) => onLayers({ ...layers, [l.key]: e.target.checked })}
            />
            <span className="sw" style={{ background: l.swatch }} />
            {l.label}
          </label>
        ))}

        <div className="fold">
          <label className="val">
            dièdre <b>{(dihedralT * 90).toFixed(0)}°</b>
          </label>
          <input
            type="range"
            min={0}
            max={1}
            step={0.005}
            value={dihedralT}
            onChange={(e) => onDihedralT(Number(e.target.value))}
            aria-label="Ouverture du dièdre"
          />
          {hasFold && (
            <>
              <label className="val">
                rabattement <b>{foldDeg.toFixed(0)}°</b>
              </label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.005}
                value={foldT}
                onChange={(e) => onFoldT(Number(e.target.value))}
                aria-label="Angle de rabattement"
              />
            </>
          )}
          {hasAux && (
            <>
              <label className="val">
                changement de plan <b>{(auxT * 90).toFixed(0)}°</b>
              </label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.005}
                value={auxT}
                onChange={(e) => onAuxT(Number(e.target.value))}
                aria-label="Rabattement du plan auxiliaire"
              />
            </>
          )}
          <div className="btns">
            {hasFold && <button onClick={() => setPlaying((p) => !p)}>{playing ? 'Pause' : 'Replier ▸'}</button>}
            <button onClick={onToggleEnd}>{onPlate ? '⤢ Espace' : '⊞ Planche'}</button>
            <button onClick={() => setRecenter((n) => n + 1)}>Recentrer</button>
          </div>
        </div>
      </div>

      <div className="es-hint">
        <b>glisser</b> orbiter · <b>molette</b> zoom · <b>clic droit</b> déplacer · <b>Échap</b> fermer
      </div>
      <button className="es-close" onClick={onClose} title="Revenir à l’onglet Épure (Échap)">
        ✕
      </button>
    </div>
  );
}
