export type TableMode = 'markdown_embedded' | 'markdown_standalone' | 'html_standalone';
export type ConfidenceMode = 'none' | 'word' | 'page';

export interface OcrConfig {
  model: string;
  pages: string;
  extractImages: boolean;
  extractHeader: boolean;
  extractFooter: boolean;
  boundingBoxes: boolean;
  tableMode: TableMode;
  confidence: ConfidenceMode;
  annotateImages: boolean;
  responseFormat: boolean;
  jsonSchema: string;
  annotationPrompt: string;
}

export const DEFAULT_CONFIG: OcrConfig = {
  model: 'mistral-ocr-latest',
  pages: '',
  extractImages: true,
  extractHeader: false,
  extractFooter: false,
  boundingBoxes: true,
  tableMode: 'markdown_embedded',
  confidence: 'none',
  annotateImages: false,
  responseFormat: false,
  jsonSchema: '',
  annotationPrompt: '',
};

export const MODELS = [{ id: 'mistral-ocr-latest', label: 'Document OCR · high accuracy' }];

/** Region kinds we colour and label. Anything else falls back to "other". */
export type BlockType =
  | 'title'
  | 'text'
  | 'table'
  | 'list'
  | 'image'
  | 'equation'
  | 'header'
  | 'footer'
  | 'other';

export interface Bbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Block {
  id: string;
  type: BlockType;
  bbox: Bbox;
  text: string;
  /** Present only when the source was an extracted image. */
  imageBase64?: string;
  annotation?: unknown;
  confidence?: number;
  /**
   * AI recreation of this figure (Convert view): a sanitized SVG redrawn by a vision model from
   * the crop. GENERATED content — always rendered with a visible label, never as evidence.
   * Stored on the block so the existing IndexedDB session persistence carries it: a redraw is
   * paid, so it must survive reloads and be reused by every export without another API call.
   */
  redrawnSvg?: string;
  redrawnCaption?: string;
  redrawnModel?: string;
  /** True when the SVG came from the keyless stub, so it is never presented as a real AI redraw. */
  redrawnStub?: boolean;
  /**
   * True when the redraw model judged this figure is NOT a data chart (apparatus, reaction scheme,
   * photo, table…) and declined to draw one. The reading view then keeps the ORIGINAL SCAN rather
   * than a fabricated chart — the guard against inventing a titration curve for a photo. A figure
   * is either redrawn (`redrawnSvg`) OR kept (`redrawNotChart`), never both.
   */
  redrawNotChart?: boolean;
  /** What the figure actually is, per the redraw model — shown as the kept-scan note. */
  redrawReason?: string;
  /**
   * True when `redrawnSvg` is a human-authored EXACT reference (e.g. the periodic table) inserted in
   * place of the scan — NOT an AI redraw. Rendered with a neutral "reference" label, never the "AI
   * recreated" badge, and skipped by the redraw batch so "Recreate all" can't overwrite it.
   */
  redrawnCanonical?: boolean;
  /**
   * A figure redrawn BY HAND (authored offline, checked against a potrace of the scan's own ink)
   * rather than by a vision model at run time. Distinct from `redrawnCanonical`, which means an
   * exact external reference like the periodic table: this is a *reconstruction of this page*, and
   * it carries the reconstruction's risk — a misread label or a misplaced point would look
   * perfect. So it is badged as a reconstruction, shown beside the scan, and never called
   * evidence. Skipped by the AI redraw batch, which must not overwrite it.
   */
  redrawnAuthored?: boolean;
  /** What the author could NOT read on the scan and therefore left out. Shown with the figure. */
  authoredOmissions?: string[];
  /** Source-matched SVGs omitted by OCR from successive body rows of a table. Presentation-only. */
  authoredTableFigures?: string[];
  /**
   * Text recovered from an image region that Mistral captured only as a picture — transcribed by a
   * second reading as Markdown + LaTeX. Shown labelled beside the figure; a RECOVERY, not evidence,
   * so it never touches the immutable OCR markdown.
   */
  recoveredText?: string;
  recoveredModel?: string;
  /**
   * AI teaching note for this figure — what it shows, how to read it, the key concept, the classic
   * mistake. A STUDY AID for students, rendered clearly labelled; never an inspection verdict and
   * never merged into the OCR evidence. Persists on the block like a redraw.
   */
  explanation?: string;
  explainModel?: string;
  /**
   * Independent vision reading of this figure's labels (the investigator): the places where the
   * OCR disagrees with what the figure shows — e.g. a `10^{-3}` the OCR misread as `0^{-3}`. These
   * are FLAGS, not corrections: they mark where to look. Stored on the block so the check survives
   * reloads and is reused by every export, like a redraw.
   */
  labelNotes?: { ocr: string; image: string; kind: string }[];
  labelCheckModel?: string;
  /** True once a label check has run for this figure, even when it found nothing to flag. */
  labelChecked?: boolean;
  /**
   * The redraw model's own enumeration of what it read off the crop (ticks, sampled points,
   * parts/labels) before drawing. Shown collapsed beside the compare view — the SVG's "working",
   * so a human can see what the drawing claims to encode.
   */
  redrawReading?: string;
  /**
   * True once a critic pass has compared the rendered redraw against the original crop — even when
   * it found nothing. Absence means "never compared", not "correct".
   */
  redrawChecked?: boolean;
  /** The critic's verdict: the redraw carries the same data and labels as the crop. */
  redrawFaithful?: boolean;
  /**
   * Concrete mismatches the critic still sees after the one automatic retry. FLAGS, rendered
   * visibly under the figure — unresolved disagreement stays visible, never silently accepted.
   */
  redrawProblems?: string[];
  redrawCheckModel?: string;
}

export interface Word {
  text: string;
  confidence: number;
  bbox?: Bbox;
}

export interface OcrPage {
  /** 0-based index into the original document. */
  index: number;
  markdown: string;
  width: number;
  height: number;
  blocks: Block[];
  words: Word[];
  confidence?: number;
  /**
   * Result of the paid vision "second opinion" for this page: the places an independent reading of
   * the page IMAGE disagrees with the OCR text. Stored on the page (not in throwaway component
   * state) so it survives navigation and reloads via the session checkpoint, and so it can be
   * highlighted in place — mirroring how a figure's `labelNotes` persist on its block. An
   * inspection aid: it is never merged into `markdown` (the evidence) and certifies nothing.
   */
  visionNotes?: { ocr: string; image: string; kind: string }[];
  visionModel?: string;
  /** True once a second opinion has run for this page, even when it found nothing to disagree with. */
  visionChecked?: boolean;
  /** Auditable GPT vision replacements applied to `editedMarkdown`; immutable OCR remains intact. */
  visionCorrections?: Array<{
    start: number;
    end: number;
    ocr: string;
    replacement: string;
    kind: string;
    reason: string;
    confidence: 'high' | 'medium';
    applied: boolean;
  }>;
  visionCorrectedAt?: number;
  /**
   * The human's corrected text for this page (Edit tab). Deliberately a SEPARATE field: `markdown`
   * stays exactly what the OCR returned, because it is the claim the inspector measures — suspect
   * signals and the vision second opinion keep reading `markdown`, so the tool can never end up
   * grading the user's own edits and calling them clean. Presentation and export prefer this via
   * `effectiveMarkdown(page)` (lib/editorNodes.ts). Absent until the page is actually edited.
   */
  editedMarkdown?: string;
}

export interface OcrResult {
  pages: OcrPage[];
  pagesProcessed: number;
  /** How many requests the document was split into. 1 for an ordinary single-shot run. */
  chunks?: number;
  /** Served from the server's disk cache: no API call was made, and nothing was billed. */
  cached?: boolean;
  model: string;
  documentAnnotation?: unknown;
  /** null when the response carried no token accounting; the UI must not invent one. */
  tokens: number | null;
  warnings: string[];
  processingMs: number;
  raw: unknown;
  sentBody: Record<string, unknown>;
}

export interface DocFile {
  id: string;
  name: string;
  sizeBytes: number;
  mime: string;
  sourceType: 'document_url' | 'image_url';
  /** data: URI held in memory for the preview and for inline requests. */
  dataUri: string;
  /** Page count from pdf.js; 1 for images. */
  pageCount: number;
  /**
   * Content hash of this document, once it has been saved to the library. Its presence means
   * "this exact document is on disk with a finished result", which is what lets Reopen skip both
   * the upload and the run.
   */
  libKey?: string;
  result?: OcrResult;
  error?: string;
  running?: boolean;
  /** Chunked runs make several requests; this is how far along we are. */
  progress?: { done: number; total: number };
}
