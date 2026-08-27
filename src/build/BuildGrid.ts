import type { Box, Collider } from '../world/collision'
import { colliderBounds, obbOverlap, rayCollider } from '../world/collision'
import {
  PIECE_KINDS,
  isPanel,
  localBounds,
  normalizeYaw,
  pieceBounds,
  pieceColliders,
  snapPoints,
  yawFromRad,
  yawRad,
} from './pieces'
import type { Piece, PieceKind } from './pieces'

/** 置ける／置けない理由。 */
export type PlaceCheck = 'ok' | 'overlap' | 'unsupported'

/** 地形が固体かどうかを外から渡す（テストでは偽の地形を渡せる）。 */
export type SolidFn = (x: number, y: number, z: number) => boolean

/** 空間索引の 1 マス（m）。 */
const HASH_CELL = 3

/** 接続点を探す半径（m）。 */
export const SNAP_RANGE = 2

/**
 * 重なり判定で見る「本体」の割合。1 より小さいので、直角に交わる 2 枚の壁が
 * 角で食い込む程度は許され、同じ場所への二重置きだけが弾かれる。
 */
const OVERLAP_SCALE = 0.7

/** これだけ離れていても「接している」とみなす（m）。 */
const SUPPORT_REACH = 0.35

/**
 * 「食い込んでいる」とみなす縮め量。面を共有して接しているだけの姿勢を
 * 食い込み扱いにしないよう、わずかに縮めてから測る。
 */
const SINK_GROW = -0.01

/**
 * 既存パーツに食い込む姿勢の採点に足す距離（m）。
 * 置ける姿勢が複数あるとき、**めり込まない置き方**を先に選ばせるための重り。
 */
const SINK_PENALTY = 1.5

/** 重なり判定にかける吸着候補の数。近い順に見て、最初に通ったものを採る。 */
const SNAP_CANDIDATES = 10

/** 地形に直接置くときの水平方向の丸め（m）。 */
const GROUND_STEP = 0.25

export interface PieceHit {
  piece: Piece
  distance: number
  /** 当たった面の外向き法線（ワールド）。 */
  nx: number
  ny: number
  nz: number
}

export function createPieceHit(): PieceHit {
  return {
    piece: { kind: 'wall', x: 0, y: 0, z: 0, yaw: 0, mat: 0 },
    distance: 0,
    nx: 0,
    ny: 1,
    nz: 0,
  }
}

/** 近隣のパーツを `out` に**追記する**関数（{@link BuildGrid.neighbors}）。 */
export type PieceSource = (
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  out: Piece[],
) => void

export interface SnapResult {
  piece: Piece
  /** 吸着に使った接続点（ワールド）。地形に直接置くときは null。 */
  point: readonly number[] | null
}

/**
 * 置いた建築パーツの入れ物。
 *
 * three に依存しない。**「どこに置けるか」「何に当たるか」だけを持つ**ので、
 * 描画（{@link BuildManager}）を持ち込まずに単体テストできる。
 *
 * 格子には乗らない。パーツは連続座標と 5° 刻みのヨーを持ち、置くときは
 * **既存パーツの接続点に吸着して向きを継承する**（Valheim 方式）。
 * 接続点どうしを一致させるので、隣り合うパーツは角度が何度でも隙間なく噛み合う。
 */
export class BuildGrid {
  private readonly all = new Set<Piece>()
  private readonly cells = new Map<string, Piece[]>()
  /**
   * 使っているセルの範囲。問い合わせをここに切り詰めるので、
   * 「y は全部」のような広い範囲を渡されても空のセルを延々と走らない。
   */
  private readonly lo = [Infinity, Infinity, Infinity]
  private readonly hi = [-Infinity, -Infinity, -Infinity]

  /**
   * 自分が持っていない近隣のパーツを供給する（村の建物）。
   *
   * **置けるか・どこへ吸着するか・支えがあるか**の判定にだけ使う。
   * 当たり判定の収集やレイキャストには関わらない（そちらは持ち主それぞれが自分のぶんを出す）。
   * これがあるので、村の家の壁にそのまま建て増しができ、
   * 村の壁と同じ場所に二重置きすることもない。
   */
  neighbors: PieceSource | null = null

  private readonly seen = new Set<Piece>()
  private readonly nearScratch: Piece[] = []
  private readonly overlapScratch: Piece[] = []
  private readonly colsA: Collider[] = []
  private readonly colsB: Collider[] = []
  private readonly boundsA: Box = emptyBox()
  private readonly boundsB: Box = emptyBox()

  // 吸着候補（上位だけ残す小さな挿入ソート）
  private readonly candScore: number[] = []
  private readonly candPiece: Piece[] = []
  private readonly candPoint: number[] = []
  private readonly candOrder: number[] = []
  private readonly candSunk: number[] = []

  get count(): number {
    return this.all.size
  }

  pieces(): IterableIterator<Piece> {
    return this.all.values()
  }

  /** 置く。既存パーツと重なるなら false。 */
  place(p: Piece): boolean {
    if (this.overlaps(p)) return false
    this.insert(p)
    return true
  }

  /**
   * 重なりを調べずにまとめて入れる。**すでに整合していると分かっている一式**
   * （村の建物のように生成側が組み方を保証しているもの）を空間索引へ流し込むためのもので、
   * プレイヤーの設置には使わない（そちらは {@link place} が重なりを見る）。
   */
  fill(pieces: Iterable<Piece>): void {
    for (const p of pieces) this.insert(p)
  }

  /** 取り除く。取り除いたパーツを返す。 */
  remove(p: Piece): Piece | null {
    if (!this.all.has(p)) return null
    this.all.delete(p)
    this.eachCell(p, (list) => {
      const i = list.indexOf(p)
      if (i >= 0) list.splice(i, 1)
    })
    return p
  }

  clear(): void {
    this.all.clear()
    this.cells.clear()
    this.lo[0] = this.lo[1] = this.lo[2] = Infinity
    this.hi[0] = this.hi[1] = this.hi[2] = -Infinity
  }

  // ------------------------------------------------------------------ 空間索引

  private insert(p: Piece): void {
    this.all.add(p)
    this.eachCell(p, (list) => list.push(p))
  }

  /** パーツの外接箱がまたぐセルを巡る。 */
  private eachCell(p: Piece, fn: (list: Piece[]) => void): void {
    const b = pieceBounds(p, this.boundsA)
    const i0 = Math.floor(b.minX / HASH_CELL)
    const i1 = Math.floor(b.maxX / HASH_CELL)
    const j0 = Math.floor(b.minY / HASH_CELL)
    const j1 = Math.floor(b.maxY / HASH_CELL)
    const k0 = Math.floor(b.minZ / HASH_CELL)
    const k1 = Math.floor(b.maxZ / HASH_CELL)
    if (i0 < this.lo[0]) this.lo[0] = i0
    if (j0 < this.lo[1]) this.lo[1] = j0
    if (k0 < this.lo[2]) this.lo[2] = k0
    if (i1 > this.hi[0]) this.hi[0] = i1
    if (j1 > this.hi[1]) this.hi[1] = j1
    if (k1 > this.hi[2]) this.hi[2] = k1
    for (let k = k0; k <= k1; k++) {
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const key = `${i},${j},${k}`
          let list = this.cells.get(key)
          if (!list) {
            list = []
            this.cells.set(key, list)
          }
          fn(list)
        }
      }
    }
  }

  /** 指定の箱にかかるパーツを `out` に集める（重複なし）。 */
  piecesInBounds(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
    out: Piece[],
  ): Piece[] {
    out.length = 0
    return this.appendPiecesInBounds(minX, minY, minZ, maxX, maxY, maxZ, out)
  }

  /** {@link piecesInBounds} と同じだが `out` を空にせず**追記する**。 */
  appendPiecesInBounds(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
    out: Piece[],
  ): Piece[] {
    if (this.all.size === 0) return out
    const seen = this.seen
    seen.clear()
    // 使っているセルの範囲まで切り詰める
    const i0 = Math.max(this.lo[0], Math.floor(minX / HASH_CELL))
    const i1 = Math.min(this.hi[0], Math.floor(maxX / HASH_CELL))
    const j0 = Math.max(this.lo[1], Math.floor(minY / HASH_CELL))
    const j1 = Math.min(this.hi[1], Math.floor(maxY / HASH_CELL))
    const k0 = Math.max(this.lo[2], Math.floor(minZ / HASH_CELL))
    const k1 = Math.min(this.hi[2], Math.floor(maxZ / HASH_CELL))
    for (let k = k0; k <= k1; k++) {
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const list = this.cells.get(`${i},${j},${k}`)
          if (!list) continue
          for (const p of list) {
            if (seen.has(p)) continue
            seen.add(p)
            out.push(p)
          }
        }
      }
    }
    return out
  }

  // ------------------------------------------------------------ 置けるかどうか

  /** 置けるかどうかの判定に使うパーツ（自分のぶん＋{@link neighbors}）。 */
  private placementPieces(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
    out: Piece[],
  ): Piece[] {
    this.piecesInBounds(minX, minY, minZ, maxX, maxY, maxZ, out)
    this.neighbors?.(minX, minY, minZ, maxX, maxY, maxZ, out)
    return out
  }

  canPlace(p: Piece, isSolid: SolidFn): PlaceCheck {
    if (this.overlaps(p)) return 'overlap'
    return this.isSupported(p, isSolid) ? 'ok' : 'unsupported'
  }

  /**
   * 既存パーツの**本体**とめり込んでいるか。置けるかどうかの判定はこれで見る。
   * 直角に交わる 2 枚の壁が角で食い込む程度は本体の重なりではないので通る。
   */
  overlaps(p: Piece): boolean {
    return this.hits(p, 0, OVERLAP_SCALE)
  }

  /**
   * 既存パーツと交差しているか。`grow`/`scale` で「どこまでを重なりとみなすか」を変える。
   * 置けるかどうか（本体の重なり）にも、吸着候補の採点（わずかな食い込み）にも使う。
   */
  private hits(p: Piece, grow: number, scale: number): boolean {
    const b = pieceBounds(p, this.boundsA)
    this.placementPieces(b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ, this.overlapScratch)
    if (this.overlapScratch.length === 0) return false
    const mine = pieceColliders(p, this.colsA)
    for (const q of this.overlapScratch) {
      if (q === p) continue
      for (const qc of pieceColliders(q, this.colsB)) {
        for (const mc of mine) {
          if (obbOverlap(mc, qc, grow, scale)) return true
        }
      }
    }
    return false
  }

  /**
   * 地形か既存のパーツに接しているか。
   *
   * 判定は当たり判定そのものの重なりで見る。パーツの形を変えても支持の判定が
   * 自動で追従するし、角度が何度でも同じ規則が効く。
   */
  isSupported(p: Piece, isSolid: SolidFn): boolean {
    // 1. 地形。パーツの底面（回転後）の 4 隅と中心、その少し下を見る
    const local = localBounds(p.kind)
    const rad = yawRad(p.yaw)
    const frame: Collider = {
      ...local,
      minY: p.y + local.minY,
      maxY: p.y + local.maxY,
      ox: p.x,
      oz: p.z,
      cos: Math.cos(rad),
      sin: Math.sin(rad),
    }
    const eps = 0.05
    const cx = (local.minX + local.maxX) / 2
    const cz = (local.minZ + local.maxZ) / 2
    const lx = [local.minX + eps, local.maxX - eps, local.minX + eps, local.maxX - eps, cx]
    const lz = [local.minZ + eps, local.minZ + eps, local.maxZ - eps, local.maxZ - eps, cz]
    if (isSolid(frameX(frame, cx, cz), (frame.minY + frame.maxY) / 2, frameZ(frame, cx, cz))) {
      return true
    }
    for (const y of [frame.minY + eps, frame.minY - SUPPORT_REACH]) {
      for (let i = 0; i < 5; i++) {
        if (isSolid(frameX(frame, lx[i], lz[i]), y, frameZ(frame, lx[i], lz[i]))) return true
      }
    }

    // 2. 既存のパーツ
    const b = pieceBounds(p, this.boundsB)
    const r = SUPPORT_REACH
    this.placementPieces(
      b.minX - r,
      b.minY - r,
      b.minZ - r,
      b.maxX + r,
      b.maxY + r,
      b.maxZ + r,
      this.overlapScratch,
    )
    if (this.overlapScratch.length === 0) return false
    const mine = pieceColliders(p, this.colsA)
    for (const q of this.overlapScratch) {
      if (q === p) continue
      for (const qc of pieceColliders(q, this.colsB)) {
        for (const mc of mine) {
          if (obbOverlap(mc, qc, r)) return true
        }
      }
    }
    return false
  }

  // ------------------------------------------------------------------ 吸着

  /**
   * 照準の当たった点から、置くパーツの姿勢を決める。
   *
   * 1. 照準点の近くにある**既存パーツの接続点** A を集める
   * 2. 新しいパーツのヨー = A を持つパーツのヨー ＋ プレイヤーのオフセット
   * 3. 新しいパーツの接続点 B を A に合わせる姿勢を候補にする
   * 4. 中心が照準点にいちばん近い候補から順に、めり込まないものを選ぶ
   * 5. 接続点が届かなければ地形に直接置く（向きはカメラ基準、位置は粗く丸める）
   */
  snap(
    kind: PieceKind,
    mat: number,
    yawOffset: number,
    px: number,
    py: number,
    pz: number,
    camYaw: number,
  ): SnapResult {
    const local = localBounds(kind)
    const lcx = (local.minX + local.maxX) / 2
    const lcy = (local.minY + local.maxY) / 2
    const lcz = (local.minZ + local.maxZ) / 2
    const mine = snapPoints(kind)

    this.candScore.length = 0
    this.candPiece.length = 0
    this.candPoint.length = 0

    const r = SNAP_RANGE
    this.placementPieces(px - r, py - r, pz - r, px + r, py + r, pz + r, this.nearScratch)

    for (const q of this.nearScratch) {
      const qPts = snapPoints(q.kind)
      const qRad = yawRad(q.yaw)
      const qcos = Math.cos(qRad)
      const qsin = Math.sin(qRad)
      const yaw = normalizeYaw(q.yaw + yawOffset)
      const rad = yawRad(yaw)
      const cos = Math.cos(rad)
      const sin = Math.sin(rad)

      for (let i = 0; i < qPts.length; i += 3) {
        const ax = q.x + qPts[i] * qcos + qPts[i + 2] * qsin
        const ay = q.y + qPts[i + 1]
        const az = q.z - qPts[i] * qsin + qPts[i + 2] * qcos
        const d0 = Math.hypot(ax - px, ay - py, az - pz)
        if (d0 > r) continue

        for (let j = 0; j < mine.length; j += 3) {
          const bx = mine[j]
          const by = mine[j + 1]
          const bz = mine[j + 2]
          // 基準点 = A - R(yaw)·B、中心 = 基準点 + R(yaw)·(局所中心)
          const ddx = lcx - bx
          const ddz = lcz - bz
          const ccx = ax + ddx * cos + ddz * sin
          const ccy = ay + lcy - by
          const ccz = az - ddx * sin + ddz * cos
          // 照準点に中心が近い姿勢を優先し、遠い接続点はわずかに不利にする
          const score = Math.hypot(ccx - px, ccy - py, ccz - pz) + d0 * 0.35
          // 上位に入らない候補はパーツを作らずに捨てる（密な基地では候補が数千になる）
          const n = this.candScore.length
          if (n >= SNAP_CANDIDATES && score >= this.candScore[n - 1]) continue
          this.pushCandidate(
            score,
            {
              kind,
              x: ax - (bx * cos + bz * sin),
              y: ay - by,
              z: az - (-bx * sin + bz * cos),
              yaw,
              mat,
            },
            ax,
            ay,
            az,
          )
        }
      }
    }

    // 上位候補だけ、既存パーツへの食い込みを測って順位を入れ替える。
    // 「中心が照準点にいちばん近い」だけで選ぶと、床の辺を狙ったときに
    // 床へ半分めり込んだ壁が勝ってしまうので、めり込まない置き方を先に出す
    const n = this.candPiece.length
    this.candOrder.length = 0
    this.candSunk.length = 0
    for (let i = 0; i < n; i++) {
      this.candOrder.push(i)
      this.candSunk.push(
        this.candScore[i] + (this.hits(this.candPiece[i], SINK_GROW, 1) ? SINK_PENALTY : 0),
      )
    }
    this.candOrder.sort((a, b) => this.candSunk[a] - this.candSunk[b])

    for (const i of this.candOrder) {
      const cand = this.candPiece[i]
      if (this.overlaps(cand)) continue
      return { piece: cand, point: this.pointAt(i) }
    }

    // 全部めり込むなら、いちばん近い姿勢をそのまま返す（ゴーストが赤くなって理由が分かる）
    if (n > 0) {
      return { piece: this.candPiece[this.candOrder[0]], point: this.pointAt(this.candOrder[0]) }
    }

    // 接続点が届かないときは地形の上へ
    return { piece: this.groundPlacement(kind, mat, yawOffset, px, py, pz, camYaw), point: null }
  }

  /** 地形に直接置くときの姿勢。位置は粗く丸め、底面が照準点に乗るようにする。 */
  groundPlacement(
    kind: PieceKind,
    mat: number,
    yawOffset: number,
    px: number,
    py: number,
    pz: number,
    camYaw: number,
  ): Piece {
    return {
      kind,
      x: Math.round(px / GROUND_STEP) * GROUND_STEP,
      y: py - localBounds(kind).minY,
      z: Math.round(pz / GROUND_STEP) * GROUND_STEP,
      yaw: normalizeYaw(defaultYaw(kind, camYaw) + yawOffset),
      mat,
    }
  }

  private pointAt(i: number): number[] {
    return [this.candPoint[i * 3], this.candPoint[i * 3 + 1], this.candPoint[i * 3 + 2]]
  }

  /** 上位 {@link SNAP_CANDIDATES} 件だけを近い順に保つ。 */
  private pushCandidate(score: number, p: Piece, ax: number, ay: number, az: number): void {
    const n = this.candScore.length
    if (n >= SNAP_CANDIDATES && score >= this.candScore[n - 1]) return
    let i = n
    while (i > 0 && this.candScore[i - 1] > score) i--
    this.candScore.splice(i, 0, score)
    this.candPiece.splice(i, 0, p)
    this.candPoint.splice(i * 3, 0, ax, ay, az)
    if (this.candScore.length > SNAP_CANDIDATES) {
      this.candScore.pop()
      this.candPiece.pop()
      this.candPoint.length = SNAP_CANDIDATES * 3
    }
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
    out: Collider[],
    y0 = -1e5,
    y1 = 1e5,
  ): Collider[] {
    if (this.all.size === 0) return out
    this.piecesInBounds(x - r, y0, z - r, x + r, y1, z + r, this.overlapScratch)
    for (const p of this.overlapScratch) {
      for (const c of pieceColliders(p, this.colsB)) {
        const b = colliderBounds(c, this.boundsA)
        if (b.maxY <= y0 || b.minY >= y1) continue
        if (x < b.minX - r || x > b.maxX + r) continue
        if (z < b.minZ - r || z > b.maxZ + r) continue
        out.push({ ...c })
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
    if (this.all.size === 0) return null
    const ex = ox + dx * maxDist
    const ey = oy + dy * maxDist
    const ez = oz + dz * maxDist
    this.piecesInBounds(
      Math.min(ox, ex),
      Math.min(oy, ey),
      Math.min(oz, ez),
      Math.max(ox, ex),
      Math.max(oy, ey),
      Math.max(oz, ez),
      this.overlapScratch,
    )

    let best = maxDist
    let found = false
    for (const p of this.overlapScratch) {
      for (const c of pieceColliders(p, this.colsB)) {
        const t = rayCollider(ox, oy, oz, dx, dy, dz, c, best, NORMAL)
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
    return found ? out : null
  }

  /** 指定の点にいちばん近いパーツ（デバッグ／テスト用）。 */
  nearest(x: number, y: number, z: number, range: number): Piece | null {
    this.piecesInBounds(
      x - range,
      y - range,
      z - range,
      x + range,
      y + range,
      z + range,
      this.overlapScratch,
    )
    let best: Piece | null = null
    let bd = range
    for (const p of this.overlapScratch) {
      const b = pieceBounds(p, this.boundsA)
      const d = Math.hypot(
        x - clamp(x, b.minX, b.maxX),
        y - clamp(y, b.minY, b.maxY),
        z - clamp(z, b.minZ, b.maxZ),
      )
      if (d >= bd) continue
      bd = d
      best = p
    }
    return best
  }

  // -------------------------------------------------------------------- 保存

  /** `[種類, x, y, z, yaw, 素材, …]` の平坦な配列。 */
  serialize(): number[] {
    const out: number[] = []
    for (const p of this.all) {
      out.push(PIECE_KINDS.indexOf(p.kind), p.x, p.y, p.z, p.yaw, p.mat)
    }
    return out
  }

  /** 壊れた要素は 1 件ずつ捨てる（`Inventory.load` と同じ寛容さ）。 */
  load(data: unknown): void {
    this.clear()
    if (!Array.isArray(data)) return
    for (let i = 0; i + 5 < data.length; i += 6) {
      const kind = PIECE_KINDS[data[i]]
      if (!kind) continue
      const [x, y, z, yaw, mat] = data.slice(i + 1, i + 6) as number[]
      if (![x, y, z, yaw, mat].every((v) => typeof v === 'number' && Number.isFinite(v))) continue
      this.insert({ kind, x, y, z, yaw: normalizeYaw(yaw), mat: Math.round(mat) })
    }
  }

  /**
   * 格子だった頃の保存データ（`[種類, cx, cy, cz, rot, 素材]`）を読む。
   * セルの基準点と 90° 刻みの向きを、そのまま連続座標とヨーに移すだけ。
   */
  loadLegacy(data: unknown, cell: number): void {
    this.clear()
    if (!Array.isArray(data)) return
    for (let i = 0; i + 5 < data.length; i += 6) {
      const kind = PIECE_KINDS[data[i]]
      if (!kind) continue
      const [cx, cy, cz, rot, mat] = data.slice(i + 1, i + 6) as number[]
      if (![cx, cy, cz, rot, mat].every((v) => typeof v === 'number' && Number.isFinite(v))) continue
      const h = cell / 2
      const r = ((Math.round(rot) % 4) + 4) % 4
      let x: number
      let y: number
      let z: number
      let yaw: number
      if (isPanel(kind)) {
        // 板はセルの -x 面 / -z 面に立っていた
        yaw = (r & 1) * 18
        x = cx * cell + ((r & 1) === 0 ? 0 : h)
        y = cy * cell + h
        z = cz * cell + ((r & 1) === 0 ? h : 0)
      } else {
        yaw = kind === 'stair' || kind === 'roof' ? r * 18 : 0
        x = cx * cell + h
        y = cy * cell
        z = cz * cell + h
      }
      this.insert({ kind, x, y, z, yaw, mat: Math.round(mat) })
    }
  }
}

/**
 * 地形に直接置くときの既定の向き。
 * 板と家具は**プレイヤーの方を向き**、階段・屋根・妻壁は**プレイヤーから見て奥へ昇る**。
 */
export function defaultYaw(kind: PieceKind, camYaw: number): number {
  // 昇る向き・棟の向きを持つパーツはプレイヤーから見て奥へ、それ以外は手前を向く
  if (kind === 'stair' || kind === 'roof' || kind === 'gable') {
    return yawFromRad(camYaw + Math.PI / 2)
  }
  return yawFromRad(camYaw - Math.PI / 2)
}

const NORMAL = [0, 0, 0]

function frameX(c: Collider, lx: number, lz: number): number {
  return (c.ox ?? 0) + lx * (c.cos ?? 1) + lz * (c.sin ?? 0)
}

function frameZ(c: Collider, lx: number, lz: number): number {
  return (c.oz ?? 0) - lx * (c.sin ?? 0) + lz * (c.cos ?? 1)
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function emptyBox(): Box {
  return { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 }
}
