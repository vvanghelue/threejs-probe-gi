// "Cloister": a Sponza-like open-air courtyard ringed by two-storey arcaded galleries.
// - the sun only reaches the courtyard and the gallery floors through the arches; colored drapes,
//   floor tiles and dado bands bleed their color into the shaded galleries,
// - a tall covered hall off the north gallery never gets direct sun: it is lit by bounce light from
//   the galleries (three doorways + sill openings) and by north-facing clerestory windows,
// - a crypt under the hall, reached by a stair that turns a corner, is lit only by emissive
//   candles, stained panels and a brazier.
// Axes: +x east, +z north. The ring is described per side ('N','S','E','W') with u = coordinate
// along the side and d = distance from the centre, so the four sides share one code path.
import * as THREE from 'three';
import { Builder, C, mulberry32, noisyGround, hills } from '../scene.js';

const K = {
  CREAM: [0.78, 0.72, 0.6],
  PLASTER: [0.88, 0.85, 0.78],
  SANDSTONE: [0.68, 0.58, 0.44],
  TILE_A: [0.8, 0.74, 0.62],
  TILE_B: [0.62, 0.25, 0.11],
  EARTH: [0.3, 0.3, 0.13],
  CRYPT: [0.42, 0.39, 0.35],
  CRYPT_FLOOR: [0.25, 0.23, 0.21],
  WATER: [0.08, 0.22, 0.32],
  CYPRESS: [0.06, 0.17, 0.05],
  OLIVE: [0.24, 0.3, 0.16],
};
// drape / dado colours per side. N and W face the default sun (sun from +x/-z)
const SIDE = {
  N: { drape: [0.75, 0.06, 0.04], band: C.RED },
  W: { drape: [0.08, 0.2, 0.78], band: C.BLUE },
  E: { drape: [0.1, 0.55, 0.15], band: C.GREEN },
  S: { drape: [0.88, 0.56, 0.1], band: C.OCHRE },
};

// ring layout
const R = 14; // outer extent of the cloister (walls 13.4..14)
const IN = 13.4; // inner face of the outer walls
const A0 = 8.6, A1 = 9.4; // arcade wall (courtyard face at 8.6)
const L1 = 4.5, F2 = 4.8; // upper floor slab bottom / top
const RF = 8.5; // roof slab bottom
const PIERS = [-9, -5.4, -1.8, 1.8, 5.4, 9];
const ARCHES = PIERS.slice(0, -1).map((p, i) => [p + 0.4, PIERS[i + 1] - 0.4]);
// hall + crypt (north, outside the ring)
const HX = 8, HZ0 = 14, HZ1 = 26, HH = 9;
const CRYPT_Y = -4.5;
const STAIR_HOLE = [-7.4, -5.6, 16.4, 23.2]; // hall floor opening above the crypt stair
const REF = [-20, 1.6, -30]; // auto-exposure reference: open field south-west of the gate

/** map (u along the side, d from the centre) to world boxes for side s */
function sideBox(b, s, u0, u1, d0, d1, y0, y1, color, opts) {
  if (s === 'N') b.box([u0, y0, d0], [u1, y1, d1], color, opts);
  else if (s === 'S') b.box([u0, y0, -d1], [u1, y1, -d0], color, opts);
  else if (s === 'E') b.box([d0, y0, u0], [d1, y1, u1], color, opts);
  else b.box([-d1, y0, u0], [-d0, y1, u1], color, opts);
}
function sideWall(b, s, u0, u1, d0, d1, y0, y1, color, openings) {
  if (s === 'N') b.wall('x', u0, u1, d0, d1, y0, y1, color, openings);
  else if (s === 'S') b.wall('x', u0, u1, -d1, -d0, y0, y1, color, openings);
  else if (s === 'E') b.wall('z', u0, u1, d0, d1, y0, y1, color, openings);
  else b.wall('z', u0, u1, -d1, -d0, y0, y1, color, openings);
}
/** stepped "arch": rectangle + two narrower steps on top */
const arch = ([a, c], y0, y1) => [[a, c, y0, y1], [a + 0.35, c - 0.35, y1, y1 + 0.35], [a + 0.8, c - 0.8, y1 + 0.35, y1 + 0.6]];

function cloister(b) {
  for (const s of ['N', 'S', 'E', 'W']) {
    // N/S walls own the corners, E/W walls fit between them
    const ns = s === 'N' || s === 'S';
    // arcade: ground-floor arches, upper arches above a solid parapet, string course, cornice
    sideWall(b, s, ns ? -A1 : -A0, ns ? A1 : A0, A0, A1, 0, L1, K.SANDSTONE, ARCHES.flatMap((a) => arch(a, 0, 3.2)));
    sideWall(b, s, ns ? -A1 : -A0, ns ? A1 : A0, A0, A1, F2, RF, K.SANDSTONE, ARCHES.flatMap((a) => arch(a, 5.8, 7.3)));
    sideBox(b, s, -A1 + (ns ? 0 : 0.8), A1 - (ns ? 0 : 0.8), A0 - 0.12, A0, L1, F2, K.CREAM);
    // outer wall: south gate, three arched doorways into the hall, small upper windows
    const gate = [[-2.4, 2.4, 0, 3.6], [-1.8, 1.8, 3.6, 4.1]];
    const door = s === 'S' ? gate : s === 'N' ? [ARCHES[1], ARCHES[2], ARCHES[3]].flatMap((a) => arch(a, 0, 3.2)) : [];
    const wins = (s === 'N' ? [-10.8, 10.8] : [-7.2, 0, 7.2]).map((u) => [u - 0.6, u + 0.6, 6.0, 7.6]);
    // north: sill-height openings from the upper gallery into the hall (sun can't reach them directly)
    if (s === 'N') for (const u of [-3.6, 0, 3.6]) wins.push([u - 1.1, u + 1.1, 5.8, 7.8]);
    sideWall(b, s, ns ? -R : -IN, ns ? R : IN, IN, R, 0, RF, C.FACADE, [...door, ...wins]);
    // saturated dado band on the gallery side of the outer wall
    sideWall(b, s, ns ? -IN : -IN + 0.08, ns ? IN : IN - 0.08, IN - 0.08, IN, 0.05, 1.3, SIDE[s].band, door);
    // drapes hanging in front of the arches either side of the centre (4 strips -> folds)
    for (const [a, c] of [ARCHES[1], ARCHES[3]]) {
      const w = (c - a - 0.3) / 4;
      for (let k = 0; k < 4; k++) {
        const u = a + 0.15 + k * w, off = k % 2 ? 0.07 : 0;
        const shade = k % 2 ? 0.85 : 1;
        sideBox(b, s, u, u + w, A0 - 0.2 + off, A0 - 0.13 + off, 0.9, 5.7, SIDE[s].drape.map((v) => v * shade));
      }
    }
  }

  // ground-floor gallery floor, courtyard checker tiles
  b.slab(-IN, IN, -IN, IN, 0, 0.05, K.CREAM, [[-A0, A0, -A0, A0]], { solid: false });
  const n = 10, t = (2 * A0) / n;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      b.box([-A0 + i * t, 0, -A0 + j * t], [-A0 + (i + 1) * t, 0.05, -A0 + (j + 1) * t], (i + j) % 2 ? K.TILE_B : K.TILE_A, { solid: false });

  // stair to the upper gallery, along the west outer wall (18 steps, north-bound)
  const steps = 18, rise = F2 / steps, run = 0.4, sz = -4, sx0 = -IN, sx1 = -11.6;
  for (let i = 0; i < steps; i++) b.box([sx0, 0, sz + i * run], [sx1, (i + 1) * rise, sz + (i + 1) * run], K.SANDSTONE);
  const hole = [sx0, sx1, -2, sz + steps * run];

  // upper floor: cream ceiling, terracotta floor; roof slab with eaves over the courtyard
  b.slab(-IN, IN, -IN, IN, L1, 4.7, K.CREAM, [[-A0, A0, -A0, A0], hole]);
  b.slab(-IN, IN, -IN, IN, 4.7, F2, C.TERRACOTTA, [[-A0, A0, -A0, A0], hole]);
  b.box([sx1, F2, -2], [sx1 + 0.1, F2 + 1, hole[3]], C.WOOD); // railings around the stair opening
  b.box([sx0, F2, -2.1], [sx1 + 0.1, F2 + 1, -2], C.WOOD);
  b.slab(-R, R, -R, R, RF, 8.75, K.CREAM, [[-8.2, 8.2, -8.2, 8.2]]);
  b.slab(-R, R, -R, R, 8.75, 8.9, C.TERRACOTTA, [[-8.2, 8.2, -8.2, 8.2]]);
  // outer parapet
  b.box([-R, 8.9, -R], [R, 9.4, -R + 0.3], C.FACADE);
  b.box([-R, 8.9, R - 0.3], [R, 9.4, R], C.FACADE);
  b.box([-R, 8.9, -R + 0.3], [-R + 0.3, 9.4, R - 0.3], C.FACADE);
  b.box([R - 0.3, 8.9, -R + 0.3], [R, 9.4, R - 0.3], C.FACADE);

  // courtyard: fountain + four raised lawns
  b.box([-1.8, 0, -1.8], [1.8, 0.6, -1.5], K.CREAM);
  b.box([-1.8, 0, 1.5], [1.8, 0.6, 1.8], K.CREAM);
  b.box([-1.8, 0, -1.5], [-1.5, 0.6, 1.5], K.CREAM);
  b.box([1.5, 0, -1.5], [1.8, 0.6, 1.5], K.CREAM);
  b.box([-1.5, 0, -1.5], [1.5, 0.42, 1.5], K.WATER);
  b.box([-0.2, 0.42, -0.2], [0.2, 1.6, 0.2], K.CREAM);
  b.box([-0.6, 1.6, -0.6], [0.6, 1.8, 0.6], K.CREAM);
  for (const x of [-4.8, 4.8]) for (const z of [-4.8, 4.8]) b.box([x - 1.7, 0, z - 1.7], [x + 1.7, 0.3, z + 1.7], C.GRASS);
  // benches in the galleries
  for (const s of ['E', 'S']) for (const u of [-7.2, 7.2]) sideBox(b, s, u - 1, u + 1, IN - 0.6, IN - 0.1, 0, 0.45, C.WOOD);
}

function hallAndCrypt(b) {
  const T = 0.6, X = HX - T, Z1 = HZ1 - T;
  // hall walls go down to the crypt floor; the cloister's north wall is the hall's south wall.
  // East/west walls are double-skinned: the back-face sun shadow map then stores the outer skin,
  // well in front of the interior, which removes the light-leak lines at floor/corner seams.
  for (const sx of [-1, 1]) {
    b.wall('z', HZ0, Z1, sx > 0 ? X : -X - 0.2, sx > 0 ? X + 0.2 : -X, CRYPT_Y - 0.5, HH, K.PLASTER);
    b.wall('z', HZ0, Z1, sx > 0 ? HX - 0.2 : -HX, sx > 0 ? HX : -HX + 0.2, CRYPT_Y - 0.5, HH, K.PLASTER);
    b.box([sx > 0 ? X + 0.2 : -HX + 0.2, CRYPT_Y - 0.5, HZ0], [sx > 0 ? HX - 0.2 : -X - 0.2, HH, Z1], K.PLASTER, { visual: false, collide: false }); // no probes in the gap
  }
  // north clerestory: the sun always stays south (z <= 0) at any time of day, so these only ever
  // let in sky light, never a direct sun beam
  b.wall('x', -HX, HX, Z1, HZ1, CRYPT_Y - 0.5, HH, K.PLASTER, [-5, 0, 5].map((u) => [u - 1.3, u + 1.3, 5.0, 8.5]));
  b.box([-HX, RF, IN], [HX, HH + 0.3, R], K.PLASTER); // gable above the gallery roof
  b.slab(-HX, HX, HZ0, HZ1, HH, HH + 0.3, K.PLASTER);
  b.slab(-HX, HX, HZ0, HZ1, HH + 0.3, HH + 0.45, C.TERRACOTTA);

  // hall floor (= crypt ceiling) with the stair opening
  b.slab(-X, X, HZ0, Z1, -0.05, 0.05, K.CREAM, [STAIR_HOLE]);
  b.slab(-X, X, 15, Z1, -0.5, -0.05, K.CRYPT, [STAIR_HOLE]);
  b.box([-1.2, 0.05, HZ0], [1.2, 0.07, 23.6], C.RED, { collide: false, solid: false }); // carpet
  // columns, pews, dais + altar, golden reredos, tapestries
  for (const x of [-4, 4]) for (const z of [17.3, 20.3, 23.3]) b.box([x - 0.4, 0, z - 0.4], [x + 0.4, HH, z + 0.4], K.SANDSTONE);
  for (let z = 16.5; z < 23; z += 1.5) {
    b.box([-3.2, 0, z], [-1.6, 0.5, z + 0.5], C.WOOD);
    b.box([1.6, 0, z], [3.2, 0.5, z + 0.5], C.WOOD);
  }
  b.box([-3.5, 0, 23.6], [3.5, 0.45, Z1], K.SANDSTONE);
  b.box([-1.5, 0.45, 24.1], [1.5, 1.4, 25], K.PLASTER);
  b.box([-2.5, 1.6, Z1 - 0.1], [2.5, 4.6, Z1], C.YELLOW);
  b.box([-X, 3, 17], [-X + 0.08, 7.5, 24], C.PURPLE, { collide: false, solid: false });
  b.box([X - 0.08, 3, 17], [X, 7.5, 24], C.GREEN, { collide: false, solid: false });
  // railing around the stair opening
  b.box([STAIR_HOLE[1], 0.05, STAIR_HOLE[2]], [STAIR_HOLE[1] + 0.12, 1.05, STAIR_HOLE[3] + 0.12], C.WOOD);
  b.box([-X, 0.05, STAIR_HOLE[3]], [STAIR_HOLE[1], 1.05, STAIR_HOLE[3] + 0.12], C.WOOD);

  // crypt: floor, south wall, stair (north-bound, turns into the room around a partition)
  b.box([-X, CRYPT_Y - 0.5, 15.6], [X, CRYPT_Y, Z1], K.CRYPT_FLOOR);
  b.box([-HX, CRYPT_Y - 0.5, 15], [HX, -0.5, 15.6], K.CRYPT);
  const steps = 16, rise = -CRYPT_Y / steps, run = 0.42, sz = STAIR_HOLE[2];
  for (let i = 0; i < steps; i++) b.box([-X, CRYPT_Y, sz + i * run], [STAIR_HOLE[1], -(i + 1) * rise, sz + (i + 1) * run], K.CRYPT);
  b.box([-X, CRYPT_Y, 15.6], [STAIR_HOLE[1], -0.5, sz], K.CRYPT); // fill the pocket behind the first step
  const stairEnd = sz + (steps - 1) * run;
  b.box([STAIR_HOLE[1], CRYPT_Y, 15.6], [STAIR_HOLE[1] + 0.2, -0.5, stairEnd], K.CRYPT); // light lock
  for (const x of [-2, 4]) for (const z of [18.6, 21.2, 23.8]) b.box([x - 0.3, CRYPT_Y, z - 0.3], [x + 0.3, -0.5, z + 0.3], K.CRYPT);

  // emissive light sources (large enough to be seen by the 16² probe cubemaps)
  const WARM = [1.0, 0.55, 0.2], COOL = [0.25, 0.6, 1.0], EMBER = [1.0, 0.25, 0.08];
  for (const x of [-3, 1, 5]) { // hanging lanterns (omni, so no SH ringing on the wall behind)
    b.box([x - 0.03, -1.3, 24.77], [x + 0.03, -0.5, 24.83], C.DARK, { collide: false, solid: false });
    b.box([x - 0.22, -1.75, 24.58], [x + 0.22, -1.3, 25.02], COOL, { emissive: 2.5, solid: false });
  }
  b.box([5.8, CRYPT_Y, 20], [7.0, -3.5, 23], C.DARK); // altar
  b.box([6.0, -3.5, 20.6], [6.8, -3.2, 22.4], WARM, { emissive: 2.5, solid: false }); // candle bank
  for (const z of [17.4, 24.6]) b.box([X - 0.1, -2.6, z - 0.6], [X, -2.2, z + 0.6], WARM, { emissive: 2, solid: false }); // wall niches
  b.box([0.7, CRYPT_Y, 21.2], [1.3, -3.9, 21.8], C.DARK); // brazier pedestal
  const ember = new THREE.IcosahedronGeometry(0.4, 1);
  ember.translate(1, -3.55, 21.5);
  b.addGeom(ember, EMBER, 3);
}

function build() {
  const b = new Builder();
  // ground: plane minus the stairwell cells, invisible collider slab with the crypt cut out
  noisyGround(b, K.EARTH, { size: 400, segments: 100, seed: 11, holes: [[-HX, HX, 16, 24]] } /* 4 m cells */);
  b.slab(-200, 200, -200, 200, -2, 0, K.EARTH, [[-HX, HX, 15, HZ1]], { visual: false });
  b.box([-2, 0, -60], [2, 0.03, -R], C.STONE, { solid: false }); // path to the gate

  cloister(b);
  hallAndCrypt(b);

  // cypress avenue along the path + scattered olive trees
  const rnd = mulberry32(5);
  const cypress = (x, z, h) => {
    b.box([x - 0.15, 0, z - 0.15], [x + 0.15, 1.2, z + 0.15], C.TRUNK);
    const g = new THREE.ConeGeometry(0.9 + rnd() * 0.3, h, 7);
    g.translate(x, 1 + h / 2, z);
    b.addGeom(g, K.CYPRESS.map((v) => v * (0.8 + rnd() * 0.4)));
  };
  for (let z = -20; z > -60; z -= 6) { cypress(-4.5, z, 7 + rnd() * 2); cypress(4.5, z, 7 + rnd() * 2); }
  let placed = 0;
  for (let tries = 0; tries < 600 && placed < 45; tries++) {
    const a = rnd() * Math.PI * 2, r = 24 + rnd() * 60;
    const x = Math.cos(a) * r, z = Math.sin(a) * r + 6;
    if (Math.abs(x) < 8 && z < -14) continue; // avenue
    if (Math.abs(x) < 19 && z > -19 && z < 33) continue; // buildings
    if (Math.hypot(x - REF[0], z - REF[2]) < 10) continue; // keep the exposure reference in open air
    if (rnd() < 0.35) { cypress(x, z, 6 + rnd() * 4); placed++; continue; }
    const h = 1.2 + rnd();
    b.box([x - 0.2, 0, z - 0.2], [x + 0.2, h, z + 0.2], C.TRUNK);
    const rad = 1.6 + rnd();
    const g = new THREE.IcosahedronGeometry(rad, 0);
    g.scale(1.3, 0.8, 1.3);
    g.rotateY(rnd() * 6);
    g.translate(x, h + rad * 0.5, z);
    b.addGeom(g, K.OLIVE.map((v) => v * (0.8 + rnd() * 0.4)));
    placed++;
  }
  hills(b, rnd, { color: [0.22, 0.22, 0.12] });

  return { geometry: b.finish(), colliders: b.colliders, solids: b.solids };
}

export default {
  id: 'cloister',
  name: 'Cloister',
  build,
  // coarse global + the whole two-storey ring + hall and crypt in one column (volumes blend in xz
  // only, so the crypt can't have its own volume under the hall)
  volumes: (fs, Q) => {
    const p = fs + 0.2;
    return [
      ['global', [-42, 0.5, -42], [42, 12.5, 42], Q.coarse],
      ['cloister', [-R - p, 0.5, -R - p], [R + p, 8.3, R + p], [fs, fs, fs]],
      ['hall+crypt', [-HX - p, CRYPT_Y + 0.3, HZ0 - p], [HX + p, HH - 0.4, HZ1 + p], [fs, fs, fs]],
    ];
  },
  spawn: { pos: [0, 0, -10.4], yaw: Math.PI, pitch: 0.08 }, // just inside the south gate, facing the courtyard
  refPoint: REF,
  shadow: { radius: 52, center: [0, 0, 0] },
  fog: { near: 90, far: 450 },
  defaultTimeOfDay: 0.3,
  dynamic: [
    { path: (t) => new THREE.Vector3(0, 1.3, 11 + Math.sin(t * 0.3) * 8), r: 0.6 }, // courtyard -> gallery -> hall
    { path: (t) => new THREE.Vector3(-10.5, 6.1, Math.sin(t * 0.4) * 10), r: 0.45 }, // upper west gallery
    { path: (t) => new THREE.Vector3(11.4, 1.0 + Math.abs(Math.sin(t * 1.6)) * 0.6, Math.sin(t * 0.35) * 11), r: 0.45 }, // east gallery
    { path: (t) => new THREE.Vector3(1 + Math.cos(t * 0.5) * 2, -3.2, 21.5 + Math.sin(t * 0.5) * 2), r: 0.45 }, // crypt, around the brazier
  ],
};
