// Shared procedural world builder used by every scene in src/scenes/.
// Everything static is merged into ONE mesh (vertex colors + per-vertex emissive) so a probe
// capture costs a single draw call per cube face.
//
// A scene module default-exports a plain definition:
//   { id, name, build() -> { geometry, colliders, solids, ... },
//     volumes(fineSpacing, Q, world) -> [[name, min, max, spacing], ...]  (first = coarse global),
//     spawn: { pos, yaw, pitch }, refPoint (open sunlit air, auto-exposure reference),
//     shadow: { radius, center } (static sun map, must cover the probes), fog: { near, far },
//     dynamic: [{ path: (t) => Vector3, r }], defaultTimeOfDay }
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const C = {
  WHITE: [0.8, 0.78, 0.74],
  FACADE: [0.72, 0.68, 0.6],
  RED: [0.7, 0.07, 0.04],
  GREEN: [0.1, 0.5, 0.12],
  BLUE: [0.07, 0.18, 0.7],
  OCHRE: [0.75, 0.48, 0.12],
  PURPLE: [0.35, 0.18, 0.55],
  DARK: [0.2, 0.2, 0.22],
  WOOD: [0.42, 0.26, 0.13],
  STONE: [0.5, 0.47, 0.43],
  GRASS: [0.16, 0.3, 0.07],
  ROOF: [0.35, 0.33, 0.32],
  TERRACOTTA: [0.6, 0.24, 0.1],
  YELLOW: [0.8, 0.62, 0.25],
  TRUNK: [0.22, 0.13, 0.07],
  LEAF: [0.1, 0.28, 0.05],
};

export class Builder {
  constructor() {
    this.geoms = [];
    this.colliders = []; // walking collision
    this.solids = []; // probe relocation
  }
  addGeom(geo, color, emissive = 0) {
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (g.attributes.uv) g.deleteAttribute('uv');
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    const em = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      col[i * 3] = color[0]; col[i * 3 + 1] = color[1]; col[i * 3 + 2] = color[2];
      em[i] = emissive;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aEmissive', new THREE.BufferAttribute(em, 1));
    this.geoms.push(g);
  }
  box(min, max, color, { collide = true, solid = true, emissive = 0, visual = true } = {}) {
    const sx = max[0] - min[0], sy = max[1] - min[1], sz = max[2] - min[2];
    if (sx <= 1e-4 || sy <= 1e-4 || sz <= 1e-4) return;
    if (visual) {
      const g = new THREE.BoxGeometry(sx, sy, sz);
      g.translate((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
      this.addGeom(g, color, emissive);
    }
    const b = { min: [...min], max: [...max] };
    if (collide) this.colliders.push(b);
    if (solid) this.solids.push(b);
  }
  /**
   * Axis-aligned wall with rectangular openings.
   * axis 'x': runs along X from u0..u1, thickness t0..t1 in Z. axis 'z': runs along Z, thickness in X.
   * openings: [[ua, ub, ya, yb], ...]
   */
  wall(axis, u0, u1, t0, t1, y0, y1, color, openings = []) {
    const us = new Set([u0, u1]);
    const vs = new Set([y0, y1]);
    for (const [a, b, c, d] of openings) {
      us.add(Math.max(u0, Math.min(u1, a))); us.add(Math.max(u0, Math.min(u1, b)));
      vs.add(Math.max(y0, Math.min(y1, c))); vs.add(Math.max(y0, Math.min(y1, d)));
    }
    const U = [...us].sort((a, b) => a - b);
    const V = [...vs].sort((a, b) => a - b);
    for (let i = 0; i < U.length - 1; i++) {
      const cu = (U[i] + U[i + 1]) / 2;
      let start = null;
      for (let j = 0; j <= V.length - 1; j++) {
        const inWall = j < V.length - 1 && !openings.some(([a, b, c, d]) => {
          const cv = (V[j] + V[j + 1]) / 2;
          return cu > a && cu < b && cv > c && cv < d;
        });
        if (inWall && start === null) start = V[j];
        if (!inWall && start !== null) {
          const ya = start, yb = V[j];
          if (axis === 'x') this.box([U[i], ya, t0], [U[i + 1], yb, t1], color);
          else this.box([t0, ya, U[i]], [t1, yb, U[i + 1]], color);
          start = null;
        }
      }
    }
  }
  /** Two-tone partition: colorA on the low side of t, colorB on the high side. */
  partition(axis, u0, u1, t, y0, y1, colorA, colorB, openings = [], th = 0.15) {
    this.wall(axis, u0, u1, t - th, t, y0, y1, colorA, openings);
    this.wall(axis, u0, u1, t, t + th, y0, y1, colorB, openings);
  }
  /** Horizontal slab with rectangular holes: holes [[xa, xb, za, zb]]; opts as for box() */
  slab(x0, x1, z0, z1, y0, y1, color, holes = [], opts) {
    const xs = new Set([x0, x1]);
    const zs = new Set([z0, z1]);
    for (const [a, b, c, d] of holes) { xs.add(a); xs.add(b); zs.add(c); zs.add(d); }
    const X = [...xs].filter((v) => v >= x0 && v <= x1).sort((a, b) => a - b);
    const Z = [...zs].filter((v) => v >= z0 && v <= z1).sort((a, b) => a - b);
    for (let i = 0; i < X.length - 1; i++) {
      const cx = (X[i] + X[i + 1]) / 2;
      let start = null;
      for (let j = 0; j <= Z.length - 1; j++) {
        const inSlab = j < Z.length - 1 && !holes.some(([a, b, c, d]) => {
          const cz = (Z[j] + Z[j + 1]) / 2;
          return cx > a && cx < b && cz > c && cz < d;
        });
        if (inSlab && start === null) start = Z[j];
        if (!inSlab && start !== null) {
          this.box([X[i], y0, start], [X[i + 1], y1, Z[j]], color, opts);
          start = null;
        }
      }
    }
  }
  /** Merge everything into the single static geometry. */
  finish() {
    const geometry = mergeGeometries(this.geoms, false);
    geometry.computeBoundingSphere();
    return geometry;
  }
}

export function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Visual ground plane (size² m) with per-triangle color noise; add the collider separately.
 * holes: [[xa, xb, za, zb]] drops the triangles whose centroid falls inside (e.g. over a stairwell).
 */
export function noisyGround(b, color, { size = 500, segments = 100, seed = 7, holes = [] } = {}) {
  const ground = new THREE.PlaneGeometry(size, size, segments, segments);
  ground.rotateX(-Math.PI / 2);
  let g = ground.toNonIndexed();
  g.deleteAttribute('uv');
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  const rnd = mulberry32(seed);
  const pos = g.attributes.position;
  const keep = [];
  for (let i = 0; i < n; i += 3) {
    const k = 0.8 + rnd() * 0.4;
    for (let j = 0; j < 3; j++) {
      const x = pos.getX(i + j), z = pos.getZ(i + j);
      const w = 0.85 + 0.15 * Math.sin(x * 0.07) * Math.cos(z * 0.05);
      col.set([color[0] * k * w, color[1] * k * w, color[2] * k * w], (i + j) * 3);
    }
    const cx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3, cz = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
    if (!holes.some(([a, c, d, e]) => cx > a && cx < c && cz > d && cz < e)) keep.push(i);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (keep.length * 3 < n) {
    // compact the kept triangles
    const P = new Float32Array(keep.length * 9), N = new Float32Array(keep.length * 9), K = new Float32Array(keep.length * 9);
    const src = [g.attributes.position.array, g.attributes.normal.array, col];
    keep.forEach((i, t) => [P, N, K].forEach((dst, s) => dst.set(src[s].subarray(i * 3, i * 3 + 9), t * 9)));
    g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    g.setAttribute('color', new THREE.BufferAttribute(K, 3));
  }
  g.setAttribute('aEmissive', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count), 1));
  b.geoms.push(g);
}

/** Ring of distant low-poly hills (visual only). */
export function hills(b, rnd, { count = 16, r0 = 190, r1 = 250, color = [0.14, 0.2, 0.1] } = {}) {
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rnd() * 0.3;
    const r = r0 + rnd() * (r1 - r0);
    const hh = 25 + rnd() * 45;
    const cg = new THREE.ConeGeometry(30 + rnd() * 30, hh, 7);
    cg.translate(Math.cos(a) * r, hh / 2 - 1, Math.sin(a) * r);
    const k = 0.7 + rnd() * 0.5;
    b.addGeom(cg, [color[0] * k, color[1] * k, color[2] * k]);
  }
}
