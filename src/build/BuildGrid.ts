import type { Box } from '../world/village'
import {
  BUILD_CELL,
  PIECE_KINDS,
  cellOf,
  isPanel,
  normalizeRot,
  pieceBounds,
  pieceBoxes,
  slotKey,
} from './pieces'
import type { Piece, PieceKind } from './pieces'

/** 置ける／置けない理由。 */
export type PlaceCheck = 'ok' | 'occupied' | 'unsupported'

/** 地形が固体かどうかを外から渡す（テストでは偽の地形を渡せる）。 */
export type SolidFn = (x: number, y: number, z: number) => boolean

/** これだけ離れていても「接している」とみなす（m）。 */
const SUPPORT_REACH = 0.35

/** 1 セルが持ちうるスロット。 */
const SLOTS = ['wx', 'wz', 'f', 'v'] as const

export interface PieceHit {
  piece: Piece
  distance: number
  /** 当たった面の外向き法線。 */
  nx: number
  ny: number
  nz: number
}

export function createPieceHit(): PieceHit {
  return { piece: { kind: 'wall', cx: 0, cy: 0, cz: 0, rot: 0, mat: 0 }, distance: 0, nx: 0, ny: 1, nz: 0 }
}

/**
 * 建築パーツの置き場。
 *
 * three に依存しない。**「どこに置けるか」「何に当たるか」だけを持つ**ので、
 * 描画（{@link BuildManager}）を持ち込まずに単体テストできる。
 *
 * パーツはセルの 4 つのスロット（-x 面の板 / -z 面の板 / 床 / 体積）のどれかを占める。
 * 壁は必ず小さい方のセルの面へ正規化されるので、隣のセルから置いても同じスロットになり、
 * 同じ面に 2 枚重なることが起きない。
 */
export class BuildGrid {
  private readonly slots = new Map<string, Piece>()
  private readonly scratch: Box[] = []

  get count(): number {
    return this.slots.size
  }

  pieces(): IterableIterator<Piece> {
    return this.slots.values()
  }

  get(key: string): Piece | undefined {
    return this.slots.get(key)
  }

  /** 置く。すでに埋まっていれば false。 */
  place(p: Piece): boolean {
    const key = slotKey(p)
    if (this.slots.has(key)) return false
    this.slots.set(key, p)
    return true
  }

  /** 取り除く。取り除いたパーツを返す。 */
  remove(p: Piece): Piece | null {
    const key = slotKey(p)
    const cur = this.slots.get(key)
    if (!cur) return null
    this.slots.delete(key)
    return cur
  }

  clear(): void {
    this.slots.clear()
  }

  // ------------------------------------------------------------ 置けるかどうか

  canPlace(p: Piece, isSolid: SolidFn): PlaceCheck {
    if (this.slots.has(slotKey(p))) return 'occupied'
    return this.isSupported(p, isSolid) ? 'ok' : 'unsupported'
  }

  /**
   * 地形か既存のパーツに接しているか。
   *
   * スロットの隣接表は持たず、**当たり判定の箱の重なりでそのまま見る**。
   * パーツの形が変わっても支持の判定が自動で追従するし、表の書き漏らしも起きない。
   */
  isSupported(p: Piece, isSolid: SolidFn): boolean {
    const b = pieceBounds(p)
    const eps = 0.05
    const cxs = [b.minX + eps, (b.minX + b.maxX) / 2, b.maxX - eps]
    const czs = [b.minZ + eps, (b.minZ + b.maxZ) / 2, b.maxZ - eps]

    // 1. 地形。底面のすぐ内側と、その少し下を見る（斜面に食い込ませた壁も支持される）
    if (isSolid((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2)) return true
    for (const y of [b.minY + eps, b.minY - SUPPORT_REACH]) {
      for (let i = 0; i < 3; i++) {
        // 4 隅と中心の 5 点
        const x = cxs[i]
        const z = czs[i]
        if (isSolid(x, y, z)) return true
        if (i !== 1 && isSolid(cxs[i], y, czs[2 - i])) return true
      }
    }

    // 2. 既存のパーツ
    const boxes = pieceBoxes(p, [])
    for (let cz = p.cz - 1; cz <= p.cz + 1; cz++) {
      for (let cy = p.cy - 1; cy <= p.cy + 1; cy++) {
        for (let cx = p.cx - 1; cx <= p.cx + 1; cx++) {
          for (const slot of SLOTS) {
            const q = this.slots.get(`${slot}|${cx},${cy},${cz}`)
            if (!q) continue
            for (const qb of pieceBoxes(q, this.scratch)) {
              for (const pb of boxes) {
                if (overlaps(pb, qb, SUPPORT_REACH)) return true
              }
            }
          }
        }
      }
    }
    return false
  }

  // ------------------------------------------------------------------ 当たり判定

  /**
   * 付近のパーツの当たり判定を `out` に**追記する**。
   * 村の建物（`VillageManager.collidersNear`）が `out` を空にしてから詰めるので、
   * その後ろに足せるようにしてある。
   */
  collectColliders(
    x: number,
    z: number,
    r: number,
    out: Box[],
    y0 = -Infinity,
    y1 = Infinity,
  ): Box[] {
    if (this.slots.size === 0) return out
    const ci0 = cellOf(x - r) - 1
    const ci1 = cellOf(x + r) + 1
    const ck0 = cellOf(z - r) - 1
    const ck1 = cellOf(z + r) + 1
    const cj0 = Number.isFinite(y0) ? cellOf(y0) - 1 : cellOf(-64)
    const cj1 = Number.isFinite(y1) ? cellOf(y1) + 1 : cellOf(320)

    for (let cz = ck0; cz <= ck1; cz++) {
      for (let cy = cj0; cy <= cj1; cy++) {
        for (let cx = ci0; cx <= ci1; cx++) {
          for (const slot of SLOTS) {
            const p = this.slots.get(`${slot}|${cx},${cy},${cz}`)
            if (!p) continue
            for (const b of pieceBoxes(p, this.scratch)) {
              if (b.maxY <= y0 || b.minY >= y1) continue
              if (x < b.minX - r || x > b.maxX + r) continue
              if (z < b.minZ - r || z > b.maxZ + r) continue
              out.push({ ...b })
            }
          }
        }
      }
    }
    return out
  }

  /** 手前のパーツにレイを当てる。 */
  raycast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDist: number,
    out: PieceHit,
  ): PieceHit | null {
    if (this.slots.size === 0) return null
    const ex = ox + dx * maxDist
    const ey = oy + dy * maxDist
    const ez = oz + dz * maxDist
    const ci0 = cellOf(Math.min(ox, ex)) - 1
    const ci1 = cellOf(Math.max(ox, ex)) + 1
    const cj0 = cellOf(Math.min(oy, ey)) - 1
    const cj1 = cellOf(Math.max(oy, ey)) + 1
    const ck0 = cellOf(Math.min(oz, ez)) - 1
    const ck1 = cellOf(Math.max(oz, ez)) + 1

    let best = maxDist
    let found = false
    for (let cz = ck0; cz <= ck1; cz++) {
      for (let cy = cj0; cy <= cj1; cy++) {
        for (let cx = ci0; cx <= ci1; cx++) {
          for (const slot of SLOTS) {
            const p = this.slots.get(`${slot}|${cx},${cy},${cz}`)
            if (!p) continue
            for (const b of pieceBoxes(p, this.scratch)) {
              const t = rayBox(ox, oy, oz, dx, dy, dz, b, best, NORMAL)
              if (t === null || t >= best) continue
              best = t
              found = true
              out.piece = p
              out.distance = t
              out.nx = NORMAL[0]
              out.ny = NORMAL[1]
              out.nz = NORMAL[2]
            }
          }
        }
      }
    }
    return found ? out : null
  }

  /** 指定の点にいちばん近いパーツ（デバッグ／テスト用）。 */
  nearest(x: number, y: number, z: number, range: number): Piece | null {
    let best: Piece | null = null
    let bd = range
    const ci0 = cellOf(x - range)
    const ci1 = cellOf(x + range)
    const cj0 = cellOf(y - range)
    const cj1 = cellOf(y + range)
    const ck0 = cellOf(z - range)
    const ck1 = cellOf(z + range)
    for (let cz = ck0; cz <= ck1; cz++) {
      for (let cy = cj0; cy <= cj1; cy++) {
        for (let cx = ci0; cx <= ci1; cx++) {
          for (const slot of SLOTS) {
            const p = this.slots.get(`${slot}|${cx},${cy},${cz}`)
            if (!p) continue
            const b = pieceBounds(p)
            const d = Math.hypot(
              x - clamp(x, b.minX, b.maxX),
              y - clamp(y, b.minY, b.maxY),
              z - clamp(z, b.minZ, b.maxZ),
            )
            if (d >= bd) continue
            bd = d
            best = p
          }
        }
      }
    }
    return best
  }

  // -------------------------------------------------------------------- 保存

  /** `[種類, cx, cy, cz, rot, 素材, …]` の平坦な配列。 */
  serialize(): number[] {
    const out: number[] = []
    for (const p of this.slots.values()) {
      out.push(PIECE_KINDS.indexOf(p.kind), p.cx, p.cy, p.cz, p.rot, p.mat)
    }
    return out
  }

  /** 壊れた要素は 1 件ずつ捨てる（`Inventory.load` と同じ寛容さ）。 */
  load(data: unknown): void {
    this.slots.clear()
    if (!Array.isArray(data)) return
    for (let i = 0; i + 5 < data.length; i += 6) {
      const kind = PIECE_KINDS[data[i]]
      if (!kind) continue
      const [cx, cy, cz, rot, mat] = data.slice(i + 1, i + 6) as number[]
      if (![cx, cy, cz, rot, mat].every((v) => typeof v === 'number' && Number.isFinite(v))) continue
      this.place({
        kind,
        cx: Math.round(cx),
        cy: Math.round(cy),
        cz: Math.round(cz),
        rot: normalizeRot(kind, Math.round(rot)),
        mat: Math.round(mat),
      })
    }
  }
}

/**
 * 照準の当たった点を、そのパーツ種類のスロットへ吸着させる。
 *
 * 面の外側へわずかに出した点を基準にするので、
 * 「見ている面の手前側のセル」が素直に選ばれる。
 */
export function snapPiece(
  kind: PieceKind,
  px: number,
  py: number,
  pz: number,
  nx: number,
  ny: number,
  nz: number,
  rot: number,
  mat: number,
): Piece {
  const C = BUILD_CELL
  const qx = px + nx * 0.15
  const qy = py + ny * 0.15
  const qz = pz + nz * 0.15

  if (isPanel(kind)) {
    // 最寄りの鉛直グリッド面に立てる。x 面と z 面のうち近い方を選ぶ
    const gx = Math.round(qx / C)
    const gz = Math.round(qz / C)
    const dx = Math.abs(qx - gx * C)
    const dz = Math.abs(qz - gz * C)
    if (dx <= dz) {
      return { kind, cx: gx, cy: cellOf(qy), cz: cellOf(qz), rot: 0, mat }
    }
    return { kind, cx: cellOf(qx), cy: cellOf(qy), cz: gz, rot: 1, mat }
  }

  if (kind === 'floor') {
    // 床は最寄りの水平グリッド面へ。1 階の床と 2 階の床が同じ高さに揃う
    return { kind, cx: cellOf(qx), cy: Math.round(qy / C), cz: cellOf(qz), rot: 0, mat }
  }

  return {
    kind,
    cx: cellOf(qx),
    cy: cellOf(qy),
    cz: cellOf(qz),
    rot: normalizeRot(kind, rot),
    mat,
  }
}

const NORMAL = [0, 0, 0]

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function overlaps(a: Box, b: Box, grow: number): boolean {
  return (
    a.minX - grow < b.maxX &&
    a.maxX + grow > b.minX &&
    a.minY - grow < b.maxY &&
    a.maxY + grow > b.minY &&
    a.minZ - grow < b.maxZ &&
    a.maxZ + grow > b.minZ
  )
}

/**
 * レイと軸平行ボックスのスラブ法。入射距離を返し、`normal` にその面の外向き法線を入れる。
 * 中にいるときは 0 を返す。
 */
function rayBox(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  b: Box,
  maxT: number,
  normal: number[],
): number | null {
  let tmin = 0
  let tmax = maxT
  let axis = -1
  let sign = 1
  const o = [ox, oy, oz]
  const d = [dx, dy, dz]
  const lo = [b.minX, b.minY, b.minZ]
  const hi = [b.maxX, b.maxY, b.maxZ]
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < lo[i] || o[i] > hi[i]) return null
      continue
    }
    let t1 = (lo[i] - o[i]) / d[i]
    let t2 = (hi[i] - o[i]) / d[i]
    let s = -1
    if (t1 > t2) {
      const tmp = t1
      t1 = t2
      t2 = tmp
      s = 1
    }
    if (t1 > tmin) {
      tmin = t1
      axis = i
      sign = s
    }
    if (t2 < tmax) tmax = t2
    if (tmin > tmax) return null
  }
  normal[0] = 0
  normal[1] = 0
  normal[2] = 0
  if (axis >= 0) normal[axis] = sign
  return tmin
}
