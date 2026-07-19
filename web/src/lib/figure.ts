import { renderPageToImage, renderRegionToImage } from './pdf';
import { critiqueWantsRetry, type CheckedRedraw, type FigureCompare, type FigureRedraw } from './figurePatch';
import type { Block, DocFile, OcrPage } from './types';

// The pure result→block mapping lives in figurePatch.ts (testable under tsx, which cannot load
// this file's ./pdf import); re-exported here so existing imports keep working.
export {
  checkedRedrawPatch,
  critiqueWantsRetry,
  figureRedrawPatch,
  type CheckedRedraw,
  type FigureCompare,
  type FigureRedraw,
} from './figurePatch';

/**
 * The image handed to the redraw model for one figure block, best quality first: a tight,
 * high-resolution crop rendered from the source PDF at the figure's own bbox reads far sharper
 * than Mistral's small extracted crop. Falls back to the extracted crop, then to the whole page
 * (or the image itself for image documents). Shared by the Convert and Book views.
 */
export async function figureCropDataUri(doc: DocFile, page: OcrPage, block: Block): Promise<string> {
  if (doc.sourceType === 'document_url' && page.width > 0 && page.height > 0) {
    try {
      return await renderRegionToImage(doc.id, doc.dataUri, page.index, block.bbox, page.width, page.height);
    } catch {
      /* region too small / render failed — fall through */
    }
  }
  if (block.imageBase64) {
    return block.imageBase64.startsWith('data:') ? block.imageBase64 : `data:image/jpeg;base64,${block.imageBase64}`;
  }
  if (doc.sourceType === 'image_url') return doc.dataUri;
  return renderPageToImage(doc.id, doc.dataUri, page.index);
}

/**
 * Downscale + JPEG-encode an image for calls where legibility is enough. The redraw pipeline
 * needs the lossless ~1600px crop (the model can only be as precise as the pixels), but that
 * body runs to a megabyte and the RUNBOOK's documented failure applies: large uploads to either
 * vision provider get their connection reset mid-flight (EPIPE / UND_ERR_SOCKET). An explanation
 * only needs to READ the figure, so it ships a ~1000px JPEG instead and actually arrives.
 */
export async function shrinkImage(dataUri: string, maxDim = 1000, quality = 0.82): Promise<string> {
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('image decode failed'));
      img.src = dataUri;
    });
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return dataUri;
    ctx.fillStyle = '#fff'; // JPEG has no alpha; a transparent crop must not turn black
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality);
  } catch {
    return dataUri;
  }
}

/**
 * Ask the server (xAI Grok) to recreate one figure as a clean, faithful SVG chart — axes,
 * curves, reference lines and French labels reproduced from the crop. Generated content: the
 * caller renders it with a visible AI label, next to (never instead of) the original.
 * `force` deliberately bypasses the server cache (billed); `feedback` carries the critic's
 * mismatches from a previous attempt into the retry prompt.
 */
export async function redrawFigure(
  image: string,
  context: string,
  opts: { force?: boolean; feedback?: string } = {},
): Promise<FigureRedraw> {
  const res = await fetch('/api/figure', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image, context, force: opts.force, feedback: opts.feedback }),
  });
  const data = await res.json().catch(() => ({ error: `Server returned ${res.status}.` }));
  if (!res.ok) throw new Error(data.error ?? `Server returned ${res.status}.`);
  return data as FigureRedraw;
}

/** Ask the critic to compare a rendered redraw against the original scan crop. */
export async function compareRedraw(original: string, redraw: string, context: string): Promise<FigureCompare> {
  const res = await fetch('/api/figure/compare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ original, redraw, context }),
  });
  const data = await res.json().catch(() => ({ error: `Server returned ${res.status}.` }));
  if (!res.ok) throw new Error(data.error ?? `Server returned ${res.status}.`);
  return data as FigureCompare;
}

/**
 * Render an SVG string to a PNG data URL, for the critic — vision models read rasters, not vector
 * source. White is painted first because the comparison is against a paper scan and an SVG without
 * its own background would rasterize transparent. Redraw SVGs are sanitized and self-contained
 * (no external references), so the canvas is never tainted. Returns null on any failure — a
 * failed raster only means "no critic verdict", never a broken redraw.
 */
export async function svgToPngDataUri(svg: string, width = 720): Promise<string | null> {
  try {
    const vb = /viewBox\s*=\s*["']\s*[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(svg);
    const vbW = vb ? parseFloat(vb[1]) : 720;
    const vbH = vb ? parseFloat(vb[2]) : 480;
    const height = Math.max(1, Math.round((width * vbH) / (vbW || 720)));

    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      const loaded = new Promise<boolean>((resolve) => {
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
      });
      img.src = url;
      if (!(await loaded)) return null;

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      return canvas.toDataURL('image/png');
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return null;
  }
}

export type RedrawStage = 'drawing' | 'checking' | 'retrying';

async function safeCompare(original: string, redraw: string, context: string): Promise<FigureCompare | null> {
  try {
    return await compareRedraw(original, redraw, context);
  } catch {
    return null; // no verdict — the redraw is kept and simply stays unchecked
  }
}

/**
 * The checked recreation loop: draw → critic compares the rendering against the scan crop → ONE
 * automatic retry with the critic's mismatches → final verdict. Whatever mismatches remain are the
 * caller's to render visibly. Failure handling is asymmetric on purpose: a failed retry never
 * downgrades the first drawing, and a failed compare degrades to "unchecked", never to a pass.
 */
export async function redrawFigureChecked(
  image: string,
  context: string,
  opts: { force?: boolean; onStage?: (s: RedrawStage) => void } = {},
): Promise<CheckedRedraw> {
  opts.onStage?.('drawing');
  const first = await redrawFigure(image, context, { force: opts.force });
  // Nothing drawn (not-a-chart verdict, soft failure) or the keyless stub — nothing to check.
  if (!first.svg || first.stub) return { redraw: first, critique: null, attempts: 1 };

  opts.onStage?.('checking');
  const png1 = await svgToPngDataUri(first.svg);
  const critique1 = png1 ? await safeCompare(image, png1, context) : null;
  if (!critiqueWantsRetry(critique1)) return { redraw: first, critique: critique1, attempts: 1 };

  opts.onStage?.('retrying');
  const second = await redrawFigure(image, context, {
    force: true,
    feedback: critique1!.problems.join('\n'),
  }).catch(() => null);
  if (!second?.svg) return { redraw: first, critique: critique1, attempts: 2 };

  opts.onStage?.('checking');
  const png2 = await svgToPngDataUri(second.svg);
  const critique2 = png2 ? await safeCompare(image, png2, context) : null;
  // The second verdict when we have one; otherwise the first — remaining mismatches stay visible.
  return { redraw: second, critique: critique2 ?? critique1, attempts: 2 };
}

export interface FigureClass {
  isChart: boolean;
  reason: string;
  model: string;
  cached?: boolean;
}

/**
 * Classify a figure without drawing it — the cheap re-check for redraws made before the classify
 * gate. isChart:false means the existing redraw is a fabrication (a chart invented for an
 * apparatus/photo/text) and the caller should drop it and keep the scan.
 */
export async function classifyFigure(image: string, context: string): Promise<FigureClass> {
  const res = await fetch('/api/figure/classify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image, context }),
  });
  const data = await res.json().catch(() => ({ error: `Server returned ${res.status}.` }));
  if (!res.ok) throw new Error(data.error ?? `Server returned ${res.status}.`);
  return data as FigureClass;
}
