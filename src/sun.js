// Cascaded sun shadows, done by hand instead of three's single DirectionalLight shadow.
//
// - N "near" cascades follow the camera (texel-snapped to avoid shimmering) and are re-rendered
//   every frame, so they also catch dynamic objects: crisp contact shadows up close.
// - 1 static wide map covers the whole probe area; it is only re-rendered when the sun moves.
//   Probe captures (giCapture = 1) use it exclusively, and it's the far fallback on screen.
// - Cascade selection is by containment (smallest cascade whose map contains the point), with a
//   blend band at the border, so it works for any camera (main view or probe cube faces).
// - The sun itself is applied in the shader via RE_Direct, so there is no three.js light at all.
import * as THREE from 'three';

const MAX_NEAR = 3;

export const SUN_GLSL = /* glsl */ `
uniform vec3 sunDirW;
uniform vec3 sunColor;
uniform int sunCascades;
uniform float sunShadowOn;
uniform mat4 sunMat[4];
uniform vec4 sunParams[4]; // x: world texel size, y: 1/res, z: depth bias, w: kernel step (texels)
uniform sampler2DShadow sunMap0;
uniform sampler2DShadow sunMap1;
uniform sampler2DShadow sunMap2;
uniform sampler2DShadow sunMapS;

float sunPCF(sampler2DShadow m, vec3 c, vec4 p) {
  vec2 t = vec2(p.y * p.w);
  float s = 0.0;
  s += texture(m, vec3(c.xy, c.z)) * 2.0;
  s += texture(m, vec3(c.xy + vec2(-t.x, -t.y * 0.5), c.z));
  s += texture(m, vec3(c.xy + vec2( t.x * 0.5, -t.y), c.z));
  s += texture(m, vec3(c.xy + vec2( t.x,  t.y * 0.5), c.z));
  s += texture(m, vec3(c.xy + vec2(-t.x * 0.5,  t.y), c.z));
  s += texture(m, vec3(c.xy + vec2(-t.x * 1.6, t.y * 0.1), c.z)) * 0.5;
  s += texture(m, vec3(c.xy + vec2( t.x * 1.6, -t.y * 0.1), c.z)) * 0.5;
  s += texture(m, vec3(c.xy + vec2(t.x * 0.1, t.y * 1.6), c.z)) * 0.5;
  s += texture(m, vec3(c.xy + vec2(-t.x * 0.1, -t.y * 1.6), c.z)) * 0.5;
  return s / 8.0;
}
vec3 sunCoord(int i, vec3 P, vec3 N, float NdL) {
  vec4 p = sunParams[i];
  float nb = p.x * (1.0 + 2.5 * (1.0 - NdL)) * max(p.w, 1.0);
  vec3 c = (sunMat[i] * vec4(P + N * nb, 1.0)).xyz * 0.5 + 0.5;
  c.z -= p.z;
  return c;
}
float sunEdge(vec3 c) {
  if (c.z >= 1.0 || c.z <= 0.0) return -1.0;
  return min(min(c.x, 1.0 - c.x), min(c.y, 1.0 - c.y));
}
float sunSample(int i, vec3 c) {
  if (i == 0) return sunPCF(sunMap0, c, sunParams[0]);
  if (i == 1) return sunPCF(sunMap1, c, sunParams[1]);
  if (i == 2) return sunPCF(sunMap2, c, sunParams[2]);
  return sunPCF(sunMapS, c, sunParams[3]);
}
float sunShadow(vec3 P, vec3 N, float NdL, bool capture) {
  if (!capture && sunShadowOn < 0.5) return 1.0;
  if (!capture) {
    for (int i = 0; i < ${MAX_NEAR}; i++) {
      if (i >= sunCascades) break;
      vec3 c = sunCoord(i, P, N, NdL);
      float e = sunEdge(c);
      if (e > 0.0) {
        float s = sunSample(i, c);
        float f = smoothstep(0.0, 0.08, e);
        if (f < 1.0) {
          int j = i + 1 < sunCascades ? i + 1 : 3;
          vec3 c2 = sunCoord(j, P, N, NdL);
          float s2 = sunEdge(c2) > 0.0 ? sunSample(j, c2) : 1.0;
          s = mix(s2, s, f);
        }
        return s;
      }
    }
  }
  vec3 c = sunCoord(3, P, N, NdL);
  return sunEdge(c) > 0.0 ? sunSample(3, c) : 1.0;
}
`;

export class SunShadows {
  /**
   * @param nearCascades [{radius, res}] smallest first (max 3)
   * @param staticCascade {radius, res, center}
   */
  constructor(renderer, scene, { near, stat }) {
    this.renderer = renderer;
    this.scene = scene;
    this.dir = new THREE.Vector3(0, 1, 0);
    this.enabled = true;
    this.near = near.slice(0, MAX_NEAR).map((c) => this._makeCascade(c.radius, c.res, 300));
    this.stat = this._makeCascade(stat.radius, stat.res, 400);
    this.stat.center = new THREE.Vector3(...stat.center);
    this.depthMat = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.BackSide });

    this.uniforms = {
      sunDirW: { value: this.dir },
      sunColor: { value: new THREE.Color(1, 1, 1) },
      sunCascades: { value: this.near.length },
      sunShadowOn: { value: 1 },
      sunMat: { value: [0, 1, 2, 3].map(() => new THREE.Matrix4()) },
      sunParams: { value: [0, 1, 2, 3].map(() => new THREE.Vector4(0.1, 1 / 1024, 0, 1)) },
      sunMap0: { value: this.near[0]?.rt.depthTexture ?? this.stat.rt.depthTexture },
      sunMap1: { value: this.near[1]?.rt.depthTexture ?? this.stat.rt.depthTexture },
      sunMap2: { value: this.near[2]?.rt.depthTexture ?? this.stat.rt.depthTexture },
      sunMapS: { value: this.stat.rt.depthTexture },
    };
    this.near.forEach((c, i) => this._setParams(i, c));
    this._setParams(3, this.stat);
  }

  _makeCascade(radius, res, depth) {
    const rt = new THREE.WebGLRenderTarget(res, res, {
      format: THREE.RedFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      generateMipmaps: false,
    });
    rt.depthTexture = new THREE.DepthTexture(res, res, THREE.UnsignedIntType);
    rt.depthTexture.format = THREE.DepthFormat;
    rt.depthTexture.compareFunction = THREE.LessEqualCompare;
    rt.depthTexture.minFilter = rt.depthTexture.magFilter = THREE.LinearFilter;
    const cam = new THREE.OrthographicCamera(-radius, radius, radius, -radius, 0.5, depth);
    return { radius, res, depth, rt, cam, texel: (2 * radius) / res };
  }

  _setParams(i, c) {
    // soft kernel: aim for ~4 cm penumbra, at least 1 texel, at most 3
    const step = THREE.MathUtils.clamp(0.04 / c.texel, 1, 3);
    this.uniforms.sunParams.value[i].set(c.texel, 1 / c.res, (c.texel * 0.6) / c.depth, step);
  }

  setSun(dir, color, intensity) {
    this.dir.copy(dir).normalize();
    this.uniforms.sunColor.value.copy(color).multiplyScalar(intensity);
    this.renderStatic();
  }

  _place(c, center) {
    const cam = c.cam;
    const up = Math.abs(this.dir.y) > 0.99 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
    // light basis
    const fwd = this.dir.clone().negate();
    const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
    const lup = new THREE.Vector3().crossVectors(right, fwd).normalize();
    // texel snapping in light space
    const t = c.texel;
    const x = center.dot(right), y = center.dot(lup), z = center.dot(fwd);
    const snapped = new THREE.Vector3()
      .addScaledVector(right, Math.round(x / t) * t)
      .addScaledVector(lup, Math.round(y / t) * t)
      .addScaledVector(fwd, z);
    cam.position.copy(snapped).addScaledVector(this.dir, c.depth * 0.5);
    cam.up.copy(lup);
    cam.lookAt(snapped);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();
  }

  _render(c, index, layers) {
    const r = this.renderer;
    const scene = this.scene;
    const prevOverride = scene.overrideMaterial;
    const prevTarget = r.getRenderTarget();
    const prevFog = scene.fog;
    c.cam.layers.mask = layers;
    scene.overrideMaterial = this.depthMat;
    scene.fog = null;
    this.onBeforeShadow?.();
    r.setRenderTarget(c.rt);
    r.clear(true, true, false);
    r.render(scene, c.cam);
    r.setRenderTarget(prevTarget);
    this.onAfterShadow?.();
    scene.overrideMaterial = prevOverride;
    scene.fog = prevFog;
    this.uniforms.sunMat.value[index].multiplyMatrices(c.cam.projectionMatrix, c.cam.matrixWorldInverse);
  }

  renderStatic() {
    this._place(this.stat, this.stat.center);
    this._render(this.stat, 3, 1 << 0); // static geometry only
  }

  /** On-screen shadows on/off. The static map is kept: the probe bake always uses it. */
  setEnabled(on) {
    this.enabled = on;
    this.uniforms.sunShadowOn.value = on ? 1 : 0;
  }

  /** Re-fit and render the near cascades around the camera (static + dynamic layers). */
  update(camera) {
    if (!this.enabled) return;
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1);
    fwd.normalize();
    this.near.forEach((c, i) => {
      const center = camera.position.clone().addScaledVector(fwd, c.radius * 0.45);
      this._place(c, center);
      this._render(c, i, (1 << 0) | (1 << 1));
    });
  }

  /** Inject the sun (direct light + cascaded shadow) into a built-in lit material. */
  inject(sh) {
    Object.assign(sh.uniforms, this.uniforms);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + SUN_GLSL)
      .replace(
        '#include <lights_fragment_begin>',
        `#include <lights_fragment_begin>
        {
          vec3 sP = (vec4(-vViewPosition, 0.0) * viewMatrix).xyz + cameraPosition;
          vec3 sN = normalize((vec4(geometryNormal, 0.0) * viewMatrix).xyz);
          float sNdL = dot(sN, sunDirW);
          if (sNdL > 0.0) {
            IncidentLight sunL;
            sunL.direction = normalize((viewMatrix * vec4(sunDirW, 0.0)).xyz);
            sunL.color = sunColor * sunShadow(sP, sN, sNdL, giCapture > 0.5);
            sunL.visible = true;
            RE_Direct(sunL, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
          }
        }`,
      );
  }
}
