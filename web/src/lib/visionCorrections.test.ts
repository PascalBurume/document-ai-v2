import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyVisionCorrections } from './visionCorrections';

const fix = (start: number, ocr: string, replacement: string, confidence: 'high' | 'medium' = 'high') => ({
  start, end: start + ocr.length, ocr, replacement, confidence, kind: 'letter', reason: 'visible',
});

test('vision corrections apply high-confidence exact spans without changing OCR evidence', () => {
  const original = 'La fonetion est continue.';
  const result = applyVisionCorrections(original, original, [fix(3, 'fonetion', 'fonction')]);
  assert.equal(result.markdown, 'La fonction est continue.');
  assert.equal(original, 'La fonetion est continue.');
  assert.equal(result.corrections[0].applied, true);
});

test('medium-confidence proposals remain visible but are not auto-applied', () => {
  const result = applyVisionCorrections('xO', 'xO', [fix(0, 'xO', 'x0', 'medium')]);
  assert.equal(result.markdown, 'xO');
  assert.equal(result.corrections[0].applied, false);
});

test('a unique span maps after a human edit, while ambiguous repeats are skipped', () => {
  const original = 'Titre\nLa fonetion. fin fin';
  const result = applyVisionCorrections(`Nouveau ${original}`, original, [
    fix(9, 'fonetion', 'fonction'), fix(19, 'fin', 'FIN'),
  ]);
  assert.match(result.markdown, /La fonction/);
  assert.equal(result.corrections[0].applied, true);
  assert.equal(result.corrections[1].applied, false);
});
