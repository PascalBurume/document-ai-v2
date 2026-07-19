import type { Block, BlockType, Bbox, OcrPage, OcrResult, Word } from './types';

/**
 * The OCR response is parsed defensively: block/word structures are only loosely
 * specified, so every shape we have seen (or might reasonably get) is accepted and
 * anything unrecognised is dropped rather than thrown.
 */

type Any = Record<string, any>;

const KNOWN_TYPES: BlockType[] = ['title', 'text', 'table', 'list', 'image', 'equation', 'header', 'footer'];

function asType(value: unknown): BlockType {
  const s = String(value ?? '').toLowerCase();
  const hit = KNOWN_TYPES.find((t) => s === t || s.includes(t));
  if (hit) return hit;
  if (s === 'paragraph' || s === 'plaintext') return 'text';
  if (s === 'heading' || s.startsWith('h1') || s.startsWith('h2')) return 'title';
  if (s === 'formula' || s === 'math') return 'equation';
  if (s === 'figure' || s === 'picture') return 'image';
  return 'other';
}

/** Accepts corner pairs, x/y/w/h, or a 4-tuple. Returns null if none apply. */
function asBbox(source: Any): Bbox | null {
  if (!source) return null;
  const box = source.bbox ?? source.bounding_box ?? source.box ?? source;

  if (Array.isArray(box) && box.length === 4 && box.every((n) => typeof n === 'number')) {
    const [x0, y0, x1, y1] = box as number[];
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  if (typeof box !== 'object' || box === null) return null;

  const b = box as Any;
  if (typeof b.top_left_x === 'number' && typeof b.bottom_right_x === 'number') {
    return {
      x: b.top_left_x,
      y: b.top_left_y,
      w: b.bottom_right_x - b.top_left_x,
      h: b.bottom_right_y - b.top_left_y,
    };
  }
  if (typeof b.x === 'number' && typeof b.width === 'number') {
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  }
  if (typeof b.x0 === 'number' && typeof b.x1 === 'number') {
    return { x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 };
  }
  return null;
}

function asText(source: Any): string {
  const raw = source.text ?? source.markdown ?? source.content ?? source.value ?? '';
  return typeof raw === 'string' ? raw : '';
}

function asWords(source: Any): Word[] {
  const list = source?.words ?? source?.word_confidences ?? source?.confidence?.words;
  if (!Array.isArray(list)) return [];
  return list
    .map((w: Any) => {
      const text = typeof w === 'string' ? w : (w.text ?? w.word ?? w.value ?? '');
      const confidence = Number(w?.confidence ?? w?.score ?? w?.conf ?? NaN);
      if (!text || Number.isNaN(confidence)) return null;
      // Confidences arrive as either 0-1 or 0-100.
      const norm = confidence > 1 ? confidence / 100 : confidence;
      return { text: String(text), confidence: norm, bbox: asBbox(w) ?? undefined } as Word;
    })
    .filter((w): w is Word => w !== null);
}

function parseBlocks(page: Any, pageIndex: number): Block[] {
  const blocks: Block[] = [];
  const rawBlocks = page.blocks ?? page.regions ?? page.elements ?? [];

  if (Array.isArray(rawBlocks)) {
    rawBlocks.forEach((b: Any, i: number) => {
      const bbox = asBbox(b);
      if (!bbox) return;
      blocks.push({
        id: `p${pageIndex}-b${i}`,
        type: asType(b.type ?? b.label ?? b.category ?? b.element_type),
        bbox,
        text: asText(b),
        annotation: b.annotation ?? b.bbox_annotation,
        confidence: typeof b.confidence === 'number' ? b.confidence : undefined,
      });
    });
  }

  // Extracted images are reported separately from blocks; they are regions too.
  const images = Array.isArray(page.images) ? page.images : [];
  images.forEach((img: Any, i: number) => {
    const bbox = asBbox(img);
    if (!bbox) return;
    blocks.push({
      id: `p${pageIndex}-i${i}`,
      type: 'image',
      bbox,
      text: String(img.id ?? `image-${i}`),
      imageBase64: img.image_base64 ?? img.base64,
      annotation: img.image_annotation ?? img.annotation,
    });
  });

  return blocks;
}

export function parseOcrResponse(payload: Any): OcrResult {
  const raw = payload.raw as Any;
  const rawPages: Any[] = Array.isArray(raw?.pages) ? raw.pages : [];

  const pages: OcrPage[] = rawPages.map((p, i) => {
    const dims = p.dimensions ?? p.dimension ?? {};
    const index = typeof p.index === 'number' ? p.index : i;
    return {
      index,
      markdown: typeof p.markdown === 'string' ? p.markdown : '',
      width: Number(dims.width) || 1000,
      height: Number(dims.height) || 1400,
      blocks: parseBlocks(p, index),
      words: asWords(p),
      confidence: typeof p.confidence === 'number' ? p.confidence : undefined,
    };
  });

  const usage = raw?.usage_info ?? raw?.usage ?? {};
  const tokens = Number(usage.total_tokens ?? usage.tokens ?? NaN);

  return {
    pages,
    pagesProcessed: Number(usage.pages_processed) || pages.length,
    cached: Boolean(payload.cached),
    model: String(raw?.model ?? ''),
    documentAnnotation: parseMaybeJson(raw?.document_annotation),
    tokens: Number.isNaN(tokens) ? null : tokens,
    warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
    processingMs: Number(payload.processingMs) || 0,
    raw,
    sentBody: payload.sentBody ?? {},
  };
}

/** document_annotation comes back as a JSON string. */
function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/* ---------- Block <-> markdown linking ---------- */

export interface Segment {
  text: string;
  blockId: string | null;
}

/** Collapse whitespace, keeping a map back to offsets in the original string. */
function normalize(source: string): { text: string; map: number[] } {
  const chars: string[] = [];
  const map: number[] = [];
  let lastWasSpace = true;

  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (/\s/.test(c)) {
      if (!lastWasSpace) {
        chars.push(' ');
        map.push(i);
        lastWasSpace = true;
      }
      continue;
    }
    chars.push(c.toLowerCase());
    map.push(i);
    lastWasSpace = false;
  }
  return { text: chars.join(''), map };
}

/**
 * Splits a page's markdown into spans, each tagged with the block it came from (or null).
 * The API does not hand back character offsets, so blocks are located by matching their
 * text back into the markdown. Unmatched blocks simply stay unlinked — the overlay still
 * works, only the two-way highlight is missing for them.
 */
export function linkBlocks(markdown: string, blocks: Block[]): Segment[] {
  const haystack = normalize(markdown);
  const hits: { start: number; end: number; blockId: string }[] = [];

  for (const block of blocks) {
    if (block.type === 'image' || block.text.trim().length < 4) continue;
    const needle = normalize(block.text).text.trim();
    if (!needle) continue;

    let at = haystack.text.indexOf(needle);
    // Long blocks often differ by a character or two (an equation, a ligature).
    // Fall back to the first line, which is usually enough to anchor the region.
    if (at === -1 && needle.length > 40) {
      const head = needle.slice(0, 40);
      at = haystack.text.indexOf(head);
      if (at !== -1) {
        hits.push({ start: haystack.map[at], end: haystack.map[Math.min(at + needle.length, haystack.map.length - 1)], blockId: block.id });
        continue;
      }
    }
    if (at === -1) continue;

    hits.push({
      start: haystack.map[at],
      end: haystack.map[Math.min(at + needle.length - 1, haystack.map.length - 1)] + 1,
      blockId: block.id,
    });
  }

  // A block's text is the prose, without the markdown that introduces it. Pull the match
  // back over any leading "# ", "- ", "> " on the same line so the heading marker travels
  // with its heading instead of orphaning into its own segment.
  for (const hit of hits) {
    const lineStart = markdown.lastIndexOf('\n', hit.start - 1) + 1;
    if (/^[#>\-*\d.\s]*$/.test(markdown.slice(lineStart, hit.start))) hit.start = lineStart;
  }

  hits.sort((a, b) => a.start - b.start || b.end - a.end);

  const segments: Segment[] = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.start < cursor) continue; // overlapping match, keep the first
    if (hit.start > cursor) segments.push({ text: markdown.slice(cursor, hit.start), blockId: null });
    segments.push({ text: markdown.slice(hit.start, hit.end), blockId: hit.blockId });
    cursor = hit.end;
  }
  if (cursor < markdown.length) segments.push({ text: markdown.slice(cursor), blockId: null });

  return segments.filter((s) => s.text.length > 0);
}

export const BLOCK_COLORS: Record<BlockType, string> = {
  title: '#2563eb',
  text: '#0ea5e9',
  table: '#a855f7',
  list: '#f59e0b',
  image: '#10b981',
  equation: '#ec4899',
  header: '#64748b',
  footer: '#64748b',
  other: '#94a3b8',
};

/** Header/footer chips act as filters on the returned regions. */
export function visibleBlocks(page: OcrPage, keepHeader: boolean, keepFooter: boolean): Block[] {
  return page.blocks.filter(
    (b) => (b.type !== 'header' || keepHeader) && (b.type !== 'footer' || keepFooter),
  );
}
