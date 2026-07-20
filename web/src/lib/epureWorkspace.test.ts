import assert from 'node:assert/strict';
import test from 'node:test';
import { reconstructionStatus, summarizeReconstructionWarnings, workspacePose, WORKSPACE_STEPS } from './epureWorkspace';

test('workspace poses tell one coherent 2D -> 3D story', () => {
  assert.deepEqual(WORKSPACE_STEPS.map((s) => s.id), ['plate', 'projections', 'space', 'trueSize']);
  assert.deepEqual(workspacePose('plate', true, true), {
    dihedralT: 0,
    foldT: 1,
    auxT: 0,
    view: 'planche',
  });
  assert.equal(workspacePose('space', true, true).dihedralT, 1);
  assert.equal(workspacePose('space', true, true).foldT, 0);
  assert.equal(workspacePose('trueSize', true, false).foldT, 1);
  assert.equal(workspacePose('trueSize', false, false).foldT, 0);
});

test('reconstruction status never calls an incomplete or fatal scene exact', () => {
  assert.equal(reconstructionStatus([]), 'exact');
  assert.equal(reconstructionStatus(['coplanarity']), 'partial');
  assert.equal(reconstructionStatus(['incomplete']), 'partial');
  assert.equal(reconstructionStatus([], true), 'error');
});

test('repeated incomplete points become one useful toolbar summary', () => {
  const summary = summarizeReconstructionWarnings([
    { code: 'incomplete', message: 'A : projection manquante' },
    { code: 'incomplete', message: 'B : projection manquante' },
    { code: 'incomplete', message: 'C : projection manquante' },
  ]);
  assert.deepEqual(summary, [{
    code: 'incomplete',
    count: 3,
    label: '3 coordonnées à compléter',
    detail: 'A : projection manquante\nB : projection manquante\nC : projection manquante',
  }]);
});
