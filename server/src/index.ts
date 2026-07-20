import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, runOcr, uploadAndSign } from './mistral.js';
import {
  recoverText,
  verifyFigure,
  visionCompare,
  visionModelName,
  type FigureCheck,
  type RecoveredText,
  type VisionResult,
} from './vision.js';
import {
  classifyFigure,
  compareFigure,
  explainFigure,
  figureCacheKey,
  figureCheckCacheKey,
  figureClassCacheKey,
  figureCompareCacheKey,
  figureExplainCacheKey,
  figureTextCacheKey,
  pageVisionCacheKey,
  readFigureCache,
  readFigureCheckCache,
  readFigureClassCache,
  readFigureCompareCache,
  readFigureExplainCache,
  readFigureTextCache,
  readPageVisionCache,
  redrawFigure,
  writeFigureCache,
  writeFigureCheckCache,
  writeFigureClassCache,
  writeFigureCompareCache,
  writeFigureExplainCache,
  writeFigureTextCache,
  writePageVisionCache,
  type FigureClass,
  type FigureCompare,
  type FigureExplain,
} from './figure.js';
import {
  mockFigure,
  mockFigureCheck,
  mockFigureClass,
  mockFigureCompare,
  mockFigureExplain,
  mockFigureText,
  mockRun,
  mockVision,
} from './mock.js';
import * as cache from './cache.js';
import { cacheKey } from './cache.js';
import { readEdits, writeEdit, stats as editStats } from './edits.js';
import * as library from './library.js';
import type { OcrRequestPayload } from './types.js';

// npm workspaces run this with cwd = server/, so a bare dotenv/config would look for
// server/.env and miss the real one at the app root. Load both, root first.
const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../../.env') });
dotenv.config();

const MOCK = process.env.MOCK_OCR === '1';

const app = express();
app.use(cors());
// Inline base64 documents are large; the cap is well above Mistral's own 50MB file limit.
app.use(express.json({ limit: '80mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    keyConfigured: MOCK || Boolean(process.env.MISTRAL_API_KEY),
    mock: MOCK,
    // Drives OpenAI-powered visual reading, reconstruction, critique, and teaching features.
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
  });
});

app.post('/api/ocr', async (req, res) => {
  try {
    const payload = req.body as OcrRequestPayload;
    if (!payload?.source?.url) throw new HttpError(400, 'No document supplied.');

    if (MOCK) return void res.json(mockRun(payload));

    // OCR costs money and a scanned page never changes. Re-processing a document you have
    // already paid for is pure waste, so a hit is served from disk without touching the API.
    const key = cacheKey(payload.config, payload.source.url);
    if (!payload.force) {
      const hit = cache.read(key);
      if (hit) {
        console.log(`cache hit ${key.slice(0, 8)} — no API call, no cost`);
        return void res.json(hit);
      }
    }

    const result = await runOcr(payload);
    cache.write(key, result);
    res.json(result);
  } catch (err) {
    fail(res, err);
  }
});

/**
 * The "second reading": a vision model reads the page image and reports only where the OCR text
 * disagrees with what is printed. An inspection aid — it certifies nothing (see vision.ts).
 */
app.post('/api/vision', async (req, res) => {
  try {
    const { image, text } = req.body as { image?: string; text?: string };
    if (!image) throw new HttpError(400, 'A page image is required.');
    if (MOCK) return void res.json(mockVision());

    // A second opinion is paid; the same page image + OCR text always reads the same. Serve a hit
    // from disk so re-opening a page never re-pays — the fix for the one vision route that had no cache.
    const key = pageVisionCacheKey(image, text ?? '', visionModelName());
    const hit = readPageVisionCache<VisionResult>(key);
    if (hit) {
      console.log(`page vision cache hit ${key.slice(0, 8)} — no API call, no cost`);
      return void res.json(hit);
    }
    const result = await visionCompare(image, text ?? '');
    // Never cache a soft failure (unparseable model reply): a bad parse must stay retryable.
    if (!result.raw) writePageVisionCache(key, result);
    res.json(result);
  } catch (err) {
    fail(res, err);
  }
});

/**
 * "Redraw this figure" with OpenAI vision: a faithful, clean SVG recreation cropped from
 * the scan (see figure.ts). GENERATED content, rendered as a labelled AI recreation — never a
 * substitute for the original. Stubs automatically until OPENAI_API_KEY is set, so the Convert view
 * is fully usable with no key and no spend; adding the key flips it live with no code change.
 * Live results are disk-cached by image content (a redraw is paid; the same crop never changes).
 * Stub results are deliberately NOT cached, so they can't shadow real ones once the key exists.
 */
app.post('/api/figure', async (req, res) => {
  try {
    const { image, context, force, feedback } = req.body as {
      image?: string;
      context?: string;
      force?: boolean;
      feedback?: string;
    };
    if (!image) throw new HttpError(400, 'A figure image is required.');
    if (MOCK || !process.env.OPENAI_API_KEY) return void res.json(mockFigure());

    // `force` (mirroring /api/ocr) bypasses only the READ — the write below still lands on the
    // same key, so the newest (possibly feedback-corrected) redraw becomes THE cached entry for
    // this crop. `feedback` deliberately never enters the key: the cache stores the latest/best
    // redraw of a crop, not one entry per prompt variant. A force request is always deliberate,
    // so nothing is ever re-billed silently.
    const key = figureCacheKey(image);
    if (!force) {
      const hit = readFigureCache(key);
      if (hit) {
        console.log(`figure cache hit ${key.slice(0, 8)} — no API call, no cost`);
        return void res.json(hit);
      }
    }
    const result = await redrawFigure(image, context ?? '', feedback);
    // Cache a real SVG OR a definitive "not a chart" verdict — both are stable answers for this
    // crop and must not be re-paid. Only a soft failure (no verdict, `raw` set) stays retryable.
    if (result.svg || result.isChart === false) writeFigureCache(key, result);
    res.json(result);
  } catch (err) {
    fail(res, err);
  }
});

/**
 * The critic: compare an AI recreation (rendered to a PNG by the client) against the original scan
 * crop and report concrete data/label mismatches. This is the closed loop the redraw alone lacks —
 * its verdict feeds one automatic retry, and whatever mismatches remain are rendered visibly under
 * the figure. It flags where to look; it never edits anything. Disk-cached on both images.
 */
app.post('/api/figure/compare', async (req, res) => {
  try {
    const { original, redraw, context } = req.body as { original?: string; redraw?: string; context?: string };
    if (!original || !redraw) throw new HttpError(400, 'Both the original crop and the redraw render are required.');
    if (MOCK || !process.env.OPENAI_API_KEY) return void res.json(mockFigureCompare(redraw));

    const key = figureCompareCacheKey(original, redraw);
    const hit = readFigureCompareCache<FigureCompare>(key);
    if (hit) {
      console.log(`figure compare cache hit ${key.slice(0, 8)} — no API call, no cost`);
      return void res.json(hit);
    }
    const result = await compareFigure(original, redraw, context ?? '');
    if (!result.raw) writeFigureCompareCache(key, result);
    res.json(result);
  } catch (err) {
    fail(res, err);
  }
});

/**
 * Classify a figure without drawing it — the cheap re-check for redraws made before the classify
 * gate. Lets the client sweep existing redraws and drop fabricated charts (isChart:false) without
 * paying to re-draw the ones that are genuine charts. Disk-cached like the redraw.
 */
app.post('/api/figure/classify', async (req, res) => {
  try {
    const { image, context } = req.body as { image?: string; context?: string };
    if (!image) throw new HttpError(400, 'A figure image is required.');
    if (MOCK || !process.env.OPENAI_API_KEY) return void res.json(mockFigureClass());

    const key = figureClassCacheKey(image);
    const hit = readFigureClassCache<FigureClass>(key);
    if (hit) {
      console.log(`figure classify cache hit ${key.slice(0, 8)} — no API call, no cost`);
      return void res.json(hit);
    }
    const result = await classifyFigure(image, context ?? '');
    if (!result.raw) writeFigureClassCache(key, result);
    res.json(result);
  } catch (err) {
    fail(res, err);
  }
});

/**
 * The per-figure label investigator: a vision model reads a figure crop and reports where its
 * reading of the labels/exponents disagrees with the OCR text near it (see vision.ts). An
 * inspection aid — it flags where to look, never rewrites the figure. Stubs under MOCK_OCR.
 */
app.post('/api/figure/verify', async (req, res) => {
  try {
    const { image, context } = req.body as { image?: string; context?: string };
    if (!image) throw new HttpError(400, 'A figure image is required.');
    if (MOCK) return void res.json(mockFigureCheck());

    // A label check is paid; the same crop + OCR context always reads the same. Serve a hit from
    // disk without touching the API, so a check is never paid for twice — across sessions or machines.
    const key = figureCheckCacheKey(image, context ?? '', visionModelName());
    const hit = readFigureCheckCache<FigureCheck>(key);
    if (hit) {
      console.log(`figure check cache hit ${key.slice(0, 8)} — no API call, no cost`);
      return void res.json(hit);
    }
    const result = await verifyFigure(image, context ?? '');
    // Never cache a soft failure (the model returned unparseable JSON): a bad parse must be
    // retryable, not frozen on disk. A clean result — flags or none — is what gets stored.
    if (!result.raw) writeFigureCheckCache(key, result);
    res.json(result);
  } catch (err) {
    fail(res, err);
  }
});

/**
 * Recover text trapped in an image region. Mistral sometimes bundles a text-heavy region (equations,
 * a reaction block) into a single image, so its text is never transcribed. A vision model reads that
 * crop and returns the text as Markdown + LaTeX — a labelled recovery the client shows beside the
 * figure, never merged into the OCR evidence. Disk-cached like the redraw and the label check.
 */
app.post('/api/figure/text', async (req, res) => {
  try {
    const { image, context } = req.body as { image?: string; context?: string };
    if (!image) throw new HttpError(400, 'A figure image is required.');
    if (MOCK) return void res.json(mockFigureText());

    const key = figureTextCacheKey(image, context ?? '', visionModelName());
    const hit = readFigureTextCache<RecoveredText>(key);
    if (hit) {
      console.log(`figure text cache hit ${key.slice(0, 8)} — no API call, no cost`);
      return void res.json(hit);
    }
    const result = await recoverText(image, context ?? '');
    if (!result.raw) writeFigureTextCache(key, result);
    res.json(result);
  } catch (err) {
    fail(res, err);
  }
});

/**
 * Explain a figure to a student — a STUDY AID, deliberately separate from every inspection route.
 * The model teaches (what the figure shows, how to read it, the key concept, the classic mistake);
 * it never grades the OCR and the client renders it clearly labelled as AI teaching material.
 * `facts` carries exact computed geometry when the client has it (the épure reconstruction), so
 * the explanation leans on arithmetic instead of the model's own reading where possible.
 */
app.post('/api/figure/explain', async (req, res) => {
  try {
    const { image, context, facts } = req.body as { image?: string; context?: string; facts?: string };
    if (!image) throw new HttpError(400, 'A figure image is required.');
    if (MOCK) return void res.json(mockFigureExplain());

    const key = figureExplainCacheKey(image, context ?? '', facts ?? '');
    const hit = readFigureExplainCache<FigureExplain>(key);
    if (hit) {
      console.log(`figure explain cache hit ${key.slice(0, 8)} — no API call, no cost`);
      return void res.json(hit);
    }
    const result = await explainFigure(image, context ?? '', facts);
    if (!result.raw) writeFigureExplainCache(key, result);
    res.json(result);
  } catch (err) {
    fail(res, err);
  }
});

/** What's already been paid for. */
app.get('/api/cache', (_req, res) => res.json(cache.stats()));

/**
 * Human corrections, keyed by document content hash (see edits.ts). This is what makes an edit outlive
 * the browser it was typed in — clear IndexedDB, switch machine, re-drop the same scan, and the
 * corrections are still attached to it. It stores text a person typed; it asserts nothing about
 * whether the page is correct. There is no `verified` here and there must not be.
 */
app.get('/api/edits/:key', (req, res) => {
  try {
    res.json({ pages: readEdits(req.params.key) });
  } catch (err) {
    fail(res, err);
  }
});

app.put('/api/edits/:key', (req, res) => {
  try {
    const { pageIndex, markdown } = req.body as { pageIndex?: number; markdown?: string | null };
    if (typeof pageIndex !== 'number') throw new HttpError(400, 'pageIndex is required.');
    res.json({ pages: writeEdit(req.params.key, pageIndex, markdown ?? null) });
  } catch (err) {
    fail(res, err);
  }
});

/** What's been corrected on this machine. */
app.get('/api/edits', (_req, res) => res.json(editStats()));

/* ---------------------------------------------------------------- library */

/**
 * The library: every document processed on this machine, filed under its content hash so it can be
 * reopened with no upload and no second API call.
 *
 * It lives here rather than in the browser because IndexedDB is scoped to an origin, and this UI is
 * served from more than one (:5174 standalone, :5173 inside Relire, :8787 built) — so the library
 * read empty depending on where you opened it, while the paid work sat on disk the whole time.
 *
 * Metadata and bytes are separate routes on purpose: listing the library must never read a PDF, and
 * the bytes are immutable, so they are uploaded once per document rather than on every save.
 */
app.get('/api/library', (_req, res) => {
  try {
    res.json({ entries: library.listMeta() });
  } catch (err) {
    fail(res, err);
  }
});

app.get('/api/library/:key', (req, res) => {
  try {
    const entry = library.readEntry(req.params.key);
    if (!entry) throw new HttpError(404, 'Not in the library.');
    res.json(entry);
  } catch (err) {
    fail(res, err);
  }
});

/** File (or refile) an entry. `needsBytes` in the reply asks the client to PUT the bytes once. */
app.put('/api/library/:key', (req, res) => {
  try {
    const { doc, config, savedAt, thumb } = req.body as {
      doc?: library.StoredDoc;
      config?: OcrRequestPayload['config'];
      savedAt?: number;
      thumb?: string;
    };
    if (!doc || !config) throw new HttpError(400, 'doc and config are both required.');
    if (!doc.result) throw new HttpError(400, 'Refusing to file a document with no result.');
    res.json(library.writeEntry(req.params.key, { doc, config, savedAt: savedAt ?? Date.now(), thumb }));
  } catch (err) {
    fail(res, err);
  }
});

app.put('/api/library/:key/blob', (req, res) => {
  try {
    const { dataUri } = req.body as { dataUri?: string };
    if (!dataUri) throw new HttpError(400, 'dataUri is required.');
    library.writeBlob(req.params.key, dataUri);
    res.json({ ok: true });
  } catch (err) {
    fail(res, err);
  }
});

app.put('/api/library/:key/thumb', (req, res) => {
  try {
    const { thumb } = req.body as { thumb?: string };
    if (!thumb) throw new HttpError(400, 'thumb is required.');
    library.updateThumb(req.params.key, thumb);
    res.json({ ok: true });
  } catch (err) {
    fail(res, err);
  }
});

app.delete('/api/library/:key', (req, res) => {
  try {
    library.remove(req.params.key);
    res.json({ ok: true });
  } catch (err) {
    fail(res, err);
  }
});

/** Large-file path: hand the bytes to Mistral's Files API and return a signed URL. */
app.post('/api/files', async (req, res) => {
  try {
    const { fileName, base64 } = req.body as { fileName?: string; base64?: string };
    if (!fileName || !base64) throw new HttpError(400, 'fileName and base64 are both required.');
    const url = await uploadAndSign(fileName, Buffer.from(base64, 'base64'));
    res.json({ url });
  } catch (err) {
    fail(res, err);
  }
});

function fail(res: express.Response, err: unknown) {
  const status = err instanceof HttpError ? err.status : 500;
  let message = err instanceof Error ? err.message : 'Unknown server error.';

  // Node's fetch reports every network failure as the bare string "fetch failed", which
  // tells the user nothing. Dig the real cause out and say it.
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  if (message === 'fetch failed' && cause) {
    // This helper serves more than one upstream API, so keep the network error provider-neutral.
    message = `Could not reach the upstream API: ${cause.code ?? cause.message ?? 'network error'}.`;
  }

  if (status >= 500) console.error(err);
  res.status(status).json({ error: message });
}

// Serve the built SPA in production; in dev, Vite proxies /api here instead.
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
app.use(express.static(dist));
app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));

const port = Number(process.env.PORT) || 8787;
app.listen(port, () => {
  const keyed = process.env.MISTRAL_API_KEY ? 'key loaded' : 'NO MISTRAL_API_KEY — set it in document-ai/.env';
  console.log(`Document AI server on http://localhost:${port} (${keyed})`);
});
