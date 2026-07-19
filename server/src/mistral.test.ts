import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBody, parsePageRange, rejectedFields, HttpError } from './mistral.js';
import type { OcrConfig, OcrRequestPayload } from './types.js';

const config: OcrConfig = {
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

const payload = (over: Partial<OcrConfig> = {}): OcrRequestPayload => ({
  config: { ...config, ...over },
  source: { type: 'document_url', url: 'data:application/pdf;base64,AAA', fileName: 'x.pdf' },
});

test('page range: 1-based UI becomes the API 0-based list', () => {
  assert.deepEqual(parsePageRange('1-4,8'), [0, 1, 2, 3, 7]);
  assert.deepEqual(parsePageRange('3'), [2]);
  assert.deepEqual(parsePageRange(' 2 , 1 '), [0, 1], 'sorted and deduped');
  assert.deepEqual(parsePageRange('1,1,1'), [0]);
});

test('page range: empty means every page, not page zero', () => {
  assert.equal(parsePageRange(''), undefined);
  assert.equal(parsePageRange('   '), undefined);
});

test('page range: rejects nonsense rather than guessing', () => {
  assert.throws(() => parsePageRange('0'), HttpError, 'page 0 does not exist in a 1-based UI');
  assert.throws(() => parsePageRange('4-2'), HttpError, 'backwards range');
  assert.throws(() => parsePageRange('abc'), HttpError);
});

test('buildBody: sends the documented fields', () => {
  const body = buildBody(payload());
  assert.equal(body.model, 'mistral-ocr-latest');
  assert.equal(body.include_image_base64, true);
  assert.equal(body.include_blocks, true);
  assert.ok(!('pages' in body), 'no page range means no pages field');
});

test('buildBody: confidence=none sends no confidence_scores field', () => {
  assert.ok(!('confidence_scores' in buildBody(payload())));
  assert.equal(buildBody(payload({ confidence: 'word' })).confidence_scores, 'word');
});

test('buildBody: the annotation prompt rides along as the schema description', () => {
  const body = buildBody(
    payload({
      responseFormat: true,
      jsonSchema: '{"type":"object","title":"Invoice","properties":{}}',
      annotationPrompt: 'Extract the total.',
    }),
  );
  const fmt = body.document_annotation_format as any;
  assert.equal(fmt.json_schema.name, 'Invoice');
  assert.equal(fmt.json_schema.schema.description, 'Extract the total.');
});

test('buildBody: an unparseable schema is a user error, not a silent drop', () => {
  assert.throws(() => buildBody(payload({ responseFormat: true, jsonSchema: '{oops' })), HttpError);
});

// The bug this suite exists for: a rejection of one speculative field used to strip them all,
// reporting working controls as broken.
test('rejectedFields: strips only the field the API actually names', () => {
  const real422 =
    '{"detail":[{"type":"extra_forbidden","loc":["body","confidence_scores"],"msg":"Extra inputs are not permitted"}]}';
  const body = { include_blocks: true, confidence_scores: 'word' };

  assert.deepEqual(rejectedFields(real422, body), ['confidence_scores'], 'include_blocks works and must survive');
});

test('rejectedFields: a generic complaint drops every speculative field', () => {
  const body = { include_blocks: true, confidence_scores: 'word' };
  assert.deepEqual(rejectedFields('extra fields not permitted', body), ['include_blocks', 'confidence_scores']);
});

test('rejectedFields: an unrelated 422 is a real error, not something to retry', () => {
  const body = { include_blocks: true };
  assert.deepEqual(rejectedFields('{"message":"invalid json_schema for annotation"}', body), []);
});
