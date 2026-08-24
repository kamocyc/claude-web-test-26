import * as THREE from 'three'

/** 実際に灯す THREE のライトの数。多すぎると描画コストが跳ねる。 */
const MAX_LIGHTS = 6
const LIGHT_RANGE = 26

export interface Torch {
  x: number
  y: number
  z: number
  /** 壁付けの向き（ラジアン）。 */
  yaw: number
}

/**
 * 置いた松明。
 *
 * 見た目は全部の松明に出すが、実際の `PointLight` は近い順に
 * {@link MAX_LIGHTS} 個だけ使い回す。three のライト数は
 * シェーダのコンパイル単位に効くので、増やしたり減らしたりしない。
 */
export class TorchManager {
  readonly group = new THREE.Group()
  readonly torches: Torch[] = []

  private readonly lights: THREE.PointLight[] = []
  private readonly stickGeo = new THREE.CylinderGeometry(0.045, 0.055, 0.5, 6)
  private readonly flameGeo = new THREE.SphereGeometry(0.1, 8, 6)
  private readonly stickMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2c, roughness: 0.9 })
  private readonly flameMat = new THREE.MeshStandardMaterial({
    color: 0x000000,
    emissive: 0xffb454,
    emissiveIntensity: 3.2,
  })
  private readonly meshes: THREE.Object3D[] = []
  private flicker = 0

  constructor(scene: THREE.Scene) {
    this.group.name = 'torches'
    scene.add(this.group)
    for (let i = 0; i < MAX_LIGHTS; i++) {
      const l = new THREE.PointLight(0xffb163, 0, LIGHT_RANGE, 1.6)
      l.visible = false
      scene.add(l)
      this.lights.push(l)
    }
  }

  get count(): number {
    return this.torches.length
  }

  add(x: number, y: number, z: number, yaw: number): Torch {
    const t: Torch = { x, y, z, yaw }
    this.torches.push(t)
    this.build(t)
    return t
  }

  /** 指定座標にいちばん近い松明を、範囲内なら取り除く。 */
  removeNear(x: number, y: number, z: number, range: number): Torch | null {
    let best = -1
    let bd = range
    for (let i = 0; i < this.torches.length; i++) {
      const t = this.torches[i]
      const d = Math.hypot(t.x - x, t.y - y, t.z - z)
      if (d < bd) {
        bd = d
        best = i
      }
    }
    if (best < 0) return null
    const t = this.torches[best]
    this.torches.splice(best, 1)
    this.group.remove(this.meshes[best])
    this.meshes.splice(best, 1)
    return t
  }

  clear(): void {
    for (const m of this.meshes) this.group.remove(m)
    this.meshes.length = 0
    this.torches.length = 0
  }

  load(list: Torch[]): void {
    this.clear()
    for (const t of list) {
      if (!Number.isFinite(t.x) || !Number.isFinite(t.y) || !Number.isFinite(t.z)) continue
      this.add(t.x, t.y, t.z, Number.isFinite(t.yaw) ? t.yaw : 0)
    }
  }

  private build(t: Torch): void {
    const g = new THREE.Group()
    const stick = new THREE.Mesh(this.stickGeo, this.stickMat)
    stick.position.y = 0.25
    stick.rotation.z = 0.22
    g.add(stick)
    const flame = new THREE.Mesh(this.flameGeo, this.flameMat)
    flame.position.set(-0.11, 0.52, 0)
    g.add(flame)
    g.position.set(t.x, t.y, t.z)
    g.rotation.y = t.yaw
    this.group.add(g)
    this.meshes.push(g)
  }

  /** 近い松明にだけライトを割り当てる。 */
  update(dt: number, px: number, py: number, pz: number): void {
    this.flicker += dt * 9
    const near: { t: Torch; d: number }[] = []
    for (const t of this.torches) {
      const d = Math.hypot(t.x - px, t.y - py, t.z - pz)
      if (d < LIGHT_RANGE * 1.6) near.push({ t, d })
    }
    near.sort((a, b) => a.d - b.d)
    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i]
      const n = near[i]
      if (!n) {
        l.visible = false
        continue
      }
      l.visible = true
      l.position.set(n.t.x - 0.11, n.t.y + 0.52, n.t.z)
      l.intensity = 9 + Math.sin(this.flicker + i * 2.1) * 1.6
    }
  }
}
