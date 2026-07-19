/**
 * The exact-geometry substrate for épure reconstruction. Pure functions over plain vectors —
 * no three.js, no DOM — so the same code runs in the app, in node tests, and in any future
 * batch/eval harness.
 *
 * World frame (right-handed): X along the ground line, Y = depth (éloignement, the H-projection
 * side), Z = height (cote, the V-projection side). πH is z=0, πV is y=0, the ground line their
 * intersection. Pixel space is y-DOWN; the frame absorbs that once, here, so nothing downstream
 * ever thinks about screen coordinates again.
 */

import type { Vec2 } from './epureIr';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
export const add = (a: Vec3, b: Vec3): Vec3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: Vec3, b: Vec3): Vec3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a: Vec3, k: number): Vec3 => v3(a.x * k, a.y * k, a.z * k);
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: Vec3, b: Vec3): Vec3 =>
  v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const norm = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const normalize = (a: Vec3): Vec3 => scale(a, 1 / norm(a));
export const dist = (a: Vec3, b: Vec3): number => norm(sub(a, b));

/**
 * The épure's 2D frame, calibrated once from the ground line. `ex` runs along the line; `nDown`
 * is the screen-down normal (pixels grow down), so `s(p)` is positive BELOW the line — which is
 * the H-projection side. The drawing may be tilted; this is where the tilt dies.
 */
export interface Frame {
  origin: Vec2;
  ex: Vec2;
  nDown: Vec2;
}

export function calibrateFrame(gl: { a: Vec2; b: Vec2 }): Frame {
  const dx = gl.b.x - gl.a.x;
  const dy = gl.b.y - gl.a.y;
  const len = Math.hypot(dx, dy);
  const ex = { x: dx / len, y: dy / len };
  return { origin: gl.a, ex, nDown: { x: -ex.y, y: ex.x } };
}

/** Abscissa along the ground line. */
export const u = (f: Frame, p: Vec2): number => (p.x - f.origin.x) * f.ex.x + (p.y - f.origin.y) * f.ex.y;
/** Signed offset from the ground line; positive below it on screen (the H side). */
export const s = (f: Frame, p: Vec2): number => (p.x - f.origin.x) * f.nDown.x + (p.y - f.origin.y) * f.nDown.y;

/** Where a 3D point's V-projection falls on the sheet: abscissa x, height z above the line. */
export function toPixelV(f: Frame, p: Vec3): Vec2 {
  return {
    x: f.origin.x + p.x * f.ex.x - p.z * f.nDown.x,
    y: f.origin.y + p.x * f.ex.y - p.z * f.nDown.y,
  };
}

/** Where a 3D point's H-projection falls on the sheet: abscissa x, depth y below the line. */
export function toPixelH(f: Frame, p: Vec3): Vec2 {
  return {
    x: f.origin.x + p.x * f.ex.x + p.y * f.nDown.x,
    y: f.origin.y + p.x * f.ex.y + p.y * f.nDown.y,
  };
}

/** Rodrigues rotation of `v` about unit axis `k` by `ang` radians. */
export function rodrigues(v: Vec3, k: Vec3, ang: number): Vec3 {
  const c = Math.cos(ang);
  const si = Math.sin(ang);
  const kxv = cross(k, v);
  const kdv = dot(k, v);
  return add(add(scale(v, c), scale(kxv, si)), scale(k, kdv * (1 - c)));
}

/** Rotate point `p` about the line through `axisPoint` with unit direction `axisDir`. */
export function rotateAboutAxis(p: Vec3, axisPoint: Vec3, axisDir: Vec3, ang: number): Vec3 {
  return add(rodrigues(sub(p, axisPoint), axisDir, ang), axisPoint);
}
