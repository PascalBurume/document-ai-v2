import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOcrResponse, linkBlocks, visibleBlocks } from './ocr';
import { applyTableMode, tableToHtml } from './tables';
import { fieldsToSchema, schemaToFields, TEMPLATES, templateToSchema } from './templates';

const response = (pages: unknown[]) => ({
  raw: { pages, model: 'mistral-ocr-latest', usage_info: { pages_processed: pages.length } },
  warnings: [],
  processingMs: 10,
  sentBody: {},
});

test('parser: reads the documented corner-pair bbox shape', () => {
  const r = parseOcrResponse(
    response([
      {
        index: 0,
        markdown: 'hello',
        dimensions: { width: 800, height: 1000 },
        blocks: [
          { type: 'text', text: 'hello', bbox: { top_left_x: 10, top_left_y: 20, bottom_right_x: 110, bottom_right_y: 70 } },
        ],
      },
    ]),
  );
  assert.deepEqual(r.pages[0].blocks[0].bbox, { x: 10, y: 20, w: 100, h: 50 });
});

test('parser: accepts x/y/w/h and 4-tuple bboxes too', () => {
  const r = parseOcrResponse(
    response([
      {
        index: 0,
        markdown: '',
        dimensions: { width: 800, height: 1000 },
        blocks: [
          { type: 'text', text: 'a', bbox: { x: 5, y: 5, width: 20, height: 10 } },
          { type: 'text', text: 'b', bbox: [0, 0, 30, 40] },
        ],
      },
    ]),
  );
  assert.deepEqual(r.pages[0].blocks.map((b) => b.bbox.w), [20, 30]);
});

test('parser: a block with no usable bbox is dropped, not crashed on', () => {
  const r = parseOcrResponse(
    response([{ index: 0, markdown: '', dimensions: {}, blocks: [{ type: 'text', text: 'x' }, null, 'junk'] }]),
  );
  assert.equal(r.pages[0].blocks.length, 0);
});

test('parser: unknown block types fall back to "other", known aliases normalise', () => {
  const r = parseOcrResponse(
    response([
      {
        index: 0,
        markdown: '',
        dimensions: {},
        blocks: [
          { type: 'paragraph', text: 'a', bbox: [0, 0, 1, 1] },
          { type: 'formula', text: 'b', bbox: [0, 0, 1, 1] },
          { type: 'wingding', text: 'c', bbox: [0, 0, 1, 1] },
        ],
      },
    ]),
  );
  assert.deepEqual(r.pages[0].blocks.map((b) => b.type), ['text', 'equation', 'other']);
});

test('parser: extracted images become image regions', () => {
  const r = parseOcrResponse(
    response([
      {
        index: 0,
        markdown: '![img-0.jpeg](img-0.jpeg)',
        dimensions: { width: 800, height: 1000 },
        images: [{ id: 'img-0.jpeg', top_left_x: 0, top_left_y: 0, bottom_right_x: 100, bottom_right_y: 100, image_base64: 'AAA' }],
      },
    ]),
  );
  const img = r.pages[0].blocks[0];
  assert.equal(img.type, 'image');
  assert.equal(img.imageBase64, 'AAA');
});

test('parser: word confidence accepted as 0-1 or 0-100, normalised to 0-1', () => {
  const r = parseOcrResponse(
    response([
      { index: 0, markdown: '', dimensions: {}, words: [{ text: 'a', confidence: 0.42 }, { text: 'b', confidence: 95 }] },
    ]),
  );
  assert.deepEqual(r.pages[0].words.map((w) => w.confidence), [0.42, 0.95]);
});

test('parser: no token count reported means null, never a fabricated number', () => {
  const r = parseOcrResponse(response([{ index: 0, markdown: '', dimensions: {} }]));
  assert.equal(r.tokens, null);
});

test('parser: page index is preserved, so a "1-2,5" run still lines up with the viewer', () => {
  const r = parseOcrResponse(
    response([{ index: 0, markdown: '', dimensions: {} }, { index: 4, markdown: '', dimensions: {} }]),
  );
  assert.deepEqual(r.pages.map((p) => p.index), [0, 4]);
});

/* ---- block <-> markdown linking ---- */

const block = (id: string, text: string, type = 'text') =>
  ({ id, text, type, bbox: { x: 0, y: 0, w: 1, h: 1 } }) as any;

test('linking: a matched block claims its span of the markdown', () => {
  const md = 'Intro line.\n\nThe quick brown fox.';
  const segs = linkBlocks(md, [block('b1', 'The quick brown fox.')]);

  const linked = segs.filter((s) => s.blockId);
  assert.equal(linked.length, 1);
  assert.equal(linked[0].blockId, 'b1');
  assert.equal(linked[0].text.trim(), 'The quick brown fox.');
  assert.equal(segs.map((s) => s.text).join(''), md, 'segments must reconstruct the markdown exactly');
});

test('linking: a heading keeps its "# " marker instead of orphaning it', () => {
  const segs = linkBlocks('# Chapitre 1\n\nbody', [block('t', 'Chapitre 1', 'title')]);
  const linked = segs.find((s) => s.blockId === 't')!;
  assert.ok(linked.text.startsWith('# '), `expected the hash to travel with the heading, got ${JSON.stringify(linked.text)}`);
});

test('linking: an unmatched block simply stays unlinked', () => {
  const segs = linkBlocks('nothing like it here', [block('b1', 'a completely different string')]);
  assert.equal(segs.filter((s) => s.blockId).length, 0);
  assert.equal(segs.map((s) => s.text).join(''), 'nothing like it here');
});

test('linking: whitespace differences do not defeat the match', () => {
  const segs = linkBlocks('The   quick\nbrown fox', [block('b1', 'The quick brown fox')]);
  assert.equal(segs.filter((s) => s.blockId).length, 1);
});

test('header/footer chips filter regions of that type', () => {
  const page = {
    blocks: [block('a', 'body'), block('h', 'top', 'header'), block('f', '48', 'footer')],
  } as any;
  assert.deepEqual(visibleBlocks(page, false, false).map((b) => b.id), ['a']);
  assert.deepEqual(visibleBlocks(page, true, true).map((b) => b.id), ['a', 'h', 'f']);
});

/* ---- table modes ---- */

const MD_TABLE = 'Before.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nAfter.';

test('tables: embedded mode leaves the markdown untouched', () => {
  const { body, tables } = applyTableMode(MD_TABLE, 'markdown_embedded');
  assert.equal(body, MD_TABLE);
  assert.equal(tables.length, 0);
});

test('tables: standalone mode lifts the table out of the body', () => {
  const { body, tables } = applyTableMode(MD_TABLE, 'markdown_standalone');
  assert.equal(tables.length, 1);
  assert.ok(!/\|\s*---/.test(body), 'the table must no longer be inline');
  assert.ok(body.includes('Before.') && body.includes('After.'), 'surrounding prose survives');
  assert.ok(tables[0].markdown.includes('| 1 | 2 |'));
});

test('tables: html mode produces real table markup', () => {
  const html = tableToHtml('| A | B |\n| --- | --- |\n| 1 | 2 |');
  assert.ok(html.includes('<th>A</th>') && html.includes('<td>2</td>'));
});

test('tables: cell content is escaped, not injected', () => {
  const html = tableToHtml('| A |\n| --- |\n| <script>x</script> |');
  assert.ok(!html.includes('<script>'), 'must not emit raw script tags');
  assert.ok(html.includes('&lt;script&gt;'));
});

/* ---- schema builder ---- */

test('schema: the Structured data template matches the documented shape', () => {
  const json = JSON.parse(templateToSchema(TEMPLATES.find((t) => t.id === 'structured')!));
  assert.equal(json.title, 'StructuredData');
  assert.equal(json.properties.name.type, 'string');
  assert.equal(json.properties.age.type, 'number');
  assert.deepEqual(json.required, ['name']);
});

test('schema: visual builder and code editor round-trip', () => {
  for (const template of TEMPLATES) {
    const json = templateToSchema(template);
    const back = schemaToFields(json);
    assert.ok(back, `${template.id} must parse back into fields`);
    assert.equal(fieldsToSchema(back!.title, back!.fields), json, `${template.id} round-trip must be lossless`);
  }
});

test('schema: a broken hand-edit returns null rather than throwing', () => {
  assert.equal(schemaToFields('{not json'), null);
});
