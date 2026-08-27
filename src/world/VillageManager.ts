import * as THREE from 'three'
import { VILLAGE_CELL } from './constants'
import type { DensityField } from './density'
import { BuildGrid } from '../build/BuildGrid'
import { villagePieces } from '../build/villagePieces'
import { pieceColliders } from '../build/pieces'
import { PieceRenderer } from '../render/PieceRenderer'
import type { Collider } from './collision'
import type { Village } from './village'

interface Built {
  village: Village
  /** この村の建物を組んでいる建築パーツ。 */
  pieces: ReturnType<typeof villagePieces>
  /** 当たり判定を引くための空間索引。プレイヤーが建てたパーツとまったく同じ仕組み。 */
  grid: BuildGrid
  colliders: number
}

/**
 * 村の建物をプレイヤーの周囲だけ生成・保持する。
 * 地形チャンクとは独立（村は 1 つでチャンクをまたぐため）で、
 * 敷地の平坦化そのものは密度場側が担当している。
 *
 * 建物の実体は**プレイヤーが使うのと同じ建築パーツ**（`build/villagePieces.ts` が展開する）。
 * 描画は `BuildManager` と同じ {@link PieceRenderer}、当たり判定は同じ {@link BuildGrid} なので、
 * 「村だけ別扱い」のコードはもう無い。
 */
export class VillageManager {
  readonly group: THREE.Group
  private readonly renderer = new PieceRenderer('villages')
  private readonly built = new Map<number, Built>()
  private readonly active: Built[] = []
  private lastCell = ''

  constructor(private readonly field: DensityField) {
    this.group = this.renderer.group
  }

  get activeCount(): number {
    return this.active.length
  }

  /** 読み込み済みの村が持つ当たり判定の総数。 */
  get colliderCount(): number {
    let n = 0
    for (const b of this.active) n += b.colliders
    return n
  }

  /** 読み込み済みの村を組んでいるパーツの総数。 */
  get pieceCount(): number {
    let n = 0
    for (const b of this.active) n += b.pieces.length
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
    let changed = false

    for (let vz = cz - reach; vz <= cz + reach; vz++) {
      for (let vx = cx - reach; vx <= cx + reach; vx++) {
        const v = this.field.village(vx, vz)
        if (!v) continue
        if (Math.hypot(px - v.cx, pz - v.cz) > range + v.radius * 1.3) continue
        wanted.add(v.key)
        if (this.built.has(v.key)) continue
        this.built.set(v.key, buildVillage(v))
        changed = true
      }
    }

    for (const [k, b] of this.built) {
      if (wanted.has(k)) continue
      b.grid.clear()
      this.built.delete(k)
      changed = true
    }

    if (!changed) return

    // 出入りがあった回（村のセルをまたいだときだけ）に、描画をまとめて張り替える
    this.renderer.clear()
    this.active.length = 0
    for (const b of this.built.values()) {
      this.active.push(b)
      for (const p of b.pieces) this.renderer.add(p)
    }
    this.renderer.rebuild()
  }

  /**
   * プレイヤー付近の当たり判定を集める。
   * `out` は**空にしてから**詰める（建てたパーツや軌道はこの後ろに足される）。
   */
  collidersNear(x: number, z: number, r: number, out: Collider[], y0?: number, y1?: number): Collider[] {
    out.length = 0
    for (const b of this.active) {
      if (Math.hypot(x - b.village.cx, z - b.village.cz) > b.village.radius * 1.4 + r) continue
      b.grid.collectColliders(x, z, r, out, y0, y1)
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

function buildVillage(v: Village): Built {
  const pieces = villagePieces(v)
  const grid = new BuildGrid()
  grid.fill(pieces)
  let colliders = 0
  const scratch: Collider[] = []
  for (const p of pieces) colliders += pieceColliders(p, scratch).length
  return { village: v, pieces, grid, colliders }
}
