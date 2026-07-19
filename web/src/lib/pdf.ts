import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { DocFile } from './types';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const cache = new Map<string, Promise<PDFDocumentProxy>>();

export function loadPdf(docId: string, dataUri: string): Promise<PDFDocumentProxy> {
  let existing = cache.get(docId);
  if (!existing) {
    const bytes = Uint8Array.from(atob(dataUri.split(',')[1]), (c) => c.charCodeAt(0));
    existing = pdfjs.getDocument({ data: bytes }).promise;
    cache.set(docId, existing);
  }
  return existing;
}

export function forgetPdf(docId: string) {
  cache.delete(docId);
}

/**
 * Render one page to a JPEG data URL, for the vision "second opinion" — which needs the page as
 * an image, not a canvas on screen. Reuses the cached document; capped in width so the upload to
 * the vision model stays small.
 */
export async function renderPageToImage(
  docId: string,
  dataUri: string,
  index: number,
  maxWidth = 1400,
  quality = 0.85,
): Promise<string> {
  const pdf = await loadPdf(docId, dataUri);
  const page = await pdf.getPage(index + 1);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(2, maxWidth / base.width);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get a 2D canvas context to render the page.');
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas.toDataURL('image/jpeg', quality);
}

/**
 * A small first-page preview for the library cards, stored alongside the metadata so listing the
 * library never has to open a PDF. 320px at q0.75 is 10–25KB — cheap enough that 24 of them cost
 * less than one page render. Never worth failing a save over, so any error resolves to undefined.
 */
export async function makeThumbnail(
  doc: Pick<DocFile, 'id' | 'dataUri' | 'sourceType'>,
): Promise<string | undefined> {
  try {
    if (doc.sourceType === 'document_url') {
      return await renderPageToImage(doc.id, doc.dataUri, 0, 320, 0.75);
    }
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('image failed to decode'));
      img.src = doc.dataUri;
    });
    const scale = Math.min(1, 320 / img.naturalWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.75);
  } catch {
    return undefined;
  }
}

/**
 * Render a TIGHT, HIGH-RESOLUTION crop of one figure region straight from the source PDF, for the
 * figure redraw. A vision model can only be as precise as the pixels it reads — Mistral's own crop
 * is small and lossy, so tick numbers and curve inflections blur. Rendering the figure's own bbox
 * from the vector PDF at high scale gives the model sharp text and lines to reproduce.
 *
 * `bbox` is in the OCR coordinate space (`pageWidth`×`pageHeight`); it's converted to page
 * fractions, so it lines up regardless of the DPI the OCR ran at. A small margin is kept so axis
 * labels sitting just outside the detected box aren't clipped. PNG (lossless) is used on purpose —
 * JPEG artifacts on thin lines and small digits are exactly what hurts reading accuracy.
 */
export async function renderRegionToImage(
  docId: string,
  dataUri: string,
  index: number,
  bbox: { x: number; y: number; w: number; h: number },
  pageWidth: number,
  pageHeight: number,
  targetWidth = 1600,
): Promise<string> {
  const pdf = await loadPdf(docId, dataUri);
  const page = await pdf.getPage(index + 1);
  const base = page.getViewport({ scale: 1 });

  const fx = bbox.x / pageWidth;
  const fy = bbox.y / pageHeight;
  const fw = bbox.w / pageWidth;
  const fh = bbox.h / pageHeight;
  if (!(fw > 0.01) || !(fh > 0.01)) throw new Error('Figure region is too small to crop.');

  // Scale the whole page so the figure region lands near targetWidth px; cap to bound memory.
  const scale = Math.min(6, Math.max(1, targetWidth / (fw * base.width)));
  const viewport = page.getViewport({ scale });
  const full = document.createElement('canvas');
  full.width = Math.round(viewport.width);
  full.height = Math.round(viewport.height);
  const fctx = full.getContext('2d');
  if (!fctx) throw new Error('Could not get a 2D canvas context to render the page.');
  await page.render({ canvasContext: fctx, viewport }).promise;

  const margin = 0.04;
  const sx = Math.max(0, (fx - margin) * viewport.width);
  const sy = Math.max(0, (fy - margin) * viewport.height);
  const sw = Math.min(viewport.width - sx, (fw + margin * 2) * viewport.width);
  const sh = Math.min(viewport.height - sy, (fh + margin * 2) * viewport.height);
  const crop = document.createElement('canvas');
  crop.width = Math.round(sw);
  crop.height = Math.round(sh);
  const cctx = crop.getContext('2d');
  if (!cctx) throw new Error('Could not get a 2D canvas context to crop the figure.');
  cctx.drawImage(full, sx, sy, sw, sh, 0, 0, crop.width, crop.height);
  return crop.toDataURL('image/png');
}

export async function pdfPageCount(dataUri: string): Promise<number> {
  const bytes = Uint8Array.from(atob(dataUri.split(',')[1]), (c) => c.charCodeAt(0));
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  return doc.numPages;
}

export function readFileAsDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
