import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';

/**
 * Turn one authored plate SVG into flat line geometry + text labels, in the SVG's own viewBox
 * user space (y-down). This is what lets the 19 construction plates — the épures the geometry
 * cannot lift to 3D — be shown in the same zoomable three.js canvas as the reconstructions,
 * instead of a static, un-zoomable inline `<svg>`.
 *
 * Nothing here is a *reconstruction*: it is the authored drawing, re-expressed as segments so a
 * WebGL camera can zoom into it. The scan in the left pane stays the reference.
 *
 * Two readers, because SVGLoader ignores `<text>`:
 *  - geometry: SVGLoader parses `<line>`/`<path>` (only M/L/Z/Q appear) and BAKES every element and
 *    group transform (incl. the whole-plate `rotate(-90)` on the 18 landscape plates) into points;
 *  - labels: a throwaway offscreen mount so the browser resolves the same transforms natively via
 *    `getCTM()`, then each `<text>`'s `<tspan>` super/subscripts become `<sup>`/`<sub>`.
 * Both land in the same viewBox space, so they register 1:1 — exactly as the current inline SVG does.
 */

export interface PlateVec2 {
  x: number;
  y: number;
}
export interface PlateSeg {
  pts: PlateVec2[];
  /** Authored stroke-width in user units — bucketed to a pixel weight by the viewer. */
  width: number;
  /** Hidden / rappel line (`stroke-dasharray`). */
  dashed: boolean;
}
export interface PlateLabel {
  /** Reconstructed inner HTML: base text with `<sup>`/`<sub>` for the ᵛ/ᴴ marks and ₁/₂ indices. */
  html: string;
  x: number;
  y: number;
  /** Baked per-label rotation (the `rotate(90 cx cy)` dimension labels), degrees. */
  rotDeg: number;
}
export interface PlateScene {
  segments: PlateSeg[];
  labels: PlateLabel[];
  width: number;
  height: number;
}

const esc = (s: string) => s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));

/** `<tspan dy="-5">V</tspan>` → `<sup>V</sup>`, `dy>0` → `<sub>`. Anything else is flat text. */
function tspansToHtml(text: Element): string {
  let html = '';
  for (const node of Array.from(text.childNodes)) {
    if (node.nodeType === 3) {
      html += esc(node.textContent ?? '');
    } else if (node.nodeType === 1 && (node as Element).tagName.toLowerCase() === 'tspan') {
      const el = node as Element;
      const dy = parseFloat(el.getAttribute('dy') ?? '0');
      const inner = esc(el.textContent ?? '');
      html += dy < 0 ? `<sup>${inner}</sup>` : dy > 0 ? `<sub>${inner}</sub>` : inner;
    }
  }
  return html;
}

export function parsePlate(svg: string): PlateScene {
  // --- geometry ------------------------------------------------------------------------------
  const data = new SVGLoader().parse(svg);
  const segments: PlateSeg[] = [];
  for (const path of data.paths) {
    const style = (path.userData?.style ?? {}) as {
      stroke?: string;
      strokeWidth?: number | string;
      strokeDasharray?: string;
    };
    // A stroked element (every drawn line inherits `stroke="#111"` from its group). Pure fills —
    // the white `<rect>` background, the odd filled glyph — carry no stroke and are skipped.
    if (!style.stroke || style.stroke === 'none') continue;
    const width =
      typeof style.strokeWidth === 'number' ? style.strokeWidth : parseFloat(String(style.strokeWidth)) || 1;
    const dashed = !!style.strokeDasharray && style.strokeDasharray !== 'none';
    for (const sub of path.subPaths) {
      // 12 samples per curve: exact for the M/L segments, smooth for the few Q Béziers.
      const pts = sub.getPoints(12).map((p) => ({ x: p.x, y: p.y }));
      if (pts.length >= 2) segments.push({ pts, width, dashed });
    }
  }

  // --- labels --------------------------------------------------------------------------------
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const svgEl = doc.documentElement as unknown as SVGSVGElement;
  const vb = (svgEl.getAttribute('viewBox') ?? '0 0 720 720').trim().split(/[\s,]+/).map(Number);
  const width = vb[2] || 720;
  const height = vb[3] || 720;

  const labels: PlateLabel[] = [];
  // getCTM needs the node laid out in the document. The svg's width/height attributes equal its
  // viewBox size, so 1 user unit == 1 px and getCTM returns viewBox-space coordinates — the same
  // space the geometry is in. Mounted far offscreen and torn down immediately.
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-99999px;top:0;visibility:hidden';
  const mounted = document.importNode(svgEl, true) as unknown as SVGSVGElement;
  holder.appendChild(mounted);
  document.body.appendChild(holder);
  try {
    mounted.querySelectorAll('text').forEach((t) => {
      const html = tspansToHtml(t);
      if (!html.trim()) return;
      const x0 = parseFloat(t.getAttribute('x') ?? '0');
      const y0 = parseFloat(t.getAttribute('y') ?? '0');
      const ctm = (t as SVGGraphicsElement).getCTM();
      if (!ctm) {
        labels.push({ html, x: x0, y: y0, rotDeg: 0 });
        return;
      }
      labels.push({
        html,
        x: ctm.a * x0 + ctm.c * y0 + ctm.e,
        y: ctm.b * x0 + ctm.d * y0 + ctm.f,
        rotDeg: (Math.atan2(ctm.b, ctm.a) * 180) / Math.PI,
      });
    });
  } finally {
    document.body.removeChild(holder);
  }

  return { segments, labels, width, height };
}
