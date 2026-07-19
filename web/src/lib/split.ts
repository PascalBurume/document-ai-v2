import { PDFDocument } from 'pdf-lib';

/**
 * Sending a whole book to Mistral is unreliable: large request bodies get their connection
 * reset before the upload completes. Measured against the live API, uploads above a few MB
 * fail intermittently — and identically under Node's fetch AND curl, so it is the network
 * path, not the client.
 *
 * The fix is to stop sending a book. We extract only the pages actually being OCR'd and ship
 * them in small chunks, each inlined as a data URI.
 */

/**
 * Max bytes of a chunk PDF. The JSON body we POST is base64, ~1.33x this, so 1.5MB of PDF is
 * about a 2MB request — comfortably inside what this network carries reliably.
 */
const MAX_CHUNK_BYTES = 1.5 * 1024 * 1024;

/** Never put more than this many pages in one request, however small they are. */
const MAX_PAGES_PER_CHUNK = 15;

export interface PdfChunk {
  /** Base64 of a PDF containing only these pages. */
  base64: string;
  /** 0-based indices in the ORIGINAL document, in order. Used to remap the results back. */
  indices: number[];
}

function bytesOf(dataUri: string): Uint8Array {
  const b64 = dataUri.split(',')[1];
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const STEP = 0x8000; // chunked: String.fromCharCode blows the stack on big arrays
  for (let i = 0; i < bytes.length; i += STEP) {
    bin += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  return btoa(bin);
}

/**
 * Build a PDF holding exactly these pages of the source.
 *
 * `updateMetadata: false` is what makes the cache work, and it is not cosmetic. By default
 * pdf-lib stamps a fresh CreationDate/ModificationDate into every document it creates, so the
 * same page rebuilt a second later serialises to DIFFERENT BYTES. The server's cache is keyed by
 * a hash of exactly these bytes — so with the default, every chunk of every upload missed, and a
 * book you had already paid to OCR was silently billed again on every single re-upload. Only
 * files under the inline limit (which skip this path and send the original PDF untouched) ever
 * hit the cache, which is why small documents looked fine and books never did.
 *
 * Determinism here is therefore a correctness property of the cache, not a nicety. It is pinned
 * by a test that builds the same chunk twice and asserts the bytes are identical.
 */
async function build(source: PDFDocument, indices: number[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const copied = await doc.copyPages(source, indices);
  copied.forEach((p) => doc.addPage(p));
  return doc.save();
}

/**
 * Emit chunks for `indices`, splitting in half whenever the built PDF turns out too big.
 *
 * Sizing by average bytes-per-page does NOT work: on a scanned book the cover and plates are
 * many times heavier than a text page, so an "average" 12-page chunk measured 4.26MB against a
 * 2.5MB target — and that oversized chunk is exactly what got its connection reset. So we build
 * the chunk, measure it, and split again if it is over. A single page that is still too big is
 * emitted anyway: it cannot be divided, and the server's retry is its only recourse.
 */
async function emit(source: PDFDocument, indices: number[], out: PdfChunk[]): Promise<void> {
  if (!indices.length) return;

  const bytes = await build(source, indices);

  const tooBig = bytes.length > MAX_CHUNK_BYTES || indices.length > MAX_PAGES_PER_CHUNK;
  if (tooBig && indices.length > 1) {
    const mid = Math.ceil(indices.length / 2);
    await emit(source, indices.slice(0, mid), out);
    await emit(source, indices.slice(mid), out);
    return;
  }

  out.push({ base64: toBase64(bytes), indices });
}

/**
 * @param wanted 0-based page indices to keep, or null for every page.
 */
export async function splitPdf(dataUri: string, wanted: number[] | null): Promise<PdfChunk[]> {
  const source = await PDFDocument.load(bytesOf(dataUri), { ignoreEncryption: true });
  const total = source.getPageCount();

  const pages = (wanted ?? Array.from({ length: total }, (_, i) => i)).filter((i) => i < total);
  if (!pages.length) return [];

  // Start from a cheap guess, then let `emit` measure and subdivide what is actually too big.
  const avgPageBytes = bytesOf(dataUri).length / total;
  const guess = Math.max(1, Math.min(MAX_PAGES_PER_CHUNK, Math.floor(MAX_CHUNK_BYTES / avgPageBytes)));

  const chunks: PdfChunk[] = [];
  for (let i = 0; i < pages.length; i += guess) {
    await emit(source, pages.slice(i, i + guess), chunks);
  }

  return chunks;
}
