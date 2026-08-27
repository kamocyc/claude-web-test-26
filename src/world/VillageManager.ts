import * as THREE from 'three'
import { VILLAGE_CELL } from './constants'
import type { DensityField } from './density'
import { BuildGrid, createPieceHit } from '../build/BuildGrid'
import type { PieceHit } from '../build/BuildGrid'
import { villagePieces } from '../build/villagePieces'
import { pieceColliders } from '../build/pieces'
import type { Piece } from '../build/pieces'
import { PieceRenderer } from '../render/PieceRenderer'
import type { Collider } from './collision'
import type { Village } from './village'

interface Built {
  village: Village
  /** この村の建物を組んでいる建築パーツ（取り壊したぶんは入っていない）。 */
  pieces: Piece[]
  /**
   * パーツ → **生成時の並びの何番目か**。
   * `villagePieces()` は決定論的なので、この番号が「どのパーツを壊したか」の
   * 保存 ID になる（村そのものはシードから作り直せる）。
   */
  index: Map<Piece, number>
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
  /** 取り壊したパーツ。村ごとに「生成時の並びの何番目か」で覚える。 */
  private readonly razed = new Map<number, Set<number>>()
  private readonly hit = createPieceHit()
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
        this.built.set(v.key, buildVillage(v, this.razed.get(v.key)))
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

  /**
   * 指定の箱にかかる村のパーツを `out` に**追記する**。
   * `BuildGrid.neighbors` に渡して、村の壁への吸着と二重置きの防止に使う。
   */
  piecesInBounds(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
    out: Piece[],
  ): void {
    for (const b of this.active) {
      b.grid.appendPiecesInBounds(minX, minY, minZ, maxX, maxY, maxZ, out)
    }
  }

  /**
   * 指定の点にいちばん近い村のパーツ（テスト用）。
   * 村どうしは数百 m 離れているので、数 m の範囲に入る村は高々 1 つ。
   */
  nearestPiece(x: number, y: number, z: number, range: number): Piece | null {
    for (const b of this.active) {
      const p = b.grid.nearest(x, y, z, range)
      if (p) return p
    }
    return null
  }

  /**
   * 村の建物にレイを当てる。プレイヤーが建てたパーツと同じ {@link PieceHit} を返すので、
   * 建築モードは「自分のパーツか村の建物か」を距離だけで選べる。
   */
  raycast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDist: number,
  ): PieceHit | null {
    let best: PieceHit | null = null
    for (const b of this.active) {
      const h = b.grid.raycast(ox, oy, oz, dx, dy, dz, best ? best.distance : maxDist, this.hit)
      if (h) best = h
    }
    return best
  }

  /**
   * 村の建物のパーツを 1 枚取り壊す。取り壊したパーツを返す。
   *
   * 村はシードから作り直せるので、**壊した番号だけ**を覚えておけば復元できる
   * （壊した家が読み込み直しで元に戻らない）。
   */
  remove(p: Piece): Piece | null {
    for (const b of this.active) {
      const i = b.index.get(p)
      if (i === undefined) continue
      if (!b.grid.remove(p)) return null
      b.index.delete(p)
      b.pieces.splice(b.pieces.indexOf(p), 1)
      b.colliders -= pieceColliders(p, SCRATCH).length
      let set = this.razed.get(b.village.key)
      if (!set) {
        set = new Set<number>()
        this.razed.set(b.village.key, set)
      }
      set.add(i)
      this.renderer.remove(p)
      this.renderer.rebuild()
      return p
    }
    return null
  }

  /** 取り壊した記録。`[村キー, 枚数, 番号…]` の平坦な配列。 */
  serialize(): number[] {
    const out: number[] = []
    for (const [key, set] of this.razed) {
      if (set.size === 0) continue
      out.push(key, set.size)
      for (const i of set) out.push(i)
    }
    return out
  }

  /**
   * 取り壊した記録を読む。長さ付きの形式なので、辻褄が合わなくなったらそこで打ち切る
   * （途中から読み直しようがない）。壊れていても落ちはしない。
   */
  load(data: unknown): void {
    this.razed.clear()
    if (!Array.isArray(data)) {
      this.forget()
      return
    }
    let i = 0
    while (i + 1 < data.length) {
      const key = data[i]
      const n = data[i + 1]
      i += 2
      if (!Number.isFinite(key) || !Number.isInteger(n) || n < 0 || i + n > data.length) break
      const set = new Set<number>()
      for (let k = 0; k < n; k++) {
        const v = data[i + k]
        if (Number.isInteger(v) && v >= 0) set.add(v)
      }
      i += n
      if (set.size > 0) this.razed.set(key, set)
    }
    this.forget()
  }

  /** 読み込み済みの村を捨てて、次の {@link update} で組み直させる。 */
  private forget(): void {
    this.built.clear()
    this.active.length = 0
    this.renderer.clear()
    this.renderer.rebuild()
    this.lastCell = ''
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

function buildVillage(v: Village, razed: Set<number> | undefined): Built {
  const all = villagePieces(v)
  const pieces: Piece[] = []
  const index = new Map<Piece, number>()
  for (let i = 0; i < all.length; i++) {
    if (razed?.has(i)) continue
    pieces.push(all[i])
    index.set(all[i], i)
  }
  const grid = new BuildGrid()
  grid.fill(pieces)
  let colliders = 0
  for (const p of pieces) colliders += pieceColliders(p, SCRATCH).length
  return { village: v, pieces, index, grid, colliders }
}

const SCRATCH: Collider[] = []
