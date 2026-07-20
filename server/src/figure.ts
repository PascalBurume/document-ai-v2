import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callOpenAIVision, openaiVisionModelName } from './openai.js';

/**
 * "Recreate this figure." OpenAI vision looks at ONE figure cropped from the scan and
 * redraws it as a clean, faithful SVG chart — axes, ticks, curves, reference lines and French
 * labels reproduced from the image, in the style of a modern vector plot.
 *
 * This is GENERATED content, not transcription — the caller renders it as a clearly-labelled AI
 * recreation next to (never instead of) the original crop. It stays an inspection/reading aid,
 * in keeping with what this tab is: an inspector, not an automatic verifier.
 */
const modelName = openaiVisionModelName;

/** Bump when the prompt changes materially — it is part of the cache key. */
const PROMPT_VERSION = 5;

// The Book/Convert view redraws EVERY figure in the book — that is its purpose. So the prompt
// recreates whatever kind of figure the crop holds, FAITHFULLY. Faithfulness is the guard the
// earlier chart-only gate was reaching for: reproduce what is actually drawn (an apparatus as an
// apparatus, a curve through its real points) and invent no data — that alone prevents the old
// failure of inventing a titration curve for a photo of a burette, WITHOUT refusing to draw.
//
// v5: the reading became a real data-collection step. The model must enumerate every tick value and
// sample each curve in DATA coordinates, then state the data→viewBox mapping and draw from it — a
// curve that "looks right" but plots wrong values was the dominant failure of v4. The reading is
// also STORED now (block.redrawReading), so a human can see what the SVG claims to encode.
const SYSTEM = `You recreate ONE figure cropped from a scanned French chemistry textbook as a clean, faithful SVG.
Work in TWO steps, and return both.

STEP 1 — READ. In the "reading" field, enumerate precisely what is printed in THIS crop:
  - for a data chart: each axis title WITH its unit; EVERY tick value on each axis, listed;
    each curve/series (by label or appearance) with 5-10 sampled points in DATA coordinates
    ("V=10 ml -> pH=8.2"), and every notable feature — intersections, plateaus, asymptotes,
    peaks, equivalence points — with their data coordinates;
  - for a schematic or apparatus (burette, flask, montage, tubing): every part with its label,
    and every dimension letter or value (d, l, r…);
  - for a molecule / reaction scheme / labelled drawing: each structure, arrow, and label.
Read only what is visible. Write "illisible" for anything you cannot read — never guess.

STEP 2 — DRAW. For charts, first state ONE linear mapping per axis from data coordinates to
viewBox coordinates at the end of the reading (e.g. "mapping: x 0-20 ml -> 70-690 px; y pH 0-14 ->
420-20 px"), then draw the SVG so that EVERY point and feature enumerated in STEP 1 lands exactly
where that mapping puts it. For schematics, keep the same parts, shapes, and proportions as the
crop. Reproduce ALL text and labels verbatim in French, accents included.

Do NOT invent data, numeric values, curves, parts, or labels that are not visible in the crop, and do
NOT be swayed by nearby text (e.g. a section titled "courbes") into drawing something the crop does not
show — a faithful vector recreation of what is on THIS page, nothing added or "improved". If a part is
genuinely unreadable, omit it rather than guessing.

Style: clean modern vector drawing. viewBox="0 0 720 480". White background; thin dark strokes; small
sans-serif labels; for charts, numbered axis ticks and dashed reference lines; for diagrams, dashed
dimension lines carrying the letters/values shown. No <script>, <foreignObject>, external references,
or event handlers; all text as plain <text> elements.

Return STRICT JSON and nothing else:
{"reading": "<the STEP 1 enumeration, ending with the axis mapping for charts>", "svg": "<svg ...>...</svg>", "caption": "<one French sentence>"}
Only if the crop is blank or pure noise with nothing to draw, return {"isChart": false, "reason": "<why>"}.`;

export interface FigureRedraw {
  svg: string;
  caption: string;
  model: string;
  /**
   * The model's own enumeration of what it read off the crop (axes/ticks/sampled points, or
   * parts/labels) BEFORE drawing — stored so a human (and the critic pass) can see what the SVG
   * claims to encode instead of taking the drawing on faith.
   */
  reading?: string;
  /**
   * False when the model judged the crop is NOT a data chart (apparatus, scheme, photo, table…),
   * so no SVG was drawn and `svg` is empty. The caller keeps the original scan rather than showing
   * a fabricated chart. Undefined for a normal chart redraw (and for the stub).
   */
  isChart?: boolean;
  /** Why the crop was not redrawn — what it actually is. Present only when `isChart` is false. */
  reason?: string;
  /** Present only when the model did not return clean JSON — surfaced rather than thrown. */
  raw?: string;
  /** Served from the disk cache — no API call, no cost. */
  cached?: boolean;
}

/** Pull the JSON object out of a model reply, tolerating code fences or stray prose around it. */
function extractJson(
  text: string,
): { isChart?: unknown; reason?: unknown; svg?: unknown; caption?: unknown; reading?: unknown } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Model-authored SVG is injected into the page and into exported HTML, so strip anything that
 * could execute or phone home: scripts, inline event handlers, foreignObject, and any external
 * or javascript: reference. In-document `#id` references are kept.
 */
export function sanitizeSvg(svg: string): string {
  if (!svg) return '';
  const i = svg.indexOf('<svg');
  const j = svg.lastIndexOf('</svg>');
  if (i === -1 || j === -1) return '';
  return svg
    .slice(i, j + 6)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*')/gi, '')
    .replace(/(href|xlink:href)\s*=\s*("(?!#)[^"]*"|'(?!#)[^']*')/gi, '');
}

// A figure redraw costs money and the same crop never changes, so results are cached on disk
// next to the OCR cache. Keyed by image content + model + prompt version — never by filename.
const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.cache');

export function figureCacheKey(image: string): string {
  const payload = image.startsWith('data:') ? image.slice(image.indexOf(',') + 1) : image;
  const bytes = createHash('sha256').update(payload).digest('hex');
  return createHash('sha256').update(JSON.stringify({ bytes, model: modelName(), v: PROMPT_VERSION })).digest('hex');
}

export function readFigureCache(key: string): FigureRedraw | null {
  try {
    const hit = JSON.parse(readFileSync(path.join(DIR, `fig-${key}.json`), 'utf8')) as FigureRedraw;
    return { ...hit, cached: true };
  } catch {
    return null;
  }
}

export function writeFigureCache(key: string, result: FigureRedraw): void {
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(path.join(DIR, `fig-${key}.json`), JSON.stringify(result));
  } catch (err) {
    console.warn('figure cache write failed:', (err as Error).message);
  }
}

// The figure LABEL CHECK (vision investigator) is paid too, and the same crop + OCR context always
// reads the same — so cache it on disk beside the redraws (`vfy-<sha>.json`). Keyed by image content
// + context + vision model + a version, so a re-OCR that changes the text, or a prompt bump, re-checks
// rather than serving a stale flag. Content-addressed → the cache survives session/machine changes,
// which is the whole point: a check, once paid for, is never paid for again.
const CHECK_VERSION = 1;

export function figureCheckCacheKey(image: string, context: string, model: string): string {
  const payload = image.startsWith('data:') ? image.slice(image.indexOf(',') + 1) : image;
  const bytes = createHash('sha256').update(payload).digest('hex');
  const ctx = createHash('sha256').update(context).digest('hex');
  return createHash('sha256').update(JSON.stringify({ bytes, ctx, model, v: CHECK_VERSION })).digest('hex');
}

export function readFigureCheckCache<T extends object>(key: string): T | null {
  try {
    const hit = JSON.parse(readFileSync(path.join(DIR, `vfy-${key}.json`), 'utf8')) as T;
    return { ...hit, cached: true };
  } catch {
    return null;
  }
}

export function writeFigureCheckCache(key: string, result: unknown): void {
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(path.join(DIR, `vfy-${key}.json`), JSON.stringify(result));
  } catch (err) {
    console.warn('figure check cache write failed:', (err as Error).message);
  }
}

// The PAGE second-opinion (whole-page vision re-read, /api/vision) is paid too, and the same page
// image + OCR text always reads the same — so cache it beside the figure checks (`vis-<sha>.json`).
// Keyed by image content + text + vision model + a version, so a re-OCR that changes the page text,
// or a prompt/model bump, re-reads rather than serving a stale disagreement. This is the fix for the
// one vision route that used to re-pay on every navigation.
const PAGE_VISION_VERSION = 1;

export function pageVisionCacheKey(image: string, text: string, model: string): string {
  const payload = image.startsWith('data:') ? image.slice(image.indexOf(',') + 1) : image;
  const bytes = createHash('sha256').update(payload).digest('hex');
  const ctx = createHash('sha256').update(text).digest('hex');
  return createHash('sha256').update(JSON.stringify({ bytes, ctx, model, v: PAGE_VISION_VERSION })).digest('hex');
}

export function readPageVisionCache<T extends object>(key: string): T | null {
  try {
    const hit = JSON.parse(readFileSync(path.join(DIR, `vis-${key}.json`), 'utf8')) as T;
    return { ...hit, cached: true };
  } catch {
    return null;
  }
}

export function writePageVisionCache(key: string, result: unknown): void {
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(path.join(DIR, `vis-${key}.json`), JSON.stringify(result));
  } catch (err) {
    console.warn('page vision cache write failed:', (err as Error).message);
  }
}

// Recovered text (text trapped in a mis-classified image region) is paid too and stable per crop —
// cache it beside the rest (`txt-<sha>.json`), same content-addressed scheme as the check cache.
const TEXT_VERSION = 1;

export function figureTextCacheKey(image: string, context: string, model: string): string {
  const payload = image.startsWith('data:') ? image.slice(image.indexOf(',') + 1) : image;
  const bytes = createHash('sha256').update(payload).digest('hex');
  const ctx = createHash('sha256').update(context).digest('hex');
  return createHash('sha256').update(JSON.stringify({ bytes, ctx, model, v: TEXT_VERSION })).digest('hex');
}

export function readFigureTextCache<T extends object>(key: string): T | null {
  try {
    const hit = JSON.parse(readFileSync(path.join(DIR, `txt-${key}.json`), 'utf8')) as T;
    return { ...hit, cached: true };
  } catch {
    return null;
  }
}

export function writeFigureTextCache(key: string, result: unknown): void {
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(path.join(DIR, `txt-${key}.json`), JSON.stringify(result));
  } catch (err) {
    console.warn('figure text cache write failed:', (err as Error).message);
  }
}

export async function redrawFigure(image: string, context: string, feedback?: string): Promise<FigureRedraw> {
  let userText =
    'Read, then recreate this figure faithfully. The OCR text near it (may be noisy) can help you ' +
    `read axis titles, values, and dimension labels:\n${context.slice(0, 2500)}`;
  // The critic's mismatches from a previous attempt, fed back for the one automatic retry.
  if (feedback) {
    userText +=
      '\n\nA previous recreation of this exact crop was compared against the original and these ' +
      'mismatches were found. Fix exactly these; keep everything that was already correct:\n- ' +
      feedback.slice(0, 1500);
  }
  const text = await callOpenAIVision(
    SYSTEM,
    userText,
    image,
    // Room for the reading + a detailed SVG; a truncated SVG is worse than a small one.
    8000,
  );
  const parsed = extractJson(text);
  if (!parsed) return { svg: '', caption: '', model: modelName(), raw: text.slice(0, 2000) };

  // The crop is not a data chart — the model refused to draw one rather than fabricate. Return the
  // verdict with no SVG; the caller keeps the original scan. This is the guard against inventing a
  // titration curve for a photo of the apparatus.
  if (parsed.isChart === false) {
    return { svg: '', caption: '', model: modelName(), isChart: false, reason: String(parsed.reason ?? '') };
  }

  return {
    svg: sanitizeSvg(String(parsed.svg ?? '')),
    caption: String(parsed.caption ?? ''),
    reading: String(parsed.reading ?? ''),
    model: modelName(),
    isChart: true,
  };
}

const CLASSIFY_SYSTEM = `You are shown ONE figure cropped from a scanned French chemistry textbook.
Decide only ONE thing: is it a DATA CHART — a plotted graph whose axes and curves/points/bars encode
numeric values you can read off (e.g. a titration curve pH = f(V), a concentration plot)? These are
NOT charts: laboratory apparatus / setups, reaction schemes, molecular structures, photos, tables,
and crops that are only text or equations. When unsure, answer false.
Return STRICT JSON and nothing else: {"isChart": boolean, "reason": "<what it is, a few French words, when not a chart>"}`;

export interface FigureClass {
  isChart: boolean;
  reason: string;
  model: string;
  /** Present only when the model did not return clean JSON. */
  raw?: string;
  cached?: boolean;
}

/**
 * Classify a figure WITHOUT drawing it — a cheap check (no SVG, tiny reply) used to re-assess
 * redraws made before the classify gate existed. Fabricated charts (a curve invented for an
 * apparatus/photo) come back isChart:false so the caller can drop the fabrication and keep the scan,
 * without paying to re-draw the figures that are genuinely charts.
 */
export async function classifyFigure(image: string, context: string): Promise<FigureClass> {
  const text = await callOpenAIVision(
    CLASSIFY_SYSTEM,
    `Classify this crop. Nearby OCR text (may be noisy):\n${context.slice(0, 1200)}`,
    image,
    200,
  );
  const parsed = extractJson(text);
  if (!parsed || typeof parsed.isChart !== 'boolean') {
    return { isChart: true, reason: '', model: modelName(), raw: text.slice(0, 1000) };
  }
  return { isChart: parsed.isChart, reason: String(parsed.reason ?? ''), model: modelName() };
}

// The classify verdict is cheap but still a paid call and stable per crop — cache it (`cls-<sha>`).
const CLASSIFY_VERSION = 1;

export function figureClassCacheKey(image: string): string {
  const payload = image.startsWith('data:') ? image.slice(image.indexOf(',') + 1) : image;
  const bytes = createHash('sha256').update(payload).digest('hex');
  return createHash('sha256').update(JSON.stringify({ bytes, model: modelName(), v: CLASSIFY_VERSION })).digest('hex');
}

export function readFigureClassCache<T extends object>(key: string): T | null {
  try {
    const hit = JSON.parse(readFileSync(path.join(DIR, `cls-${key}.json`), 'utf8')) as T;
    return { ...hit, cached: true };
  } catch {
    return null;
  }
}

export function writeFigureClassCache(key: string, result: unknown): void {
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(path.join(DIR, `cls-${key}.json`), JSON.stringify(result));
  } catch (err) {
    console.warn('figure class cache write failed:', (err as Error).message);
  }
}

// ---------------------------------------------------------------------- critic (redraw vs scan)

/** Bump when the critic prompt changes materially — it is part of the compare cache key. */
const CRITIC_VERSION = 1;

// The closed loop the redraw never had: nothing else ever looks at the drawn SVG again, so a
// recreation that misplots the data sails through looking clean. The critic reads BOTH images and
// reports concrete content mismatches; the caller retries once with them, and whatever remains is
// rendered under the figure as visible notes — a disagreement to inspect, never a silent pass.
const CRITIC_SYSTEM = `You are shown TWO images. Image 1 is a figure cropped from a scanned French
chemistry textbook — the ORIGINAL. Image 2 is an AI vector recreation of that same figure — the COPY.
Compare the COPY against the ORIGINAL and report only CONCRETE content mismatches:
  - axis titles/units or tick values that are wrong, missing, or added;
  - a curve whose shape, direction, position, intersections, plateaus, or asymptotes differ from the original;
  - curves, points, reference lines, parts, or labels present in one image and not the other;
  - labels or numeric values that read differently; badly wrong proportions in a schematic.
IGNORE style: colors, fonts, line weights, exact layout, and rendering quality are NOT mismatches.
The copy may be cleaner than the scan — that is expected and fine.
Return STRICT JSON and nothing else:
{"faithful": <true when the copy carries the same data and labels as the original>,
 "problems": ["<one short French sentence per concrete mismatch, most serious first>"],
 "summary": "<one French sentence>"}
When faithful, "problems" must be [].`;

export interface FigureCompare {
  /** The recreation carries the same data and labels as the original crop. */
  faithful: boolean;
  /** Concrete mismatches, most serious first — short French sentences. */
  problems: string[];
  summary: string;
  model: string;
  /** Present only when the model did not return clean JSON — surfaced, never cached. */
  raw?: string;
  /** Served from the disk cache — no API call, no cost. */
  cached?: boolean;
}

/**
 * Parse the critic's reply, exported pure so the JSON tolerance is unit-testable. A reply that
 * cannot be parsed yields faithful:false with NO problems — nothing concrete to retry on — and
 * `raw` set, which also keeps it out of the cache so the next attempt is a fresh call.
 */
export function parseCompareReply(text: string): FigureCompare {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as {
        faithful?: unknown;
        problems?: unknown;
        summary?: unknown;
      };
      if (typeof parsed.faithful === 'boolean') {
        const problems = Array.isArray(parsed.problems)
          ? parsed.problems.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
          : [];
        return { faithful: parsed.faithful, problems, summary: String(parsed.summary ?? ''), model: modelName() };
      }
    } catch {
      /* fall through to the raw shape */
    }
  }
  return { faithful: false, problems: [], summary: '', model: modelName(), raw: text.slice(0, 1000) };
}

/** Compare an AI recreation (rendered to a raster) against the original scan crop. */
export async function compareFigure(original: string, redraw: string, context: string): Promise<FigureCompare> {
  const text = await callOpenAIVision(
    CRITIC_SYSTEM,
    'Image 1 = original scan crop. Image 2 = AI recreation. Nearby OCR text (may be noisy):\n' +
      context.slice(0, 1500),
    [original, redraw],
    600,
  );
  return parseCompareReply(text);
}

// A compare verdict is paid and stable for a given (crop, rendering) pair — cache it (`cmp-<sha>`).
// The key hashes BOTH images: a retry produces a new SVG, hence a new raster, hence a new key, so
// the compare cache never needs a force flag.
export function figureCompareCacheKey(original: string, redraw: string): string {
  const strip = (img: string) => (img.startsWith('data:') ? img.slice(img.indexOf(',') + 1) : img);
  const a = createHash('sha256').update(strip(original)).digest('hex');
  const b = createHash('sha256').update(strip(redraw)).digest('hex');
  return createHash('sha256').update(JSON.stringify({ a, b, model: modelName(), v: CRITIC_VERSION })).digest('hex');
}

export function readFigureCompareCache<T extends object>(key: string): T | null {
  try {
    const hit = JSON.parse(readFileSync(path.join(DIR, `cmp-${key}.json`), 'utf8')) as T;
    return { ...hit, cached: true };
  } catch {
    return null;
  }
}

export function writeFigureCompareCache(key: string, result: unknown): void {
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(path.join(DIR, `cmp-${key}.json`), JSON.stringify(result));
  } catch (err) {
    console.warn('figure compare cache write failed:', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------------------------
// Figure EXPLANATION — a study aid for students, not an inspection tool. The model teaches from
// the figure (what it shows, how to read it, the concept it illustrates); it never judges the
// OCR and its output is never evidence. Works for any subject the books cover — a Monge épure,
// a log curve, a titration montage — and when the caller already KNOWS exact geometry (the
// épure reconstruction), those computed facts are passed in so the explanation is grounded in
// arithmetic instead of the model's guess.

const EXPLAIN_SYSTEM = `Tu es un professeur qui aide des élèves du secondaire (RDC, programme francophone) à
comprendre une figure de leur manuel — mathématiques, chimie, ou géométrie descriptive.

On te montre la figure (un scan) et le texte OCR voisin. Explique la figure À L'ÉLÈVE, en français
simple et précis :

1. **Ce que montre la figure** — une phrase.
2. **Comment la lire** — pas à pas, dans l'ordre où l'œil doit la parcourir (axes, courbes,
   projections, flèches, étiquettes…).
3. **L'idée clé** — le concept du cours que la figure illustre, relié à ce qu'on voit.
4. **Piège fréquent** — l'erreur classique qu'un élève fait ici, et comment l'éviter.

Règles strictes :
- Appuie-toi UNIQUEMENT sur ce qui est visible dans la figure et le contexte fourni. Si une
  valeur est illisible, dis-le ; n'invente jamais de nombres.
- Si des « faits calculés » sont fournis, ils sont exacts (géométrie calculée) — utilise-les.
- Écris les mathématiques en LaTeX ($...$ en ligne, $$...$$ isolé), les formules chimiques avec
  leurs indices ($H_2SO_4$).
- Markdown pour la structure (titres en gras, listes). Environ 150-300 mots.

Réponds en JSON STRICT et rien d'autre : {"explanation": "<le texte Markdown>"}`;

export interface FigureExplain {
  /** The student-facing explanation, Markdown + LaTeX. */
  explanation: string;
  model: string;
  /** Present only when the model did not return clean JSON — surfaced rather than thrown. */
  raw?: string;
  /** Served from the server's disk cache — no API call, no cost. */
  cached?: boolean;
}

export async function explainFigure(image: string, context: string, facts?: string): Promise<FigureExplain> {
  let userText = `Explique cette figure à un élève. Texte OCR voisin (peut être bruité) :\n${context.slice(0, 2500)}`;
  if (facts) {
    userText += `\n\n--- FAITS CALCULÉS (géométrie exacte, fiable) ---\n${facts.slice(0, 1500)}`;
  }

  const text = await callOpenAIVision(EXPLAIN_SYSTEM, userText, image, 2500);
  const model = modelName();

  const parsed = extractJson(text) as { explanation?: unknown } | null;
  const explanation = coerceExplanation(parsed?.explanation ?? parsed);
  if (!explanation) return { explanation: '', model, raw: text.slice(0, 2000) };
  return { explanation, model };
}

/**
 * Accept the explanation in alternate shapes a model may return. The prompt asks for
 * {"explanation": "<markdown>"}, but a response can occasionally emit
 * {"explanation": {"**1. Titre**": "texte", …}}: same content, sectioned as an object. Flattening
 * keys and values back into Markdown is mechanical reshaping of what the model wrote, not
 * invention; anything that doesn't reduce to text still fails into the `raw` path.
 */
function coerceExplanation(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(coerceExplanation).filter(Boolean).join('\n\n');
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => {
        const body = coerceExplanation(v);
        if (!body) return '';
        // A heading-ish key becomes a bold lead-in unless it already carries markup.
        const head = /[*#_`]/.test(k) ? k : `**${k}**`;
        return `${head}\n\n${body}`;
      })
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

const EXPLAIN_VERSION = 1;

export function figureExplainCacheKey(image: string, context: string, facts: string): string {
  const payload = image.startsWith('data:') ? image.slice(image.indexOf(',') + 1) : image;
  const bytes = createHash('sha256').update(payload).digest('hex');
  const ctx = createHash('sha256').update(context).digest('hex');
  const fx = createHash('sha256').update(facts).digest('hex');
  return createHash('sha256').update(JSON.stringify({ bytes, ctx, fx, model: modelName(), v: EXPLAIN_VERSION })).digest('hex');
}

export function readFigureExplainCache<T extends object>(key: string): T | null {
  try {
    const hit = JSON.parse(readFileSync(path.join(DIR, `exp-${key}.json`), 'utf8')) as T;
    return { ...hit, cached: true };
  } catch {
    return null;
  }
}

export function writeFigureExplainCache(key: string, result: unknown): void {
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(path.join(DIR, `exp-${key}.json`), JSON.stringify(result));
  } catch (err) {
    console.warn('figure explain cache write failed:', (err as Error).message);
  }
}
