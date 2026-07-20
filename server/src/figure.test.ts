import { test } from 'node:test';
import assert from 'node:assert/strict';
import { figureCompareCacheKey, parseCompareReply, sanitizeSvg } from './figure.js';

/**
 * The critic feeds an automatic PAID retry, so its parsing has to be boring and correct: a clean
 * verdict retries on real problems; anything unparseable must yield nothing to retry on (a blind
 * second draw costs money and can only drift).
 */

test('critic: a clean verdict round-trips', () => {
  const r = parseCompareReply(
    '{"faithful": false, "problems": ["La courbe monte au lieu de descendre."], "summary": "Un écart."}',
  );
  assert.equal(r.faithful, false);
  assert.deepEqual(r.problems, ['La courbe monte au lieu de descendre.']);
  assert.equal(r.summary, 'Un écart.');
  assert.equal(r.raw, undefined);
});

test('critic: JSON inside a code fence with prose around it still parses', () => {
  const r = parseCompareReply(
    'Voici mon analyse :\n```json\n{"faithful": true, "problems": [], "summary": "Fidèle."}\n```\nBonne journée.',
  );
  assert.equal(r.faithful, true);
  assert.deepEqual(r.problems, []);
});

test('critic: junk yields raw set and NO problems — nothing to retry on, never cached', () => {
  const r = parseCompareReply('I could not compare these images, sorry!');
  assert.equal(r.faithful, false);
  assert.deepEqual(r.problems, []);
  assert.ok(r.raw, 'the unparseable reply is surfaced');
});

test('critic: a non-array problems field is coerced to an empty list, non-strings dropped', () => {
  const scalar = parseCompareReply('{"faithful": false, "problems": "pas une liste", "summary": ""}');
  assert.deepEqual(scalar.problems, []);
  const mixed = parseCompareReply('{"faithful": false, "problems": ["ok", 42, "", null], "summary": ""}');
  assert.deepEqual(mixed.problems, ['ok']);
});

test('critic cache key: stable for the same pair, distinct when either image changes', () => {
  const a = 'data:image/png;base64,AAAA';
  const b = 'data:image/png;base64,BBBB';
  const c = 'data:image/png;base64,CCCC';
  assert.equal(figureCompareCacheKey(a, b), figureCompareCacheKey(a, b));
  assert.notEqual(figureCompareCacheKey(a, b), figureCompareCacheKey(a, c));
  assert.notEqual(figureCompareCacheKey(a, b), figureCompareCacheKey(c, b));
  // Ordered: the original and the redraw are not interchangeable.
  assert.notEqual(figureCompareCacheKey(a, b), figureCompareCacheKey(b, a));
});

test('critic cache key: an OpenAI model change re-bills rather than serving a stale verdict', () => {
  const a = 'data:image/png;base64,AAAA';
  const b = 'data:image/png;base64,BBBB';
  const before = process.env.OPENAI_VISION_MODEL;
  try {
    process.env.OPENAI_VISION_MODEL = 'gpt-test-one';
    const k1 = figureCompareCacheKey(a, b);
    process.env.OPENAI_VISION_MODEL = 'gpt-test-two';
    const k2 = figureCompareCacheKey(a, b);
    assert.notEqual(k1, k2);
  } finally {
    if (before === undefined) delete process.env.OPENAI_VISION_MODEL;
    else process.env.OPENAI_VISION_MODEL = before;
  }
});

test('sanitizeSvg: strips scripts, handlers and external refs; keeps in-document ids', () => {
  const dirty =
    '<svg viewBox="0 0 720 480"><script>alert(1)</script>' +
    '<a href="https://evil.example"><text onclick="x()">t</text></a>' +
    '<use href="#marker"/></svg>';
  const clean = sanitizeSvg(dirty);
  assert.ok(!clean.includes('<script'));
  assert.ok(!clean.includes('onclick'));
  assert.ok(!clean.includes('evil.example'));
  assert.ok(clean.includes('href="#marker"'), 'in-document references survive');
});
