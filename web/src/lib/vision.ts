export interface VisionNote {
  ocr: string;
  image: string;
  kind: string;
}

export interface VisionResult {
  matches: boolean;
  notes: VisionNote[];
  model: string;
  raw?: string;
}

/**
 * Ask the server for a second, independent reading of one page: a vision model reads the page
 * image and reports only where it disagrees with the OCR text. An inspection aid — no flags,
 * no verified state; it points at where to look.
 */
export async function visionCompare(image: string, text: string): Promise<VisionResult> {
  const res = await fetch('/api/vision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image, text }),
  });
  const data = await res.json().catch(() => ({ error: `Server returned ${res.status}.` }));
  if (!res.ok) throw new Error(data.error ?? `Server returned ${res.status}.`);
  return data as VisionResult;
}

export interface FigureCheck {
  ok: boolean;
  /** Every text/number the model read inside the figure, verbatim. */
  labels: string[];
  notes: VisionNote[];
  model: string;
  raw?: string;
  /** Served from the server's disk cache — no API call, no cost. */
  cached?: boolean;
}

/**
 * Ask the server for an independent vision reading of one figure's labels: it reports where the
 * OCR text disagrees with what the figure actually shows (a dropped digit in `10^{-3}`, a misread
 * exponent). An inspection aid, scoped to a figure — it flags, it does not correct.
 */
export async function verifyFigure(image: string, context: string): Promise<FigureCheck> {
  const res = await fetch('/api/figure/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image, context }),
  });
  const data = await res.json().catch(() => ({ error: `Server returned ${res.status}.` }));
  if (!res.ok) throw new Error(data.error ?? `Server returned ${res.status}.`);
  return data as FigureCheck;
}

export interface RecoveredText {
  /** Text trapped in an image region, transcribed as Markdown + LaTeX by a second reading. */
  markdown: string;
  model: string;
  raw?: string;
  /** Served from the server's disk cache — no API call, no cost. */
  cached?: boolean;
}

/**
 * Recover the text Mistral trapped inside an image region (equations/text it captured only as a
 * picture). A vision model transcribes the crop as Markdown + LaTeX. Surfaced as a labelled
 * recovery next to the figure — never merged into the OCR evidence.
 */
export async function recoverFigureText(image: string, context: string): Promise<RecoveredText> {
  const res = await fetch('/api/figure/text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image, context }),
  });
  const data = await res.json().catch(() => ({ error: `Server returned ${res.status}.` }));
  if (!res.ok) throw new Error(data.error ?? `Server returned ${res.status}.`);
  return data as RecoveredText;
}

export interface FigureExplain {
  /** Student-facing explanation, Markdown + LaTeX. */
  explanation: string;
  model: string;
  raw?: string;
  cached?: boolean;
}

/**
 * Ask the teaching agent to explain a figure to a student — a STUDY AID, clearly labelled,
 * never an inspection verdict. `facts` carries exact computed geometry when the caller has it
 * (the épure reconstruction), so the model teaches from arithmetic instead of guessing.
 */
export async function explainFigure(image: string, context: string, facts?: string): Promise<FigureExplain> {
  const res = await fetch('/api/figure/explain', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image, context, facts }),
  });
  const data = await res.json().catch(() => ({ error: `Server returned ${res.status}.` }));
  if (!res.ok) throw new Error(data.error ?? `Server returned ${res.status}.`);
  return data as FigureExplain;
}
