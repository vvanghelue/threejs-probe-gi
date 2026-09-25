// Probe-volume global illumination, baked on the GPU at runtime.
//
// For each probe of each volume:
//   1. render a small HDR cubemap from the probe position (direct light + emissive + sky
//      + previous bounce GI) — distance to the hit surface is written in alpha;
//   2. project the cubemap onto L1 spherical harmonics (4 coeffs x RGB) into a 1-pixel slot
//      of an MRT atlas (3 RGBA16F textures: R, G, B coefficient vectors);
//   3. (first bounce only) write an 8x8 octahedral mean/mean^2 distance tile, used at shading
//      time for DDGI-style Chebyshev visibility to stop light leaking through walls.
// Repeating the whole process N times gives N light bounces.
import * as THREE from 'three';

export const GI_MAX_VOL = 8;
const DEPTH_RES = 16;
const CUBE_RES = 16;
const ATLAS_W = 256;
const DEPTH_TILES_W = 128;

export const GI_GLSL = /* glsl */ `
#define GI_MAX_VOL ${GI_MAX_VOL}
#define GI_DEPTH_RES ${DEPTH_RES}.0
uniform sampler2D giSH0;
uniform sampler2D giSH1;
uniform sampler2D giSH2;
uniform sampler2D giOffsets;
uniform sampler2D giDepth;
uniform float giAtlasW;
uniform float giDepthTilesW;
uniform vec2 giDepthSize;
uniform vec3 giVolOrigin[GI_MAX_VOL];
uniform vec3 giVolSpacing[GI_MAX_VOL];
uniform vec3 giVolCount[GI_MAX_VOL];
uniform float giVolBase[GI_MAX_VOL];
uniform int giVolNum;
uniform float giEnabled;
uniform float giIntensity;
uniform float giCapture;
uniform float giBias;

vec2 giSignNZ(vec2 v) { return vec2(v.x >= 0.0 ? 1.0 : -1.0, v.y >= 0.0 ? 1.0 : -1.0); }
vec2 giOctEncode(vec3 v) {
  v /= (abs(v.x) + abs(v.y) + abs(v.z));
  vec2 r = v.xy;
  if (v.z < 0.0) r = (1.0 - abs(v.yx)) * giSignNZ(v.xy);
  return r;
}
vec3 giEvalSH(vec4 r, vec4 g, vec4 b, vec3 n) {
  // L1 SH irradiance: A0*Y00 = 0.886227, A1*Y1 = 1.023328
  vec4 k = vec4(0.886227, 1.023328 * n.y, 1.023328 * n.z, 1.023328 * n.x);
  return max(vec3(dot(r, k), dot(g, k), dot(b, k)), vec3(0.0));
}

vec3 giVolumeIrradiance(int vi, vec3 P, vec3 N, vec3 V) {
  vec3 o = giVolOrigin[vi];
  vec3 s = giVolSpacing[vi];
  vec3 c = giVolCount[vi];
  int base = int(giVolBase[vi] + 0.5);
  float minS = min(s.x, min(s.y, s.z));
  vec3 Pb = P + (N * 0.25 + V * 0.75) * giBias * minS;
  vec3 g = clamp((Pb - o) / s, vec3(0.0), c - 1.0);
  vec3 i0f = min(floor(g), max(c - 2.0, vec3(0.0)));
  vec3 f = g - i0f;
  ivec3 i0 = ivec3(i0f);
  ivec3 ic = ivec3(c + 0.5);
  int W = int(giAtlasW);
  int DW = int(giDepthTilesW);
  vec4 aR = vec4(0.0), aG = vec4(0.0), aB = vec4(0.0);
  float wsum = 0.0;
  for (int k = 0; k < 8; k++) {
    ivec3 off = ivec3(k & 1, (k >> 1) & 1, (k >> 2) & 1);
    ivec3 ip = min(i0 + off, ic - 1);
    vec3 tri3 = mix(1.0 - f, f, vec3(off));
    float tri = tri3.x * tri3.y * tri3.z;
    int idx = base + ip.x + ic.x * (ip.y + ic.y * ip.z);
    ivec2 tc = ivec2(idx % W, idx / W);
    vec4 offv = texelFetch(giOffsets, tc, 0);
    vec3 pp = o + vec3(ip) * s + offv.xyz;
    // backface / wrap weight
    vec3 toProbe = normalize(pp - P + vec3(1e-5));
    float wrap = (dot(toProbe, N) + 1.0) * 0.5;
    float w = wrap * wrap + 0.2;
    // Chebyshev visibility
    vec3 toP = Pb - pp;
    float d = length(toP);
    vec3 dir = toP / max(d, 1e-4);
    vec2 luv = clamp((giOctEncode(dir) * 0.5 + 0.5) * GI_DEPTH_RES, vec2(0.5), vec2(GI_DEPTH_RES - 0.5));
    vec2 tile = vec2(float(idx % DW), float(idx / DW)) * GI_DEPTH_RES;
    vec2 m = texture(giDepth, (tile + luv) / giDepthSize).rg;
    if (d > m.x) {
      float var = abs(m.y - m.x * m.x) + 0.04 * minS * minS;
      float dd = d - m.x;
      float vis = var / (var + dd * dd);
      w *= max(vis * vis * vis, 0.02);
    }
    if (w < 0.2) w *= w * w * 25.0;
    w *= tri * offv.w;
    aR += w * texelFetch(giSH0, tc, 0);
    aG += w * texelFetch(giSH1, tc, 0);
    aB += w * texelFetch(giSH2, tc, 0);
    wsum += w;
  }
  if (wsum < 1e-6) return vec3(0.0);
  return giEvalSH(aR / wsum, aG / wsum, aB / wsum, N);
}

// Blend from the finest volume to the coarsest; volume 0 is the global fallback.
vec3 giIrradiance(vec3 P, vec3 N, vec3 V) {
  vec3 E = vec3(0.0);
  float rem = 1.0;
  for (int v = GI_MAX_VOL - 1; v >= 0; v--) {
    if (v >= giVolNum) continue;
    float fade = 1.0;
    if (v > 0) {
      vec3 g = (P - giVolOrigin[v]) / giVolSpacing[v];
      vec2 e = min(g.xz, giVolCount[v].xz - 1.0 - g.xz);
      fade = clamp(min(e.x, e.y), 0.0, 1.0);
    }
    if (fade <= 0.0) continue;
    E += rem * fade * giVolumeIrradiance(v, P, N, V);
    rem *= 1.0 - fade;
    if (rem <= 0.001) break;
  }
  return E;
}
`;

const QUAD_VERT = /* glsl */ `
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const SH_FRAG = /* glsl */ `
precision highp float;
precision highp samplerCube;
uniform samplerCube env;
uniform float valid;
layout(location = 0) out vec4 oR;
layout(location = 1) out vec4 oG;
layout(location = 2) out vec4 oB;
vec3 faceDir(int f, vec2 uv) {
  if (f == 0) return vec3(1.0, uv.y, -uv.x);
  if (f == 1) return vec3(-1.0, uv.y, uv.x);
  if (f == 2) return vec3(uv.x, 1.0, -uv.y);
  if (f == 3) return vec3(uv.x, -1.0, uv.y);
  if (f == 4) return vec3(uv.x, uv.y, 1.0);
  return vec3(-uv.x, uv.y, -1.0);
}
void main() {
  vec4 r = vec4(0.0), g = vec4(0.0), b = vec4(0.0);
  float wsum = 0.0;
  const int R = ${CUBE_RES};
  for (int f = 0; f < 6; f++) {
    for (int j = 0; j < R; j++) {
      for (int i = 0; i < R; i++) {
        vec2 uv = (vec2(float(i), float(j)) + 0.5) / float(R) * 2.0 - 1.0;
        vec3 d = faceDir(f, uv);
        float l2 = dot(d, d);
        float dw = 1.0 / (l2 * sqrt(l2)); // texel solid angle
        d = normalize(d);
        vec3 L = min(texture(env, d).rgb, vec3(500.0));
        vec4 Y = vec4(0.282095, 0.488603 * d.y, 0.488603 * d.z, 0.488603 * d.x) * dw;
        r += L.r * Y; g += L.g * Y; b += L.b * Y;
        wsum += dw;
      }
    }
  }
  float norm = 12.566370614 / wsum * valid;
  oR = r * norm; oG = g * norm; oB = b * norm;
}
`;

const DEPTH_FRAG = /* glsl */ `
precision highp float;
precision highp samplerCube;
uniform samplerCube env;
uniform float valid;
uniform vec2 tileOrigin;
out vec4 o;
vec2 signNZ(vec2 v) { return vec2(v.x >= 0.0 ? 1.0 : -1.0, v.y >= 0.0 ? 1.0 : -1.0); }
vec3 octDecode(vec2 e) {
  vec3 v = vec3(e, 1.0 - abs(e.x) - abs(e.y));
  if (v.z < 0.0) v.xy = (1.0 - abs(v.yx)) * signNZ(v.xy);
  return normalize(v);
}
void main() {
  if (valid < 0.5) { o = vec4(0.0); return; }
  vec2 local = (gl_FragCoord.xy - tileOrigin) / ${DEPTH_RES}.0;
  vec3 dir = octDecode(local * 2.0 - 1.0);
  vec3 up = abs(dir.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t = normalize(cross(up, dir));
  vec3 bt = cross(dir, t);
  float m = 0.0, m2 = 0.0;
  for (int k = 0; k < 32; k++) {
    float fk = float(k) + 0.5;
    float rr = sqrt(fk / 32.0) * 0.22;
    float a = fk * 2.39996;
    vec3 d = normalize(dir + (t * cos(a) + bt * sin(a)) * rr);
    float dist = min(texture(env, d).a, 40.0);
    m += dist; m2 += dist * dist;
  }
  o = vec4(m / 32.0, m2 / 32.0, 0.0, 1.0);
}
`;

export class ProbeGI {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;
    this.volumes = [];
    this.display = null;
    this.depthReady = false;
    const v3 = (x) => Array.from({ length: GI_MAX_VOL }, () => new THREE.Vector3(x, x, x));
    this.uniforms = {
      giSH0: { value: null },
      giSH1: { value: null },
      giSH2: { value: null },
      giOffsets: { value: null },
      giDepth: { value: null },
      giAtlasW: { value: ATLAS_W },
      giDepthTilesW: { value: DEPTH_TILES_W },
      giDepthSize: { value: new THREE.Vector2(1, 1) },
      giVolOrigin: { value: v3(0) },
      giVolSpacing: { value: v3(1) },
      giVolCount: { value: v3(1) },
      giVolBase: { value: new Array(GI_MAX_VOL).fill(0) },
      giVolNum: { value: 0 },
      giEnabled: { value: 0 },
      giIntensity: { value: 1 },
      giCapture: { value: 0 },
      giBias: { value: 0.88 }, // human tried 0.88, before : 0.4
    };
  }

  /** First volume added is the coarse global fallback; later ones are finer local volumes. */
  addVolume(name, min, max, spacing) {
    const s = new THREE.Vector3(...spacing);
    const lo = new THREE.Vector3(...min);
    const hi = new THREE.Vector3(...max);
    const counts = new THREE.Vector3(
      Math.ceil((hi.x - lo.x) / s.x - 1e-3) + 1,
      Math.ceil((hi.y - lo.y) / s.y - 1e-3) + 1,
      Math.ceil((hi.z - lo.z) / s.z - 1e-3) + 1,
    );
    // center the grid on the requested region
    const center = lo.clone().add(hi).multiplyScalar(0.5);
    const origin = center.clone().sub(counts.clone().subScalar(1).multiply(s).multiplyScalar(0.5));
    origin.y = lo.y; // keep the bottom row where requested
    this.volumes.push({ name, origin, spacing: s, counts, base: 0 });
  }

  build(solids) {
    if (this.volumes.length > GI_MAX_VOL) throw new Error('too many volumes');
    let total = 0;
    for (const v of this.volumes) {
      v.base = total;
      total += v.counts.x * v.counts.y * v.counts.z;
    }
    this.count = total;
    const H = Math.ceil(total / ATLAS_W);
    this.positions = new Float32Array(total * 3);
    this.valid = new Uint8Array(total);
    const offsets = new Float32Array(ATLAS_W * H * 4);
    const p = new THREE.Vector3();
    let invalid = 0;
    for (const v of this.volumes) {
      for (let z = 0; z < v.counts.z; z++)
        for (let y = 0; y < v.counts.y; y++)
          for (let x = 0; x < v.counts.x; x++) {
            const i = v.base + x + v.counts.x * (y + v.counts.y * z);
            p.set(x, y, z).multiply(v.spacing).add(v.origin);
            const q = relocate(p, solids, Math.min(v.spacing.x, v.spacing.y, v.spacing.z));
            const ok = q !== null;
            if (!ok) invalid++;
            const r = ok ? q : p;
            this.positions.set([r.x, r.y, r.z], i * 3);
            this.valid[i] = ok ? 1 : 0;
            offsets.set([r.x - p.x, r.y - p.y, r.z - p.z, ok ? 1 : 0], i * 4);
          }
    }
    this.invalidCount = invalid;

    const offTex = new THREE.DataTexture(offsets, ATLAS_W, H, THREE.RGBAFormat, THREE.FloatType);
    offTex.minFilter = offTex.magFilter = THREE.NearestFilter;
    offTex.needsUpdate = true;
    this.offsetTexture = offTex;

    const mrtOpts = {
      count: 3,
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      generateMipmaps: false,
    };
    this.pool = [0, 1, 2].map(() => new THREE.WebGLRenderTarget(ATLAS_W, H, mrtOpts));

    const DH = Math.ceil(total / DEPTH_TILES_W);
    this.depthRT = new THREE.WebGLRenderTarget(DEPTH_TILES_W * DEPTH_RES, DH * DEPTH_RES, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      generateMipmaps: false,
    });

    this.cubeRT = new THREE.WebGLCubeRenderTarget(CUBE_RES, {
      type: THREE.HalfFloatType,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.cubeCam = new THREE.CubeCamera(0.05, 600, this.cubeRT);

    this.quadScene = new THREE.Scene();
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.shMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: QUAD_VERT,
      fragmentShader: SH_FRAG,
      uniforms: { env: { value: this.cubeRT.texture }, valid: { value: 1 } },
      depthTest: false,
      depthWrite: false,
    });
    this.depthMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: QUAD_VERT,
      fragmentShader: DEPTH_FRAG,
      uniforms: {
        env: { value: this.cubeRT.texture },
        valid: { value: 1 },
        tileOrigin: { value: new THREE.Vector2() },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.shMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);

    const u = this.uniforms;
    u.giOffsets.value = offTex;
    u.giDepth.value = this.depthRT.texture;
    u.giDepthSize.value.set(this.depthRT.width, this.depthRT.height);
    u.giVolNum.value = this.volumes.length;
    this.volumes.forEach((v, i) => {
      u.giVolOrigin.value[i].copy(v.origin);
      u.giVolSpacing.value[i].copy(v.spacing);
      u.giVolCount.value[i].copy(v.counts);
      u.giVolBase.value[i] = v.base;
    });
  }

  /** Inject probe GI sampling into a built-in lit material (Standard/Physical). */
  patchMaterial(material, { emissiveAttr = false, specular = false } = {}) {
    const uniforms = this.uniforms;
    material.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uniforms);
      if (emissiveAttr) {
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nattribute float aEmissive;\nvarying float vGIEmissive;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGIEmissive = aEmissive;');
      }
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\n' + GI_GLSL + (emissiveAttr ? '\nvarying float vGIEmissive;\n' : ''))
        .replace(
          '#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\n' + (emissiveAttr ? 'totalEmissiveRadiance += diffuseColor.rgb * vGIEmissive;' : ''),
        )
        .replace(
          '#include <lights_fragment_maps>',
          `#include <lights_fragment_maps>
          if (giEnabled > 0.5) {
            vec3 giP = (vec4(-vViewPosition, 0.0) * viewMatrix).xyz + cameraPosition;
            vec3 giN = normalize((vec4(geometryNormal, 0.0) * viewMatrix).xyz);
            vec3 giV = normalize(cameraPosition - giP);
            irradiance += giIntensity * giIrradiance(giP, giN, giV);
            ${specular ? 'radiance += giIntensity * giIrradiance(giP, reflect(-giV, giN), giV) * 0.3183;' : ''}
          }`,
        )
        .replace(
          '#include <dithering_fragment>',
          '#include <dithering_fragment>\nif (giCapture > 0.5) gl_FragColor.a = length(vViewPosition);',
        );
    };
    material.customProgramCacheKey = () => `probegi-${emissiveAttr ? 1 : 0}${specular ? 1 : 0}`;
    return material;
  }

  /** Uniform state for normal (screen) rendering. */
  applyDisplayState(enabled) {
    const u = this.uniforms;
    const t = this.display ? this.display.textures : [null, null, null];
    u.giSH0.value = t[0];
    u.giSH1.value = t[1];
    u.giSH2.value = t[2];
    u.giEnabled.value = enabled && this.display ? 1 : 0;
    u.giCapture.value = 0;
  }

  /** Generator: yields once per baked probe. */
  *bake(bounces) {
    const withDepth = !this.depthReady;
    let read = null;
    for (let b = 0; b < bounces; b++) {
      const write = this.pool.find((rt) => rt !== this.display && rt !== read);
      for (let i = 0; i < this.count; i++) {
        this._bakeProbe(i, read, write, withDepth && b === 0);
        yield { bounce: b, bounces, index: i, total: this.count };
      }
      if (withDepth && b === 0) this.depthReady = true;
      read = write;
    }
    this.display = read;
  }

  _bakeProbe(i, read, write, withDepth) {
    const r = this.renderer;
    const u = this.uniforms;
    const valid = this.valid[i];
    if (valid) {
      const t = read ? read.textures : [null, null, null];
      u.giSH0.value = t[0];
      u.giSH1.value = t[1];
      u.giSH2.value = t[2];
      u.giEnabled.value = read ? 1 : 0;
      u.giCapture.value = 1;
      this.cubeCam.position.set(this.positions[i * 3], this.positions[i * 3 + 1], this.positions[i * 3 + 2]);
      this.cubeCam.updateMatrixWorld();
      this.cubeCam.update(r, this.scene);
    }
    const autoClear = r.autoClear;
    r.autoClear = false;
    // SH projection -> one texel
    const x = i % ATLAS_W;
    const y = Math.floor(i / ATLAS_W);
    write.viewport.set(x, y, 1, 1);
    write.scissor.set(x, y, 1, 1);
    write.scissorTest = true;
    this.shMat.uniforms.valid.value = valid;
    this.quad.material = this.shMat;
    r.setRenderTarget(write);
    r.render(this.quadScene, this.quadCam);
    if (withDepth) {
      const tx = (i % DEPTH_TILES_W) * DEPTH_RES;
      const ty = Math.floor(i / DEPTH_TILES_W) * DEPTH_RES;
      const d = this.depthRT;
      d.viewport.set(tx, ty, DEPTH_RES, DEPTH_RES);
      d.scissor.set(tx, ty, DEPTH_RES, DEPTH_RES);
      d.scissorTest = true;
      this.depthMat.uniforms.valid.value = valid;
      this.depthMat.uniforms.tileOrigin.value.set(tx, ty);
      this.quad.material = this.depthMat;
      r.setRenderTarget(d);
      r.render(this.quadScene, this.quadCam);
    }
    r.setRenderTarget(null);
    r.autoClear = autoClear;
  }

  /** Instanced spheres showing each probe's irradiance. */
  createDebugMesh(radius = 0.12) {
    const geo = new THREE.SphereGeometry(radius, 12, 8);
    const idx = new Float32Array(this.count);
    for (let i = 0; i < this.count; i++) idx[i] = i;
    geo.setAttribute('aProbe', new THREE.InstancedBufferAttribute(idx, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        attribute float aProbe;
        varying float vProbe;
        varying vec3 vN;
        void main() {
          vProbe = aProbe;
          vN = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        ${GI_GLSL}
        varying float vProbe;
        varying vec3 vN;
        void main() {
          int idx = int(vProbe + 0.5);
          int W = int(giAtlasW);
          ivec2 tc = ivec2(idx % W, idx / W);
          if (texelFetch(giOffsets, tc, 0).w < 0.5) discard;
          vec3 E = giEvalSH(texelFetch(giSH0, tc, 0), texelFetch(giSH1, tc, 0), texelFetch(giSH2, tc, 0), normalize(vN));
          gl_FragColor = vec4(E * 0.3183 * giEnabled + vec3(0.02), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, this.count);
    const m = new THREE.Matrix4();
    for (let i = 0; i < this.count; i++) {
      m.makeTranslation(this.positions[i * 3], this.positions[i * 3 + 1], this.positions[i * 3 + 2]);
      mesh.setMatrixAt(i, m);
    }
    mesh.frustumCulled = false;
    return mesh;
  }

  /** 1x1 pass evaluating average GI luminance at a point (for auto exposure). */
  createMeter() {
    const rt = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...this.uniforms, meterPos: { value: new THREE.Vector3() } },
      vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */ `
        ${GI_GLSL}
        uniform vec3 meterPos;
        void main() {
          vec3 s = vec3(0.0);
          s += giIrradiance(meterPos, vec3( 1,0,0), vec3( 1,0,0));
          s += giIrradiance(meterPos, vec3(-1,0,0), vec3(-1,0,0));
          s += giIrradiance(meterPos, vec3(0, 1,0), vec3(0, 1,0));
          s += giIrradiance(meterPos, vec3(0,-1,0), vec3(0,-1,0));
          s += giIrradiance(meterPos, vec3(0,0, 1), vec3(0,0, 1));
          s += giIrradiance(meterPos, vec3(0,0,-1), vec3(0,0,-1));
          float lum = dot(s / 6.0, vec3(0.2126, 0.7152, 0.0722));
          gl_FragColor = vec4(clamp(log2(max(lum, 1e-5)) / 24.0 + 0.5, 0.0, 1.0), 0.0, 0.0, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });
    const scene = new THREE.Scene();
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    scene.add(quad);
    const buf = new Uint8Array(4);
    let pending = false;
    return {
      measure: (pos) => {
        if (pending || !this.display) return Promise.resolve(null);
        pending = true;
        mat.uniforms.meterPos.value.copy(pos);
        const r = this.renderer;
        r.setRenderTarget(rt);
        r.render(scene, this.quadCam);
        r.setRenderTarget(null);
        return r
          .readRenderTargetPixelsAsync(rt, 0, 0, 1, 1, buf)
          .then(() => Math.pow(2, (buf[0] / 255 - 0.5) * 24))
          .catch(() => null)
          .finally(() => (pending = false));
      },
    };
  }
}

/** Push a probe out of solid boxes (DDGI-like relocation). Returns null if it can't be freed. */
function relocate(p, solids, spacing) {
  const m = 0.15;
  const q = p.clone();
  for (let iter = 0; iter < 6; iter++) {
    let hit = null;
    for (const s of solids) {
      if (
        q.x > s.min[0] - m && q.x < s.max[0] + m &&
        q.y > s.min[1] - m && q.y < s.max[1] + m &&
        q.z > s.min[2] - m && q.z < s.max[2] + m
      ) { hit = s; break; }
    }
    if (!hit) return q.distanceTo(p) < spacing * 0.9 ? q : null;
    const opts = [
      [q.x - (hit.min[0] - m), 0, -1], [hit.max[0] + m - q.x, 0, 1],
      [q.y - (hit.min[1] - m), 1, -1], [hit.max[1] + m - q.y, 1, 1],
      [q.z - (hit.min[2] - m), 2, -1], [hit.max[2] + m - q.z, 2, 1],
    ].sort((a, b) => a[0] - b[0]);
    const [d, axis, sign] = opts[0];
    q.setComponent(axis, q.getComponent(axis) + sign * (d + 0.01));
  }
  return null;
}
