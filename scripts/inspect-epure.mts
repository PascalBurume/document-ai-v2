#!/usr/bin/env tsx
/**
 * Authoring aid: dump one authored épure SVG as organised primitives, so a human can read a
 * rabattement IR off it without eyeballing raw XML. It DECIDES NOTHING — it classifies lines by
 * geometry (long-horizontal = ground/hinge candidates, near-vertical dashed = recall lines,
 * dash "16 9" = rabattu leaders), lists polygon paths by stroke weight, and parses every label
 * into { name, view, mark, pos }. The IR is still authored by hand and gated by reconstruct().
 *
 *   npx tsx scripts/inspect-epure.mts 9
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('figures/dessin-scientifique');
const n = Number(process.argv[2]);
if (!Number.isFinite(n)) { console.error('usage: inspect-epure.mts <figNumber>'); process.exit(1); }

const svgFile = readdirSync(DIR).find((f) => new RegExp(`^fig${String(n).padStart(2, '0')}_`).test(f) && f.endsWith('.svg'));
if (!svgFile) { console.error(`no svg for fig ${n}`); process.exit(1); }
const svg = readFileSync(path.join(DIR, svgFile), 'utf8');
const vb = (svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/) || []).slice(1).map(Number);

type P = [number, number];
const rnd = (x: number) => Math.round(x);

interface Line { a: P; b: P; sw: number; dash: string | null; comment: string | null }
const lines: Line[] = [];
// pair each <line> with the nearest preceding <!-- comment --> on its own or previous lines
const withComments = svg.replace(/<!--(.*?)-->/gs, (_, c) => `${c.trim()}`);
for (const m of withComments.matchAll(/<line\s+([^>]*?)\/>/g)) {
  const attrs = m[1];
  const at = (k: string) => { const a = attrs.match(new RegExp(`${k}="([-\\d.]+)"`)); return a ? Number(a[1]) : NaN; };
  const dash = attrs.match(/stroke-dasharray="([^"]+)"/);
  const before = withComments.slice(0, m.index).match(/([^]+)[^]*$/);
  lines.push({ a: [at('x1'), at('y1')], b: [at('x2'), at('y2')], sw: at('stroke-width') || 1, dash: dash ? dash[1] : null, comment: before ? before[1] : null });
}

interface Path { verts: P[]; closed: boolean; sw: number; dash: string | null; comment: string | null }
const paths: Path[] = [];
for (const m of withComments.matchAll(/<path\s+d="([^"]+)"([^>]*)\/>/g)) {
  const verts = [...m[1].matchAll(/[ML]\s*([-\d.]+)[\s,]+([-\d.]+)/g)].map((v) => [Number(v[1]), Number(v[2])] as P);
  const sw = m[2].match(/stroke-width="([-\d.]+)"/);
  const dash = m[2].match(/stroke-dasharray="([^"]+)"/);
  const before = withComments.slice(0, m.index).match(/([^]+)[^]*$/);
  paths.push({ verts, closed: /[Zz]/.test(m[1]), sw: sw ? Number(sw[1]) : 1, dash: dash ? dash[1] : null, comment: before ? before[1] : null });
}

interface Label { name: string; view: string; mark: string; pos: P }
const labels: Label[] = [];
for (const m of svg.matchAll(/<text\s+x="([-\d.]+)"\s+y="([-\d.]+)"[^>]*>(.*?)<\/text>/gs)) {
  const body = m[3];
  const name = body.replace(/<tspan[^>]*>.*?<\/tspan>/gs, '').trim();
  const sup: string[] = [], sub: string[] = [];
  for (const t of body.matchAll(/<tspan[^>]*dy="([-\d.]+)"[^>]*>(.*?)<\/tspan>/gs)) (Number(t[1]) < 0 ? sup : sub).push(t[2].trim());
  labels.push({ name, view: sup.join(''), mark: sub.join(''), pos: [Number(m[1]), Number(m[2])] });
}

const len = (l: { a: P; b: P }) => Math.hypot(l.b[0] - l.a[0], l.b[1] - l.a[1]);
const near = (l: { a: P; b: P }) => Math.abs(l.a[1] - l.b[1]) < Math.abs(l.b[0] - l.a[0]) ? 'horiz' : 'vert';
const W = vb[0] || 720;

console.log(`\n=== fig ${n}  (${svgFile})  viewBox ${vb.join(' x ')} ===\n`);

console.log('LONG near-horizontal lines (ground line / oblique hinges / plane traces):');
for (const l of lines.filter((l) => near(l) === 'horiz' && len(l) > W * 0.35))
  console.log(`  (${rnd(l.a[0])},${rnd(l.a[1])})-(${rnd(l.b[0])},${rnd(l.b[1])})  sw${l.sw}${l.dash ? ' dash' + l.dash : ''}  ${l.comment ? '// ' + l.comment : ''}`);

console.log('\nRECALL / rappel lines (short, near-vertical — V↔H of one point):');
for (const l of lines.filter((l) => near(l) === 'vert' && len(l) < W * 0.9))
  console.log(`  (${rnd(l.a[0])},${rnd(l.a[1])})-(${rnd(l.b[0])},${rnd(l.b[1])})  sw${l.sw}${l.dash ? ' dash' + l.dash : ''}  ${l.comment ? '// ' + l.comment : ''}`);

console.log('\nPOLYGON paths (thick = projections; per vertex):');
for (const p of paths.filter((p) => p.sw >= 1.8))
  console.log(`  [${p.verts.map((v) => `${rnd(v[0])},${rnd(v[1])}`).join('  ')}]${p.closed ? ' Z' : ''}  sw${p.sw}  ${p.comment ? '// ' + p.comment : ''}`);

console.log('\nRABATTU leaders (dash "16 9") and other thin paths/lines:');
for (const p of paths.filter((p) => p.sw < 1.8))
  console.log(`  path [${p.verts.map((v) => `${rnd(v[0])},${rnd(v[1])}`).join(' ')}]  sw${p.sw}${p.dash ? ' dash' + p.dash : ''}  ${p.comment ? '// ' + p.comment : ''}`);
for (const l of lines.filter((l) => l.dash && near(l) === 'horiz' && len(l) <= W * 0.35))
  console.log(`  line (${rnd(l.a[0])},${rnd(l.a[1])})-(${rnd(l.b[0])},${rnd(l.b[1])}) sw${l.sw} dash${l.dash} ${l.comment ? '// ' + l.comment : ''}`);

console.log('\nLABELS  name^view_mark  @pos:');
for (const l of labels.sort((a, b) => a.pos[1] - b.pos[1]))
  console.log(`  ${(l.name + (l.view ? '^' + l.view : '') + (l.mark ? '_' + l.mark : '')).padEnd(10)} @(${rnd(l.pos[0])},${rnd(l.pos[1])})`);
console.log('');
