#!/usr/bin/env node
/**
 * Authoring aid for épure IRs — NOT an extractor.
 *
 * Parses one authored SVG from figures/dessin-scientifique/ and prints what a human needs to
 * write the IR by hand: every <line>, every <path> with its vertices, and every <text> label
 * with its parsed name/view/rabattu mark plus the nearest path vertex as a SUGGESTION.
 *
 * The suggestion is deliberately not trusted: label anchors are offset from their points by
 * design, sheets hold several sub-figures, and pairing a label with a vertex is exactly the
 * judgment call that, done wrong, produces confident wrong 3D. The human confirms; this script
 * just saves the coordinate-squinting.
 *
 *   node scripts/digest-epure-svg.mjs figures/dessin-scientifique/fig01_p3.svg
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/digest-epure-svg.mjs <figNN_pP.svg>');
  process.exit(1);
}
const svg = readFileSync(file, 'utf8');

// --- geometry ---------------------------------------------------------------
const lines = [];
for (const m of svg.matchAll(/<line\s+([^>]*)\/>/g)) {
  const attr = (name) => {
    const a = m[1].match(new RegExp(`${name}="([-\\d.]+)"`));
    return a ? Number(a[1]) : NaN;
  };
  lines.push({ x1: attr('x1'), y1: attr('y1'), x2: attr('x2'), y2: attr('y2'), raw: m[0] });
}

const paths = [];
for (const m of svg.matchAll(/<path\s+d="([^"]+)"[^>]*\/>/g)) {
  const verts = [...m[1].matchAll(/[ML]\s*([-\d.]+)[\s,]+([-\d.]+)/g)].map((v) => [Number(v[1]), Number(v[2])]);
  const sw = m[0].match(/stroke-width="([-\d.]+)"/);
  paths.push({ verts, closed: /[Zz]/.test(m[1]), strokeWidth: sw ? Number(sw[1]) : null });
}

// --- labels -----------------------------------------------------------------
// <text x y>NAME<tspan dy="-5">V</tspan><tspan dy="9">R</tspan></text> — a raised tspan is the
// view (V/H), a lowered one the subscript (R = rabattu, or an index like B in M_B).
const labels = [];
for (const m of svg.matchAll(/<text\s+x="([-\d.]+)"\s+y="([-\d.]+)"[^>]*>(.*?)<\/text>/gs)) {
  const [, x, y, body] = m;
  const name = body.replace(/<tspan[^>]*>.*?<\/tspan>/gs, '').trim();
  const sup = [];
  const sub = [];
  for (const t of body.matchAll(/<tspan[^>]*dy="([-\d.]+)"[^>]*>(.*?)<\/tspan>/gs)) {
    (Number(t[1]) < 0 ? sup : sub).push(t[2].trim());
  }
  labels.push({ name, view: sup.join(''), mark: sub.join(''), anchor: [Number(x), Number(y)] });
}

const allVerts = [
  ...paths.flatMap((p) => p.verts),
  ...lines.flatMap((l) => [[l.x1, l.y1], [l.x2, l.y2]]),
];
const nearest = (pt) => {
  let best = null;
  let bd = Infinity;
  for (const v of allVerts) {
    const d = Math.hypot(v[0] - pt[0], v[1] - pt[1]);
    if (d < bd) { bd = d; best = v; }
  }
  return { vertex: best, distance: Math.round(bd) };
};

// --- report -----------------------------------------------------------------
console.log(`# ${file}\n`);
console.log('## Lines (candidates: ground line, hinge, recall)');
for (const l of lines) console.log(`  (${l.x1},${l.y1}) -> (${l.x2},${l.y2})`);
console.log('\n## Paths (candidates: projections, rabattu — stroke-width hints role: thickest = rabattu)');
for (const p of paths) {
  console.log(`  sw=${p.strokeWidth} ${p.closed ? 'closed' : 'open'}: ${p.verts.map((v) => `(${v[0]},${v[1]})`).join(' ')}`);
}
console.log('\n## Labels -> nearest vertex (SUGGESTION — verify each one)');
for (const l of labels) {
  if (!/^[A-Z]$/i.test(l.name) && !/^Ch/i.test(l.name) && !/π/.test(l.name)) continue;
  const n = nearest(l.anchor);
  console.log(
    `  ${l.name}${l.view ? '^' + l.view : ''}${l.mark ? '_' + l.mark : ''}` +
      ` anchor(${l.anchor[0]},${l.anchor[1]}) ~> vertex(${n.vertex?.[0]},${n.vertex?.[1]}) d=${n.distance}px`,
  );
}
console.log('\n## IR skeleton (fill in from the suggestions ABOVE after checking each)');
const skeleton = {
  version: 1,
  source: { book: 'dessin-scientifique', n: 0, sub: 'a', page: 0, blockId: '', caption: '' },
  units: 'px',
  imageSize: { width: 0, height: 0 },
  groundLine: { a: { x: 0, y: 0 }, b: { x: 0, y: 0 } },
  points: [{ id: 'A', v: { x: 0, y: 0 }, h: { x: 0, y: 0 } }],
  segments: [{ from: 'A', to: 'B', view: 'v' }],
  operation: {
    kind: 'rabattement_plane',
    hingeKind: 'horizontal',
    hinge: { aH: { x: 0, y: 0 }, bH: { x: 0, y: 0 } },
    planePoints: ['A', 'B', 'C'],
    rabattu: { view: 'h', points: { A: { x: 0, y: 0 } } },
  },
};
console.log(JSON.stringify(skeleton, null, 2));
