// First-person walking: keyboard + mouse (pointer lock) on desktop,
// virtual joystick (left side) + drag-to-look (right side) on touch devices.
import * as THREE from 'three';

export class Input {
  constructor(el, joy, knob) {
    this.el = el;
    this.joy = joy;
    this.knob = knob;
    this.keys = new Set();
    this.stick = { x: 0, y: 0 };
    this.look = { x: 0, y: 0 };
    this.jump = false;
    this.fire = 0; // pending throws
    this.joyId = null;
    this.lookId = null;
    this.origin = { x: 0, y: 0 };
    this.last = { x: 0, y: 0 };

    addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return; // typing in the GUI
      this.keys.add(e.code);
      if (e.code === 'Space') this.jump = true;
      if (e.code === 'KeyF' && !e.repeat) this.fire++;
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());

    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') {
        if (document.pointerLockElement !== el) el.requestPointerLock?.();
        else if (e.button === 0) this.fire++; // click throws once the mouse is captured
        return;
      }
      e.preventDefault();
      if (e.clientX < innerWidth * 0.45 && this.joyId === null) {
        this.joyId = e.pointerId;
        this.origin = { x: e.clientX, y: e.clientY };
        joy.style.left = e.clientX + 'px';
        joy.style.top = e.clientY + 'px';
        joy.classList.add('on');
        knob.style.transform = 'translate(-50%,-50%)';
      } else if (this.lookId === null) {
        this.lookId = e.pointerId;
        this.last = { x: e.clientX, y: e.clientY };
      }
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse') {
        if (document.pointerLockElement === el) {
          this.look.x += e.movementX * 0.0022;
          this.look.y += e.movementY * 0.0022;
        }
        return;
      }
      if (e.pointerId === this.joyId) {
        const R = 55;
        let dx = e.clientX - this.origin.x, dy = e.clientY - this.origin.y;
        const l = Math.hypot(dx, dy);
        if (l > R) { dx *= R / l; dy *= R / l; }
        this.stick.x = dx / R;
        this.stick.y = -dy / R;
        knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      } else if (e.pointerId === this.lookId) {
        this.look.x += (e.clientX - this.last.x) * 0.005;
        this.look.y += (e.clientY - this.last.y) * 0.005;
        this.last = { x: e.clientX, y: e.clientY };
      }
    });
    const end = (e) => {
      if (e.pointerId === this.joyId) {
        this.joyId = null;
        this.stick.x = this.stick.y = 0;
        joy.classList.remove('on');
      }
      if (e.pointerId === this.lookId) this.lookId = null;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  read() {
    const k = this.keys;
    let f = (k.has('KeyW') || k.has('ArrowUp') || k.has('KeyZ') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    let s = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') || k.has('KeyQ') ? 1 : 0);
    let mag = 1;
    if (this.joyId !== null) {
      f = this.stick.y; s = this.stick.x;
      mag = Math.min(1, Math.hypot(f, s));
    }
    const out = {
      forward: f, strafe: s, mag,
      run: k.has('ShiftLeft') || k.has('ShiftRight') || (this.joyId !== null && mag > 0.95),
      jump: this.jump,
      fire: this.fire,
      lookX: this.look.x, lookY: this.look.y,
    };
    this.look.x = this.look.y = 0;
    this.jump = false;
    this.fire = 0;
    return out;
  }
}

export class Player {
  /** spawn: { pos: [x, y, z] (feet), yaw, pitch } from the scene definition */
  constructor(colliders, { pos = [0, 0, 0], yaw = 0, pitch = 0 } = {}) {
    this.colliders = colliders;
    this.pos = new THREE.Vector3(...pos); // feet
    this.vy = 0;
    this.yaw = yaw;
    this.pitch = pitch;
    this.radius = 0.3;
    this.height = 1.75;
    this.eye = 1.62;
    this.stepH = 0.45;
    this.eyeY = this.pos.y + this.eye;
    this.onGround = false;
    this.walkSpeed = 3.6;
    this.runSpeed = 7;
    this.jumpSpeed = 5.2;
  }

  update(dt, inp, camera) {
    this.yaw -= inp.lookX;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - inp.lookY));
    const speed = (inp.run ? this.runSpeed : this.walkSpeed) * inp.mag;
    let f = inp.forward, s = inp.strafe;
    const l = Math.hypot(f, s);
    if (l > 1) { f /= l; s /= l; }
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const dx = (-sin * f + cos * s) * speed * dt;
    const dz = (-cos * f - sin * s) * speed * dt;

    // sub-step horizontal motion to avoid tunnelling
    const n = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.15));
    for (let i = 0; i < n; i++) {
      this.pos.x += dx / n;
      this.pos.z += dz / n;
      this.resolve();
    }

    if (inp.jump && this.onGround) this.vy = this.jumpSpeed;
    this.vy -= 18 * dt;
    let y = this.pos.y + this.vy * dt;
    const ground = this.groundHeight();
    const ceil = this.ceilingHeight();
    if (y + this.height > ceil && this.vy > 0) { y = ceil - this.height; this.vy = 0; }
    this.onGround = false;
    if (y <= ground) { y = ground; this.vy = 0; this.onGround = true; }
    this.pos.y = y;

    // smooth eye height over steps
    const target = this.pos.y + this.eye;
    this.eyeY = target < this.eyeY - 0.8 || target > this.eyeY + 0.8 ? target : THREE.MathUtils.damp(this.eyeY, target, 18, dt);
    camera.position.set(this.pos.x, this.eyeY, this.pos.z);
    camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  groundHeight() {
    const p = this.pos, r = this.radius * 0.6;
    let g = -100;
    for (const b of this.colliders) {
      if (p.x + r < b.min[0] || p.x - r > b.max[0] || p.z + r < b.min[2] || p.z - r > b.max[2]) continue;
      if (b.max[1] <= p.y + this.stepH && b.max[1] > g) g = b.max[1];
    }
    return g;
  }

  ceilingHeight() {
    const p = this.pos, r = this.radius * 0.6;
    let c = 1e9;
    for (const b of this.colliders) {
      if (p.x + r < b.min[0] || p.x - r > b.max[0] || p.z + r < b.min[2] || p.z - r > b.max[2]) continue;
      if (b.min[1] >= p.y + this.stepH && b.min[1] < c) c = b.min[1];
    }
    return c;
  }

  resolve() {
    const p = this.pos, r = this.radius;
    for (const b of this.colliders) {
      if (b.max[1] <= p.y + this.stepH || b.min[1] >= p.y + this.height) continue;
      const cx = Math.max(b.min[0], Math.min(p.x, b.max[0]));
      const cz = Math.max(b.min[2], Math.min(p.z, b.max[2]));
      let ex = p.x - cx, ez = p.z - cz;
      const d2 = ex * ex + ez * ez;
      if (d2 >= r * r) continue;
      if (d2 > 1e-10) {
        const d = Math.sqrt(d2);
        p.x += (ex / d) * (r - d);
        p.z += (ez / d) * (r - d);
      } else {
        // center inside the box: push along the smallest penetration
        const opts = [
          [p.x - b.min[0] + r, -1, 0], [b.max[0] - p.x + r, 1, 0],
          [p.z - b.min[2] + r, 0, -1], [b.max[2] - p.z + r, 0, 1],
        ].sort((a, c) => a[0] - c[0]);
        p.x += opts[0][1] * opts[0][0];
        p.z += opts[0][2] * opts[0][0];
      }
    }
  }
}
