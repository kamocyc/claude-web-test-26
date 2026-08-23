import * as THREE from 'three'
import { SEA_LEVEL } from '../world/constants'

const COMMON_VERT = /* glsl */ `
attribute vec4 matw;
varying vec4 vMatW;
varying vec3 vWPos;
varying vec3 vWNormal;
`

const COMMON_FRAG = /* glsl */ `
uniform sampler2D uNoise;
varying vec4 vMatW;
varying vec3 vWPos;
varying vec3 vWNormal;

// 三面投影：UV を持たない任意曲面にシームレスにディテールを乗せる
vec4 triSample(vec3 p, vec3 bw, float s) {
  vec4 nx = texture2D(uNoise, p.zy * s);
  vec4 ny = texture2D(uNoise, p.xz * s);
  vec4 nz = texture2D(uNoise, p.xy * s);
  return nx * bw.x + ny * bw.y + nz * bw.z;
}
`

const MAP_FRAGMENT = /* glsl */ `
vec3 wn = normalize(vWNormal);
vec3 bw = pow(abs(wn), vec3(4.0));
bw /= max(1e-4, bw.x + bw.y + bw.z);

vec4 n0 = triSample(vWPos, bw, 0.0075);  // マクロ変化
vec4 n1 = triSample(vWPos, bw, 0.0520);  // 中
vec4 n2 = triSample(vWPos, bw, 0.2400);  // 粒状
vec4 n3 = triSample(vWPos, bw, 1.0500);  // 近景の細かい粒

float slope = 1.0 - wn.y;

vec3 grass = mix(vec3(0.130, 0.243, 0.086), vec3(0.443, 0.588, 0.216), n1.g);
grass = mix(grass, vec3(0.271, 0.404, 0.106), n0.r * 0.85);
grass = mix(grass, vec3(0.451, 0.478, 0.239), smoothstep(0.55, 0.95, n1.a) * 0.55);
grass *= 0.72 + 0.42 * n2.b;
grass *= 0.86 + 0.28 * n3.g;

vec3 dirt = mix(vec3(0.216, 0.145, 0.090), vec3(0.494, 0.373, 0.235), n1.r);
dirt = mix(dirt, vec3(0.353, 0.255, 0.169), n0.b);
dirt *= 0.78 + 0.40 * n2.a;
dirt *= 0.88 + 0.24 * n3.r;

float strata = 0.5 + 0.5 * sin(vWPos.y * 0.42 + n0.g * 8.0 + n1.b * 2.5);
vec3 rock = mix(vec3(0.310, 0.310, 0.341), vec3(0.616, 0.612, 0.627), strata);
rock = mix(rock, vec3(0.451, 0.408, 0.376), n0.b * 0.75);
rock *= 0.74 + 0.44 * n2.r;
rock *= 0.87 + 0.26 * n3.b;

vec3 sand = mix(vec3(0.647, 0.565, 0.388), vec3(0.902, 0.831, 0.639), n1.a);
sand *= 0.88 + 0.22 * n2.g;
sand *= 0.90 + 0.20 * n3.a;

vec4 mw = vMatW;
mw /= max(1e-4, mw.x + mw.y + mw.z + mw.w);
vec3 col = grass * mw.x + dirt * mw.y + rock * mw.z + sand * mw.w;

// 高所かつ平坦なところに雪
float snow = smoothstep(64.0, 96.0, vWPos.y + n0.r * 18.0 - 9.0) * smoothstep(0.60, 0.22, slope);
col = mix(col, vec3(0.870, 0.910, 0.965) * (0.88 + 0.16 * n2.b), snow);

// 水面下は濡れて暗く、青みを帯びる
float wet = smoothstep(1.5, -3.0, vWPos.y - ${SEA_LEVEL.toFixed(1)});
col = mix(col, col * vec3(0.50, 0.68, 0.82), wet * 0.6);

diffuseColor.rgb *= col;

gBump = (vec3(n3.r, n3.g, n3.b) - 0.5) * 0.95
      + (vec3(n2.r, n2.g, n2.b) - 0.5) * 0.80
      + (vec3(n1.b, n1.a, n1.r) - 0.5) * 0.40;
gBump *= 1.0 - snow * 0.55;
gRough = clamp(0.74 + 0.22 * n1.g - 0.30 * snow - 0.18 * mw.w, 0.06, 1.0);
`

/**
 * three の MeshStandardMaterial を拡張し、ライティング・影・フォグをそのまま使いつつ
 * 三面投影のプロシージャルテクスチャで着色する。
 */
export function createTerrainMaterial(noiseTex: THREE.Texture): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.85,
    metalness: 0,
    dithering: true,
  })

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNoise = { value: noiseTex }

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${COMMON_VERT}`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vMatW = matw;
        vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWNormal = normalize(mat3(modelMatrix) * objectNormal);`,
      )

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${COMMON_FRAG}`)
      .replace(
        '#include <map_fragment>',
        `vec3 gBump = vec3(0.0);\nfloat gRough = roughness;\n${MAP_FRAGMENT}`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        'float roughnessFactor = gRough;',
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        normal = normalize(normal + mat3(viewMatrix) * gBump * 0.42);`,
      )
  }

  mat.customProgramCacheKey = () => 'smooth-terrain-v1'
  return mat
}
