/**
 * Batch authoring AID for épure IRs — proposes a reading, then GATES it on the reconstruction's
 * own gold check (does the drawn rabattu independently match the computed true size?). It never
 * ships anything: it prints, per figure, whether an auto-read reconstructs coherently, so a human
 * knows which plates are worth authoring by hand and which need real judgment. The pairing here is
 * a heuristic; the app's verification is what decides if it held.
 *
 *   npx tsx scripts/auto-epure.mts            # scan every reconstructable candidate
 *   npx tsx scripts/auto-epure.mts 6 9 47     # only these figure numbers, print the IR JSON
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { validateEpureIr, type EpureIR } from '../web/src/lib/epureIr.ts';
import { reconstruct } from '../web/src/lib/epureReconstruct.ts';

const DIR = path.resolve('figures/dessin-scientifique');
const manifest = JSON.parse(readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
const status = JSON.parse(readFileSync(path.join(DIR, 'ir/status.json'), 'utf8'));
const argNs = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n));

type P = [number, number];
function parseSvg(svg: string) {
  const lines: { a: P; b: P }[] = [];
  for (const m of svg.matchAll(/<line\s+([^>]*)\/>/g)) {
    const at = (n: string) => { const a = m[1].match(new RegExp(`${n}="([-\\d.]+)"`)); return a ? Number(a[1]) : NaN; };
    lines.push({ a: [at('x1'), at('y1')], b: [at('x2'), at('y2')] });
  }
  const paths: { verts: P[]; closed: boolean; sw: number }[] = [];
  for (const m of svg.matchAll(/<path\s+d="([^"]+)"[^>]*\/>/g)) {
    const verts = [...m[1].matchAll(/[ML]\s*([-\d.]+)[\s,]+([-\d.]+)/g)].map((v) => [Number(v[1]), Number(v[2])] as P);
    const sw = m[0].match(/stroke-width="([-\d.]+)"/);
    paths.push({ verts, closed: /[Zz]/.test(m[1]), sw: sw ? Number(sw[1]) : 1 });
  }
  const labels: { name: string; view: string; mark: string; at: P }[] = [];
  for (const m of svg.matchAll(/<text\s+x="([-\d.]+)"\s+y="([-\d.]+)"[^>]*>(.*?)<\/text>/gs)) {
    const body = m[3];
    const name = body.replace(/<tspan[^>]*>.*?<\/tspan>/gs, '').trim();
    const sup: string[] = [], sub: string[] = [];
    for (const t of body.matchAll(/<tspan[^>]*dy="([-\d.]+)"[^>]*>(.*?)<\/tspan>/gs)) (Number(t[1]) < 0 ? sup : sub).push(t[2].trim());
    labels.push({ name, view: sup.join(''), mark: sub.join(''), at: [Number(m[1]), Number(m[2])] });
  }
  return { lines, paths, labels };
}

function build(n: number): { ir: EpureIR | null; note: string } {
  const man = manifest.find((m: any) => m.n === n);
  const fig = status.figures.find((f: any) => f.n === n);
  if (!man || !fig || fig.opKind !== 'rabattement_plane') return { ir: null, note: 'not a rabattement candidate' };
  const svgFile = readdirSync(DIR).find((f) => new RegExp(`^fig${String(n).padStart(2, '0')}_`).test(f) && f.endsWith('.svg'));
  if (!svgFile) return { ir: null, note: 'no svg' };
  const svg = readFileSync(path.join(DIR, svgFile), 'utf8');
  const vb = (svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/) || []).slice(1).map(Number);
  const { lines, paths, labels } = parseSvg(svg);

  const verts: P[] = [...paths.flatMap((p) => p.verts), ...lines.flatMap((l) => [l.a, l.b])];
  const snap = (pt: P): P => verts.reduce((best, v) => (Math.hypot(v[0] - pt[0], v[1] - pt[1]) < Math.hypot(best[0] - pt[0], best[1] - pt[1]) ? v : best), verts[0]);

  // Point labels: single uppercase letter, view V or H, mark empty (position) or R (rabattu).
  const pt = (l: any) => /^[A-Z]$/.test(l.name) && (l.view === 'V' || l.view === 'H');
  const idsV: Record<string, P> = {}, idsH: Record<string, P> = {}, rab: Record<string, { p: P; view: string }> = {};
  for (const l of labels) {
    if (!pt(l)) continue;
    const pos = snap(l.at);
    if (l.mark.includes('R')) rab[l.name] = { p: pos, view: l.view.toLowerCase() };
    else if (l.view === 'V') idsV[l.name] = pos; else idsH[l.name] = pos;
  }
  const bothIds = Object.keys(idsV).filter((id) => id in idsH);
  if (bothIds.length < 3) return { ir: null, note: `only ${bothIds.length} points have both V+H projections (need >=3)` };

  // Ground line: the long, near-horizontal line lying in the y-band between the V cluster (above)
  // and the H cluster (below).
  const vY = bothIds.map((id) => idsV[id][1]), hY = bothIds.map((id) => idsH[id][1]);
  const band = [Math.max(...vY), Math.min(...hY)];
  const horiz = lines.filter((l) => Math.abs(l.a[1] - l.b[1]) < 30 && Math.hypot(l.b[0] - l.a[0], l.b[1] - l.a[1]) > (vb[0] || 700) * 0.4);
  const gl = horiz.filter((l) => (l.a[1] + l.b[1]) / 2 >= band[0] - 40 && (l.a[1] + l.b[1]) / 2 <= band[1] + 40)
    .sort((a, b) => Math.hypot(b.b[0] - b.a[0], b.b[1] - b.a[1]) - Math.hypot(a.b[0] - a.a[0], a.b[1] - a.a[1]))[0] || horiz[0];
  if (!gl) return { ir: null, note: 'no ground line found' };
  const gy = Math.round((gl.a[1] + gl.b[1]) / 2);

  // Hinge: line nearest the Ch label; kind from Ch's view (V=frontal, H=horizontal).
  const chL = labels.find((l) => /^ch$/i.test(l.name));
  const hingeKind = chL?.view === 'V' ? 'frontal' : 'horizontal';
  const rabViews = new Set(Object.values(rab).map((r) => r.view));
  const rabView = rabViews.size === 1 ? [...rabViews][0] : hingeKind === 'frontal' ? 'v' : 'h';
  const planePoints = bothIds.filter((id) => id in rab);
  if (planePoints.length < 3) return { ir: null, note: `only ${planePoints.length} plane points carry a rabattu` };

  // Hinge line = the line whose midpoint is closest to the Ch label anchor (fallback: nearest to any rabattu).
  const target = chL?.at ?? rab[planePoints[0]].p;
  const hingeLine = [...lines].sort((a, b) =>
    Math.hypot((a.a[0] + a.b[0]) / 2 - target[0], (a.a[1] + a.b[1]) / 2 - target[1]) -
    Math.hypot((b.a[0] + b.b[0]) / 2 - target[0], (b.a[1] + b.b[1]) / 2 - target[1]))[0];
  const hinge: any = {};
  if (hingeKind === 'frontal') { hinge.aV = { x: hingeLine.a[0], y: hingeLine.a[1] }; hinge.bV = { x: hingeLine.b[0], y: hingeLine.b[1] }; }
  else { hinge.aH = { x: hingeLine.a[0], y: hingeLine.a[1] }; hinge.bH = { x: hingeLine.b[0], y: hingeLine.b[1] }; }

  const ir: any = {
    version: 1, units: 'px',
    source: { book: 'dessin-scientifique', n, page: man.page, blockId: man.blockId, caption: (status.figures.find((f: any) => f.n === n)?.note) || '' },
    imageSize: { width: vb[0] || 720, height: vb[1] || 720 },
    groundLine: { a: { x: Math.round(gl.a[0]), y: gy }, b: { x: Math.round(gl.b[0]), y: gy } },
    points: bothIds.map((id) => ({ id, v: { x: idsV[id][0], y: idsV[id][1] }, h: { x: idsH[id][0], y: idsH[id][1] }, role: 'vertex' })),
    segments: [],
    operation: {
      kind: 'rabattement_plane', hingeKind, hinge, planePoints,
      rabattu: { view: rabView, points: Object.fromEntries(planePoints.map((id) => [id, { x: rab[id].p[0], y: rab[id].p[1] }])) },
    },
  };
  return { ir, note: `${planePoints.length} plane pts, hinge ${hingeKind}, rabattu ${rabView}` };
}

const targets = argNs.length ? argNs : status.figures.filter((f: any) => f.opKind === 'rabattement_plane' && !f.authored.length).map((f: any) => f.n);
console.log('n   | status');
for (const n of targets) {
  const { ir, note } = build(n);
  if (!ir) { console.log(`${String(n).padEnd(3)} | SKIP  — ${note}`); continue; }
  const val = validateEpureIr(ir);
  if (!val.ok) { console.log(`${String(n).padEnd(3)} | INVALID — ${val.errors[0].path}: ${val.errors[0].message}`); continue; }
  const r = reconstruct(val.ir);
  const gold: any = r.warnings.find((w) => w.code === 'rabattu-vs-authored');
  const other = r.warnings.filter((w) => w.code !== 'rabattu-vs-authored');
  const goldStr = gold ? `GOLD-FAIL ${gold.magnitudePx.toFixed(0)}px` : 'gold-ok';
  const verdict = r.fatal ? 'FATAL' : gold ? 'reject' : other.every((w) => (w.magnitudePx ?? 0) < 12) ? 'CANDIDATE' : 'noisy';
  console.log(`${String(n).padEnd(3)} | ${verdict.padEnd(9)} ${goldStr.padEnd(14)} fold ${(r.fold ? Math.abs(r.fold.angle * 180 / Math.PI).toFixed(0) : '-').padStart(3)}  warn[${other.map((w) => w.code + (w.magnitudePx ? Math.round(w.magnitudePx) : '')).join(',')}]  (${note})`);
  if (argNs.length) console.log(JSON.stringify(ir, null, 0));
}
