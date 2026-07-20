import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { parsePlate } from '../lib/plateScene';
import type { PlateDiagPoint } from '../lib/plateDiagnostics';

/**
 * A flat 2D plate, drawn in three.js so it can be zoomed and panned — the same canvas idea as the
 * 3D reconstructions, but for the 19 construction plates that have no 3D. It is the authored SVG
 * re-expressed as line geometry + DOM labels: no reconstruction, no reading, just a zoomable drawing.
 *
 * Orthographic + 2D pan/zoom (wheel = zoom, drag = pan, double-click = recenter). Orbiting a flat
 * plate would be meaningless, so there is none — only the "get closer to read it" the reader asked for.
 *
 * The machinery (WebGL + CSS2D label overlay, on-demand render, ResizeObserver, dispose-on-unmount)
 * mirrors EpureViewer. If the SVG can't be parsed, it falls back to the crisp inline drawing.
 */
export function EpurePlateViewer({ svg, points }: { svg: string; points?: PlateDiagPoint[] }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let parsed: ReturnType<typeof parsePlate> | null = null;
    try {
      parsed = parsePlate(svg);
    } catch {
      parsed = null;
    }
    // Nothing usable → show the authored SVG as-is rather than an empty canvas.
    if (!parsed || (!parsed.segments.length && !parsed.labels.length)) {
      const fallback = document.createElement('div');
      fallback.className = 'epure-figure-svg';
      fallback.innerHTML = svg;
      host.appendChild(fallback);
      return () => {
        if (fallback.parentNode === host) host.removeChild(fallback);
      };
    }
    const plate = parsed;

    let width = host.clientWidth || 800;
    let height = host.clientHeight || 460;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    host.appendChild(renderer.domElement);

    const labelRenderer = new CSS2DRenderer();
    labelRenderer.setSize(width, height);
    labelRenderer.domElement.className = 'epure-labels';
    host.appendChild(labelRenderer.domElement);

    const scene = new THREE.Scene();

    // SVG user space (y-down, width×height) → world (y-up, centred, ~10 units tall).
    const S = 10 / plate.height;
    const wx = (x: number) => (x - plate.width / 2) * S;
    const wy = (y: number) => -(y - plate.height / 2) * S;

    // One shared LineMaterial per (weight bucket, dashed). Line2 honours stroke width in px, which
    // plain LineBasicMaterial cannot — that hierarchy (bold figure vs thin construction) is the point.
    const materials = new Map<string, LineMaterial>();
    const bucketPx = (w: number) => (w <= 1.3 ? 1.1 : w <= 2.0 ? 1.7 : 2.6);
    const matFor = (w: number, dashed: boolean) => {
      const px = bucketPx(w);
      const key = `${px}:${dashed}`;
      let m = materials.get(key);
      if (!m) {
        m = new LineMaterial({
          color: 0x1a1a1a,
          linewidth: px,
          transparent: true,
          dashed,
          dashSize: 0.16,
          gapSize: 0.11,
        });
        m.resolution.set(width, height);
        materials.set(key, m);
      }
      return m;
    };

    for (const seg of plate.segments) {
      const pos: number[] = [];
      for (const p of seg.pts) pos.push(wx(p.x), wy(p.y), 0);
      const geo = new LineGeometry();
      geo.setPositions(pos);
      const line = new Line2(geo, matFor(seg.width, seg.dashed));
      if (seg.dashed) line.computeLineDistances();
      scene.add(line);
    }

    for (const lab of plate.labels) {
      const el = document.createElement('div');
      el.className = 'epure-plate-label';
      const inner = document.createElement('span');
      inner.innerHTML = lab.html;
      if (lab.rotDeg) {
        inner.style.display = 'inline-block';
        inner.style.transform = `rotate(${lab.rotDeg}deg)`;
      }
      el.appendChild(inner);
      const obj = new CSS2DObject(el);
      obj.center.set(0, 1); // SVG text anchors at the baseline-left, not the element centre
      obj.position.set(wx(lab.x), wy(lab.y), 0);
      scene.add(obj);
    }

    // Diagnostic points — the coordinates behind this plate's 3D fate, in red. found = solid dot,
    // unpaired = hollow ring (V/H drawn but off the rappel), missing = ✕ (a projection never drawn).
    // Shared geometries/materials, positioned per point; disposed with the scene below.
    const diagMats: THREE.Material[] = [];
    const diagGeos: THREE.BufferGeometry[] = [];
    if (points && points.length) {
      const RED = 0xd12f2f;
      const dotMat = new THREE.MeshBasicMaterial({ color: RED });
      const lineMat = new THREE.LineBasicMaterial({ color: RED });
      diagMats.push(dotMat, lineMat);
      const dotGeo = new THREE.CircleGeometry(0.12, 20);
      const ringGeo = new THREE.BufferGeometry().setFromPoints(
        Array.from({ length: 33 }, (_, i) => {
          const a = (i / 32) * Math.PI * 2;
          return new THREE.Vector3(Math.cos(a) * 0.17, Math.sin(a) * 0.17, 0);
        }),
      );
      const crossGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-0.16, -0.16, 0), new THREE.Vector3(0.16, 0.16, 0),
        new THREE.Vector3(-0.16, 0.16, 0), new THREE.Vector3(0.16, -0.16, 0),
      ]);
      diagGeos.push(dotGeo, ringGeo, crossGeo);
      for (const pt of points) {
        const at = new THREE.Vector3(wx(pt.x), wy(pt.y), 0.02); // in front of the ink
        const mark =
          pt.kind === 'found'
            ? new THREE.Mesh(dotGeo, dotMat)
            : pt.kind === 'unpaired'
              ? new THREE.LineLoop(ringGeo, lineMat)
              : new THREE.LineSegments(crossGeo, lineMat);
        mark.position.copy(at);
        scene.add(mark);
        const el = document.createElement('div');
        el.className = `epure-plate-label diag ${pt.kind}`;
        el.innerHTML = pt.label.replace(/\^([\w'′]+)/g, '<sup>$1</sup>');
        if (pt.note) el.title = pt.note;
        const obj = new CSS2DObject(el);
        obj.center.set(0, 1);
        obj.position.copy(at);
        scene.add(obj);
      }
    }

    // --- orthographic camera + 2D pan/zoom -----------------------------------------------------
    const WORLD_H = 11; // the plate is ~10 tall; a touch of margin
    let aspect = width / height;
    const camera = new THREE.OrthographicCamera(
      (-WORLD_H * aspect) / 2,
      (WORLD_H * aspect) / 2,
      WORLD_H / 2,
      -WORLD_H / 2,
      -10,
      10,
    );
    camera.position.set(0, 0, 5);

    const render = () => {
      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      camera.zoom = THREE.MathUtils.clamp(camera.zoom * Math.exp(-e.deltaY * 0.0015), 0.4, 60);
      camera.updateProjectionMatrix();
      render();
    };
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      renderer.domElement.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const perPx = WORLD_H / camera.zoom / height;
      camera.position.x -= (e.clientX - lastX) * perPx;
      camera.position.y += (e.clientY - lastY) * perPx;
      lastX = e.clientX;
      lastY = e.clientY;
      render();
    };
    const onUp = (e: PointerEvent) => {
      dragging = false;
      try {
        renderer.domElement.releasePointerCapture(e.pointerId);
      } catch {
        /* pointer already released */
      }
    };
    const onReset = () => {
      camera.zoom = 1;
      camera.position.set(0, 0, 5);
      camera.updateProjectionMatrix();
      render();
    };

    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointermove', onMove);
    renderer.domElement.addEventListener('pointerup', onUp);
    renderer.domElement.addEventListener('pointerleave', onUp);
    renderer.domElement.addEventListener('dblclick', onReset);
    host.addEventListener('wheel', onWheel, { passive: false });

    const ro = new ResizeObserver(() => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (!w || !h) return;
      width = w;
      height = h;
      aspect = w / h;
      renderer.setSize(w, h);
      labelRenderer.setSize(w, h);
      camera.left = (-WORLD_H * aspect) / 2;
      camera.right = (WORLD_H * aspect) / 2;
      camera.top = WORLD_H / 2;
      camera.bottom = -WORLD_H / 2;
      camera.updateProjectionMatrix();
      for (const m of materials.values()) m.resolution.set(w, h);
      render();
    });
    ro.observe(host);

    render();

    return () => {
      ro.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointermove', onMove);
      renderer.domElement.removeEventListener('pointerup', onUp);
      renderer.domElement.removeEventListener('pointerleave', onUp);
      renderer.domElement.removeEventListener('dblclick', onReset);
      host.removeEventListener('wheel', onWheel);
      scene.traverse((o) => {
        const g = (o as { geometry?: THREE.BufferGeometry }).geometry;
        g?.dispose();
      });
      for (const m of materials.values()) m.dispose();
      for (const m of diagMats) m.dispose();
      for (const g of diagGeos) g.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
      if (labelRenderer.domElement.parentNode === host) host.removeChild(labelRenderer.domElement);
    };
  }, [svg, points]);

  return <div ref={hostRef} className="epure-plate-viewer" />;
}
