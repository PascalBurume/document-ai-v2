import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkedRedrawPatch,
  critiqueWantsRetry,
  figureRedrawPatch,
  type CheckedRedraw,
  type FigureCompare,
  type FigureRedraw,
} from './figurePatch.js';

const redraw = (over: Partial<FigureRedraw> = {}): FigureRedraw => ({
  svg: '<svg viewBox="0 0 720 480"></svg>',
  caption: 'Courbe de dosage',
  model: 'gpt-5.6',
  reading: 'x: V 0-20 ml, ticks 0,5,10,15,20; y: pH 0-14…',
  isChart: true,
  ...over,
});

const verdict = (over: Partial<FigureCompare> = {}): FigureCompare => ({
  faithful: false,
  problems: ['La graduation 18 manque.'],
  summary: 'Un écart.',
  model: 'gpt-5.6',
  ...over,
});

test('redraw patch: carries the reading and resets any earlier critic verdict', () => {
  const p = figureRedrawPatch(redraw());
  assert.equal(p.redrawReading, 'x: V 0-20 ml, ticks 0,5,10,15,20; y: pH 0-14…');
  assert.equal(p.redrawChecked, false, 'a fresh drawing invalidates the old verdict — it judged a different image');
  assert.equal(p.redrawFaithful, undefined);
  assert.equal(p.redrawProblems, undefined);
});

test('redraw patch: the not-chart verdict clears the SVG and every critic field', () => {
  const p = figureRedrawPatch(redraw({ isChart: false, reason: 'photo du montage', svg: '' }));
  assert.equal(p.redrawNotChart, true);
  assert.equal(p.redrawnSvg, '');
  assert.equal(p.redrawChecked, false);
  assert.equal(p.redrawReading, undefined);
});

test('checked patch: merges the verdict onto the redraw', () => {
  const r: CheckedRedraw = { redraw: redraw(), critique: verdict(), attempts: 2 };
  const p = checkedRedrawPatch(r);
  assert.equal(p.redrawChecked, true);
  assert.equal(p.redrawFaithful, false);
  assert.deepEqual(p.redrawProblems, ['La graduation 18 manque.']);
  assert.equal(p.redrawCheckModel, 'gpt-5.6');
});

test('checked patch: no critique leaves the figure UNCHECKED — absence is not a pass', () => {
  const p = checkedRedrawPatch({ redraw: redraw(), critique: null, attempts: 1 });
  assert.equal(p.redrawChecked, false);
  assert.equal(p.redrawFaithful, undefined);
});

test('checked patch: an unparseable critique (raw) also leaves the figure unchecked', () => {
  const p = checkedRedrawPatch({ redraw: redraw(), critique: verdict({ raw: 'garbage' }), attempts: 1 });
  assert.equal(p.redrawChecked, false);
});

test('checked patch: a not-chart result never carries a verdict', () => {
  const p = checkedRedrawPatch({
    redraw: redraw({ isChart: false, svg: '', reason: 'photo' }),
    critique: verdict(),
    attempts: 1,
  });
  assert.equal(p.redrawChecked, false);
  assert.equal(p.redrawNotChart, true);
});

test('critiqueWantsRetry: fires only on a real verdict with concrete problems', () => {
  assert.equal(critiqueWantsRetry(verdict()), true);
  assert.equal(critiqueWantsRetry(verdict({ faithful: true, problems: [] })), false, 'faithful — nothing to fix');
  assert.equal(critiqueWantsRetry(verdict({ problems: [] })), false, 'no concrete problems — nothing to feed back');
  assert.equal(critiqueWantsRetry(verdict({ raw: 'junk' })), false, 'unparseable — a blind retry only drifts');
  assert.equal(critiqueWantsRetry(null), false, 'no verdict at all');
});
