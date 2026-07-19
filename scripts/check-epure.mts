#!/usr/bin/env tsx
/**
 * Fast per-file verdict for authored IRs — reconstruct each ir/*.json and print whether it holds,
 * without the all-or-nothing exit of build-epure-ir. Same gates the build uses: validate, then
 * reconstruct, then read the gold residual and coplanarity/recall warnings.
 *
 *   npx tsx scripts/check-epure.mts            # every ir/*.json
 *   npx tsx scripts/check-epure.mts fig09      # just this one
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { validateEpureIr } from '../web/src/lib/epureIr.ts';
import { reconstruct } from '../web/src/lib/epureReconstruct.ts';

const IR_DIR = path.resolve('figures/dessin-scientifique/ir');
const only = process.argv[2];
const files = readdirSync(IR_DIR)
  .filter((f) => /^fig\d+[a-z]?\.json$/.test(f) && (!only || f.startsWith(only)))
  .sort();

console.log('file       | verdict    gold        fold  warnings');
for (const file of files) {
  const raw = JSON.parse(readFileSync(path.join(IR_DIR, file), 'utf8'));
  const val = validateEpureIr(raw);
  if (!val.ok) { console.log(`${file.padEnd(10)} | INVALID   ${val.errors[0].path}: ${val.errors[0].message}`); continue; }
  const r = reconstruct(val.ir);
  // The gold check is whichever authored-vs-computed disagreement the operation carries: a
  // rabattement checks its rabattu, a change of plane its auxiliary view.
  const GOLD = new Set(['rabattu-vs-authored', 'aux-vs-authored']);
  const gold: any = r.warnings.find((w) => GOLD.has(w.code));
  const other = r.warnings.filter((w) => !GOLD.has(w.code));
  const op: any = val.ir.operation;
  const hasGold = op.rabattu !== undefined || op.auxiliary !== undefined;
  const goldStr = gold ? `FAIL ${gold.magnitudePx.toFixed(0)}px` : hasGold ? 'ok' : 'no-gold';
  const worst = Math.max(0, ...other.map((w) => w.magnitudePx ?? 0));
  const verdict = r.fatal ? 'FATAL' : gold ? 'reject' : worst < 12 ? 'PASS' : 'noisy';
  const fold = r.fold ? Math.abs((r.fold.angle * 180) / Math.PI).toFixed(0) + '°' : '-';
  console.log(
    `${file.padEnd(10)} | ${verdict.padEnd(9)} ${goldStr.padEnd(11)} ${fold.padStart(4)}  ${other.map((w) => w.code + (w.magnitudePx ? Math.round(w.magnitudePx) : '')).join(', ')}`,
  );
}
