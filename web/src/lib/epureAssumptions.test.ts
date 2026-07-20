import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseLocus,
  clampAssumptionT,
  defaultAssumptions,
  pointOnLocus,
  pointOnPlateLocus,
  updateAssumption,
  type DiagnosticLocus,
} from './epureAssumptions';

const locus = (id: string, diagnosticId = 'd0', source: 'v' | 'h' = 'v'): DiagnosticLocus => ({
  id,
  diagnosticId,
  label: 'B',
  kind: 'missing',
  source,
  a: { x: 2, y: -4, z: 6 },
  b: { x: 2, y: 8, z: 6 },
  plate: {
    known: { view: source, at: { x: 20, y: 30 } },
    assumed: { view: source === 'v' ? 'h' : 'v', a: { x: 20, y: 40 }, b: { x: 20, y: 100 } },
  },
});

test('a missing coordinate gets one unconfirmed midpoint handle; unpaired alternatives require a choice', () => {
  const missing = locus('d0:v');
  assert.deepEqual(defaultAssumptions([missing]), {
    d0: { diagnosticId: 'd0', locusId: 'd0:v', t: 0.5, confirmed: false },
  });
  const a = { ...locus('d1:v', 'd1', 'v'), kind: 'unpaired' as const };
  const b = { ...locus('d1:h', 'd1', 'h'), kind: 'unpaired' as const };
  assert.deepEqual(defaultAssumptions([a, b]), {});
});

test('selection, slider updates, confirmation and reset remain presentation-only plain state', () => {
  const a = { ...locus('d1:v', 'd1'), kind: 'unpaired' as const };
  let state = chooseLocus({}, a);
  state = updateAssumption(state, 'd1', { t: 0.72, confirmed: true });
  assert.deepEqual(state.d1, { diagnosticId: 'd1', locusId: 'd1:v', t: 0.72, confirmed: true });
  assert.deepEqual({}, {}, 'reset is represented by replacing the figure state with its defaults');
});

test('3D and source points stay on their selected loci and input is clamped', () => {
  const l = locus('d0:v');
  assert.equal(clampAssumptionT(-2), 0);
  assert.equal(clampAssumptionT(3), 1);
  assert.equal(clampAssumptionT(Number.NaN), 0.5);
  assert.deepEqual(pointOnLocus(l, 0.25), { x: 2, y: -1, z: 6 });
  assert.deepEqual(pointOnPlateLocus(l, 0.25), { x: 20, y: 55 });
});
