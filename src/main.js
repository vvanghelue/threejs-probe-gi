import * as THREE from 'three';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import Stats from 'three/addons/libs/stats.module.js';
import { ProbeGI } from './gi.js';
import { SunShadows } from './sun.js';
import { SSAO } from './ao.js';
import { buildWorld } from './scene.js';
import { Input, Player } from './controls.js';
import { Balls } from './balls.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const isMobile = matchMedia('(pointer: coarse)').matches || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
const PRESETS = {
  // cascades: [radius m, resolution] near -> far, re-rendered every frame around the camera
  low: { ao: 6, fine: 2.0, coarse: [8, 4, 8], bounces: 2, cascades: [[8, 1024], [35, 1024]], staticRes: 2048, dpr: 1, aa: false },
  medium: { ao: 8, fine: 1.5, coarse: [6, 4, 6], bounces: 2, cascades: [[7, 2048], [22, 2048], [70, 2048]], staticRes: 2048, dpr: 1.5, aa: true },
  high: { ao: 12, fine: 1.0, coarse: [5, 3, 5], bounces: 3, cascades: [[6, 2048], [20, 2048], [65, 2048]], staticRes: 4096, dpr: 2, aa: true },
};
const qName = PRESETS[params.get('quality')] ? params.get('quality') : isMobile ? 'low' : 'medium';
const Q = PRESETS[qName];
// live-tweakable settings (lil-gui); GI-affecting ones trigger a re-bake
const cfg = {
  timeOfDay: 0.3,
  sunIntensity: 3.4,
  bounces: Q.bounces,
  exposure: 0.65,
  // auto exposure: target = clamp((refLum / eyeLum) ^ strength, min, max), eased at `speed`
  aeStrength: 0.55,
  aeMin: 0.6,
  aeMax: 6,
  aeSpeed: 2.5,
  aeInterval: 8, // frames between luminance measurements
  animate: true,
  animSpeed: 1,
  pixelRatio: Math.min(devicePixelRatio, Q.dpr),
};
$('quality').value = qName;

// ---------------------------------------------------------------- renderer
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: Q.aa, powerPreference: 'high-performance' });
renderer.setPixelRatio(cfg.pixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(isMobile ? 75 : 70, innerWidth / innerHeight, 0.05, 1200);
camera.layers.enable(1);
camera.layers.enable(2);

// ---------------------------------------------------------------- GI
const gi = new ProbeGI(renderer, scene);

// ---------------------------------------------------------------- sky
const skyUniforms = {
  sunDir: { value: new THREE.Vector3() },
  sunCol: { value: new THREE.Color() },
  zenith: { value: new THREE.Color() },
  horizon: { value: new THREE.Color() },
  giCapture: gi.uniforms.giCapture,
};
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(500, 32, 16),
  new THREE.ShaderMaterial({
    uniforms: skyUniforms,
    side: THREE.BackSide,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 sunDir, sunCol, zenith, horizon;
      uniform float giCapture;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 col = h > 0.0 ? mix(horizon, zenith, pow(h, 0.45)) : mix(horizon, horizon * 0.35, pow(min(-h * 4.0, 1.0), 0.6));
        float sd = max(dot(d, sunDir), 0.0);
        col += sunCol * (pow(sd, 6.0) * 0.25 + pow(sd, 64.0) * 0.6);
        if (giCapture < 0.5) col += sunCol * smoothstep(0.9994, 0.9997, sd) * 60.0;
        gl_FragColor = vec4(col, giCapture > 0.5 ? 40.0 : 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  }),
);
sky.renderOrder = -1;
sky.frustumCulled = false;
scene.add(sky);

// cascaded sun shadows (near cascades follow the camera, static wide map for bake + far)
const sun = new SunShadows(renderer, scene, {
  near: Q.cascades.map(([radius, res]) => ({ radius, res })),
  stat: { radius: 80, res: Q.staticRes, center: [0, 0, 0] },
});
sun.onBeforeShadow = () => (sky.visible = false);
sun.onAfterShadow = () => (sky.visible = true);

// half-res SSAO (depth pre-pass -> AO -> 4x4 bilateral blur), applied to indirect light
const ao = new SSAO(renderer, scene, { samples: Q.ao });
ao.onBeforeDepth = () => (sky.visible = false);
ao.onAfterDepth = () => (sky.visible = true);
if (params.get('ao') === 'debug') ao.uniforms.aoDebug.value = 1;

function setTimeOfDay(t) {
  const el = Math.sin(t * Math.PI) * THREE.MathUtils.degToRad(58) + THREE.MathUtils.degToRad(3);
  const az = t * Math.PI;
  const dir = new THREE.Vector3(Math.cos(az) * Math.cos(el), Math.sin(el), -Math.sin(az) * Math.cos(el)).normalize();
  const hi = THREE.MathUtils.smoothstep(Math.sin(el), 0.0, 0.5);
  const sunCol = new THREE.Color(1.0, 0.45, 0.2).lerp(new THREE.Color(1.0, 0.93, 0.85), hi);
  sun.setSun(dir, sunCol, cfg.sunIntensity * THREE.MathUtils.smoothstep(Math.sin(el), 0.0, 0.12));
  skyUniforms.sunDir.value.copy(dir);
  skyUniforms.sunCol.value.copy(sunCol);
  skyUniforms.zenith.value.setRGB(0.08, 0.2, 0.6).lerp(new THREE.Color(0.18, 0.4, 0.95), hi).multiplyScalar(1.4);
  skyUniforms.horizon.value.setRGB(0.9, 0.5, 0.3).lerp(new THREE.Color(0.62, 0.72, 0.9), hi);
  scene.fog.color.copy(skyUniforms.horizon.value);
}
scene.fog = new THREE.Fog(0x9fb4d0, 120, 520);

// ---------------------------------------------------------------- world
const world = buildWorld();
// GI + sun injection into built-in materials
function patch(mat, opts) {
  gi.patchMaterial(mat, opts);
  const giHook = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => { giHook(sh, r); sun.inject(sh); ao.inject(sh); };
  return mat;
}
const staticMat = patch(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 }), { emissiveAttr: true });
const staticMesh = new THREE.Mesh(world.geometry, staticMat);
staticMesh.frustumCulled = false;
scene.add(staticMesh);

// probe volumes: coarse global fallback + fine local volumes around interiors
const fs = Q.fine;
gi.addVolume('global', [-66, 0.5, -66], [66, 12.5, 66], Q.coarse);
gi.addVolume('building', [-14 - 2 * fs - 0.2, 0.75, -10 - 2 * fs - 0.2], [14 + 2 * fs + 0.2, 9.6, 10 + 2 * fs + 0.2], [fs, fs, fs]);
world.houses.forEach((h, i) =>
  gi.addVolume(`house${i}`, [h.min[0] - 2 * fs, 0.75, h.min[2] - 2 * fs], [h.max[0] + 2 * fs, 3.8, h.max[2] + 2 * fs], [fs, fs, fs]),
);
gi.build(world.solids);

// dynamic objects: receive GI from the probe volume (not baked, layer 1)
const dynMat = patch(new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.35, metalness: 0 }), { specular: true });
const dyn = [
  { path: (t) => new THREE.Vector3(Math.sin(t * 0.25) * 2, 1.2, -14 + Math.cos(t * 0.25) * 11), r: 0.6 }, // plaza <-> lobby
  { path: (t) => new THREE.Vector3(-9 + Math.sin(t * 0.7) * 3, 1.4 + Math.sin(t * 1.3) * 0.4, -3 + Math.cos(t * 0.7) * 0.8), r: 0.45 }, // red room -> glow room door
  { path: (t) => new THREE.Vector3(-9 + Math.cos(t * 0.5) * 2.5, 1.5, 6 + Math.sin(t * 0.5) * 2), r: 0.4 }, // glow room
  { path: (t) => new THREE.Vector3(1 + Math.cos(t * 0.4) * 2.2, 5.2 + Math.sin(t * 0.8) * 2, -2 + Math.sin(t * 0.4) * 3), r: 0.5 }, // atrium
].map((d) => {
  const m = new THREE.Mesh(new THREE.SphereGeometry(d.r, 32, 16), dynMat);
  m.layers.set(1);
  scene.add(m);
  return { ...d, mesh: m };
});

// throwable white balls (dynamic layer: cast shadows, receive GI, never baked)
const ballMat = patch(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, metalness: 0 }), { specular: true });
const balls = new Balls(scene, ballMat, world.colliders);
balls.kinematic = dyn.map((d) => ({ mesh: d.mesh, r: d.r }));
const throwDir = new THREE.Vector3();
const throwOrigin = new THREE.Vector3();
const playerVel = new THREE.Vector3();
const lastPlayerPos = new THREE.Vector3();
function throwBall() {
  camera.getWorldDirection(throwDir);
  // start just clear of the camera, but pull back if that would put the centre inside a wall
  let d = 0.15 + balls.radius;
  for (; d > 0; d -= 0.05) {
    throwOrigin.copy(camera.position).addScaledVector(throwDir, d);
    throwOrigin.y -= 0.08;
    if (!balls.insideWorld(throwOrigin)) break;
  }
  balls.throw(throwOrigin, throwDir, playerVel);
}

// debug probes
const probes = gi.createDebugMesh(0.1);
probes.layers.set(2);
probes.visible = false;
scene.add(probes);

const meter = gi.createMeter();
const REF_POINT = new THREE.Vector3(0, 1.6, -40); // outdoor reference for auto exposure

// ---------------------------------------------------------------- UI / state
const state = { gi: true, bakeStart: 0, bakeMs: 0, firstBakeDone: false, autoExposure: true, refLum: null, exposure: 1 };
const input = new Input(canvas, $('joy'), $('knob'));
const player = new Player(world.colliders);

const updateStats = () => ($('stats').textContent = `${gi.count} probes · ${gi.volumes.length} volumes · ${cfg.bounces} bounces · ${qName}`);
updateStats();
// shared toggles: HUD buttons and GUI checkboxes both go through these accessors
const toggles = {
  get gi() { return state.gi; }, set gi(v) { state.gi = v; syncButtons(); },
  get shadows() { return sun.enabled; }, set shadows(v) { sun.setEnabled(v); syncButtons(); },
  get ao() { return ao.enabled; }, set ao(v) { ao.setEnabled(v); syncButtons(); },
  get probes() { return probes.visible; }, set probes(v) { probes.visible = v; syncButtons(); },
  get autoExposure() { return state.autoExposure; }, set autoExposure(v) { state.autoExposure = v; syncButtons(); },
};
const BTN = { gi: 'btn-gi', shadows: 'btn-shadows', ao: 'btn-ao', probes: 'btn-probes', autoExposure: 'btn-exp' };
function syncButtons() { for (const k in BTN) $(BTN[k]).classList.toggle('active', toggles[k]); }
for (const k in BTN) $(BTN[k]).onclick = () => (toggles[k] = !toggles[k]);
$('btn-jump').onpointerdown = (e) => { e.preventDefault(); input.jump = true; };
$('btn-throw').onpointerdown = (e) => { e.preventDefault(); input.fire++; };
$('quality').onchange = (e) => { params.set('quality', e.target.value); location.search = params.toString(); };
$('help-close').onclick = () => $('help').classList.add('hidden');

const tod = $('tod');
tod.value = cfg.timeOfDay;
setTimeOfDay(cfg.timeOfDay);
tod.oninput = () => { cfg.timeOfDay = +tod.value; setTimeOfDay(cfg.timeOfDay); };
tod.onchange = () => startBake();

// ---------------------------------------------------------------- FPS meter + tweak GUI
const fpsMeter = new Stats();
fpsMeter.dom.id = 'fpsmeter';
fpsMeter.dom.style.cssText = ''; // positioned in style.css
document.body.appendChild(fpsMeter.dom);

const gui = new GUI({ title: 'Tweaks', width: 260 });
if (isMobile) gui.close();
const aoU = ao.aoMat.uniforms;
{
  const f = gui.addFolder('Lighting');
  f.add(cfg, 'timeOfDay', 0.04, 0.96, 0.005).name('sun (time of day)').listen()
    .onChange((v) => { tod.value = v; setTimeOfDay(v); }).onFinishChange(() => startBake());
  f.add(cfg, 'sunIntensity', 0, 8, 0.05).name('sun intensity')
    .onChange(() => setTimeOfDay(cfg.timeOfDay)).onFinishChange(() => startBake());
  f.add(toggles, 'shadows').name('sun shadows').listen();
  f.add(scene.fog, 'near', 0, 500, 1).name('fog near');
  f.add(scene.fog, 'far', 10, 1200, 1).name('fog far');
}
{
  const f = gui.addFolder('Exposure');
  // read-only live values
  const readout = {
    get auto() { return +state.exposure.toFixed(3); },
    get final() { return +renderer.toneMappingExposure.toFixed(3); },
    get ev() { return +Math.log2(renderer.toneMappingExposure).toFixed(2); },
  };
  f.add(cfg, 'exposure', 0.05, 4, 0.01).name('base exposure');
  f.add(toggles, 'autoExposure').name('auto exposure').listen();
  f.add(cfg, 'aeStrength', 0, 1, 0.01).name('adapt strength');
  f.add(cfg, 'aeMin', 0.05, 2, 0.01).name('min multiplier');
  f.add(cfg, 'aeMax', 1, 20, 0.1).name('max multiplier');
  f.add(cfg, 'aeSpeed', 0.1, 10, 0.1).name('adapt speed');
  f.add(cfg, 'aeInterval', 1, 60, 1).name('measure every (frames)');
  f.add({ remeasure: () => (state.refLum = null) }, 'remeasure').name('re-measure outdoor reference');
  f.add(readout, 'auto').name('auto multiplier').listen().disable();
  f.add(readout, 'final').name('final exposure').listen().disable();
  f.add(readout, 'ev').name('final EV').listen().disable();
}
{
  const f = gui.addFolder('Global illumination');
  f.add(toggles, 'gi').name('enabled').listen();
  f.add(gi.uniforms.giIntensity, 'value', 0, 4, 0.01).name('intensity');
  f.add(gi.uniforms.giBias, 'value', 0, 1.5, 0.01).name('normal/view bias');
  f.add(cfg, 'bounces', 1, 6, 1).name('bounces').onFinishChange(() => { updateStats(); startBake(); });
  f.add(toggles, 'probes').name('show probes').listen();
  f.add({ rebake: () => startBake() }, 'rebake').name('re-bake now');
}
{
  const f = gui.addFolder('SSAO');
  f.add(toggles, 'ao').name('enabled').listen();
  f.add(aoU.radius, 'value', 0.1, 4, 0.05).name('radius (m)');
  f.add(aoU.intensity, 'value', 0, 8, 0.05).name('intensity');
  f.add(ao.uniforms.aoDirect, 'value', 0, 1, 0.01).name('on direct light');
  f.add(aoU.maxPx, 'value', 4, 128, 1).name('max radius (px)');
  f.add(aoU.fadeFar, 'value', 5, 300, 1).name('fade distance');
  f.add({ get debug() { return ao.uniforms.aoDebug.value > 0.5; }, set debug(v) { ao.uniforms.aoDebug.value = v ? 1 : 0; } }, 'debug').name('show AO only');
  f.close();
}
{
  const f = gui.addFolder('Camera & player');
  f.add(camera, 'fov', 40, 110, 1).onChange(() => camera.updateProjectionMatrix());
  f.add(player, 'walkSpeed', 0.5, 15, 0.1).name('walk speed');
  f.add(player, 'runSpeed', 1, 30, 0.1).name('run speed');
  f.add(player, 'jumpSpeed', 0, 15, 0.1).name('jump speed');
  f.close();
}
{
  const f = gui.addFolder('Balls');
  f.add(balls, 'radius', 0.05, 2, 0.01).name('radius (m)').onChange(() => balls.rest.fill(0));
  f.add(balls, 'speed', 2, 40, 0.5).name('throw speed');
  f.add(balls, 'restitution', 0, 0.95, 0.01).name('bounciness');
  f.add(balls, 'friction', 0, 1, 0.01).name('friction');
  f.add(balls, 'gravity', 0, 30, 0.1).name('gravity');
  f.add(balls, 'max', 1, balls.capacity, 1).name('max balls').onFinishChange((v) => balls.setMax(v));
  f.add({ clear: () => balls.clear() }, 'clear').name('clear balls');
  f.close();
}
{
  const f = gui.addFolder('Scene');
  f.add(cfg, 'animate').name('animate spheres');
  f.add(cfg, 'animSpeed', 0, 4, 0.05).name('sphere speed');
  f.add(cfg, 'pixelRatio', 0.5, Math.max(devicePixelRatio, 1), 0.25).name('pixel ratio').onFinishChange((v) => {
    renderer.setPixelRatio(v);
    renderer.setSize(innerWidth, innerHeight);
    ao.resize();
  });
  f.add({ quality: qName }, 'quality', Object.keys(PRESETS)).name('quality preset (reload)')
    .onChange((v) => { params.set('quality', v); location.search = params.toString(); });
  f.close();
}

let bakeIt = null;
let perFrame = 16;
function startBake() {
  bakeIt = gi.bake(cfg.bounces);
  state.bakeStart = performance.now();
  $('rebake').classList.toggle('on', state.firstBakeDone);
}

function runBake(dtMs) {
  if (!bakeIt) return;
  // adapt probes/frame: at boot aim ~20 fps, at runtime keep the view fluid
  const target = state.firstBakeDone ? 30 : 60;
  perFrame = dtMs < target ? Math.min(perFrame * 1.2 + 1, 3000) : Math.max(perFrame * 0.7, state.firstBakeDone ? 2 : 8);
  if (state.firstBakeDone) perFrame = Math.min(perFrame, 96);
  const fog = scene.fog;
  scene.fog = null;
  let res;
  for (let i = 0; i < perFrame; i++) {
    res = bakeIt.next();
    if (res.done) break;
  }
  scene.fog = fog;
  if (res.done) {
    bakeIt = null;
    state.bakeMs = performance.now() - state.bakeStart;
    $('baketime').textContent = `bake ${(state.bakeMs / 1000).toFixed(1)} s`;
    $('rebake').classList.remove('on');
    state.refLum = null; // re-measure the outdoor reference with the new GI
    if (!state.firstBakeDone) {
      state.firstBakeDone = true;
      $('loader').classList.add('done');
      setTimeout(() => $('loader').remove(), 800);
    }
    return;
  }
  const v = res.value;
  const p = (v.bounce + (v.index + 1) / v.total) / v.bounces;
  if (!state.firstBakeDone) {
    $('bar').style.width = (p * 100).toFixed(1) + '%';
    $('status').textContent = `Bounce ${v.bounce + 1}/${v.bounces} · probe ${v.index + 1}/${v.total}`;
  } else {
    $('rebake').textContent = `Re-baking GI ${(p * 100).toFixed(0)}%`;
  }
}

// ---------------------------------------------------------------- loop
let last = performance.now();
let frames = 0, fpsT = 0;
const clock = { t: 0 };
function frame(now) {
  fpsMeter.begin();
  const dtMs = now - last;
  last = now;
  const dt = Math.min(dtMs / 1000, 0.05);
  runBake(dtMs);

  if (state.firstBakeDone) {
    const inp = input.read();
    lastPlayerPos.copy(player.pos);
    player.update(dt, inp, camera);
    if (dt > 0) playerVel.subVectors(player.pos, lastPlayerPos).divideScalar(dt);
    if (cfg.animate) clock.t += dt * cfg.animSpeed;
    for (const d of dyn) d.mesh.position.copy(d.path(clock.t));
    for (let i = 0; i < inp.fire; i++) throwBall();
    balls.update(dt);

    gi.applyDisplayState(state.gi);
    // auto exposure from the probe irradiance at the eye
    if (state.autoExposure && frames % Math.max(1, Math.round(cfg.aeInterval)) === 0) {
      const needRef = state.refLum == null;
      meter.measure(needRef ? REF_POINT : camera.position).then((lum) => {
        if (lum == null) return;
        if (needRef) { state.refLum = lum; return; }
        if (state.refLum == null) return;
        state.lum = lum;
        state.targetExposure = Math.pow(state.refLum / Math.max(lum, 1e-4), cfg.aeStrength);
      });
      gi.applyDisplayState(state.gi);
    }
    // clamp here (not at measure time) so min/max changes apply immediately
    const te = state.autoExposure && state.gi ? THREE.MathUtils.clamp(state.targetExposure ?? 1, cfg.aeMin, Math.max(cfg.aeMin, cfg.aeMax)) : 1;
    state.exposure = THREE.MathUtils.damp(state.exposure, te, cfg.aeSpeed, dt);
    renderer.toneMappingExposure = state.exposure * cfg.exposure;
    sun.update(camera);
    ao.render(camera);
    renderer.render(scene, camera);
  }

  frames++;
  fpsT += dtMs;
  if (fpsT > 500) {
    $('fps').textContent = `${Math.round((frames * 1000) / fpsT)} fps`;
    frames = 0; fpsT = 0;
  }
  fpsMeter.end();
  requestAnimationFrame(frame);
}

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  ao.resize();
});

if (isMobile) document.body.classList.add('mobile');
player.update(0, { forward: 0, strafe: 0, mag: 0, lookX: 0, lookY: 0 }, camera);
sun.update(camera); // initialise every cascade before the bake samples them
startBake();
requestAnimationFrame((t) => { last = t; frame(t); });

window.__gi = { gi, sun, ao, player, balls, camera, renderer, state, cfg, gui, setTimeOfDay };
