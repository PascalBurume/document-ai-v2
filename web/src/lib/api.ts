import type { DocFile, OcrConfig, OcrResult, OcrPage } from './types';
import { parseOcrResponse } from './ocr';
import { splitPdf } from './split';
import { parsePageRange } from './pages';

/**
 * Above this, a single request stops being reliable: the connection gets reset mid-upload.
 * Bigger PDFs are split into page chunks instead (see split.ts).
 *
 * This is deliberately higher than the SERVER's Files-API threshold (1.5MB, FILES_API_THRESHOLD_BYTES
 * in server/src/mistral.ts). The two are not redundant and the gap is not a bug: a 1.5–4MB PDF is
 * sent whole from here (no client chunking), and the server then routes that single body through the
 * Files API rather than inlining it. Only PDFs over 4MB are split into chunks client-side — because
 * only then is chunking worth the reassembly, and the per-chunk cache wants whole pages, not a file
 * carved to hit a byte target. So: ≤1.5MB inline end to end; 1.5–4MB whole here, Files-API on the
 * server; >4MB chunked here (and each chunk re-crosses the same server threshold).
 */
const INLINE_LIMIT_BYTES = 4 * 1024 * 1024;

async function post(path: string, body: unknown): Promise<any> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: `Server returned ${res.status}.` }));
  if (!res.ok) throw new Error(data.error ?? `Server returned ${res.status}.`);
  return data;
}

export type Progress = (done: number, total: number) => void;

/**
 * Renumber a chunk's pages back to the original document. Page 0 of chunk 3 is not page 0
 * of the book — get this wrong and every page is silently mislabelled, which is exactly the
 * quiet corruption this app exists to catch. Pure, so it is unit-tested.
 */
export function remapPages(pages: { index: number }[], indices: number[]): { index: number }[] {
  return pages
    .map((p) => {
      const original = indices[p.index];
      return original == null ? null : { ...p, index: original };
    })
    .filter((p): p is { index: number } => p !== null);
}

export async function runOcr(
  doc: DocFile,
  config: OcrConfig,
  onProgress?: Progress,
  force = false,
): Promise<OcrResult> {
  const wanted = parsePageRange(config.pages);

  // Small file, or an image: one request, exactly as before.
  if (doc.sourceType === 'image_url' || doc.sizeBytes <= INLINE_LIMIT_BYTES) {
    onProgress?.(0, 1);
    const payload = await post('/api/ocr', {
      config,
      force,
      source: { type: doc.sourceType, url: doc.dataUri, fileName: doc.name, pageCount: doc.pageCount },
    });
    onProgress?.(1, 1);
    return parseOcrResponse(payload);
  }

  const chunks = await splitPdf(doc.dataUri, wanted);
  if (!chunks.length) throw new Error(`The page range “${config.pages}” selects no pages in this document.`);

  const merged: any[] = [];
  const warnings = new Set<string>();
  let processingMs = 0;
  let tokens: number | null = null;
  let sentBody: Record<string, unknown> = {};
  let model = '';
  // Each chunk is cached separately, so an interrupted run resumes for free: the chunks that
  // already went through are hits, and only the missing ones are paid for.
  let cachedChunks = 0;
  let attempted = 0;
  /** Pages that could not be read at all, after subdividing down to a single page. */
  const failed: number[] = [];

  // A work queue, not a fixed list: a chunk that fails on the network is SPLIT and its halves are
  // pushed back on. Uploads to Mistral get reset more often the bigger they are, so a chunk that
  // failed whole may well succeed in halves — and a single page that is simply too fat to upload
  // then fails alone, costing that one page instead of the other fifty.
  //
  // This loop used to `throw` on the first bad chunk, which threw away every page already read.
  // On a 51-page scan with one heavy plate that meant the book could NEVER complete, however many
  // times you pressed Run. A partial book, with the missing pages named, beats no book at all —
  // provided the gap is reported loudly, which is what `failed` is for.
  const queue = [...chunks];
  const total = chunks.length;

  onProgress?.(0, total);

  while (queue.length) {
    const chunk = queue.shift()!;
    try {
      // The chunk already contains only the wanted pages, so the request must not ALSO carry
      // a page range — that would be applied a second time, against the chunk's own numbering.
      const payload = await post('/api/ocr', {
        config: { ...config, pages: '' },
        force,
        source: {
          type: 'document_url',
          url: `data:application/pdf;base64,${chunk.base64}`,
          fileName: doc.name,
          pageCount: chunk.indices.length,
        },
      });
      if (payload.cached) cachedChunks++;

      const result = parseOcrResponse(payload);
      // remapPages renumbers page.index back to the document, but block ids were minted from the
      // chunk-LOCAL page index inside parseOcrResponse — so every chunk emits a `p0-b*`, `p1-b*`…
      // and the ids collide across chunks. That breaks the two-way link: selecting a box matches
      // the same id on ~18 pages and the pane jumps to the first one, not the page you clicked.
      // Re-key each block to its true page index so an id is unique across the whole document.
      const remapped = remapPages(result.pages, chunk.indices) as unknown as OcrPage[];
      for (const page of remapped) {
        page.blocks = page.blocks.map((b) => ({ ...b, id: b.id.replace(/^p\d+-/, `p${page.index}-`) }));
      }
      merged.push(...remapped);

      result.warnings.forEach((w) => warnings.add(w));
      processingMs += result.processingMs;
      if (result.tokens != null) tokens = (tokens ?? 0) + result.tokens;
      if (!model) model = result.model;
      if (!Object.keys(sentBody).length) sentBody = result.sentBody;
    } catch (err) {
      if (chunk.indices.length > 1) {
        // Too big for this network, most likely. Halve it and try the pieces.
        const halves = await splitPdf(doc.dataUri, chunk.indices);
        if (halves.length > 1 || halves[0]?.indices.length < chunk.indices.length) {
          queue.unshift(...halves);
        } else {
          const mid = Math.ceil(chunk.indices.length / 2);
          queue.unshift(
            ...(await splitPdf(doc.dataUri, chunk.indices.slice(0, mid))),
            ...(await splitPdf(doc.dataUri, chunk.indices.slice(mid))),
          );
        }
        continue;
      }
      // A single page that will not go through. Record it and keep reading the book.
      failed.push(...chunk.indices);
      console.warn(`page ${chunk.indices[0] + 1} failed: ${(err as Error).message}`);
    }
    attempted++;
    onProgress?.(Math.min(attempted, total), total);
  }

  // Every chunk failed — there is no book here, so this is an error, not a partial result.
  if (!merged.length) {
    throw new Error(
      `No page of this document could be read. The upstream API closed the connection on every ` +
        `chunk — usually a flaky upload rather than a problem with the file. Try again.`,
    );
  }

  // Never let a gap be silent. The whole premise of this repo is that a claim about a document
  // must not quietly omit what it failed to read.
  if (failed.length) {
    const list = failed.sort((a, b) => a - b).map((i) => i + 1).join(', ');
    warnings.add(
      `${failed.length} page${failed.length === 1 ? '' : 's'} could not be read and ${
        failed.length === 1 ? 'is' : 'are'
      } MISSING from this result: ${list}. The upstream connection was reset while uploading ` +
        `${failed.length === 1 ? 'it' : 'them'}. Press Run again to retry just ${
          failed.length === 1 ? 'that page' : 'those pages'
        } — every page already read is cached and costs nothing.`,
    );
  }

  merged.sort((a, b) => a.index - b.index);

  // Chunking is how the run succeeded, not something that went wrong — so it is reported as
  // a fact about the run (a chip), never as a warning. The warning banner is reserved for
  // things the user may need to act on; diluting it trains people to ignore it.
  return {
    pages: merged,
    pagesProcessed: merged.length,
    chunks: chunks.length,
    // `attempted`, not `chunks.length`: a subdivided chunk means more requests than the original
    // list had. And a run that lost pages is never "cached · free" — the chip must not imply a
    // complete document was served from disk when part of it is missing.
    cached: !failed.length && attempted > 0 && cachedChunks === attempted,
    model,
    documentAnnotation: undefined,
    tokens,
    warnings: [...warnings],
    processingMs,
    raw: { pages: merged, chunked: chunks.length },
    sentBody,
  };
}

export async function health(): Promise<{ keyConfigured: boolean; mock?: boolean }> {
  const res = await fetch('/api/health');
  return res.json();
}
