import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import JSZip from 'jszip';
import { downloadAll } from './download';
import type { Block, DocFile, OcrPage } from './types';

/**
 * The zip is the archive: what is not in it did not survive. Figure redraws are the most expensive
 * thing in a finished book and they live on the blocks, NOT in the OCR markdown — so a zip built
 * only from `markdown` silently drops every one of them. That regression is invisible until
 * someone opens the download months later, which is exactly why it is pinned here.
 */

const bbox = { x: 0, y: 0, w: 10, h: 10 };

const figureBlock = (over: Partial<Block> = {}): Block => ({
  id: 'p0-i0',
  type: 'image',
  bbox,
  text: 'img-0.jpeg',
  imageBase64: 'AAAA',
  ...over,
});

const page = (blocks: Block[]): OcrPage => ({
  index: 0,
  markdown: '# La matière\n\n![img-0.jpeg](img-0.jpeg)\n',
  width: 800,
  height: 1000,
  blocks,
  words: [],
});

const doc = (blocks: Block[]): DocFile =>
  ({
    id: 'doc-0',
    name: 'chimie.pdf',
    sizeBytes: 1,
    mime: 'application/pdf',
    sourceType: 'document_url',
    dataUri: 'data:application/pdf;base64,x',
    pageCount: 1,
    result: { pages: [page(blocks)], raw: { ok: true }, model: 'mistral-ocr-latest', pagesProcessed: 1 },
  }) as unknown as DocFile;

/** downloadAll saves via a DOM anchor; capture the zip instead of touching the document. */
async function zipOf(d: DocFile): Promise<JSZip> {
  let captured: Blob | undefined;
  const g = globalThis as Record<string, unknown>;
  const url = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };
  g.URL = { ...(g.URL as object), ...url };
  g.document = {
    createElement: () => ({ click: () => {}, set href(_v: string) {}, set download(_v: string) {} }),
  };
  const origBlob = g.Blob;
  g.Blob = class {
    constructor(parts: unknown[]) {
      captured = parts[0] as Blob;
    }
  };
  try {
    await downloadAll([d], 'markdown_embedded');
  } finally {
    g.Blob = origBlob;
  }
  // jszip's generateAsync('blob') needs a real Blob; ask for a buffer via a second pass instead.
  return captured ? await JSZip.loadAsync(captured as unknown as ArrayBuffer) : new JSZip();
}

test('the zip carries the recreated figure — book.html, book.md and its own SVG file', async () => {
  const svg = '<svg viewBox="0 0 720 480"><path d="M0 0"/></svg>';
  const zip = await zipOf(doc([figureBlock({ redrawnSvg: svg, redrawnModel: 'gpt-5.6' })]));

  const names = Object.keys(zip.files);
  assert.ok(names.some((n) => n.endsWith('book.html')), 'the assembled book is in the archive');
  assert.ok(names.some((n) => n.endsWith('book.md')));
  assert.ok(names.some((n) => n.includes('figures/') && n.endsWith('.svg')), 'each redraw is a reusable file');

  const html = await zip.file(/book\.html$/)[0].async('string');
  assert.ok(html.includes('viewBox="0 0 720 480"'), 'the redraw is inlined in the book');
  assert.ok(html.includes('recreated by AI'), 'and stays labelled as generated content');

  const md = await zip.file(/book\.md$/)[0].async('string');
  assert.ok(md.includes('<svg'), 'the markdown export inlines it too');
});

test('the raw OCR evidence and the scan are still archived alongside the book', async () => {
  const zip = await zipOf(doc([figureBlock({ redrawnSvg: '<svg><rect/></svg>', redrawnModel: 'gpt-5.6' })]));
  const names = Object.keys(zip.files);
  assert.ok(names.some((n) => n.endsWith('result.json')), 'the immutable API response');
  assert.ok(names.some((n) => n.endsWith('document.md')), 'the transcription');
  assert.ok(names.some((n) => n.includes('images/') && n.endsWith('.jpeg')), 'the original scan crop');
});

test('a stub redraw is not archived as a figure — it was never a real recreation', async () => {
  const zip = await zipOf(doc([figureBlock({ redrawnSvg: '<svg><rect/></svg>', redrawnStub: true })]));
  const names = Object.keys(zip.files);
  assert.ok(!names.some((n) => n.includes('figures/') && n.endsWith('.svg')));
});
