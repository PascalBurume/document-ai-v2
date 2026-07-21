import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSuspectReview } from './vision.js';

test('suspect review keeps only corrections that exactly address immutable OCR spans', () => {
  const ocr = 'La fonetion est continue.';
  const parsed = parseSuspectReview(JSON.stringify({ corrections: [
    { start: 3, end: 11, ocr: 'fonetion', replacement: 'fonction', kind: 'letter', reason: 'scan', confidence: 'high' },
    { start: 0, end: 2, ocr: 'wrong', replacement: 'La', kind: 'word', reason: 'stale', confidence: 'high' },
  ] }), ocr);
  assert.equal(parsed.raw, undefined);
  assert.deepEqual(parsed.corrections.map((c) => c.replacement), ['fonction']);
});

test('suspect review surfaces malformed output instead of applying it', () => {
  const parsed = parseSuspectReview('not json', 'source');
  assert.deepEqual(parsed.corrections, []);
  assert.equal(parsed.raw, 'not json');
});
