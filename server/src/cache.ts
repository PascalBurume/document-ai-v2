import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OcrConfig, OcrRunResult } from './types.js';

/**
 * OCR costs money and the same page never changes. A result is cached on disk, keyed by the
 * bytes of the document plus the settings that affect the response — so re-running a book you
 * have already processed is instant and free, and survives a page reload, a server restart,
 * and a new browser.
 *
 * Keyed by CONTENT, not filename: renaming the file, or dropping the same scan in twice, still
 * hits the cache.
 */

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.cache');

/**
 * Only the settings that change what the API returns. Table mode and the header/footer chips
 * are applied client-side, so they must NOT bust the cache — the stored response is the same.
 */
function requestShape(config: OcrConfig) {
  return {
    model: config.model,
    pages: config.pages,
    extractImages: config.extractImages,
    boundingBoxes: config.boundingBoxes,
    confidence: config.confidence,
    annotateImages: config.annotateImages,
    responseFormat: config.responseFormat,
    jsonSchema: config.responseFormat ? config.jsonSchema : '',
    annotationPrompt: config.responseFormat ? config.annotationPrompt : '',
  };
}

/** `document` is the data URI (or signed URL) actually sent. Hash its payload. */
export function cacheKey(config: OcrConfig, document: string): string {
  const payload = document.startsWith('data:') ? document.slice(document.indexOf(',') + 1) : document;
  const bytes = createHash('sha256').update(payload).digest('hex');
  return createHash('sha256').update(JSON.stringify({ bytes, ...requestShape(config) })).digest('hex');
}

export function read(key: string): OcrRunResult | null {
  try {
    const hit = JSON.parse(readFileSync(path.join(DIR, `${key}.json`), 'utf8')) as OcrRunResult;
    return { ...hit, cached: true };
  } catch {
    return null; // absent or unreadable — treat as a miss, never as an error
  }
}

export function write(key: string, result: OcrRunResult): void {
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(path.join(DIR, `${key}.json`), JSON.stringify(result));
  } catch (err) {
    // A cache that cannot write is a slow cache, not a broken app.
    console.warn('cache write failed:', (err as Error).message);
  }
}

export function stats(): { entries: number; bytes: number } {
  try {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));
    const bytes = files.reduce((sum, f) => sum + statSync(path.join(DIR, f)).size, 0);
    return { entries: files.length, bytes };
  } catch {
    return { entries: 0, bytes: 0 };
  }
}
