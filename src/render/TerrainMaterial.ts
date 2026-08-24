import * as THREE from 'three'
import { SEA_LEVEL } from '../world/constants'

const COMMON_VERT = /* glsl */ `
attribute vec4 matw;
attribute vec4 matw2;
attribute vec2 abiome;
varying vec4 vMatW;
varying vec4 vMatW2;
varying vec2 vBiome;
varying vec3 vWPos;
varying vec3 vWNormal;
`

const COMMON_FRAG = /* glsl */ `
uniform sampler2D uNoise;
varying vec4 vMatW;
varying vec4 vMatW2;
varying vec2 vBiome;
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

// バイオーム：湿潤なほど濃い緑、乾燥するとサバンナ色、寒冷だとくすむ
float bTemp = vBiome.x;
float bHumid = vBiome.y;
vec3 grassBase = mix(vec3(0.435, 0.412, 0.192), vec3(0.129, 0.259, 0.086), smoothstep(0.22, 0.78, bHumid));
grassBase = mix(grassBase, vec3(0.227, 0.322, 0.216), smoothstep(0.46, 0.14, bTemp));
vec3 grass = mix(grassBase * 0.70, grassBase * 1.55, n1.g);
grass = mix(grass, grassBase * vec3(1.12, 1.02, 0.72), n0.r * 0.7);
grass = mix(grass, vec3(0.451, 0.478, 0.239), smoothstep(0.62, 0.96, n1.a) * 0.4);
grass *= 0.76 + 0.38 * n2.b;
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

// --- クラフトした建材 ---
// 板：木目を 1 方向に流す
float grain = sin(vWPos.x * 7.3 + vWPos.z * 2.1 + n1.r * 5.0);
vec3 plank = mix(vec3(0.451, 0.290, 0.145), vec3(0.741, 0.541, 0.322), 0.5 + 0.5 * grain);
plank = mix(plank, vec3(0.310, 0.196, 0.098), step(0.86, fract(vWPos.y * 1.6 + n0.g)) * 0.8);
plank *= 0.86 + 0.28 * n2.r;

// レンガ：目地を格子で入れる。1 段ごとに半個ずらす
float row = floor(vWPos.y * 2.6);
vec2 bp = vec2(fract((vWPos.x + vWPos.z) * 1.1 + mod(row, 2.0) * 0.5), fract(vWPos.y * 2.6));
float mortar = min(smoothstep(0.0, 0.07, bp.x) * smoothstep(1.0, 0.93, bp.x),
                   smoothstep(0.0, 0.10, bp.y) * smoothstep(1.0, 0.90, bp.y));
vec3 brick = mix(vec3(0.776, 0.749, 0.694), vec3(0.639, 0.294, 0.212), mortar);
brick = mix(brick, brick * vec3(0.82, 0.90, 0.96), n1.b * 0.35);
brick *= 0.88 + 0.24 * n2.a;

// ガラス：不透明側にも薄く出るので、淡い水色にしておく
vec3 glass = mix(vec3(0.686, 0.851, 0.898), vec3(0.902, 0.965, 0.980), n1.a);

vec4 mw = vMatW;
vec4 mw2 = vMatW2;
float mtotal = max(1e-4, mw.x + mw.y + mw.z + mw.w + mw2.x + mw2.y + mw2.z);
mw /= mtotal;
mw2 /= mtotal;
vec3 col = grass * mw.x + dirt * mw.y + rock * mw.z + sand * mw.w;
col += plank * mw2.x + brick * mw2.y + glass * mw2.z;
float craft = mw2.x + mw2.y + mw2.z;

// 建材には雪も濡れも乗せない
// 高所、または寒冷バイオームの平坦なところに雪
float altSnow = smoothstep(62.0, 98.0, vWPos.y + n0.r * 20.0 - 10.0);
float coldSnow = smoothstep(0.32, 0.10, bTemp) * smoothstep(-1.0, 12.0, vWPos.y);
float snow = max(altSnow, coldSnow) * smoothstep(0.62, 0.20, slope) * (1.0 - craft);
col = mix(col, vec3(0.870, 0.910, 0.965) * (0.88 + 0.16 * n2.b), snow);

// 水面下は濡れて暗く、青みを帯びる
float wet = smoothstep(1.5, -3.0, vWPos.y - ${SEA_LEVEL.toFixed(1)}) * (1.0 - craft);
col = mix(col, col * vec3(0.50, 0.68, 0.82), wet * 0.6);

diffuseColor.rgb *= col;

gBump = (vec3(n3.r, n3.g, n3.b) - 0.5) * 0.95
      + (vec3(n2.r, n2.g, n2.b) - 0.5) * 0.80
      + (vec3(n1.b, n1.a, n1.r) - 0.5) * 0.40;
gBump *= 1.0 - snow * 0.55;
gBump *= 1.0 - craft * 0.6;
gRough = clamp(0.74 + 0.22 * n1.g - 0.30 * snow - 0.18 * mw.w - 0.55 * mw2.z, 0.06, 1.0);
`

/**
 * ガラスの面だけを描く透過マテリアル。
 * 地形メッシュは 1 つだが、`geometry.groups` でガラスの三角形だけ切り出して張る。
 */
export function createGlassMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0xbfe6f2,
    roughness: 0.05,
    metalness: 0,
    transparent: true,
    opacity: 0.3,
    // 半透明どうしの前後関係で破綻しないよう、深度は書かない
    depthWrite: false,
    side: THREE.DoubleSide,
  })
}

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
        vMatW2 = matw2;
        vBiome = abiome;
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
