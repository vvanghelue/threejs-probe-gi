// Procedural world: a two-storey building with colored rooms, an atrium, a windowless room
// lit only by emissive panels, small houses, a pergola, trees and a plaza.
// Everything static is merged into ONE mesh (vertex colors + per-vertex emissive) so a probe
// capture costs a single draw call per cube face.
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

class Builder {
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
  /** Horizontal slab with rectangular holes: holes [[xa, xb, za, zb]] */
  slab(x0, x1, z0, z1, y0, y1, color, holes = []) {
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
          this.box([X[i], y0, start], [X[i + 1], y1, Z[j]], color);
          start = null;
        }
      }
    }
  }
}

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mainBuilding(b) {
  const X0 = -14, X1 = 14, Z0 = -10, Z1 = 10, T = 0.4;
  const RF = 8.4;
  const up = [5.2, 7.4];
  // ground floor
  b.box([X0 + T, 0, Z0 + T], [X1 - T, 0.05, Z1 - T], C.WOOD);
  // exterior walls
  b.wall('x', X0, X1, Z0, Z0 + T, 0, RF, C.FACADE, [
    [-1.5, 1.5, 0, 3], [-12.5, -10, 1, 3], [-8, -5.5, 1, 3], [2.5, 5, 1, 3], [7.5, 10, 1, 3.2], [11, 13, 1, 3.2],
    ...[[-12.5, -10], [-8.5, -6], [-3.5, -1], [1, 3.5], [6, 8.5], [10, 12.5]].map(([a, c]) => [a, c, ...up]),
  ]);
  b.wall('x', X0, X1, Z1 - T, Z1, 0, RF, C.FACADE, [
    [9, 11, 0, 2.8], [12, 13, 1, 3], [-2, 1, 2.8, 3.7],
    ...[[-12.5, -10], [-8, -6], [-2, 1], [6, 8.5], [10, 12.5]].map(([a, c]) => [a, c, ...up]),
  ]);
  b.wall('z', Z0 + T, Z1 - T, X0, X0 + T, 0, RF, C.FACADE, [
    [-8.5, -6, 1, 3], [-4.5, -2, 1, 3], [-8, -4, ...up], [1, 5, ...up],
  ]);
  b.wall('z', Z0 + T, Z1 - T, X1 - T, X1, 0, RF, C.FACADE, [
    [-8.5, -2, 0.8, 3.2], [4, 7, 1, 3], [-7, -3, ...up], [2, 6, ...up],
  ]);

  // ground-floor partitions (0..4)
  b.partition('z', Z0 + T, 0, -4, 0, 4, C.RED, C.WHITE, [[-3, -1.5, 0, 2.7]]);
  b.partition('z', 0, Z1 - T, -4, 0, 4, C.DARK, C.WHITE);
  b.partition('x', X0 + T, -4.15, 0, 0, 4, C.RED, C.DARK, [[-6.8, -5.4, 0, 2.6]]);
  b.partition('z', Z0 + T, 1, 6, 0, 4, C.WHITE, C.GREEN, [[-6, -4.5, 0, 2.7]]);
  b.partition('z', 1, Z1 - T, 6, 0, 4, C.WHITE, C.BLUE, [[4, 5.5, 0, 2.7]]);
  b.partition('x', 6.15, X1 - T, 1, 0, 4, C.GREEN, C.BLUE, [[11, 12.2, 0, 2.7]]);

  // "glow room" (no windows): lit only by emissive panels -> pure GI
  b.box([-12, 2.9, 9.5], [-6, 3.3, 9.6], [1.0, 0.5, 0.15], { emissive: 6, solid: false });
  b.box([-13.6, 0.3, 2], [-13.5, 0.6, 8], [0.15, 0.55, 1.0], { emissive: 5, solid: false });
  b.box([-9.5, 0, 4.5], [-8.5, 0.9, 5.5], C.DARK);
  b.box([-9.2, 0.9, 4.8], [-8.8, 1.3, 5.2], [0.3, 1.0, 0.3], { emissive: 8, solid: false });

  // stairs along the north wall of the lobby
  const steps = 16, rise = 4.3 / steps, run = 0.42, sx = -3.3;
  for (let i = 0; i < steps; i++) {
    b.box([sx + i * run, 0, 7.45], [sx + (i + 1) * run, (i + 1) * rise, Z1 - T], C.WOOD);
  }
  const stairTop = sx + steps * run;

  // upper floor slab: white ceiling below, wood floor on top; holes for atrium + stairs
  const holes = [[-2, 4, -6.5, 2.5], [-3.85, stairTop, 7.4, Z1 - T]];
  b.slab(X0 + T, X1 - T, Z0 + T, Z1 - T, 4.0, 4.2, C.WHITE, holes);
  b.slab(X0 + T, X1 - T, Z0 + T, Z1 - T, 4.2, 4.3, C.WOOD, holes);

  // railings
  const rh = [4.3, 5.3];
  b.box([-2, rh[0], -6.58], [4, rh[1], -6.5], C.WHITE);
  b.box([-2, rh[0], 2.5], [4, rh[1], 2.58], C.WHITE);
  b.box([-2.08, rh[0], -6.5], [-2, rh[1], 2.5], C.WHITE);
  b.box([4, rh[0], -6.5], [4.08, rh[1], 2.5], C.WHITE);
  b.box([-3.85, rh[0], 7.32], [stairTop, rh[1], 7.4], C.WHITE);

  // upper-floor partitions (4.3..8)
  b.partition('z', Z0 + T, Z1 - T, -5, 4.3, 8, C.OCHRE, C.WHITE, [[-7, -5.5, 4.3, 6.8], [3, 4.5, 4.3, 6.8]]);
  b.partition('z', Z0 + T, Z1 - T, 9, 4.3, 8, C.WHITE, C.PURPLE, [[-5, -3, 4.3, 6.8], [3, 5, 4.3, 6.8]]);

  // roof with skylight above the atrium, parapet
  const sky = [[-2, 4, -6.5, 2.5]];
  b.slab(X0, X1, Z0, Z1, 8.0, 8.3, C.WHITE, sky);
  b.slab(X0, X1, Z0, Z1, 8.3, 8.4, C.ROOF, sky);
  b.box([X0, 8.4, Z0], [X1, 9, Z0 + 0.3], C.FACADE);
  b.box([X0, 8.4, Z1 - 0.3], [X1, 9, Z1], C.FACADE);
  b.box([X0, 8.4, Z0 + 0.3], [X0 + 0.3, 9, Z1 - 0.3], C.FACADE);
  b.box([X1 - 0.3, 8.4, Z0 + 0.3], [X1, 9, Z1 - 0.3], C.FACADE);

  // lobby props
  b.box([0, 0, -3], [2, 2.2, -1], C.WHITE); // sculpture under the skylight
  b.box([-3, 0, -8.5], [-1, 0.45, -7.9], C.WOOD);
  b.box([2.5, 0, -8.5], [4.5, 0.45, -7.9], C.WOOD);
  // red room: table + carpet
  b.box([-11, 0.05, -8], [-6, 0.07, -3], [0.75, 0.7, 0.6], { collide: false, solid: false });
  b.box([-9.5, 0, -6.2], [-7.5, 0.8, -4.8], C.WOOD);
  // green room: shelves
  b.box([12.6, 0, 1.3], [13.6, 2.2, 5], C.WOOD);
  // upper gallery props
  b.box([-11, 4.3, -1], [-8, 5.3, 1], C.WHITE);
}

function house(b, cx, cz, w, d, h, wall, inner, doorSouth = true) {
  const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2, T = 0.3;
  b.box([x0 + T, 0, z0 + T], [x1 - T, 0.05, z1 - T], C.WOOD);
  const door = [cx - 0.7, cx + 0.7, 0, 2.3];
  const wins = [[x0 + 1, x0 + 2.5, 1, 2.3], [x1 - 2.5, x1 - 1, 1, 2.3]];
  b.wall('x', x0, x1, z0, z0 + T, 0, h, wall, doorSouth ? [door, ...wins] : wins);
  b.wall('x', x0, x1, z1 - T, z1, 0, h, wall, doorSouth ? [[cx - 1, cx + 1, 1.1, 2.3]] : [door, ...wins]);
  b.wall('z', z0 + T, z1 - T, x0, x0 + T, 0, h, wall, [[cz - 1, cz + 1, 1, 2.3]]);
  b.wall('z', z0 + T, z1 - T, x1 - T, x1, 0, h, wall, [[cz - 1, cz + 1, 1, 2.3]]);
  // interior lining so interiors get their own color
  b.box([x0 + T, 0.05, z0 + T], [x1 - T, 0.1, z1 - T], inner, { collide: false, solid: false });
  b.box([x0 - 0.2, h, z0 - 0.2], [x1 + 0.2, h + 0.3, z1 + 0.2], C.ROOF);
  b.box([cx - 0.6, 0, cz + 0.5], [cx + 0.6, 0.75, cz + 1.5], C.WOOD); // table
  return { min: [x0, 0, z0], max: [x1, h + 0.3, z1] };
}

export function buildWorld() {
  const b = new Builder();

  // ground (visual plane with color noise, collider box)
  const ground = new THREE.PlaneGeometry(500, 500, 100, 100);
  ground.rotateX(-Math.PI / 2);
  {
    const g = ground.toNonIndexed();
    g.deleteAttribute('uv');
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    const rnd = mulberry32(7);
    const pos = g.attributes.position;
    for (let i = 0; i < n; i += 3) {
      const k = 0.8 + rnd() * 0.4;
      for (let j = 0; j < 3; j++) {
        const x = pos.getX(i + j), z = pos.getZ(i + j);
        const w = 0.85 + 0.15 * Math.sin(x * 0.07) * Math.cos(z * 0.05);
        col.set([C.GRASS[0] * k * w, C.GRASS[1] * k * w, C.GRASS[2] * k * w], (i + j) * 3);
      }
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aEmissive', new THREE.BufferAttribute(new Float32Array(n), 1));
    b.geoms.push(g);
  }
  b.box([-250, -2, -250], [250, 0, 250], C.GRASS, { visual: false });

  // plaza + path
  b.box([-24, 0, -32], [24, 0.03, -10], C.STONE, { solid: false });
  b.box([-3, 0, -60], [3, 0.03, -32], C.STONE, { solid: false });
  b.box([-40, 0, 10], [40, 0.03, 14], C.STONE, { solid: false });

  mainBuilding(b);

  // pergola: slatted roof -> striped shadows
  for (let x = -12; x <= 12; x += 4) {
    b.box([x - 0.2, 0, -18.2], [x + 0.2, 3.2, -17.8], C.WHITE);
    b.box([x - 0.2, 0, -22.2], [x + 0.2, 3.2, -21.8], C.WHITE);
  }
  b.box([-12.3, 3.2, -18.3], [12.3, 3.5, -17.7], C.WHITE);
  b.box([-12.3, 3.2, -22.3], [12.3, 3.5, -21.7], C.WHITE);
  for (let x = -12; x < 12; x += 0.8) b.box([x, 3.5, -22.6], [x + 0.18, 3.65, -17.4], C.WOOD, { solid: false });

  // outdoor color bleeding sculptures
  b.box([-15, 0, -29], [-11.5, 3.5, -25.5], C.RED);
  b.box([11, 0, -30], [11.6, 5, -24], C.BLUE);
  b.box([16, 0, -16], [22, 2.5, -15.4], C.YELLOW);

  // houses (each gets its own fine probe volume)
  const houses = [
    house(b, -32, -22, 8, 6, 3.4, C.WHITE, C.BLUE),
    house(b, 32, -24, 8, 6, 3.4, C.YELLOW, C.RED),
    house(b, -30, 26, 8, 6, 3.4, C.TERRACOTTA, C.WHITE, false),
    house(b, 30, 26, 8, 6, 3.4, C.WHITE, C.GREEN, false),
  ];

  // trees
  const rnd = mulberry32(42);
  const avoid = [{ min: [-18, 0, -34], max: [18, 0, 14] }, ...houses.map((h) => ({ min: [h.min[0] - 3, 0, h.min[2] - 3], max: [h.max[0] + 3, 0, h.max[2] + 3] }))];
  let placed = 0;
  for (let tries = 0; tries < 800 && placed < 90; tries++) {
    const a = rnd() * Math.PI * 2;
    const r = 20 + rnd() * 75;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (Math.abs(x) < 4 && z < -30) continue; // keep path free
    if (avoid.some((q) => x > q.min[0] && x < q.max[0] && z > q.min[2] && z < q.max[2])) continue;
    const h = 2 + rnd() * 2;
    b.box([x - 0.18, 0, z - 0.18], [x + 0.18, h, z + 0.18], C.TRUNK);
    const rad = 1.3 + rnd() * 1.2;
    const cg = new THREE.IcosahedronGeometry(rad, 0);
    cg.scale(1, 1.25, 1);
    cg.rotateY(rnd() * 6);
    cg.translate(x, h + rad * 0.8, z);
    const k = 0.7 + rnd() * 0.6;
    b.addGeom(cg, [C.LEAF[0] * k, C.LEAF[1] * k, C.LEAF[2] * k]);
    placed++;
  }

  // distant hills
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 + rnd() * 0.3;
    const r = 190 + rnd() * 60;
    const hh = 25 + rnd() * 45;
    const cg = new THREE.ConeGeometry(30 + rnd() * 30, hh, 7);
    cg.translate(Math.cos(a) * r, hh / 2 - 1, Math.sin(a) * r);
    const k = 0.7 + rnd() * 0.5;
    b.addGeom(cg, [0.14 * k, 0.2 * k, 0.1 * k]);
  }

  const geometry = mergeGeometries(b.geoms, false);
  geometry.computeBoundingSphere();
  return { geometry, colliders: b.colliders, solids: b.solids, houses };
}
