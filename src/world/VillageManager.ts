import * as THREE from 'three'
import { VILLAGE_CELL } from './constants'
import type { DensityField } from './density'
import { buildVillageMesh, villageColliders } from '../render/villageBuilder'
import type { Box, Village } from './village'

interface Built {
  village: Village
  mesh: THREE.Mesh
  colliders: Box[]
}

/**
 * 村の建物をプレイヤーの周囲だけ生成・保持する。
 * 地形チャンクとは独立（村は 1 つでチャンクをまたぐため）で、
 * 敷地の平坦化そのものは密度場側が担当している。
 */
export class VillageManager {
  readonly group = new THREE.Group()
  private readonly built = new Map<number, Built>()
  private readonly active: Built[] = []
  private lastCell = ''

  constructor(private readonly field: DensityField) {
    this.group.name = 'villages'
  }

  get activeCount(): number {
    return this.active.length
  }

  /** 読み込み済みの村が持つ壁の当たり判定の総数。 */
  get colliderCount(): number {
    let n = 0
    for (const b of this.active) n += b.colliders.length
    return n
  }

  update(px: number, pz: number, range: number): void {
    const cx = Math.floor(px / VILLAGE_CELL)
    const cz = Math.floor(pz / VILLAGE_CELL)
    const key = `${cx},${cz},${Math.round(range)}`
    if (key === this.lastCell) return
    this.lastCell = key

    const reach = Math.ceil((range + VILLAGE_CELL) / VILLAGE_CELL)
    const wanted = new Set<number>()

    for (let vz = cz - reach; vz <= cz + reach; vz++) {
      for (let vx = cx - reach; vx <= cx + reach; vx++) {
        const v = this.field.village(vx, vz)
        if (!v) continue
        if (Math.hypot(px - v.cx, pz - v.cz) > range + v.radius * 1.3) continue
        wanted.add(v.key)
        if (this.built.has(v.key)) continue
        const mesh = buildVillageMesh(v)
        mesh.updateMatrix()
        this.group.add(mesh)
        this.built.set(v.key, { village: v, mesh, colliders: villageColliders(v) })
      }
    }

    for (const [k, b] of this.built) {
      if (wanted.has(k)) continue
      this.group.remove(b.mesh)
      b.mesh.geometry.dispose()
      this.built.delete(k)
    }

    this.active.length = 0
    for (const b of this.built.values()) this.active.push(b)
  }

  /** プレイヤー付近の壁の当たり判定を集める。 */
  collidersNear(x: number, z: number, r: number, out: Box[]): Box[] {
    out.length = 0
    for (const b of this.active) {
      if (Math.hypot(x - b.village.cx, z - b.village.cz) > b.village.radius * 1.4 + r) continue
      for (const box of b.colliders) {
        if (x < box.minX - r || x > box.maxX + r) continue
        if (z < box.minZ - r || z > box.maxZ + r) continue
        out.push(box)
      }
    }
    return out
  }

  /** 最寄りの村（デバッグ表示用）。 */
  nearest(x: number, z: number): Village | null {
    let best: Village | null = null
    let bestD = Infinity
    for (const b of this.active) {
      const d = Math.hypot(x - b.village.cx, z - b.village.cz)
      if (d < bestD) {
        bestD = d
        best = b.village
      }
    }
    return best
  }
}
