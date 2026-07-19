import type { Block } from './types';

/**
 * The pure half of the figure-redraw client: result shapes and the result→block mapping. Split out
 * of figure.ts because that file imports ./pdf, whose Vite-only `?url` worker import cannot load
 * under `tsx --test` — this module keeps the mapping unit-testable. No fetch lives here.
 */

export interface FigureRedraw {
  svg: string;
  caption: string;
  model: string;
  /** The model's enumeration of what it read off the crop (ticks/points or parts/labels) before drawing. */
  reading?: string;
  raw?: string;
  /**
   * False when the model judged the crop is NOT a data chart (apparatus, scheme, photo, table…) and
   * declined to draw one — `svg` is empty and the caller keeps the original scan instead of a
   * fabricated chart. Undefined for a normal redraw and for the stub.
   */
  isChart?: boolean;
  /** What the crop actually is — present only when `isChart` is false. */
  reason?: string;
  /** True when the server returned the keyless stub (no XAI_API_KEY yet). */
  stub?: boolean;
  /** Served from the server's disk cache — no API call, no cost. */
  cached?: boolean;
}

/** The critic's verdict on a redraw, compared against the original scan crop. */
export interface FigureCompare {
  faithful: boolean;
  problems: string[];
  summary: string;
  model: string;
  /** Present only when the critic did not return clean JSON — nothing concrete to act on. */
  raw?: string;
  cached?: boolean;
}

/** The outcome of the full checked loop: final redraw, final critic verdict, how many draws it took. */
export interface CheckedRedraw {
  redraw: FigureRedraw;
  /** Null when the critic never produced a verdict (raster or compare failed) — NOT a pass. */
  critique: FigureCompare | null;
  attempts: number;
}

/**
 * Map a redraw result to the block patch, handling both outcomes in one place so the Convert row
 * and the Book batch stay in step. A chart stores its SVG and clears any prior non-chart verdict; a
 * non-chart stores the "keep the scan" verdict AND clears any prior (possibly fabricated) SVG, so
 * re-running a figure that was wrongly drawn before now removes the fabrication. Either way, a
 * fresh drawing invalidates any earlier critic verdict — it judged a different image.
 */
export function figureRedrawPatch(r: FigureRedraw): Partial<Block> {
  if (r.isChart === false) {
    return {
      redrawNotChart: true,
      redrawReason: r.reason,
      redrawnSvg: '',
      redrawnCaption: '',
      redrawnModel: r.model,
      redrawnStub: false,
      redrawReading: undefined,
      redrawChecked: false,
      redrawFaithful: undefined,
      redrawProblems: undefined,
      redrawCheckModel: undefined,
    };
  }
  return {
    redrawnSvg: r.svg,
    redrawnCaption: r.caption,
    redrawnModel: r.model,
    redrawnStub: r.stub,
    redrawNotChart: false,
    redrawReason: undefined,
    redrawReading: r.reading,
    redrawChecked: false,
    redrawFaithful: undefined,
    redrawProblems: undefined,
    redrawCheckModel: undefined,
  };
}

/**
 * Map the checked loop's final outcome to the block patch: the redraw plus, when the critic
 * actually ran, its verdict. A null critique leaves `redrawChecked` false — absence of a verdict is
 * "never compared", never a pass.
 */
export function checkedRedrawPatch(r: CheckedRedraw): Partial<Block> {
  const base = figureRedrawPatch(r.redraw);
  if (!r.critique || r.critique.raw || r.redraw.isChart === false || !r.redraw.svg) return base;
  return {
    ...base,
    redrawChecked: true,
    redrawFaithful: r.critique.faithful,
    redrawProblems: r.critique.problems,
    redrawCheckModel: r.critique.model,
  };
}

/**
 * Retry exactly when the critic returned a real verdict with concrete problems. An unparseable
 * reply (`raw`) or an empty problems list gives the retry nothing to fix, so it must not fire —
 * a blind second draw costs money and can only get worse or drift.
 */
export function critiqueWantsRetry(c: FigureCompare | null): boolean {
  return Boolean(c && !c.faithful && c.problems.length > 0 && !c.raw);
}
