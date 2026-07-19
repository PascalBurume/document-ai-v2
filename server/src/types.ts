/** Shared contract between web and server. Keep in sync with web/src/lib/types.ts. */

export type TableMode = 'markdown_embedded' | 'markdown_standalone' | 'html_standalone';
export type ConfidenceMode = 'none' | 'word' | 'page';

export interface OcrConfig {
  model: string;
  /** 1-based page range syntax, e.g. "1-4,8". Empty = all pages. */
  pages: string;
  extractImages: boolean;
  extractHeader: boolean;
  extractFooter: boolean;
  /** maps to include_blocks */
  boundingBoxes: boolean;
  tableMode: TableMode;
  confidence: ConfidenceMode;
  annotateImages: boolean;
  /** Structured-output add-on. */
  responseFormat: boolean;
  jsonSchema: string;
  annotationPrompt: string;
}

export interface OcrSource {
  /** 'document_url' for PDFs, 'image_url' for images. */
  type: 'document_url' | 'image_url';
  /** data: URI, or an https URL from the Files API path. */
  url: string;
  fileName: string;
  /** Page count known to the client. Only MOCK_OCR uses it, to stay honest about page counts. */
  pageCount?: number;
}

export interface OcrRequestPayload {
  config: OcrConfig;
  source: OcrSource;
  /** Bypass the cache and pay for a fresh run. Off by default: OCR costs money. */
  force?: boolean;
}

export interface OcrRunResult {
  /** True when this came from the on-disk cache: no API call, no cost. */
  cached?: boolean;
  raw: unknown;
  /** Fields the API rejected and we retried without, plus any other soft failures. */
  warnings: string[];
  /** Server-measured round trip, ms. */
  processingMs: number;
  /** Exactly what we sent, minus the (huge) document payload. Powers the Code export. */
  sentBody: Record<string, unknown>;
}
