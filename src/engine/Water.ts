import * as THREE from 'three'
import { SEA_LEVEL } from '../world/constants'

const WAVE = /* glsl */ `
// 3 つの正弦波の合成。導関数も同時に求めて法線を作る。
float waveAt(vec2 p, float t, out vec2 grad) {
  float a1 = 0.155, a2 = 0.115, a3 = 0.20;
  float k1 = 0.120, k2 = 0.171, k3 = 0.068;
  float s1 = sin(p.x * k1 + t * 0.85);
  float s2 = sin(p.y * k2 - t * 1.06);
  float s3 = sin((p.x + p.y) * k3 + t * 0.55);
  grad.x = cos(p.x * k1 + t * 0.85) * k1 * a1 + cos((p.x + p.y) * k3 + t * 0.55) * k3 * a3;
  grad.y = cos(p.y * k2 - t * 1.06) * k2 * a2 + cos((p.x + p.y) * k3 + t * 0.55) * k3 * a3;
  return s1 * a1 + s2 * a2 + s3 * a3;
}
`

/**
 * 海面。ボクセル地形と違ってここは単純な平面で十分だが、
 * 頂点シェーダで波打たせて法線も付けることで滑らかな水面になる。
 */
export class Water {
  readonly mesh: THREE.Mesh
  readonly material: THREE.MeshStandardMaterial
  private time = { value: 0 }

  constructor(size = 4000, segments = 160) {
    const geo = new THREE.PlaneGeometry(size, size, segments, segments)
    geo.rotateX(-Math.PI / 2) // ジオメトリ自体を寝かせて object 空間 = world 向きに揃える

    this.material = new THREE.MeshStandardMaterial({
      color: 0x2e6f95,
      roughness: 0.06,
      metalness: 0.02,
      transparent: true,
      opacity: 0.78,
      side: THREE.DoubleSide,
    })

    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.time
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\nuniform float uTime;\n${WAVE}`)
        .replace(
          '#include <beginnormal_vertex>',
          `#include <beginnormal_vertex>
          vec3 wpos0 = (modelMatrix * vec4(position, 1.0)).xyz;
          vec2 wgrad;
          float wh = waveAt(wpos0.xz, uTime, wgrad);
          objectNormal = normalize(vec3(-wgrad.x, 1.0, -wgrad.y));`,
        )
        .replace('#include <begin_vertex>', `#include <begin_vertex>\ntransformed.y += wh;`)
    }

    this.mesh = new THREE.Mesh(geo, this.material)
    this.mesh.position.y = SEA_LEVEL
    this.mesh.renderOrder = 5
    this.mesh.receiveShadow = false
    this.mesh.castShadow = false
    this.mesh.frustumCulled = false
  }

  update(dt: number, cameraPos: THREE.Vector3): void {
    this.time.value += dt
    this.mesh.position.x = cameraPos.x
    this.mesh.position.z = cameraPos.z
  }

  /** 与えられた高さが水中かどうか（波の高さは無視した近似）。 */
  static isUnderwater(y: number): boolean {
    return y < SEA_LEVEL
  }
}
