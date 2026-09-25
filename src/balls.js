// Throwable balls: one InstancedMesh (layer 1 = dynamic, so they cast cascade shadows and
// receive probe GI, but are never baked into the probes), simple sphere physics against the
// AABB colliders of the world, ball-ball collisions and the animated spheres as kinematic obstacles.
import * as THREE from 'three';

const _m = new THREE.Matrix4();

export class Balls {
  constructor(scene, material, colliders, { capacity = 128, radius = 0.5 } = {}) {
    this.capacity = capacity;
    this.radius = radius;
    this.max = Math.min(64, capacity); // live limit, oldest ball is recycled beyond it
    this.speed = 14; // throw speed (m/s)
    this.gravity = 9.81;
    this.restitution = 0.55; // bounciness
    this.friction = 0.25; // tangential velocity lost per bounce
    this.rolling = 1.2; // rolling drag while resting on a surface (1/s)

    // flat collider arrays for a tight inner loop
    const n = colliders.length;
    this.boxes = new Float32Array(n * 6);
    colliders.forEach((b, i) => this.boxes.set([...b.min, ...b.max], i * 6));
    this.kinematic = []; // [{ mesh, r }] moving obstacles (animated spheres)

    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.rest = new Uint8Array(capacity);
    this.count = 0;
    this.next = 0; // ring index used once `max` is reached

    this.mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 32, 16), material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false; // instances move everywhere; bounds would go stale
    this.mesh.layers.set(1);
    scene.add(this.mesh);
  }

  /** Throw a ball from `origin` along `dir` (unit), adding `inherit` (e.g. player velocity). */
  throw(origin, dir, inherit) {
    let i;
    if (this.count < this.max) i = this.count++;
    else { i = this.next; this.next = (this.next + 1) % this.max; }
    const p = this.pos, v = this.vel, k = i * 3;
    p[k] = origin.x; p[k + 1] = origin.y; p[k + 2] = origin.z;
    v[k] = dir.x * this.speed + (inherit?.x ?? 0);
    v[k + 1] = dir.y * this.speed + (inherit?.y ?? 0) + 1.0; // slight upward lob
    v[k + 2] = dir.z * this.speed + (inherit?.z ?? 0);
    this.rest[i] = 0;
  }

  /** True if point p lies inside a collider box. */
  insideWorld(p) {
    const B = this.boxes;
    for (let b = 0; b < B.length; b += 6) {
      if (p.x > B[b] && p.x < B[b + 3] && p.y > B[b + 1] && p.y < B[b + 4] && p.z > B[b + 2] && p.z < B[b + 5]) return true;
    }
    return false;
  }

  clear() {
    this.count = 0;
    this.next = 0;
    this.mesh.count = 0;
  }

  setMax(n) {
    this.max = Math.max(1, Math.min(this.capacity, n | 0));
    if (this.count > this.max) this.count = this.max;
    this.next %= this.max;
  }

  update(dt) {
    if (!this.count) return;
    const p = this.pos, v = this.vel, r = this.radius;
    // sub-step so a fast ball never moves more than half a radius per step (no tunnelling)
    let vmax = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.rest[i]) continue;
      const k = i * 3;
      vmax = Math.max(vmax, Math.abs(v[k]) + Math.abs(v[k + 1]) + Math.abs(v[k + 2]));
    }
    const steps = Math.min(12, Math.max(1, Math.ceil((vmax * dt) / (r * 0.5))));
    const h = dt / steps;
    for (let s = 0; s < steps; s++) {
      for (let i = 0; i < this.count; i++) {
        if (this.rest[i]) continue;
        const k = i * 3;
        v[k + 1] -= this.gravity * h;
        p[k] += v[k] * h; p[k + 1] += v[k + 1] * h; p[k + 2] += v[k + 2] * h;
        const grounded = this._collideWorld(i, h);
        if (grounded) {
          const d = Math.exp(-this.rolling * h);
          v[k] *= d; v[k + 2] *= d;
          if (v[k] * v[k] + v[k + 1] * v[k + 1] + v[k + 2] * v[k + 2] < 0.004) {
            v[k] = v[k + 1] = v[k + 2] = 0;
            this.rest[i] = 1; // sleep until something hits it
          }
        }
        if (p[k + 1] < -50) { v[k] = v[k + 1] = v[k + 2] = 0; this.rest[i] = 1; }
      }
      this._collideBalls();
      this._collideKinematic();
    }

    for (let i = 0; i < this.count; i++) {
      const r = this.radius;
      _m.makeScale(r, r, r).setPosition(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Bounce off a contact with unit normal (nx,ny,nz). */
  _bounce(k, nx, ny, nz) {
    const v = this.vel;
    const vn = v[k] * nx + v[k + 1] * ny + v[k + 2] * nz;
    if (vn >= 0) return;
    // split into normal + tangential parts: reflect the first, damp the second
    const tx = v[k] - vn * nx, ty = v[k + 1] - vn * ny, tz = v[k + 2] - vn * nz;
    const e = -vn < 0.6 ? 0 : this.restitution; // small impacts don't bounce (lets balls settle)
    const f = 1 - this.friction * Math.min(1, -vn / 4);
    v[k] = tx * f - vn * e * nx;
    v[k + 1] = ty * f - vn * e * ny;
    v[k + 2] = tz * f - vn * e * nz;
  }

  _collideWorld(i) {
    const p = this.pos, B = this.boxes, r = this.radius, k = i * 3;
    let grounded = false;
    for (let b = 0; b < B.length; b += 6) {
      const x = p[k], y = p[k + 1], z = p[k + 2];
      if (x + r < B[b] || x - r > B[b + 3] || y + r < B[b + 1] || y - r > B[b + 4] || z + r < B[b + 2] || z - r > B[b + 5]) continue;
      const cx = Math.max(B[b], Math.min(x, B[b + 3]));
      const cy = Math.max(B[b + 1], Math.min(y, B[b + 4]));
      const cz = Math.max(B[b + 2], Math.min(z, B[b + 5]));
      let nx = x - cx, ny = y - cy, nz = z - cz;
      const d2 = nx * nx + ny * ny + nz * nz;
      if (d2 >= r * r) continue;
      let pen;
      if (d2 > 1e-12) {
        const d = Math.sqrt(d2);
        nx /= d; ny /= d; nz /= d;
        pen = r - d;
      } else {
        // center inside the box: exit through the closest face
        const o = [
          [x - B[b], -1, 0, 0], [B[b + 3] - x, 1, 0, 0],
          [y - B[b + 1], 0, -1, 0], [B[b + 4] - y, 0, 1, 0],
          [z - B[b + 2], 0, 0, -1], [B[b + 5] - z, 0, 0, 1],
        ].reduce((a, c) => (c[0] < a[0] ? c : a));
        [pen, nx, ny, nz] = [o[0] + r, o[1], o[2], o[3]];
      }
      p[k] += nx * pen; p[k + 1] += ny * pen; p[k + 2] += nz * pen;
      this._bounce(k, nx, ny, nz);
      if (ny > 0.7) grounded = true;
    }
    return grounded;
  }

  _collideBalls() {
    const p = this.pos, v = this.vel, r2 = this.radius * 2, e = this.restitution;
    for (let i = 0; i < this.count; i++) {
      const a = i * 3;
      for (let j = i + 1; j < this.count; j++) {
        if (this.rest[i] && this.rest[j]) continue;
        const b = j * 3;
        let nx = p[b] - p[a], ny = p[b + 1] - p[a + 1], nz = p[b + 2] - p[a + 2];
        const d2 = nx * nx + ny * ny + nz * nz;
        if (d2 >= r2 * r2 || d2 < 1e-12) continue;
        const d = Math.sqrt(d2);
        nx /= d; ny /= d; nz /= d;
        const push = (r2 - d) * 0.5;
        p[a] -= nx * push; p[a + 1] -= ny * push; p[a + 2] -= nz * push;
        p[b] += nx * push; p[b + 1] += ny * push; p[b + 2] += nz * push;
        // equal masses: exchange the normal component of the relative velocity
        const vn = (v[b] - v[a]) * nx + (v[b + 1] - v[a + 1]) * ny + (v[b + 2] - v[a + 2]) * nz;
        if (vn < 0) {
          const j0 = (-(1 + e) * vn) / 2;
          v[a] -= j0 * nx; v[a + 1] -= j0 * ny; v[a + 2] -= j0 * nz;
          v[b] += j0 * nx; v[b + 1] += j0 * ny; v[b + 2] += j0 * nz;
        }
        // only a real impact wakes a sleeping neighbour (resting piles stay asleep)
        if (vn < -0.05 || push > 0.01) this.rest[i] = this.rest[j] = 0;
      }
    }
  }

  _collideKinematic() {
    const p = this.pos;
    for (const o of this.kinematic) {
      const c = o.mesh.position, rr = o.r + this.radius;
      for (let i = 0; i < this.count; i++) {
        const k = i * 3;
        let nx = p[k] - c.x, ny = p[k + 1] - c.y, nz = p[k + 2] - c.z;
        const d2 = nx * nx + ny * ny + nz * nz;
        if (d2 >= rr * rr || d2 < 1e-12) continue;
        const d = Math.sqrt(d2);
        nx /= d; ny /= d; nz /= d;
        p[k] += nx * (rr - d); p[k + 1] += ny * (rr - d); p[k + 2] += nz * (rr - d);
        this.rest[i] = 0;
        this._bounce(k, nx, ny, nz);
      }
    }
  }
}
