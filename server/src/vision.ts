import { HttpError, withRetry } from './mistral.js';

const API = 'https://api.mistral.ai/v1';

/**
 * The "second reading". Mistral's OCR silently edits the page — it invents accents that are not
 * printed and reports nothing (the exact failure this repo exists to catch). Text alone cannot
 * expose that: there is only one reading to trust or doubt.
 *
 * So a VISION model reads the page IMAGE independently and is asked for one thing only — the
 * places where the OCR text disagrees with what is actually printed. That turns an invisible,
 * unfalsifiable edit into a visible disagreement between two independent readings.
 *
 * This stays an INSPECTION aid on purpose, in keeping with what this tab is: it never rewrites
 * the page, it produces no flags, no queue, and no `verified` state. It shows you where to look.
 */
// Read lazily, not at module load: index.ts imports this file before it calls dotenv.config(), so
// a module-level const would capture the default and never see VISION_MODEL from .env (the same
// import-order trap that stuck the figure redraw on a retired model). A getter reads it at call time.
export const visionModelName = () => process.env.VISION_MODEL || 'pixtral-12b-2409';

const PROMPT = `You are shown a scanned page image and the text an OCR system produced from it.
Read the page yourself, from the image only. Report ONLY the places where the OCR text differs
from what is actually printed: accents added or removed, changed letters, wrong digits, dropped
or invented words, misread symbols. Pay special attention to accents the OCR added that are NOT
on the printed page, and accents on the page the OCR dropped.

Do NOT rewrite or "improve" the page. If the OCR text faithfully matches the image, say so.

Return STRICT JSON and nothing else:
{"matches": boolean, "notes": [{"ocr": "<what the OCR text says>", "image": "<what the page actually shows>", "kind": "accent|letter|digit|word|symbol|other"}]}`;

const FIGURE_PROMPT = `You are shown a CROPPED FIGURE from a scanned French chemistry textbook, plus the OCR text near it.
Read every piece of text INSIDE the figure from the image only: axis titles, axis tick values,
numbers, exponents (e.g. 10^{-3}), curve labels, legends, units, and annotations.

Then compare what you read against the OCR text and report ONLY genuine disagreements — a label
the OCR got wrong, a digit or exponent misread (for example the image shows 10^{-3} but the OCR
says 0^{-3}), a dropped or invented character. Pay special attention to powers of ten and to
sub/superscripts, where a single dropped digit changes the meaning.

Do NOT rewrite the figure or invent labels that are not clearly legible. If the OCR faithfully
matches the figure, return ok=true with an empty notes list.

Return STRICT JSON and nothing else:
{"ok": boolean, "labels": ["<each text or number you read in the figure, verbatim>"], "notes": [{"ocr": "<what the OCR says>", "image": "<what the figure shows>", "kind": "digit|exponent|label|symbol|unit|other"}]}`;

export interface VisionNote {
  ocr: string;
  image: string;
  kind: string;
}

export interface VisionResult {
  matches: boolean;
  notes: VisionNote[];
  model: string;
  /** Present only when the model did not return clean JSON — its words, surfaced rather than thrown. */
  raw?: string;
}

/**
 * One vision call: the prompt (with the OCR context already appended) plus the image. Shared by
 * the page "second opinion" and the per-figure label investigator — both are the same move (read
 * the image independently, report where it disagrees with the OCR) at different scales. Exported
 * so the figure-explanation route can fall back to it when the Grok account is dry.
 */
export async function callVision(prompt: string, image: string): Promise<string> {
  const k = process.env.MISTRAL_API_KEY;
  if (!k) throw new HttpError(500, 'MISTRAL_API_KEY is not set on the server.');
  if (!image?.startsWith('data:image')) throw new HttpError(400, 'An image (data:image/...) is required.');

  const res = await withRetry('reading an image with the vision model', 3, () =>
    fetch(`${API}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${k}` },
      body: JSON.stringify({
        model: visionModelName(),
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: image }] }],
      }),
    }),
  );

  const data = (await res.json().catch(() => ({}))) as {
    choices?: { message?: { content?: string } }[];
    message?: string;
    error?: { message?: string };
  };
  if (!res.ok) {
    const detail = data?.message || data?.error?.message || JSON.stringify(data).slice(0, 300);
    throw new HttpError(res.status, `Vision model failed (${res.status}): ${detail}`);
  }
  return data?.choices?.[0]?.message?.content ?? '';
}

/** Normalise the model's `notes` array into VisionNote[], defensively (any shape, capped). */
function parseNotes(value: unknown): VisionNote[] {
  return Array.isArray(value)
    ? (value as VisionNote[])
        .filter((n) => n && typeof n === 'object')
        .slice(0, 50)
        .map((n) => ({ ocr: String(n.ocr ?? ''), image: String(n.image ?? ''), kind: String(n.kind ?? 'other') }))
    : [];
}

export async function visionCompare(image: string, ocrText: string): Promise<VisionResult> {
  const text = await callVision(`${PROMPT}\n\n--- OCR TEXT ---\n${ocrText.slice(0, 6000)}`, image);
  try {
    const parsed = JSON.parse(text) as { matches?: unknown; notes?: unknown };
    return { matches: Boolean(parsed.matches), notes: parseNotes(parsed.notes), model: visionModelName() };
  } catch {
    return { matches: false, notes: [], model: visionModelName(), raw: text.slice(0, 2000) };
  }
}

/**
 * The FIGURE label investigator. A chart's axis labels and exponents live inside the image as
 * pixels — the OCR text near it is a separate, unverifiable claim about them. Text alone cannot
 * tell `0^{-3}` (a dropped "1") from the `10^{-3}` actually printed. So a vision model reads the
 * figure crop and reports where its reading of the labels disagrees with the OCR — turning a
 * silent misread into a checkable disagreement. Like the page second opinion: an inspection aid
 * that flags where to look, not a correction.
 */
export interface FigureCheck {
  ok: boolean;
  /** Every text/number the model read inside the figure, verbatim — the evidence for its notes. */
  labels: string[];
  notes: VisionNote[];
  model: string;
  raw?: string;
  /** Served from the server's disk cache — no API call, no cost. */
  cached?: boolean;
}

export async function verifyFigure(image: string, context: string): Promise<FigureCheck> {
  const text = await callVision(`${FIGURE_PROMPT}\n\n--- OCR TEXT NEAR THIS FIGURE ---\n${context.slice(0, 3000)}`, image);
  try {
    const parsed = JSON.parse(text) as { ok?: unknown; labels?: unknown; notes?: unknown };
    const labels = Array.isArray(parsed.labels) ? parsed.labels.slice(0, 60).map((l) => String(l)) : [];
    return { ok: Boolean(parsed.ok), labels, notes: parseNotes(parsed.notes), model: visionModelName() };
  } catch {
    return { ok: false, labels: [], notes: [], model: visionModelName(), raw: text.slice(0, 2000) };
  }
}

const RECOVER_PROMPT = `You are shown a CROP from a scanned French chemistry textbook that an OCR system wrongly treated
as a single IMAGE — so any text and equations printed inside it were never transcribed. Read the
crop and transcribe EVERYTHING printed in it, faithfully and in reading order:
  - all text, verbatim and in French, accents included;
  - every equation, formula, and chemical reaction as LaTeX — $...$ inline, $$...$$ for display
    lines; chemical formulae with proper sub/superscripts (e.g. $CH_3COOH$, $OH^-$);
  - use Markdown for structure (line breaks, lists) as it appears.

Do NOT summarize, translate, "improve", or invent anything — copy what is printed. Where part of the
crop is a genuine non-text drawing (an apparatus, a plotted curve, a photo), do not transcribe pixels;
describe it in ONE bracketed French phrase, e.g. [schéma : montage burette + bécher]. If a character
is truly unreadable, write [[unreadable]].

Return STRICT JSON and nothing else: {"markdown": "<the faithful transcription>"}`;

export interface RecoveredText {
  /** The trapped text, transcribed as Markdown + LaTeX. Empty when the crop held no real text. */
  markdown: string;
  model: string;
  /** Present only when the model did not return clean JSON — surfaced rather than thrown. */
  raw?: string;
  /** Served from the server's disk cache — no API call, no cost. */
  cached?: boolean;
}

/**
 * Recover text trapped in an image. Mistral sometimes classifies a text-heavy region (equations,
 * a reaction block) as a single image, so its text is never transcribed — a silent hole in the
 * page. A vision model reads that crop and transcribes the text as Markdown + LaTeX. This is a
 * SECOND reading surfaced as a labelled recovery, never merged into the immutable OCR evidence.
 */
export async function recoverText(image: string, context: string): Promise<RecoveredText> {
  const text = await callVision(
    `${RECOVER_PROMPT}\n\n--- OCR TEXT NEAR THIS CROP (context, may be noisy) ---\n${context.slice(0, 2000)}`,
    image,
  );
  try {
    const parsed = JSON.parse(text) as { markdown?: unknown };
    return { markdown: String(parsed.markdown ?? '').trim(), model: visionModelName() };
  } catch {
    return { markdown: '', model: visionModelName(), raw: text.slice(0, 3000) };
  }
}
