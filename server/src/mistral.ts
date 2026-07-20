import type { OcrRequestPayload, OcrRunResult } from './types.js';

const API = 'https://api.mistral.ai/v1';

/**
 * Fields the published OCR schema does not document, but the playground exposes.
 * We send them; if the API rejects the body we strip these and retry once, so an
 * unsupported control degrades into a warning chip instead of a failed run.
 */
const SPECULATIVE_FIELDS = ['include_blocks', 'confidence_scores'] as const;

function key(): string {
  const k = process.env.MISTRAL_API_KEY;
  if (!k) throw new HttpError(500, 'MISTRAL_API_KEY is not set on the server. Copy .env.example to .env and add your key.');
  return k;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * Socket-level failures, not HTTP responses. Uploading a multi-MB body to Mistral drops
 * the connection often enough that a single attempt is not good enough: measured on one
 * run, a 13MB upload died with ECONNRESET while a 20MB upload went through. It is the
 * connection that is flaky, not the file — so retry rather than surface it.
 */
const TRANSIENT = new Set(['EPIPE', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'UND_ERR_SOCKET']);

export function transientCode(err: unknown): string | null {
  const code = (err as { cause?: { code?: string } })?.cause?.code;
  return code && TRANSIENT.has(code) ? code : null;
}

/**
 * Node's fetch reports every one of these as the useless message "fetch failed". Retry the
 * transient socket-level ones with exponential backoff; rethrow anything else untouched. Shared by
 * the OCR, vision and figure-redraw calls — all upload multi-MB bodies to a flaky connection.
 * Provider-neutral on purpose: OCR and OpenAI visual reasoning both upload large request bodies.
 */
export async function withRetry<T>(label: string, attempts: number, fn: () => Promise<T>): Promise<T> {
  let lastCode = '';
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const code = transientCode(err);
      if (!code) throw err;
      lastCode = code;
      console.warn(`${label}: ${code} on attempt ${i}/${attempts}`);
      if (i < attempts) await new Promise((r) => setTimeout(r, 500 * 2 ** (i - 1)));
    }
  }
  throw new HttpError(
    502,
    `The upstream API closed the connection while ${label} (${lastCode}), ${attempts} times in a row. ` +
      `This is usually a flaky upload of a large body rather than a problem with the input — try again.`,
  );
}

/**
 * "1-4,8" -> [0,3,7]. The UI is 1-based; the API is 0-based.
 * Returns undefined for an empty range, meaning "every page".
 */
export function parsePageRange(spec: string): number[] | undefined {
  const trimmed = spec.trim();
  if (!trimmed) return undefined;

  const pages = new Set<number>();
  for (const part of trimmed.split(',')) {
    const chunk = part.trim();
    if (!chunk) continue;

    const range = chunk.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const [start, end] = [Number(range[1]), Number(range[2])];
      if (start < 1 || end < start) throw new HttpError(400, `Invalid page range "${chunk}".`);
      for (let p = start; p <= end; p++) pages.add(p - 1);
      continue;
    }

    const single = chunk.match(/^(\d+)$/);
    if (!single || Number(single[1]) < 1) throw new HttpError(400, `Invalid page "${chunk}". Use syntax like "1-4,8".`);
    pages.add(Number(single[1]) - 1);
  }
  return [...pages].sort((a, b) => a - b);
}

function annotationFormat(schema: unknown, name: string) {
  return {
    type: 'json_schema',
    json_schema: { schema, name, strict: true },
  };
}

/** The instruction attached to each detected image when "Annotate images" is on. */
const IMAGE_ANNOTATION_SCHEMA = {
  type: 'object',
  title: 'ImageAnnotation',
  properties: {
    image_type: { type: 'string', description: 'The kind of image: chart, diagram, photo, logo, formula, table, other.' },
    description: { type: 'string', description: 'A short description of what the image depicts.' },
    extracted_text: { type: 'string', description: 'Any text legible inside the image, verbatim.' },
  },
  required: ['image_type', 'description'],
};

export function buildBody(payload: OcrRequestPayload): Record<string, unknown> {
  const { config, source } = payload;

  const body: Record<string, unknown> = {
    model: config.model,
    document:
      source.type === 'document_url'
        ? { type: 'document_url', document_url: source.url, document_name: source.fileName }
        : { type: 'image_url', image_url: source.url },
    include_image_base64: config.extractImages,
    include_blocks: config.boundingBoxes,
  };

  const pages = parsePageRange(config.pages);
  if (pages) body.pages = pages;

  if (config.confidence !== 'none') body.confidence_scores = config.confidence;

  if (config.annotateImages) {
    body.bbox_annotation_format = annotationFormat(IMAGE_ANNOTATION_SCHEMA, 'image_annotation');
  }

  if (config.responseFormat && config.jsonSchema.trim()) {
    let schema: unknown;
    try {
      schema = JSON.parse(config.jsonSchema);
    } catch {
      throw new HttpError(400, 'Response format: the JSON Schema is not valid JSON.');
    }
    // Mistral reads the schema's descriptions as extraction instructions, so the
    // free-text prompt rides along as the schema description rather than a separate field.
    if (payload.config.annotationPrompt.trim() && schema && typeof schema === 'object') {
      (schema as Record<string, unknown>).description = payload.config.annotationPrompt.trim();
    }
    const title = (schema as { title?: string })?.title;
    body.document_annotation_format = annotationFormat(schema, title || 'document_annotation');
  }

  return body;
}

async function post(path: string, body: unknown): Promise<Response> {
  const payload = JSON.stringify(body);
  return withRetry(`sending the request to ${path}`, 3, () =>
    fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key()}` },
      body: payload,
    }),
  );
}

/**
 * Above this decoded size, inlining the document as base64 in the JSON /ocr body is the thing that
 * gets its connection reset mid-upload (EPIPE) — an undivided heavy scanned page is the usual
 * culprit, since the client splitter cannot divide below one page. At or under it, the body is the
 * size the client already proved reliable when it chunks (MAX_CHUNK_BYTES in web/src/lib/split.ts);
 * mirror that boundary here so oversized single pages, and mid-size single files, take the robust path.
 */
const FILES_API_THRESHOLD_BYTES = 1.5 * 1024 * 1024;

/**
 * When the document is too large to inline reliably, hand the raw bytes to Mistral's Files API — a
 * streamed multipart upload (no base64 inflation, its own retry) — and point the OCR request at the
 * returned signed URL instead. The /ocr body then carries a short URL rather than megabytes of
 * base64, which is what dodges the EPIPE. Returns whether the swap happened. The cache key was
 * already taken from the inline bytes in the /api/ocr handler, so this never changes what is cached.
 */
async function routeLargeDocumentThroughFiles(
  payload: OcrRequestPayload,
  body: Record<string, unknown>,
): Promise<boolean> {
  const src = payload.source;
  if (src.type !== 'document_url' || !src.url.startsWith('data:')) return false;

  const bytes = Buffer.from(src.url.slice(src.url.indexOf(',') + 1), 'base64');
  if (bytes.length <= FILES_API_THRESHOLD_BYTES) return false;

  const signedUrl = await uploadAndSign(src.fileName || 'document.pdf', bytes);
  body.document = { type: 'document_url', document_url: signedUrl, document_name: src.fileName };
  return true;
}

export async function runOcr(payload: OcrRequestPayload): Promise<OcrRunResult> {
  const body = buildBody(payload);
  const warnings: string[] = [];
  const started = performance.now();

  const viaFilesApi = await routeLargeDocumentThroughFiles(payload, body);

  let res = await post('/ocr', body);

  if (!res.ok && (res.status === 400 || res.status === 422)) {
    const detail = await res.text();
    const offenders = rejectedFields(detail, body);

    if (offenders.length) {
      // Strip ONLY what the API actually complained about. Blaming every speculative
      // field would misreport working controls as broken — e.g. confidence_scores is
      // unsupported while include_blocks is fine, and they are usually sent together.
      for (const f of offenders) delete body[f];
      warnings.push(
        `The API rejected ${offenders.join(', ')}; re-ran without ${offenders.length > 1 ? 'them' : 'it'}. ${offenders.length > 1 ? 'Those controls' : 'That control'} had no effect on this run.`,
      );
      res = await post('/ocr', body);
    } else {
      throw new HttpError(res.status, `Mistral OCR rejected the request: ${detail.slice(0, 600)}`);
    }
  }

  if (!res.ok) {
    throw new HttpError(res.status, `Mistral OCR failed (${res.status}): ${(await res.text()).slice(0, 600)}`);
  }

  const raw = await res.json();
  const processingMs = Math.round(performance.now() - started);

  const { document: _doc, ...sentBody } = body;
  return {
    raw,
    warnings,
    processingMs,
    sentBody: { ...sentBody, document: viaFilesApi ? '<uploaded via Files API — sent as signed URL>' : '<inlined document>' },
  };
}

/**
 * Which of our speculative fields did this 400/422 actually name? Empty means the request
 * was bad for some other reason (the user's schema, say) and must surface as a real error.
 */
export function rejectedFields(detail: string, body: Record<string, unknown>): string[] {
  const lower = detail.toLowerCase();
  const present = SPECULATIVE_FIELDS.filter((f) => f in body);

  const named = present.filter((f) => lower.includes(f));
  if (named.length) return named;

  // A generic "extra fields not permitted" doesn't say which field. Only then do we
  // fall back to dropping all of them.
  const generic =
    lower.includes('extra fields') ||
    lower.includes('extra inputs') ||
    lower.includes('unexpected') ||
    lower.includes('additional properties');
  return generic ? [...present] : [];
}

/**
 * Upload-then-reference path, for files too large to inline as base64.
 * Returns a signed URL usable as document_url.
 */
export async function uploadAndSign(fileName: string, bytes: Buffer): Promise<string> {
  const mb = (bytes.length / 1024 / 1024).toFixed(1);

  // The multipart body is rebuilt per attempt: a FormData whose stream has already been
  // consumed by a failed request cannot be replayed.
  const up = await withRetry(`uploading ${fileName} (${mb}MB)`, 4, async () => {
    const form = new FormData();
    form.append('purpose', 'ocr');
    form.append('file', new Blob([new Uint8Array(bytes)]), fileName);
    return fetch(`${API}/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key()}` },
      body: form,
    });
  });

  if (!up.ok) throw new HttpError(up.status, `File upload failed (${up.status}): ${(await up.text()).slice(0, 400)}`);
  const { id } = (await up.json()) as { id: string };

  const signed = await withRetry('signing the uploaded file', 3, () =>
    fetch(`${API}/files/${id}/url?expiry=24`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${key()}` },
    }),
  );
  if (!signed.ok) throw new HttpError(signed.status, `Could not sign the uploaded file (${signed.status}).`);
  const { url } = (await signed.json()) as { url: string };
  return url;
}
