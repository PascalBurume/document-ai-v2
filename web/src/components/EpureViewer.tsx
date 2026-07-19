import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { EpureScene } from '../lib/epureScene';
import { rotateAboutAxis, type Vec3 } from '../lib/epureMath';

/** Which of the épure's readings are on screen. */
export interface EpureLayers {
  spatial: boolean;
  v: boolean;
  h: boolean;
  projectors: boolean;
  hinge: boolean;
  rabattu: boolean;
  section: boolean;
  aux: boolean;
  labels: boolean;
}

export const ALL_LAYERS: EpureLayers = {
  spatial: true,
  v: true,
  h: true,
  projectors: true,
  hinge: true,
  rabattu: true,
  section: true,
  aux: true,
  labels: true,
};

/** `planche` = the printed sheet, square-on; `espace` = the opening view, free to orbit from. */
export type EpureView = 'espace' | 'planche';

interface Props {
  scene: EpureScene;
  /** 0 = the spatial figure, 1 = fully rabattu. Ignored when the scene has no fold. */
  foldT: number;
  /** 1 = πH horizontal (space), 0 = πH folded onto πV about the ground line (the printed épure). */
  dihedralT: number;
  /** 1 = auxiliary plane in space, 0 = swung flat onto the retained plane (the drawn auxiliary view). Ignored without a change of plane. */
  auxT: number;
  layers: EpureLayers;
  view: EpureView;
  /** Bump to re-apply the current view's home camera — a Recentrer button, without changing `view`. */
  recenter?: number;
  hoveredId: string | null;
  onHoverPoint?: (id: string | null) => void;
}

/**
 * The parametric épure renderer. Driven ENTIRELY by the scene descriptor — it has no idea which
 * figure it is showing, which is the point: written once, it serves every reconstruction. Neither
 * fold is baked into the geometry; both are recomputed from their parameter with the same
 * closed-form rotation the reconstructor used, so what the sliders show IS the math.
 *
 * It draws two different folds, and conflating them is the mistake this component exists to avoid:
 *
 *   dièdre       πH swings about the ground line. At 0 the scene lies flat and IS the épure as
 *                printed — which makes it a check: if the reading is wrong, the flat state does
 *                not match the plate.
 *   rabattement  the figure's plane swings about the charnière onto πH (or πV) to show true size.
 *
 * Rendering is on demand, never a loop: every mutator — a drag, a wheel, a fold, a hover, a resize
 * — ends in an explicit `render()`, and an idle canvas draws nothing at all. The controls are
 * hand-rolled (see below) rather than three's OrbitControls, so the mouse gets a 1:1 response with
 * no damping to settle and no frozen orbit axis to work around.
 */
export function EpureViewer({ scene, foldT, dihedralT, auxT, layers, view, recenter, hoveredId, onHoverPoint }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rigRef = useRef<{
    setFold: (t: number) => void;
    setDihedral: (t: number) => void;
    setAux: (t: number) => void;
    setLayers: (l: EpureLayers) => void;
    setHovered: (id: string | null) => void;
    setView: (v: EpureView) => void;
  } | null>(null);

  // Seed the rig from the current props without putting them in the build effect's deps — a
  // rebuild is for a new scene, not a new slider value.
  const seed = useRef({ foldT, dihedralT, auxT, layers, view, hoveredId });
  seed.current = { foldT, dihedralT, auxT, layers, view, hoveredId };
  const onHoverRef = useRef(onHoverPoint);
  onHoverRef.current = onHoverPoint;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let width = host.clientWidth || 800;
    let height = host.clientHeight || 520;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    host.appendChild(renderer.domElement);

    const labelRenderer = new CSS2DRenderer();
    labelRenderer.setSize(width, height);
    labelRenderer.domElement.className = 'epure-labels';
    host.appendChild(labelRenderer.domElement);

    const three = new THREE.Scene();

    // Ink on draughtsman's paper, like the plates themselves — the canvas is transparent and the
    // paper comes from CSS (`--epure-paper`), so there is one place it is defined. The two
    // projections are colour-coded to their planes — cool πV, warm πH — because they are the two
    // halves of the whole idea and a reader who cannot tell them apart cannot read the figure.
    const INK = 0x111111;
    const V_INK = 0x2f5d7c;
    const H_INK = 0x8a7a33;
    const TERRA = 0xb3543a;
    // The cut is its own idea — neither projection, neither plane — so it gets its own ink, a
    // green kept clear of the cool πV and warm πH so a reader never mistakes the section for a view.
    const SECTION_INK = 0x3f7d4f;
    // The auxiliary view is a THIRD projection; a violet keeps it apart from both original views.
    const AUX_INK = 0x7a4fa3;

    const materials = {
      spatial: new THREE.LineBasicMaterial({ color: INK, transparent: true }),
      projectionV: new THREE.LineBasicMaterial({ color: V_INK, transparent: true }),
      projectionH: new THREE.LineBasicMaterial({ color: H_INK, transparent: true }),
      projector: new THREE.LineDashedMaterial({ color: 0xb5b5b5, dashSize: 0.18, gapSize: 0.12, transparent: true }),
      hinge: new THREE.LineBasicMaterial({ color: TERRA, transparent: true }),
      sectionEdge: new THREE.LineBasicMaterial({ color: SECTION_INK, transparent: true }),
      projectionAux: new THREE.LineBasicMaterial({ color: AUX_INK, transparent: true }),
    };
    // `transparent` is set at construction and never flipped: toggling it forces a shader rebuild,
    // which is not something to do mid-drag.
    const dotMats: Record<string, THREE.MeshBasicMaterial> = {
      spatial: new THREE.MeshBasicMaterial({ color: INK, transparent: true }),
      v: new THREE.MeshBasicMaterial({ color: V_INK, transparent: true }),
      h: new THREE.MeshBasicMaterial({ color: H_INK, transparent: true }),
      rabattu: new THREE.MeshBasicMaterial({ color: TERRA, transparent: true }),
      aux: new THREE.MeshBasicMaterial({ color: AUX_INK, transparent: true }),
      hover: new THREE.MeshBasicMaterial({ color: 0xfa500f }),
    };
    const dotGeo = new THREE.SphereGeometry(1, 16, 12);

    const vec = (p: Vec3) => new THREE.Vector3(p.x, p.y, p.z);

    // Layer groups. Children carry absolute world coordinates and the groups sit at the origin, so
    // a group's local x-axis IS the ground line — which is exactly the dièdre's hinge. Never give
    // one a position.
    const G = {
      spatial: new THREE.Group(),
      v: new THREE.Group(),
      h: new THREE.Group(),
      projectors: new THREE.Group(),
      hinge: new THREE.Group(),
      rabattu: new THREE.Group(),
      section: new THREE.Group(),
      aux: new THREE.Group(),
    };
    // The charnière and the rabattu live ON a projection plane, so they must ride the dièdre with
    // it — but through their own frame, so that hiding πH does not also hide them.
    const foldFrame = new THREE.Group();
    foldFrame.add(G.hinge, G.rabattu);
    // The section and the auxiliary view live in space, so they stay at the root like G.spatial.
    three.add(G.spatial, G.v, G.h, G.projectors, foldFrame, G.section, G.aux);

    // Each plane is a wash of its own ink, so the warm/cool coding survives the paper: a pale tint
    // picked against white (the old #f0ead9) composites to within 2/255 of this background and
    // vanishes — the plane would be gone and only πV would still read.
    const PLANE_WASH = 0.14;
    const planeMat = (color: number) =>
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: PLANE_WASH, side: THREE.DoubleSide, depthWrite: false });
    const vPlaneMat = planeMat(V_INK);
    const hPlaneMat = planeMat(H_INK);

    const planeMesh = (min: Vec3, max: Vec3, mat: THREE.Material, horizontal: boolean) => {
      const geo = new THREE.PlaneGeometry(max.x - min.x, horizontal ? max.y - min.y : max.z - min.z);
      if (!horizontal) geo.rotateX(Math.PI / 2); // PlaneGeometry is XY; πH already IS the XY plane here (z up)
      const mesh = new THREE.Mesh(geo, mat);
      // The plane is translucent with depthWrite off, so coplanar ink underneath gets washed at
      // 45%. Tolerable in space; in the flat plate EVERY mark is coplanar with it. A few
      // thousandths further from the plate camera and it backs the ink instead of veiling it.
      // (Scene data still says the plane is at 0 — where the mesh sits is the renderer's business.)
      mesh.position.set((min.x + max.x) / 2, horizontal ? (min.y + max.y) / 2 : 0.004, horizontal ? 0.004 : (min.z + max.z) / 2);
      return mesh;
    };
    G.h.add(planeMesh(scene.planes.h.min, scene.planes.h.max, hPlaneMat, true));
    G.v.add(planeMesh(scene.planes.v.min, scene.planes.v.max, vPlaneMat, false));

    // Ground line — the spine of the épure, drawn heavier than the projections. It stays at the
    // root: it belongs to both plates, and it is the axis everything else turns about.
    {
      const geo = new THREE.BufferGeometry().setFromPoints([vec(scene.groundLine.a), vec(scene.groundLine.b)]);
      three.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color: INK })));
    }

    const SEG_GROUP: Record<string, THREE.Group> = {
      spatial: G.spatial,
      projectionV: G.v,
      projectionH: G.h,
      projector: G.projectors,
      hinge: G.hinge,
      sectionEdge: G.section,
    };
    for (const s of scene.segments) {
      const geo = new THREE.BufferGeometry().setFromPoints([vec(s.a), vec(s.b)]);
      const line = new THREE.Line(geo, materials[s.kind]);
      if (s.kind === 'projector') line.computeLineDistances();
      SEG_GROUP[s.kind].add(line);
    }

    // CSS2DRenderer's renderObject bails on the first ancestor with visible=false and hides the
    // whole subtree, so a label parented under its layer follows that layer for free.
    const allLabels: CSS2DObject[] = [];
    const label = (text: string, kind: string, at: THREE.Vector3, parent: THREE.Group) => {
      const el = document.createElement('div');
      el.className = `epure-label ${kind}`;
      el.textContent = text;
      const obj = new CSS2DObject(el);
      obj.position.copy(at);
      parent.add(obj);
      allLabels.push(obj);
      return obj;
    };

    type Pick = { id: string; which: 'spatial' | 'v' | 'h'; mesh: THREE.Mesh };
    const picks: Pick[] = [];
    const dot = (at: THREE.Vector3, kind: string, parent: THREE.Group, r = 0.09) => {
      const mesh = new THREE.Mesh(dotGeo, dotMats[kind]);
      mesh.position.copy(at);
      mesh.scale.setScalar(r);
      parent.add(mesh);
      return mesh;
    };

    const LABEL_GROUP: Record<string, THREE.Group> = { spatial: G.spatial, v: G.v, h: G.h };
    for (const p of scene.points) {
      picks.push({ id: p.id, which: 'spatial', mesh: dot(vec(p.p), 'spatial', G.spatial) });
      picks.push({ id: p.id, which: 'v', mesh: dot(vec(p.pv), 'v', G.v, 0.07) });
      picks.push({ id: p.id, which: 'h', mesh: dot(vec(p.ph), 'h', G.h, 0.07) });
    }
    for (const l of scene.labels) {
      const off = l.kind === 'spatial' ? 0.32 : 0.26;
      label(
        l.text,
        l.kind,
        vec(l.at).add(new THREE.Vector3(0, l.kind === 'h' ? off : 0, l.kind === 'h' ? 0 : off)),
        LABEL_GROUP[l.kind],
      );
    }

    // The rabattement: a rotating COPY of the plane figure, so the spatial original stays visible
    // and at t=1 the copy lies flat exactly on the rabattu positions the reconstructor computed.
    let setFold = (_t: number) => {};
    if (scene.fold) {
      const fold = scene.fold;
      const staticPos = new Map(scene.points.map((p) => [p.id, p.p]));
      const startOf = new Map<string, Vec3>([...staticPos, ...fold.moving.map((m) => [m.id, m.start] as const)]);

      const n = fold.polygon.length;
      const faceGeo = new THREE.BufferGeometry();
      faceGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((n - 2) * 9), 3));
      const face = new THREE.Mesh(
        faceGeo,
        new THREE.MeshBasicMaterial({ color: TERRA, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }),
      );
      G.rabattu.add(face);

      const edgeGeo = new THREE.BufferGeometry();
      edgeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((n + 1) * 3), 3));
      G.rabattu.add(new THREE.Line(edgeGeo, new THREE.LineBasicMaterial({ color: TERRA, transparent: true })));

      const movingIds = new Set(fold.moving.map((m) => m.id));
      const dots = new Map(fold.polygon.map((id) => [id, dot(vec(startOf.get(id)!), 'rabattu', G.rabattu, 0.07)]));
      const tags = new Map(fold.polygon.map((id) => [id, label(`${id}ᴿ`, 'rabattu', vec(startOf.get(id)!), G.rabattu)]));

      setFold = (t: number) => {
        const ang = t * fold.angle;
        const pos = new Map<string, Vec3>();
        for (const id of fold.polygon) {
          const start = startOf.get(id)!;
          pos.set(id, movingIds.has(id) ? rotateAboutAxis(start, fold.axisPoint, fold.axisDir, ang) : start);
        }
        const fp = faceGeo.getAttribute('position') as THREE.BufferAttribute;
        for (let i = 0; i < n - 2; i++) {
          for (const [slot, id] of [fold.polygon[0], fold.polygon[i + 1], fold.polygon[i + 2]].entries()) {
            const p = pos.get(id)!;
            fp.setXYZ(i * 3 + slot, p.x, p.y, p.z);
          }
        }
        fp.needsUpdate = true;
        faceGeo.computeBoundingSphere();
        const ep = edgeGeo.getAttribute('position') as THREE.BufferAttribute;
        for (const [i, id] of [...fold.polygon, fold.polygon[0]].entries()) {
          const p = pos.get(id)!;
          ep.setXYZ(i, p.x, p.y, p.z);
        }
        ep.needsUpdate = true;
        edgeGeo.computeBoundingSphere();
        for (const [id, mesh] of dots) mesh.position.copy(vec(pos.get(id)!));
        for (const [id, tag] of tags) tag.position.copy(vec(pos.get(id)!).add(new THREE.Vector3(0, 0.2, 0.2)));
        render();
      };
    }

    // The section: the cut face (a translucent fan over the section polygon) sitting inside the
    // cutting plane (a fainter wash of the same green). Static — a section has no fold — so it is
    // built once, not driven by a slider.
    if (scene.section) {
      const poly = scene.section.polygon.map((e) => e.at);
      const n = poly.length;
      if (n >= 3) {
        const fan = new Float32Array((n - 2) * 9);
        for (let i = 0; i < n - 2; i++) {
          for (const [slot, p] of [poly[0], poly[i + 1], poly[i + 2]].entries()) {
            fan[i * 9 + slot * 3] = p.x;
            fan[i * 9 + slot * 3 + 1] = p.y;
            fan[i * 9 + slot * 3 + 2] = p.z;
          }
        }
        const faceGeo = new THREE.BufferGeometry();
        faceGeo.setAttribute('position', new THREE.BufferAttribute(fan, 3));
        faceGeo.computeBoundingSphere();
        G.section.add(
          new THREE.Mesh(
            faceGeo,
            new THREE.MeshBasicMaterial({ color: SECTION_INK, transparent: true, opacity: 0.24, side: THREE.DoubleSide, depthWrite: false }),
          ),
        );
      }
      const [q0, q1, q2, q3] = scene.section.quad;
      const washGeo = new THREE.BufferGeometry();
      washGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        q0.x, q0.y, q0.z, q1.x, q1.y, q1.z, q2.x, q2.y, q2.z,
        q0.x, q0.y, q0.z, q2.x, q2.y, q2.z, q3.x, q3.y, q3.z,
      ]), 3));
      washGeo.computeBoundingSphere();
      G.section.add(
        new THREE.Mesh(
          washGeo,
          new THREE.MeshBasicMaterial({ color: SECTION_INK, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false }),
        ),
      );
    }

    // The change of plane: the auxiliary view swings about L′ as a second dièdre. At auxT=1 it is
    // the derived view in space; at auxT=0 it lies flat in the retained plane — the drawn auxiliary.
    // Recomputed from the parameter with the same rotation the reconstructor used, like the fold.
    let setAux = (_t: number) => {};
    if (scene.changePlane) {
      const cp = scene.changePlane;
      const base = new Map(cp.aux.map((e) => [e.id, e.at]));

      // L′ is fixed — the auxiliary turns about it, it does not move itself.
      G.aux.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([vec(cp.line.a), vec(cp.line.b)]), materials.projectionAux));

      const washGeo = new THREE.BufferGeometry();
      washGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6 * 3), 3));
      G.aux.add(
        new THREE.Mesh(washGeo, new THREE.MeshBasicMaterial({ color: AUX_INK, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false })),
      );

      const edgeGeo = new THREE.BufferGeometry();
      edgeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cp.edges.length * 2 * 3), 3));
      G.aux.add(new THREE.LineSegments(edgeGeo, materials.projectionAux));

      const auxDots = new Map(cp.aux.map((e) => [e.id, dot(vec(e.at), 'aux', G.aux, 0.07)]));
      const auxTags = new Map(cp.aux.map((e) => [e.id, label(`${e.id}₁`, 'aux', vec(e.at), G.aux)]));

      setAux = (t: number) => {
        const ang = cp.unfoldAngle * (1 - t);
        const pos = new Map<string, Vec3>();
        for (const e of cp.aux) pos.set(e.id, rotateAboutAxis(base.get(e.id)!, cp.axisPoint, cp.axisDir, ang));

        const ep = edgeGeo.getAttribute('position') as THREE.BufferAttribute;
        cp.edges.forEach(([a, b], i) => {
          const pa = pos.get(a)!;
          const pb = pos.get(b)!;
          ep.setXYZ(i * 2, pa.x, pa.y, pa.z);
          ep.setXYZ(i * 2 + 1, pb.x, pb.y, pb.z);
        });
        ep.needsUpdate = true;
        edgeGeo.computeBoundingSphere();

        const q = cp.quad.map((c) => rotateAboutAxis(c, cp.axisPoint, cp.axisDir, ang));
        const wp = washGeo.getAttribute('position') as THREE.BufferAttribute;
        [q[0], q[1], q[2], q[0], q[2], q[3]].forEach((p, i) => wp.setXYZ(i, p.x, p.y, p.z));
        wp.needsUpdate = true;
        washGeo.computeBoundingSphere();

        for (const [id, mesh] of auxDots) mesh.position.copy(vec(pos.get(id)!));
        for (const [id, tag] of auxTags) tag.position.copy(vec(pos.get(id)!).add(new THREE.Vector3(0, 0.2, 0.2)));
        render();
      };
    }

    // Camera: z is up (the world is the reconstructor's, no remap).
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 200);
    camera.up.set(0, 0, 1);

    // Hand-rolled orbit, in spherical coordinates about a target. Preferred over three's
    // OrbitControls here because it answers the mouse 1:1 — no damping to chase, and no orbit axis
    // frozen at construction (which is what made the flat "planche" view fragile): the plate view
    // is just a azimuth/elevation this controller can point at directly, up stays z throughout.
    //   theta  azimuth in the xy-plane      phi  angle DOWN from +z (the pole)      radius  distance
    const RADIUS = { min: 2.5, max: 70 };
    const cam = {
      target: new THREE.Vector3(0, Math.max(scene.planes.h.max.y, 4) / 2, Math.max(scene.planes.v.max.z, 2) / 3),
      theta: 0.7,
      phi: 1.13, // ~65° from the pole — a three-quarter view onto the open dihedral
      radius: 15,
    };
    const home = { theta: cam.theta, phi: cam.phi, radius: cam.radius, target: cam.target.clone() };
    const place = () => {
      const s = Math.sin(cam.phi);
      camera.position.set(
        cam.target.x + cam.radius * s * Math.cos(cam.theta),
        cam.target.y + cam.radius * s * Math.sin(cam.theta),
        cam.target.z + cam.radius * Math.cos(cam.phi),
      );
      camera.up.set(0, 0, 1);
      camera.lookAt(cam.target);
    };
    place();

    const render = () => {
      renderer.render(three, camera);
      labelRenderer.render(three, camera);
    };

    // ---- state the bridge methods share -------------------------------------------------------
    let curLayers: EpureLayers = seed.current.layers;
    let curDihedral = seed.current.dihedralT;

    const ss = THREE.MathUtils.smoothstep;
    /** How present the 3D-only content is. It has no meaning on a flat sheet. */
    const solidity = () => ss(curDihedral, 0.5, 1);

    // setDihedral and setLayers both decide visibility; they must AND, never overwrite.
    const applyVisibility = () => {
      const solid = solidity() > 0.01;
      G.spatial.visible = curLayers.spatial && solid;
      G.projectors.visible = curLayers.projectors && solid;
      G.section.visible = curLayers.section && solid; // the cut only means anything in space
      G.aux.visible = curLayers.aux && solid; // the auxiliary view is a construction in space
      G.v.visible = curLayers.v;
      G.h.visible = curLayers.h;
      G.hinge.visible = curLayers.hinge;
      G.rabattu.visible = curLayers.rabattu;
      for (const l of allLabels) l.visible = curLayers.labels;
    };

    const setDihedral = (t: number) => {
      curDihedral = t;
      // πH turns about the ground line. Its children all have z=0, so rotating by -π/2 sends each
      // H image to z = -éloignement: below the line, opposite the V images at z = +cote. The plate.
      const rot = -(1 - ss(t, 0, 0.75)) * (Math.PI / 2);
      G.h.rotation.x = rot;
      foldFrame.rotation.x = scene.fold?.onto === 'v' ? 0 : rot;

      // Fade the 3D-only content out over [0.5, 1] — ahead of the fold over [0, 0.75] — because a
      // projector ends on πH and would dangle in mid-air while the plane is in transit.
      const solid = solidity();
      materials.spatial.opacity = solid;
      dotMats.spatial.opacity = solid;
      materials.projector.opacity = solid * 0.85;
      // CSS2D labels are DOM: no material, no fade. They ride the visibility cliff in
      // applyVisibility instead, which lands while everything around them is already at ~0.
      applyVisibility();
      render();
    };

    const setLayers = (l: EpureLayers) => {
      if ((Object.keys(l) as (keyof EpureLayers)[]).every((k) => l[k] === curLayers[k])) return;
      curLayers = { ...l };
      applyVisibility();
      render();
    };

    const setView = (v: EpureView) => {
      if (v === 'planche') {
        // The sheet head-on, so a length on screen is a length on the plate. Folded, πH occupies
        // z ∈ [-h.max.y, -h.min.y], so the sheet spans that and πV's own extent.
        const h = scene.planes.h;
        const vp = scene.planes.v;
        const zLo = Math.min(vp.min.z, -h.max.y);
        const zHi = Math.max(vp.max.z, -h.min.y);
        const cz = (zLo + zHi) / 2;
        const fov = (camera.fov * Math.PI) / 180;
        const dist = (Math.max((zHi - zLo) / 2, (h.max.x - h.min.x) / 2 / camera.aspect) / Math.tan(fov / 2)) * 1.15;
        // Look along +y at the equator (phi = π/2), so screen-right is +x and screen-up +z — the
        // printed orientation. The equator is not a pole, so orbiting away from it afterwards is
        // free; the reader can nudge the flat plate without it flipping.
        cam.target.set(0, 0, cz);
        cam.theta = -Math.PI / 2;
        cam.phi = Math.PI / 2;
        cam.radius = THREE.MathUtils.clamp(dist, RADIUS.min, RADIUS.max);
      } else {
        cam.target.copy(home.target);
        cam.theta = home.theta;
        cam.phi = home.phi;
        cam.radius = home.radius;
      }
      place();
      render();
    };

    // ---- hover -------------------------------------------------------------------------------
    // Not a Raycaster: it has no threshold for meshes, so the tolerance would be the dot's world
    // radius — which SHRINKS as you zoom out, exactly when the dots are hardest to hit — and it
    // ignores `visible` on the object and every ancestor, so hidden layers would stay hoverable.
    // There are ~30 dots; project them and take the nearest in pixels.
    const HIT_PX = 14;
    const _wp = new THREE.Vector3();
    const shown = (o: THREE.Object3D | null) => {
      for (let n = o; n; n = n.parent) if (!n.visible) return false;
      return true;
    };
    const pickAt = (px: number, py: number): string | null => {
      let best: { id: string; d2: number } | null = null;
      for (const p of picks) {
        if (!shown(p.mesh)) continue;
        p.mesh.getWorldPosition(_wp).project(camera);
        if (_wp.z < -1 || _wp.z > 1) continue;
        const dx = (_wp.x * 0.5 + 0.5) * width - px;
        const dy = (-_wp.y * 0.5 + 0.5) * height - py;
        const d2 = dx * dx + dy * dy;
        if (d2 <= HIT_PX * HIT_PX && (!best || d2 < best.d2)) best = { id: p.id, d2 };
      }
      return best?.id ?? null;
    };

    let applied: string | null = null;
    const setHovered = (id: string | null) => {
      if (id === applied) return;
      applied = id;
      for (const p of picks) {
        const on = p.id === id;
        p.mesh.material = on ? dotMats.hover : dotMats[p.which];
        p.mesh.scale.setScalar((p.which === 'spatial' ? 0.09 : 0.07) * (on ? 1.7 : 1));
      }
      render();
    };

    // ---- interaction: drag orbits, right-drag pans, wheel zooms ------------------------------
    // A hand-rolled controller answering the mouse 1:1. `drag` is the held button: 0 orbit, 2 pan,
    // null idle (when the same pointermove does hover picking instead).
    let drag: number | null = null;
    let px = 0;
    let py = 0;
    const _right = new THREE.Vector3();
    const _up = new THREE.Vector3();

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 && e.button !== 2) return;
      drag = e.button;
      px = e.clientX;
      py = e.clientY;
      renderer.domElement.setPointerCapture(e.pointerId);
      e.preventDefault();
    };
    const onUp = (e: PointerEvent) => {
      if (drag === null) return;
      drag = null;
      renderer.domElement.releasePointerCapture(e.pointerId);
    };

    // Report only — the highlight comes back as the hoveredId prop, so the plate and the 3D read
    // from one source and cannot disagree.
    let reported: string | null = null;
    const report = (id: string | null) => {
      if (id === reported) return;
      reported = id;
      renderer.domElement.style.cursor = id ? 'pointer' : drag !== null ? 'grabbing' : '';
      onHoverRef.current?.(id);
    };

    const onMove = (e: PointerEvent) => {
      if (drag === null) {
        // Idle: pick the dot under the cursor.
        const r = renderer.domElement.getBoundingClientRect();
        report(pickAt(e.clientX - r.left, e.clientY - r.top));
        return;
      }
      const dx = e.clientX - px;
      const dy = e.clientY - py;
      px = e.clientX;
      py = e.clientY;
      if (drag === 0) {
        // Orbit. phi is kept off both poles so the view never gimbal-flips.
        cam.theta -= dx * 0.006;
        cam.phi = THREE.MathUtils.clamp(cam.phi - dy * 0.006, 0.05, Math.PI - 0.05);
      } else {
        // Pan the target across the screen plane, using the camera's own right/up axes so it tracks
        // the cursor whatever the orbit. Scaled by radius so the grab feels the same at any zoom.
        const m = camera.matrix.elements;
        _right.set(m[0], m[1], m[2]);
        _up.set(m[4], m[5], m[6]);
        const k = cam.radius * 0.0016;
        cam.target.addScaledVector(_right, -dx * k).addScaledVector(_up, dy * k);
      }
      place();
      render();
    };
    const onLeave = () => report(null);

    // Wheel zooms by pulling the camera in/out along radius, clamped so the figure can be neither
    // pushed through the near plane nor shrunk to a speck. `passive: false` + preventDefault so the
    // wheel drives the 3D and never scrolls the pane underneath — anywhere over the canvas box.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      cam.radius = THREE.MathUtils.clamp(cam.radius * Math.exp(e.deltaY * 0.001), RADIUS.min, RADIUS.max);
      place();
      render();
    };

    const onContext = (e: Event) => e.preventDefault(); // right-drag pans; no context menu

    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointermove', onMove);
    renderer.domElement.addEventListener('pointerup', onUp);
    renderer.domElement.addEventListener('pointerleave', onLeave);
    renderer.domElement.addEventListener('contextmenu', onContext);
    host.addEventListener('wheel', onWheel, { passive: false });

    // Orbiting is exploration; getting lost shouldn't be permanent. Double-click puts the camera
    // back where the scene opened.
    const resetView = () => setView('espace');
    renderer.domElement.addEventListener('dblclick', resetView);

    const ro = new ResizeObserver(() => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (!w || !h) return;
      width = w;
      height = h;
      renderer.setSize(w, h);
      labelRenderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      render();
    });
    ro.observe(host);

    // Seed from the props so the first painted frame is the one asked for, not a default.
    setFold(seed.current.foldT);
    setAux(seed.current.auxT);
    setDihedral(seed.current.dihedralT);
    setView(seed.current.view);
    setHovered(seed.current.hoveredId);

    rigRef.current = { setFold, setDihedral, setAux, setLayers, setHovered, setView };
    render();

    return () => {
      rigRef.current = null;
      ro.disconnect();
      renderer.domElement.removeEventListener('dblclick', resetView);
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointermove', onMove);
      renderer.domElement.removeEventListener('pointerup', onUp);
      renderer.domElement.removeEventListener('pointerleave', onLeave);
      renderer.domElement.removeEventListener('contextmenu', onContext);
      host.removeEventListener('wheel', onWheel);
      // Materials and geometries are shared across layers now, so collect before disposing.
      const mats = new Set<THREE.Material>();
      const geos = new Set<THREE.BufferGeometry>();
      three.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
          geos.add(obj.geometry);
          for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) mats.add(m);
        }
      });
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
      renderer.dispose();
      host.removeChild(renderer.domElement);
      host.removeChild(labelRenderer.domElement);
    };
  }, [scene]);

  // `scene` is in every dep list on purpose: a rebuild makes a new rig, which must be re-told.
  useEffect(() => {
    rigRef.current?.setFold(foldT);
  }, [scene, foldT]);
  useEffect(() => {
    rigRef.current?.setAux(auxT);
  }, [scene, auxT]);
  useEffect(() => {
    rigRef.current?.setDihedral(dihedralT);
  }, [scene, dihedralT]);
  useEffect(() => {
    rigRef.current?.setLayers(layers);
  }, [scene, layers]);
  useEffect(() => {
    rigRef.current?.setView(view);
  }, [scene, view, recenter]);
  useEffect(() => {
    rigRef.current?.setHovered(hoveredId);
  }, [scene, hoveredId]);

  return <div ref={hostRef} className="epure-canvas" />;
}
