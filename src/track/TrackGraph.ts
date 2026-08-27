import type { Box } from '../world/village'
import type { Collider } from '../world/collision'
import { colliderBounds, obbOverlap, rayCollider } from '../world/collision'
import {
  DECK_T,
  GRADE_TOL,
  MAX_SEG_LEN,
  MIN_SEG_LEN,
  TRACK_INFO,
  TRACK_KINDS,
  clampFit,
  clampRise,
  normalizeAngle,
  sampleCount,
  sampleSegment,
  segmentBounds,
  segmentColliders,
  segmentEnd,
  solveArc,
} from './track'
import type { Segment, TrackKind } from './track'

/** 敷ける／敷けない理由。 */
export type TrackCheck = 'ok' | 'overlap' | 'buried' | 'toohigh' | 'kink' | 'blocked'

/**
 * 区間を短く切り詰めた理由（切り詰めていなければ `'none'`）。
 * 敷けはするが狙った長さに届かなかった、というときの説明に使う。
 */
export type TrackTrim = 'none' | 'buried' | 'toohigh' | 'blocked'

/** 地面の高さを外から渡す（テストでは偽の地形を渡せる）。 */
export type GroundFn = (x: number, z: number) => number

/** その点が固体かどうか。掘った跡も反映される。 */
export type SolidFn = (x: number, y: number, z: number) => boolean

/**
 * 付近の障害物（村の建物・建てたパーツ）の当たり判定を集める。
 * `VillageManager.collidersNear` と同じ約束で、**`out` を空にしてから詰める**。
 */
export type ObstacleFn = (x: number, z: number, r: number, out: Collider[]) => Collider[]

/**
 * 敷設の可否を測るための地形。
 *
 * `ground` は橋脚の高さと切り盛りの量を見るための地表面。
 * `solid` を渡すと「軌道の上に地面が被っているか」をそちらで見るので、
 * **プレイヤーが掘った切通しがそのまま反映される**。渡さなければ `ground` で代用する。
 * `obstacles` を渡すと、家や建てたパーツにぶつかる区間も見つけられる。
 */
export interface Terrain {
  ground: GroundFn
  solid?: SolidFn
  obstacles?: ObstacleFn
}

/** 空間索引の 1 マス（m）。 */
const HASH_CELL = 6

/** 端点が「同じ場所」とみなされる距離（m）。 */
export const JOIN_EPS = 0.35

/** 狙点の近くの端点に繋ぎに行く距離（m）。 */
export const JOIN_RANGE = 2.5

/** 繋ぐときに許す向きの食い違い（ラジアン）。これを超えると折れ目扱い。 */
export const JOIN_MAX_ANGLE = (20 * Math.PI) / 180

/** 段差を直したとみなす余裕（m）。切土の限界ちょうどの地面を弾かないための遊び。 */
const GRADE_SLACK = 0.05

/** 橋脚の高さの上限（m）。 */
export const MAX_PILLAR = 14

/**
 * 重なり判定で見る「本体」の割合。{@link BuildGrid} と同じ考え方で、
 * 端点で接するだけの区間どうしは通し、面で重なる二重敷きだけを弾く。
 */
const OVERLAP_SCALE = 0.7

/**
 * 障害物との当たりを見るときの余裕（m）。
 *
 * こちらは**縮めずに等倍**で見る。中心寄りだけを見る {@link OVERLAP_SCALE} の縮め方は
 * 高さ方向にも効くので、地面に建つ壁と地面に載る路盤のように
 * 「底面どうしが揃っているもの」が離れてしまう。かすっただけで弾かないよう、
 * ほんの少し縮めるだけにする。
 */
const OBSTACLE_GROW = -0.06

/**
 * 軌道の端点。`yaw` は**そこから先へ伸ばす向き**なので、
 * 終端ならその区間の終端の向き、始端なら区間の向きの反対になる。
 */
export interface TrackEnd {
  seg: Segment
  /** 終端側なら true。 */
  atEnd: boolean
  x: number
  y: number
  z: number
  yaw: number
}

export interface TrackHit {
  seg: Segment
  distance: number
}

/** 敷設の見積もり。ゴーストと実際の設置はどちらもこれを通る。 */
export interface TrackPlan {
  seg: Segment
  /** 伸ばした元の端点（新しい線を始めるときは null）。 */
  from: TrackEnd | null
  /** 終端を繋いだ相手（繋いでいなければ null）。 */
  joinTo: TrackEnd | null
  check: TrackCheck
  /** 切り詰める前に狙っていた長さ（m）。 */
  wanted: number
  /** 切り詰めた理由。`'none'` なら狙った長さのまま。 */
  trim: TrackTrim
}

export interface PlanRequest {
  kind: TrackKind
  mat: number
  /**
   * ホイールで決める 1 区間の長さ（m）。
   *
   * **狙点は「どちらへ曲がるか」だけを決める**ので、狙点が手前にあっても
   * 区間はこの長さまで伸びる（届く範囲は 9 m しかないのに 24 m の線を敷きたい、
   * という当たり前のことができるように）。繋ぎに行くときだけは相手までの長さになる。
   */
  maxLen: number
  /** 伸ばす元の端点。null なら狙点から新しい線を始める。 */
  railhead: TrackEnd | null
  aimX: number
  /** 狙点の高さ。地形を狙ったときは**地表の高さ**をそのまま渡す（路盤の厚みは中で足す）。 */
  aimY: number
  aimZ: number
  /** 狙点が既に敷いてある軌道の上なら true（その高さをそのまま軌道面として使う）。 */
  aimOnTrack?: boolean
  camYaw: number
  /**
   * 勾配（1 = 45°）。`null`（既定）なら**終点の地面に合わせて自動**で決める。
   * 数を渡すとその勾配で伸ばす（種類ごとの上限でクランプされる）。
   */
  grade?: number | null
  terrain: Terrain
}

/**
 * 敷いた軌道の入れ物。
 *
 * three に依存しない。**「どこへ敷けるか」「何に当たるか」だけを持つ**ので、
 * 描画（{@link TrackManager}）を持ち込まずに単体テストできる。作りは
 * {@link BuildGrid} と揃えてある（空間ハッシュ・使用セル範囲・スクラッチ配列）。
 */
export class TrackGraph {
  private readonly all = new Set<Segment>()
  private readonly cells = new Map<string, Segment[]>()
  private readonly lo = [Infinity, Infinity, Infinity]
  private readonly hi = [-Infinity, -Infinity, -Infinity]

  private readonly seen = new Set<Segment>()
  private readonly nearScratch: Segment[] = []
  private readonly colsA: Collider[] = []
  private readonly colsB: Collider[] = []
  private readonly boundsA: Box = emptyBox()
  private readonly boundsB: Box = emptyBox()
  private readonly ptScratch: number[] = []
  private readonly endScratch: number[] = []
  private readonly endsScratch: TrackEnd[] = []
  private readonly colsFit: Collider[] = []
  private readonly obsScratch: Collider[] = []
  private readonly boundsFit: Box = emptyBox()
  private colliders = 0

  get count(): number {
    return this.all.size
  }

  /**
   * 敷いた区間が持つ当たり判定の箱の総数（HUD 用）。
   * 毎フレーム読まれるので、敷く／撤去するときに足し引きして数え直さない。
   */
  get colliderCount(): number {
    return this.colliders
  }

  segments(): IterableIterator<Segment> {
    return this.all.values()
  }

  /** その区間がまだ存在するか（撤去された端点を握り続けないための確認）。 */
  has(seg: Segment): boolean {
    return this.all.has(seg)
  }

  /**
   * 敷く。既存の区間と面で重なるなら false。
   *
   * `ignore` には**繋いだ相手**（{@link TrackPlan} の `from` と `joinTo` の区間）を渡す。
   * 継ぎ目では端が触れ合うので、見積もり（{@link check}）と同じ相手を外して測らないと、
   * ゴーストが緑なのに置けない、という食い違いが起きる。
   */
  place(seg: Segment, ignore: readonly (Segment | null)[] = []): boolean {
    if (this.overlaps(seg, ignore)) return false
    this.insert(seg)
    return true
  }

  remove(seg: Segment): Segment | null {
    if (!this.all.has(seg)) return null
    this.all.delete(seg)
    this.colliders -= sampleCount(seg)
    this.eachCell(seg, (list) => {
      const i = list.indexOf(seg)
      if (i >= 0) list.splice(i, 1)
    })
    return seg
  }

  clear(): void {
    this.all.clear()
    this.cells.clear()
    this.colliders = 0
    this.lo[0] = this.lo[1] = this.lo[2] = Infinity
    this.hi[0] = this.hi[1] = this.hi[2] = -Infinity
  }

  // ------------------------------------------------------------------ 空間索引

  private insert(seg: Segment): void {
    this.all.add(seg)
    this.colliders += sampleCount(seg)
    this.eachCell(seg, (list) => list.push(seg))
  }

  private eachCell(seg: Segment, fn: (list: Segment[]) => void): void {
    const b = segmentBounds(seg, this.boundsA)
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

  /** 指定の箱にかかる区間を `out` に集める（重複なし）。 */
  segmentsInBounds(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
    out: Segment[],
  ): Segment[] {
    out.length = 0
    if (this.all.size === 0) return out
    const seen = this.seen
    seen.clear()
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
          for (const s of list) {
            if (seen.has(s)) continue
            seen.add(s)
            out.push(s)
          }
        }
      }
    }
    return out
  }

  // ------------------------------------------------------------------ 端点

  /** 区間の 2 つの端点（`yaw` はそこから先へ伸ばす向き）。 */
  endsOf(seg: Segment, out: TrackEnd[] = []): TrackEnd[] {
    out.length = 0
    const e = segmentEnd(seg, END_SCRATCH)
    out.push({ seg, atEnd: false, x: seg.x, y: seg.y, z: seg.z, yaw: seg.yaw + Math.PI })
    out.push({ seg, atEnd: true, x: e[0], y: e[1], z: e[2], yaw: e[3] })
    return out
  }

  /** その位置に他の区間の端点が来ているか（＝もう繋がっているか）。 */
  occupied(x: number, y: number, z: number, ignore: Segment | null = null): boolean {
    // 端点を含む区間は、その端点まわりの小さな箱と必ずセルを共有する
    this.segmentsInBounds(
      x - JOIN_EPS,
      y - JOIN_EPS,
      z - JOIN_EPS,
      x + JOIN_EPS,
      y + JOIN_EPS,
      z + JOIN_EPS,
      OCCUPIED_SCRATCH,
    )
    for (const s of OCCUPIED_SCRATCH) {
      if (s === ignore) continue
      for (const e of this.endsOf(s, OCCUPIED_ENDS)) {
        if (Math.hypot(e.x - x, e.y - y, e.z - z) <= JOIN_EPS) return true
      }
    }
    return false
  }

  /**
   * `(x, y, z)` の近くにある**自由端**（まだ何も繋がっていない端点）のうち最寄りのもの。
   * これが「レールヘッド」になり、次の区間はここから向きを引き継いで伸びる。
   */
  nearestEnd(
    x: number,
    y: number,
    z: number,
    range: number,
    kind: TrackKind | null = null,
    exclude: Segment | null = null,
  ): TrackEnd | null {
    this.segmentsInBounds(
      x - range,
      y - range,
      z - range,
      x + range,
      y + range,
      z + range,
      this.nearScratch,
    )
    // 候補を先に写し取る。占有の判定が索引とスクラッチを触るので、
    // 走査しながら問い合わせると足元が崩れる
    const cands = this.endsScratch
    cands.length = 0
    for (const s of this.nearScratch) {
      if (s === exclude) continue
      if (kind !== null && s.kind !== kind) continue
      for (const e of this.endsOf(s, ENDS)) cands.push({ ...e })
    }
    let best: TrackEnd | null = null
    let bd = range
    for (const e of cands) {
      const d = Math.hypot(e.x - x, e.y - y, e.z - z)
      if (d >= bd) continue
      if (this.occupied(e.x, e.y, e.z, e.seg)) continue
      bd = d
      best = e
    }
    return best
  }

  // ------------------------------------------------------------ 敷けるかどうか

  /**
   * 狙点から 1 区間ぶんの敷設を見積もる。ゴーストの表示と実際の設置が
   * 同じ道を通るので、**見えているものがそのまま置かれる**。
   *
   * 1. レールヘッドがあれば、その位置と向きを始端にして狙点へ向かう円弧を解く
   * 2. 無ければ狙点を始端に、カメラの向きの直線を地面に沿って伸ばす（新しい線）
   * 3. 狙点の近くに別の自由端があれば、そこへ解き直して繋ぐ
   * 4. 曲率・長さ・勾配は種類ごとの上限で**クランプする**（置けない扱いにはしない）
   */
  plan(req: PlanRequest): TrackPlan {
    const { kind, mat, terrain } = req
    const head = req.railhead
    // 路盤は地面の上に載る。狙点が地形なら厚みぶん持ち上げた高さが軌道面になる
    const deckY = req.aimOnTrack ? req.aimY : req.aimY + DECK_T

    if (!head) {
      // 新しい線。狙点から、カメラの向きへ地面に沿って伸ばす
      const length = clampFit(kind, { curve: 0, length: req.maxLen }, req.maxLen).length
      const seg: Segment = {
        kind,
        x: req.aimX,
        y: deckY,
        z: req.aimZ,
        yaw: req.camYaw,
        curve: 0,
        length,
        rise: 0,
        mat,
      }
      this.applyGrade(seg, terrain, req.grade)
      return this.finish(seg, terrain, null, null, null, null)
    }

    // 狙点の近くの自由端へ繋ぎに行く
    const joinTo = this.nearestEnd(req.aimX, req.aimY, req.aimZ, JOIN_RANGE, kind, head.seg)
    if (joinTo) {
      const seg = this.arcTo(kind, mat, head, joinTo.x, joinTo.y, joinTo.z)
      const e = segmentEnd(seg, this.endScratch)
      const reached = Math.hypot(e[0] - joinTo.x, e[1] - joinTo.y, e[2] - joinTo.z) < 0.6
      if (reached) {
        // 相手の端点へ「入る」向きは、そこから伸ばす向きの逆
        const kink = Math.abs(normalizeAngle(e[3] - (joinTo.yaw + Math.PI))) > JOIN_MAX_ANGLE
        if (kink) {
          return { seg, from: head, joinTo, check: 'kink', wanted: seg.length, trim: 'none' }
        }
        // 繋ぐ区間は相手にぴったり届く長さでないと意味が無いので、切り詰めない
        const r = this.fit(seg, terrain, false, head.seg, joinTo.seg)
        return { seg, from: head, joinTo, check: r.check, wanted: seg.length, trim: r.trim }
      }
    }

    const seg = this.arcAlong(kind, mat, head, req.aimX, req.aimZ, req.maxLen)
    this.applyGrade(seg, terrain, req.grade)
    return this.finish(seg, terrain, head, null, head.seg, null)
  }

  /** 地形を見て切り詰めたうえで、見積もりにまとめる。 */
  private finish(
    seg: Segment,
    terrain: Terrain,
    from: TrackEnd | null,
    joinTo: TrackEnd | null,
    ignoreA: Segment | null,
    ignoreB: Segment | null,
  ): TrackPlan {
    const wanted = seg.length
    const r = this.fit(seg, terrain, true, ignoreA, ignoreB)
    return { seg, from, joinTo, check: r.check, wanted, trim: r.trim }
  }

  /**
   * 勾配を決める。指定があればその勾配で、無ければ**終点の地面に合わせる**。
   *
   * 自動のときに狙点の高さを使わないのは、狙点が近いと
   * 少し見上げただけで勾配が跳ね上がってしまうから。終点の地面に合わせれば、
   * 長い区間でも地形なりに素直に伸びる。
   */
  private applyGrade(seg: Segment, terrain: Terrain, grade: number | null | undefined): void {
    if (grade !== null && grade !== undefined) {
      seg.rise = clampRise(seg.kind, grade * seg.length, seg.length)
      return
    }
    const e = segmentEnd(seg, this.endScratch)
    seg.rise = clampRise(seg.kind, terrain.ground(e[0], e[2]) + DECK_T - seg.y, seg.length)
  }

  /** 端点から狙点へ**ぴったり届く**円弧（繋ぎに行くとき用）。 */
  private arcTo(
    kind: TrackKind,
    mat: number,
    from: TrackEnd,
    tx: number,
    ty: number,
    tz: number,
  ): Segment {
    const raw = solveArc(from.x, from.z, from.yaw, tx, tz)
    const fit = clampFit(kind, raw, MAX_SEG_LEN)
    // 届かない長さに切り詰めたぶん、高さ差も比例で詰める
    const ratio = raw.length > 1e-6 ? Math.min(1, fit.length / raw.length) : 1
    return {
      kind,
      x: from.x,
      y: from.y,
      z: from.z,
      yaw: from.yaw,
      curve: fit.curve,
      length: fit.length,
      rise: clampRise(kind, (ty - from.y) * ratio, fit.length),
      mat,
    }
  }

  /**
   * 端点から**狙点の向きへ、決めた長さだけ**伸ばす円弧。
   *
   * 狙点は曲がり方（曲率）を決めるだけで、長さには使わない。手が届くのは 9 m
   * 先までなので、狙点の距離を長さにしてしまうと**ホイールで長さを伸ばしても
   * 伸びない**ことになる。
   */
  private arcAlong(
    kind: TrackKind,
    mat: number,
    from: TrackEnd,
    tx: number,
    tz: number,
    len: number,
  ): Segment {
    const raw = solveArc(from.x, from.z, from.yaw, tx, tz)
    const fit = clampFit(kind, { curve: raw.curve, length: len }, len)
    return {
      kind,
      x: from.x,
      y: from.y,
      z: from.z,
      yaw: from.yaw,
      curve: fit.curve,
      length: fit.length,
      rise: 0,
      mat,
    }
  }

  /**
   * 敷けるかどうか。
   *
   * 路盤との差が {@link GRADE_TOL} までの地面は敷くときに切り盛りして合わせるので通す。
   * それを超えて高い地面は切土が深すぎるので置けず（プレイヤーが自分で掘る）、
   * 逆に低いところは橋脚で渡すが、高すぎる橋脚は認めない。
   */
  check(
    seg: Segment,
    terrain: Terrain,
    ignoreA: Segment | null = null,
    ignoreB: Segment | null = null,
  ): TrackCheck {
    return this.fit(seg, terrain, false, ignoreA, ignoreB).check
  }

  /**
   * 地形に合わせて区間を詰めてから、敷けるかどうかを返す。
   *
   * 自然の斜面は最大勾配よりずっと急なことが多いので、丘へ向けて狙うたびに
   * 「埋まる」で弾いていると何も敷けない。そこで `trim` が真なら
   * **地面にぶつかる手前で区間を切り詰める**（勾配は変えずに長さだけ詰めるので、
   * 縦断の形は変わらない）。切り詰めても最短長に届かないときだけ理由を返す。
   */
  private fit(
    seg: Segment,
    terrain: Terrain,
    trim: boolean,
    ignoreA: Segment | null,
    ignoreB: Segment | null,
  ): { check: TrackCheck; trim: TrackTrim } {
    const pts = sampleSegment(seg, this.ptScratch)
    const n = pts.length / 4 - 1
    const ds = seg.length / n
    // 家や建てたパーツ。刻みごとの箱で当たりを見るので、当たり判定と同じ精度になる
    const obstacles = this.obstaclesNear(seg, terrain)
    const cols = obstacles ? segmentColliders(seg, this.colsFit) : null

    for (let i = 0; i <= n; i++) {
      const x = pts[i * 4]
      const y = pts[i * 4 + 1]
      const z = pts[i * 4 + 2]
      const g = terrain.ground(x, z)
      // 路盤の底面から GRADE_TOL までは敷くときに削るので、そこまでは埋まっていない扱い
      const cutTop = y - DECK_T + GRADE_TOL + GRADE_SLACK
      let reason: TrackTrim = 'none'
      if (terrain.solid ? terrain.solid(x, cutTop, z) : g > cutTop) reason = 'buried'
      else if (y - g > MAX_PILLAR) reason = 'toohigh'
      else if (cols && obstacles && i < n && hitsAny(cols[i], obstacles)) reason = 'blocked'
      if (reason === 'none') continue
      if (!trim) return { check: reason, trim: 'none' }
      // ぶつかる手前まで戻す。勾配を保ったまま長さを詰める。
      // 障害物は「刻み i の箱」に当たっているので、その箱の手前（= ds·i）で止める
      const cut = reason === 'blocked' ? ds * i : ds * (i - 1)
      if (cut < MIN_SEG_LEN) return { check: reason, trim: 'none' }
      seg.rise *= cut / seg.length
      seg.length = cut
      return { check: this.overlaps(seg, [ignoreA, ignoreB]) ? 'overlap' : 'ok', trim: reason }
    }
    return { check: this.overlaps(seg, [ignoreA, ignoreB]) ? 'overlap' : 'ok', trim: 'none' }
  }

  /** 区間の周りの障害物。1 つも無ければ null（毎フレームの当たり判定を省く）。 */
  private obstaclesNear(seg: Segment, terrain: Terrain): Collider[] | null {
    if (!terrain.obstacles) return null
    const b = segmentBounds(seg, this.boundsFit)
    const cx = (b.minX + b.maxX) / 2
    const cz = (b.minZ + b.maxZ) / 2
    const r = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) / 2 + 1
    const out = terrain.obstacles(cx, cz, r, this.obsScratch)
    return out.length > 0 ? out : null
  }

  /** 既存の区間と面で重なっているか。端点で接するだけの相手は無視する。 */
  overlaps(seg: Segment, ignore: readonly (Segment | null)[] = []): boolean {
    const b = segmentBounds(seg, this.boundsA)
    this.segmentsInBounds(b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ, this.nearScratch)
    if (this.nearScratch.length === 0) return false
    const mine = segmentColliders(seg, this.colsA)
    for (const q of this.nearScratch) {
      if (q === seg || ignore.includes(q)) continue
      for (const qc of segmentColliders(q, this.colsB)) {
        for (const mc of mine) {
          if (obbOverlap(mc, qc, 0, OVERLAP_SCALE)) return true
        }
      }
    }
    return false
  }

  // ------------------------------------------------------------------ 当たり判定

  /**
   * 付近の当たり判定を `out` に**追記する**（`BuildGrid.collectColliders` と同じ約束）。
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
    this.segmentsInBounds(x - r, y0, z - r, x + r, y1, z + r, this.nearScratch)
    for (const s of this.nearScratch) {
      for (const c of segmentColliders(s, this.colsB)) {
        const b = colliderBounds(c, this.boundsB)
        if (b.maxY <= y0 || b.minY >= y1) continue
        if (x < b.minX - r || x > b.maxX + r) continue
        if (z < b.minZ - r || z > b.maxZ + r) continue
        out.push({ ...c })
      }
    }
    return out
  }

  /** 手前の区間にレイを当てる（撤去の照準に使う）。 */
  raycast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDist: number,
    out: TrackHit,
  ): TrackHit | null {
    if (this.all.size === 0) return null
    const ex = ox + dx * maxDist
    const ey = oy + dy * maxDist
    const ez = oz + dz * maxDist
    this.segmentsInBounds(
      Math.min(ox, ex),
      Math.min(oy, ey),
      Math.min(oz, ez),
      Math.max(ox, ex),
      Math.max(oy, ey),
      Math.max(oz, ez),
      this.nearScratch,
    )
    let best = maxDist
    let found = false
    for (const s of this.nearScratch) {
      for (const c of segmentColliders(s, this.colsB)) {
        const t = rayCollider(ox, oy, oz, dx, dy, dz, c, best, NORMAL)
        if (t === null || t >= best) continue
        best = t
        found = true
        out.seg = s
        out.distance = t
      }
    }
    return found ? out : null
  }

  /** 指定の点にいちばん近い区間（デバッグ／テスト用）。 */
  nearest(x: number, y: number, z: number, range: number): Segment | null {
    this.segmentsInBounds(
      x - range,
      y - range,
      z - range,
      x + range,
      y + range,
      z + range,
      this.nearScratch,
    )
    let best: Segment | null = null
    let bd = range
    for (const s of this.nearScratch.slice()) {
      const pts = sampleSegment(s, this.ptScratch)
      for (let i = 0; i < pts.length; i += 4) {
        const d = Math.hypot(pts[i] - x, pts[i + 1] - y, pts[i + 2] - z)
        if (d >= bd) continue
        bd = d
        best = s
      }
    }
    return best
  }

  // -------------------------------------------------------------------- 保存

  /** `[種類, x, y, z, yaw, 曲率, 長さ, 高さ差, 素材, …]` の平坦な配列。 */
  serialize(): number[] {
    const out: number[] = []
    for (const s of this.all) {
      out.push(TRACK_KINDS.indexOf(s.kind), s.x, s.y, s.z, s.yaw, s.curve, s.length, s.rise, s.mat)
    }
    return out
  }

  /** 壊れた要素は 1 件ずつ捨てる（`BuildGrid.load` と同じ寛容さ）。 */
  load(data: unknown): void {
    this.clear()
    if (!Array.isArray(data)) return
    for (let i = 0; i + 8 < data.length; i += 9) {
      const kind = TRACK_KINDS[data[i]]
      if (!kind) continue
      const v = data.slice(i + 1, i + 9) as number[]
      if (!v.every((n) => typeof n === 'number' && Number.isFinite(n))) continue
      const [x, y, z, yaw, curve, length, rise, mat] = v
      if (length <= 0 || length > MAX_SEG_LEN * 2) continue
      if (Math.abs(curve) > 1 / TRACK_INFO[kind].minRadius + 1e-6) continue
      this.insert({ kind, x, y, z, yaw, curve, length, rise, mat: Math.round(mat) })
    }
  }
}

const NORMAL = [0, 0, 0]
const ENDS: TrackEnd[] = []
const END_SCRATCH = [0, 0, 0, 0]
const OCCUPIED_ENDS: TrackEnd[] = []
const OCCUPIED_SCRATCH: Segment[] = []

export function createTrackHit(): TrackHit {
  return {
    seg: { kind: 'rail', x: 0, y: 0, z: 0, yaw: 0, curve: 0, length: 1, rise: 0, mat: 0 },
    distance: 0,
  }
}

function emptyBox(): Box {
  return { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 }
}

/** 箱がどれかの障害物と重なっているか。 */
function hitsAny(box: Collider, obstacles: readonly Collider[]): boolean {
  for (const o of obstacles) {
    if (obbOverlap(box, o, OBSTACLE_GROW)) return true
  }
  return false
}
