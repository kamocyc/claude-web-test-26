import { MATERIAL_COUNT, MATERIAL_INFO, VOXEL_SIZE } from './constants'
import { MAT_NONE } from './constants'

export type BrushMode = 'dig' | 'place'

export type CornerReader = (gx: number, gy: number, gz: number) => number
export type CornerMatReader = (gx: number, gy: number, gz: number) => number
export type CornerWriter = (gx: number, gy: number, gz: number, d: number, mat: number) => void

export interface BrushBounds {
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
  touched: number
  /** 空 → 固体 に変わった格子点の数（= 盛った体積） */
  solidified: number
  /** 固体 → 空 に変わった格子点の数（= 掘った体積） */
  cleared: number
  /** 取り除いた切れ端の格子点の数。 */
  fragmentsRemoved: number
  /** 読み込み範囲にあった「置いた土砂」の格子点の数。0 なら崩す処理を省ける。 */
  looseTouched: number
}

/** 素材 ID → tan(安息角)。0 は崩れない素材。 */
const LOOSE_TAN = new Float32Array(MATERIAL_COUNT)
for (const m of MATERIAL_INFO) {
  LOOSE_TAN[m.id] = m.repose > 0 ? Math.tan((m.repose * Math.PI) / 180) : 0
}

/** その素材が粒状（盛ると崩れる）かどうか。 */
export function isLooseMaterial(mat: number): boolean {
  return mat < MATERIAL_COUNT && LOOSE_TAN[mat] > 0
}

/**
 * 自然地形（プレイヤーが置いたのではない格子点）の素材を返す。
 * 粒状なら素材 ID、そうでなければ {@link MAT_NONE}。
 */
export type NaturalLooseReader = (gx: number, gz: number, y: number) => number

/**
 * ブラシの形。中心を原点とするローカル座標（格子単位）の符号付き距離で表す。
 * 外側が正・内側が負で、値が実距離とほぼ一致していること（正確な SDF）が条件。
 * 掘削・設置・掃除の範囲判定をすべてこの値だけで行う。
 */
export interface BrushShape {
  /** 走査範囲の半サイズ。 */
  readonly ex: number
  readonly ey: number
  readonly ez: number
  sdf(dx: number, dy: number, dz: number): number
  /**
   * ローカル座標 (dx, dz) の柱がブラシと交わる y 区間 `[lo, hi]`。
   * 交わらなければ `lo > hi` を返す。土砂を柱ごとに積むときに使う。
   */
  span(dx: number, dz: number, out: Span): Span
}

export interface Span {
  lo: number
  hi: number
}

export function sphereBrush(radius: number): BrushShape {
  const r = radius / VOXEL_SIZE
  return {
    ex: r,
    ey: r,
    ez: r,
    sdf: (dx, dy, dz) => Math.sqrt(dx * dx + dy * dy + dz * dz) - r,
    span: (dx, dz, out) => {
      const t = r * r - dx * dx - dz * dz
      const hc = t > 0 ? Math.sqrt(t) : -1
      out.lo = -hc
      out.hi = hc
      return out
    },
  }
}

/**
 * 軸に沿った直方体ブラシ。半サイズは格子単位。
 *
 * 面が格子平面にちょうど乗るように中心を置くと（{@link snapBoxCenter}）、
 * Surface Nets の頂点は面・稜・角の上に厳密に乗り、完全に鋭い直方体になる。
 * 格子からずらすと稜が最大 0.5 格子ぶん面取りされる。
 */
export function boxBrush(hx: number, hy: number, hz: number): BrushShape {
  const ax = hx / VOXEL_SIZE
  const ay = hy / VOXEL_SIZE
  const az = hz / VOXEL_SIZE
  return {
    ex: ax,
    ey: ay,
    ez: az,
    sdf: (dx, dy, dz) => boxSdf(dx, dy, dz, ax, ay, az),
    span: (dx, dz, out) => {
      const hit = Math.abs(dx) <= ax && Math.abs(dz) <= az
      out.lo = hit ? -ay : 1
      out.hi = hit ? ay : -1
      return out
    },
  }
}

/**
 * Y 軸まわりに回した直方体ブラシ。半サイズは m、`yaw` はラジアン。
 *
 * 回転の規約は {@link Collider} と同じで、**局所 +x が右、局所 +z が後ろ**。
 * だから `hx` が幅方向、`hz` が進行方向の半サイズになり、軌道の 1 コマを
 * そのまま切り盛りできる。走査範囲は回した箱を包む大きさに広げる。
 */
export function orientedBoxBrush(hx: number, hy: number, hz: number, yaw: number): BrushShape {
  const ax = hx / VOXEL_SIZE
  const ay = hy / VOXEL_SIZE
  const az = hz / VOXEL_SIZE
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)
  const ac = Math.abs(cos)
  const as = Math.abs(sin)
  return {
    ex: ax * ac + az * as,
    ey: ay,
    ez: ax * as + az * ac,
    sdf: (dx, dy, dz) => boxSdf(dx * cos - dz * sin, dy, dx * sin + dz * cos, ax, ay, az),
    span: (dx, dz, out) => {
      const lx = dx * cos - dz * sin
      const lz = dx * sin + dz * cos
      const hit = Math.abs(lx) <= ax && Math.abs(lz) <= az
      out.lo = hit ? -ay : 1
      out.hi = hit ? ay : -1
      return out
    },
  }
}

/** 中心を原点とする軸平行の直方体の符号付き距離。 */
function boxSdf(
  dx: number,
  dy: number,
  dz: number,
  ax: number,
  ay: number,
  az: number,
): number {
  const qx = Math.abs(dx) - ax
  const qy = Math.abs(dy) - ay
  const qz = Math.abs(dz) - az
  const ox = qx > 0 ? qx : 0
  const oy = qy > 0 ? qy : 0
  const oz = qz > 0 ? qz : 0
  const outside = Math.sqrt(ox * ox + oy * oy + oz * oz)
  const inside = Math.min(Math.max(qx, qy, qz), 0)
  return outside + inside
}

/**
 * 直方体の面が格子平面に乗るように中心座標を丸める。
 * 半サイズが整数なら中心も整数に、0.5 刻みなら中心も 0.5 刻みになる。
 */
export function snapBoxCenter(center: number, half: number): number {
  const h = half / VOXEL_SIZE
  const c = center / VOXEL_SIZE
  return (Math.round(c - h) + h) * VOXEL_SIZE
}

/**
 * この数以下の格子点しか持たない塊は切れ端とみなして消す。
 * 8 点 = だいたい 1m 角。掘ったときに残る目に見えるゴミはほぼこの大きさ以下。
 */
export const MAX_FRAGMENT_CORNERS = 8

/**
 * ブラシ表面からこの距離までを掃除の対象にする。外側は絶対に削らない。
 * 読み込み範囲は表面から REACH_PAD なので、面隣接を数える余裕がある。
 */
const CLEAN_BAND = 1.0

/** ブラシ表面から何格子ぶん外まで読み込むか。 */
const REACH_PAD = 2

/** 読み込んでいない格子点の印。空気として扱われ、書き戻されない。 */
const OUTSIDE = -1e9

/**
 * 設置のときブラシ表面をわずかに固体側へ寄せる量。
 *
 * 等値面の判定は「密度 > 0」なので、ちょうど 0 の格子点は空気に入る。
 * 掘削 (min) ではブラシ表面が空気になるのが正しいが、設置 (max) では
 * 表面まで埋まってほしいので、ここだけ符号を跨がせる。これが無いと
 * 直方体の角が 2/3 格子ぶん欠ける。
 */
const SURFACE_BIAS = 1e-4

/**
 * 一度に削る深さの上限を「無し」にする値。
 * これを渡すと掘削はブラシの形をそのまま抜く（従来の挙動）。
 */
export const DIG_ALL = Infinity

/** とげを削る回数。2 回で「幅 1 格子の触手」まで消える。 */
const ERODE_PASSES = 2

/** ならしブラシの反復回数と 1 回あたりの強さ（0.5 を超えると振動する）。 */
const SMOOTH_PASSES = 2
const SMOOTH_RATE = 0.5

/** この値より小さい変化は書き戻さない。編集差分の肥大化を防ぐ。 */
const SMOOTH_EPSILON = 1e-3

// 呼び出しごとの確保を避けるための作業バッファ
let bufD: Float32Array = new Float32Array(0)
let bufOrigD: Float32Array = new Float32Array(0)
let bufMat: Uint8Array = new Uint8Array(0)
let bufOrigMat: Uint8Array = new Uint8Array(0)
let bufState: Uint8Array = new Uint8Array(0)
let bufSdf: Float32Array = new Float32Array(0)
let bufNext: Float32Array = new Float32Array(0)
const stack: number[] = []
const component: number[] = []

function ensure(n: number): void {
  if (bufD.length >= n) return
  bufD = new Float32Array(n)
  bufOrigD = new Float32Array(n)
  bufMat = new Uint8Array(n)
  bufOrigMat = new Uint8Array(n)
  bufState = new Uint8Array(n)
  bufSdf = new Float32Array(n)
  bufNext = new Float32Array(n)
}

function emptyBounds(): BrushBounds {
  return {
    minX: Infinity,
    minY: Infinity,
    minZ: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    maxZ: -Infinity,
    touched: 0,
    solidified: 0,
    cleared: 0,
    fragmentsRemoved: 0,
    looseTouched: 0,
  }
}

/** `b` の影響範囲を `a` に取り込む。体積の集計は `a` のものを残す。 */
function mergeBounds(a: BrushBounds, b: BrushBounds): void {
  if (b.touched === 0) return
  a.touched += b.touched
  if (b.minX < a.minX) a.minX = b.minX
  if (b.minY < a.minY) a.minY = b.minY
  if (b.minZ < a.minZ) a.minZ = b.minZ
  if (b.maxX > a.maxX) a.maxX = b.maxX
  if (b.maxY > a.maxY) a.maxY = b.maxY
  if (b.maxZ > a.maxZ) a.maxZ = b.maxZ
}

/** 走査範囲。ブラシの半サイズ + REACH_PAD を格子に切り上げたもの。 */
interface Region {
  i0: number
  j0: number
  k0: number
  w: number
  h: number
  d: number
  ox: number
  oy: number
  oz: number
}

function region(
  cx: number,
  cy: number,
  cz: number,
  ex: number,
  ey: number,
  ez: number,
  clampMinY: number,
  clampMaxY: number,
): Region | null {
  const i0 = Math.floor(cx - ex - REACH_PAD)
  const i1 = Math.ceil(cx + ex + REACH_PAD)
  const j0 = Math.max(Math.floor(clampMinY / VOXEL_SIZE), Math.floor(cy - ey - REACH_PAD))
  const j1 = Math.min(Math.ceil(clampMaxY / VOXEL_SIZE), Math.ceil(cy + ey + REACH_PAD))
  const k0 = Math.floor(cz - ez - REACH_PAD)
  const k1 = Math.ceil(cz + ez + REACH_PAD)
  const w = i1 - i0 + 1
  const h = j1 - j0 + 1
  const d = k1 - k0 + 1
  if (w <= 0 || h <= 0 || d <= 0) return null
  ensure(w * h * d)
  return { i0, j0, k0, w, h, d, ox: i0 - cx, oy: j0 - cy, oz: k0 - cz }
}

/** 変化した格子点だけ書き戻し、影響範囲を記録する。 */
function writeBack(reg: Region, bounds: BrushBounds, write: CornerWriter): void {
  const { w, h, d, i0, j0, k0 } = reg
  for (let k = 0; k < d; k++) {
    for (let j = 0; j < h; j++) {
      const row = (j + k * h) * w
      for (let i = 0; i < w; i++) {
        const idx = row + i
        const next = bufD[idx]
        const cur = bufOrigD[idx]
        const nextMat = bufMat[idx]
        if (next === cur && nextMat === bufOrigMat[idx]) continue

        const gx = i0 + i
        const gy = j0 + j
        const gz = k0 + k
        write(gx, gy, gz, next, nextMat)
        bounds.touched++
        if (cur <= 0 && next > 0) bounds.solidified++
        else if (cur > 0 && next <= 0) bounds.cleared++
        if (gx < bounds.minX) bounds.minX = gx
        if (gy < bounds.minY) bounds.minY = gy
        if (gz < bounds.minZ) bounds.minZ = gz
        if (gx > bounds.maxX) bounds.maxX = gx
        if (gy > bounds.maxY) bounds.maxY = gy
        if (gz > bounds.maxZ) bounds.maxZ = gz
      }
    }
  }
}

/**
 * ブラシを密度場に適用する。
 *
 * ブラシを符号付き距離場として扱い、
 *   設置 = union      : d = max(d, -s)
 *   掘削 = subtraction: d = min(d,  s)
 * （s はブラシの符号付き距離、外側が正）とすることで、
 * 何度掛けても値が発散せず、常にブラシの形そのままのくぼみ・膨らみになる。
 *
 * 掘ったあとは、影響範囲の中で本体から切り離された小さな塊を取り除く。
 * 地形の等値面は「密度が正の格子点」があるところにしか生まれないので、
 * 格子点の連結成分を見れば目に見える切れ端を漏れなく検出できる。
 *
 * `depth` を渡すと**一度に削る深さがその値までに制限される**（{@link DIG_ALL} で無制限）。
 * 掘削は `d = min(d, max(s, d - depth))` になり、掛けるたびにブラシの形へ `depth` ずつ
 * 近づいて、最後は無制限で掛けたのとまったく同じ形（`min(d, s)`）で止まる。
 * 途中の形も等値面なので、削りかけでも穴の底はなめらかなまま。設置には効かない。
 */
export function applyBrush(
  wx: number,
  wy: number,
  wz: number,
  shape: BrushShape,
  mode: BrushMode,
  material: number,
  readD: CornerReader,
  readMat: CornerMatReader,
  write: CornerWriter,
  clampMinY: number,
  clampMaxY: number,
  depth: number = DIG_ALL,
): BrushBounds {
  const cx = wx / VOXEL_SIZE
  const cy = wy / VOXEL_SIZE
  const cz = wz / VOXEL_SIZE

  const bounds = emptyBounds()
  const reg = region(cx, cy, cz, shape.ex, shape.ey, shape.ez, clampMinY, clampMaxY)
  if (!reg) return bounds
  const { w, h, d, i0, j0, k0, ox, oy, oz } = reg
  // 密度は格子単位のおおよその距離なので、深さも格子単位に直してから使う
  const cut = depth > 0 && depth < DIG_ALL ? depth / VOXEL_SIZE : DIG_ALL

  // --- 1. ブラシの届く範囲だけ現在の値を読み込み、その場でブラシを合成する ---
  // 範囲外は OUTSIDE のままにしておく。書き戻されず、掃除の対象にもならない。
  const place = mode === 'place'
  for (let k = 0; k < d; k++) {
    const dzz = oz + k
    for (let j = 0; j < h; j++) {
      const dyy = oy + j
      const row = (j + k * h) * w
      for (let i = 0; i < w; i++) {
        const idx = row + i
        const s = shape.sdf(ox + i, dyy, dzz)
        bufSdf[idx] = s
        if (s > REACH_PAD) {
          bufD[idx] = OUTSIDE
          bufOrigD[idx] = OUTSIDE
          bufMat[idx] = MAT_NONE
          bufOrigMat[idx] = MAT_NONE
          continue
        }
        const gx = i0 + i
        const gy = j0 + j
        const gz = k0 + k
        const cur = readD(gx, gy, gz)
        const m = readMat(gx, gy, gz)
        bufOrigD[idx] = cur
        bufOrigMat[idx] = m
        if (cur > 0 && isLooseMaterial(m)) bounds.looseTouched++
        const next = place
          ? Math.max(cur, SURFACE_BIAS - s)
          : Math.min(cur, Math.max(s, cur - cut))
        bufD[idx] = next
        // 素材を刻むのは新しく固体になった格子点だけ。
        // 既にあった地形まで「置いた土砂」に化けると、山肌ごと崩れてしまう。
        bufMat[idx] = place && next > 0 && s < 0.5 && cur <= 0 ? material : m
      }
    }
  }

  // --- 2. 掘ったときは切れ端を掃除する ---
  if (!place) {
    bounds.fragmentsRemoved =
      erodeThinShards(w, h, d) + removeSmallFragments(w, h, d, MAX_FRAGMENT_CORNERS)
  }

  // --- 3. 変化した格子点だけ書き戻す ---
  writeBack(reg, bounds, write)
  return bounds
}

/** まとめて掛けるブラシ 1 本ぶんの指定。 */
export interface BrushOp {
  x: number
  y: number
  z: number
  shape: BrushShape
  mode: BrushMode
  /** 置くときの素材。掘るときは使われない。 */
  material: number
}

/**
 * 複数のブラシを順に掛け、影響範囲をひとまとめにして返す。
 *
 * 1 本ずつ掛けるのと結果は同じだが、**呼び出し側がメッシュの作り直しを 1 回で済ませられる**。
 * 軌道の切り盛りのように、細かい箱を何十本も並べて掛ける用途向け。
 *
 * `each` を渡すと 1 本ごとの結果もそこへ順に積む。掘った土の素材は場所ごとに違うので、
 * **どの箱がどれだけ掘ったか**を知りたい呼び出し側はこれを使う。
 */
export function applyBrushes(
  ops: readonly BrushOp[],
  readD: CornerReader,
  readMat: CornerMatReader,
  write: CornerWriter,
  clampMinY: number,
  clampMaxY: number,
  each?: BrushBounds[],
): BrushBounds {
  const total = emptyBounds()
  for (const op of ops) {
    const b = applyBrush(
      op.x,
      op.y,
      op.z,
      op.shape,
      op.mode,
      op.material,
      readD,
      readMat,
      write,
      clampMinY,
      clampMaxY,
    )
    total.solidified += b.solidified
    total.cleared += b.cleared
    total.fragmentsRemoved += b.fragmentsRemoved
    total.looseTouched += b.looseTouched
    mergeBounds(total, b)
    each?.push(b)
  }
  return total
}

/** 球ブラシ。既存の呼び出し向けの薄いラッパ。 */
export function applySphereBrush(
  wx: number,
  wy: number,
  wz: number,
  radius: number,
  mode: BrushMode,
  material: number,
  readD: CornerReader,
  readMat: CornerMatReader,
  write: CornerWriter,
  clampMinY: number,
  clampMaxY: number,
  depth: number = DIG_ALL,
): BrushBounds {
  return applyBrush(
    wx,
    wy,
    wz,
    sphereBrush(radius),
    mode,
    material,
    readD,
    readMat,
    write,
    clampMinY,
    clampMaxY,
    depth,
  )
}

/**
 * 凸凹をならすブラシ。密度場をその場で平滑化する。
 *
 * 密度に対するラプラシアン平滑化（`d += λ (隣接 6 点の平均 - d)`）は、
 * 等値面に対しては平均曲率流になる。つまり出っ張りは削れ、へこみは埋まり、
 * 平らな面・一定の傾斜は動かない（一次関数のラプラシアンは 0）。
 * 素材と体積の帰属が曖昧なので、掘削・設置とは違い手持ち量は増減させない。
 *
 * @param strength 0..1。中心での効き具合。
 */
export function applySmoothBrush(
  wx: number,
  wy: number,
  wz: number,
  radius: number,
  strength: number,
  readD: CornerReader,
  readMat: CornerMatReader,
  write: CornerWriter,
  clampMinY: number,
  clampMaxY: number,
): BrushBounds {
  const cx = wx / VOXEL_SIZE
  const cy = wy / VOXEL_SIZE
  const cz = wz / VOXEL_SIZE
  const r = radius / VOXEL_SIZE

  const bounds = emptyBounds()
  const reg = region(cx, cy, cz, r, r, r, clampMinY, clampMaxY)
  if (!reg) return bounds
  const { w, h, d, i0, j0, k0, ox, oy, oz } = reg
  const n = w * h * d
  const strideK = w * h

  // --- 1. 読み込み。効き具合を bufSdf に入れておく（縁で 0 になるので継ぎ目が出ない） ---
  const inner = r * 0.55
  const span = Math.max(1e-6, r - inner)
  const amount = Math.max(0, Math.min(1, strength)) * SMOOTH_RATE
  let active = false
  for (let k = 0; k < d; k++) {
    const dzz = oz + k
    for (let j = 0; j < h; j++) {
      const dyy = oy + j
      const row = (j + k * h) * w
      const planar = dyy * dyy + dzz * dzz
      for (let i = 0; i < w; i++) {
        const idx = row + i
        const dxx = ox + i
        const dist = Math.sqrt(dxx * dxx + planar)
        if (dist > r + REACH_PAD) {
          bufD[idx] = OUTSIDE
          bufOrigD[idx] = OUTSIDE
          bufMat[idx] = MAT_NONE
          bufOrigMat[idx] = MAT_NONE
          bufSdf[idx] = 0
          continue
        }
        const cur = readD(i0 + i, j0 + j, k0 + k)
        const m = readMat(i0 + i, j0 + j, k0 + k)
        if (cur > 0 && isLooseMaterial(m)) bounds.looseTouched++
        bufD[idx] = cur
        bufOrigD[idx] = cur
        bufMat[idx] = m
        bufOrigMat[idx] = m
        const t = Math.max(0, Math.min(1, (r - dist) / span))
        const wgt = t * t * (3 - 2 * t) * amount
        bufSdf[idx] = wgt
        if (wgt > 0) active = true
      }
    }
  }
  if (!active) return bounds

  // --- 2. ラプラシアン平滑化を数回。同時更新にするため別バッファへ書く ---
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    bufNext.set(bufD.subarray(0, n))
    for (let k = 1; k < d - 1; k++) {
      for (let j = 1; j < h - 1; j++) {
        const row = (j + k * h) * w
        for (let i = 1; i < w - 1; i++) {
          const idx = row + i
          const wgt = bufSdf[idx]
          if (wgt <= 0) continue
          const a = bufD[idx - 1]
          const b = bufD[idx + 1]
          const c = bufD[idx - w]
          const e = bufD[idx + w]
          const f = bufD[idx - strideK]
          const g = bufD[idx + strideK]
          // 読み込み範囲の外が混ざったら平滑化しない（OUTSIDE は密度ではない）
          if (a === OUTSIDE || b === OUTSIDE || c === OUTSIDE) continue
          if (e === OUTSIDE || f === OUTSIDE || g === OUTSIDE) continue
          const avg = (a + b + c + e + f + g) / 6
          bufNext[idx] = bufD[idx] + (avg - bufD[idx]) * wgt
        }
      }
    }
    bufD.set(bufNext.subarray(0, n))
  }

  // --- 3. 誤差程度の変化は捨てて書き戻す ---
  for (let idx = 0; idx < n; idx++) {
    if (Math.abs(bufD[idx] - bufOrigD[idx]) < SMOOTH_EPSILON) bufD[idx] = bufOrigD[idx]
  }
  writeBack(reg, bounds, write)
  return bounds
}

/** 土砂が横に広がれる距離（m）。これより外へは流れない。 */
const PILE_SPREAD = 6

/** ブラシの底からこの深さまで落ちる。空洞がある柱しか深く読まない。 */
const PILE_FALL = 48

/** ブラシより上にある地面をこの高さまで遡って探す（山の下を掘ったとき用）。 */
const PILE_RISE = 16

/** 自然地形が緩いとみなされる、地表からの深さ（m）。 */
const NATURAL_SKIN = 2.5

/**
 * 自然地形が緩いとみなされる、編集点からの水平距離（m）。
 * 「掘った周辺」だけを崩すための制限。置いた土砂は {@link PILE_SPREAD} まで流れる。
 * ここを広げると、砂地では region 全体が緩くなって走査が一気に増える。
 */
const NATURAL_RADIUS = 3

/** 安息角に達するまでの緩和回数と 1 回あたりの移動割合。 */
const PILE_PASSES = 64
const PILE_RELAX = 0.25

const COL_UNSCANNED = 0
const COL_OPEN = 1
const COL_BLOCKED = 2

// 柱ごとの作業配列
let colBase: Float32Array = new Float32Array(0)
let colTop: Float32Array = new Float32Array(0)
let colOldTop: Float32Array = new Float32Array(0)
let colOldLo: Float32Array = new Float32Array(0)
let colTan: Float32Array = new Float32Array(0)
let colMat: Uint8Array = new Uint8Array(0)
let colState: Uint8Array = new Uint8Array(0)

function ensureColumns(n: number): void {
  if (colBase.length >= n) return
  colBase = new Float32Array(n)
  colTop = new Float32Array(n)
  colOldTop = new Float32Array(n)
  colOldLo = new Float32Array(n)
  colTan = new Float32Array(n)
  colMat = new Uint8Array(n)
  colState = new Uint8Array(n)
}

/**
 * 緩い土砂を崩して安息角の斜面に落ち着かせる。
 *
 * ブラシとは無関係で、入力は範囲だけ。**何が緩いかは密度場と素材 ID から自分で読む**ので、
 * 盛った瞬間だけでなく「積んだ山の下を掘った」ときにも同じ処理で崩れる。
 * 置いた土砂の素材 ID は編集差分としてそのまま保存されているので、
 * 「どの土砂がまだ緩いか」のために新しい状態を持つ必要はない。
 *
 * 緩いとみなすもの:
 * - プレイヤーが置いた土・砂（素材 ID が粒状）。深さの制限なし
 * - 自然地形のうち、地表素材が土・砂寄りの柱の **上から {@link NATURAL_SKIN} まで**。
 *   ワールド全体を不安定にしないため、この関数を呼んだ範囲の中だけの話になる
 *
 * 柱ごとに解く:
 * 1. 上端の格子点を探す（ブラシより上に地面が続いていれば遡る）
 * 2. そこから下へ「緩い」格子点が続く範囲を切り出す
 * 3. その下が空気なら、さらに下の地面まで落とす
 * 4. 隣との高さ差が tan(安息角) を超える分だけ隣へ流す（流せるのは緩い分だけ）
 * 5. 動いた柱だけ密度場に書き戻す。非緩固体は union しかしないので地形は削れない
 *
 * @param ex,ey,ez 中心からの半サイズ（格子単位）。ここに {@link PILE_SPREAD} を足した範囲を見る。
 */
export function settleLoose(
  wx: number,
  wy: number,
  wz: number,
  ex: number,
  ey: number,
  ez: number,
  readD: CornerReader,
  readMat: CornerMatReader,
  readNaturalLoose: NaturalLooseReader,
  write: CornerWriter,
  clampMinY: number,
  clampMaxY: number,
): BrushBounds {
  const cx = wx / VOXEL_SIZE
  const cy = wy / VOXEL_SIZE
  const cz = wz / VOXEL_SIZE
  const bounds = emptyBounds()

  const rx = ex + PILE_SPREAD / VOXEL_SIZE
  const rz = ez + PILE_SPREAD / VOXEL_SIZE
  const i0 = Math.floor(cx - rx)
  const i1 = Math.ceil(cx + rx)
  const k0 = Math.floor(cz - rz)
  const k1 = Math.ceil(cz + rz)
  const yLimit = Math.ceil(clampMaxY / VOXEL_SIZE)
  // ブラシより上から始めること。掘って宙に浮いた庇を見落とさないために必要。
  const yTop = Math.min(yLimit, Math.ceil(cy + ey) + 2)
  const yBottom = Math.max(
    Math.floor(clampMinY / VOXEL_SIZE),
    Math.floor(cy - ey - PILE_FALL / VOXEL_SIZE),
  )
  const w = i1 - i0 + 1
  const d = k1 - k0 + 1
  if (w <= 0 || d <= 0 || yTop <= yBottom) return bounds
  const n = w * d
  ensureColumns(n)
  colState.fill(COL_UNSCANNED, 0, n)

  /** 柱の状態を測る。読むのは必要になった柱だけ。 */
  function scan(idx: number): boolean {
    if (colState[idx] !== COL_UNSCANNED) return colState[idx] === COL_OPEN
    const i = idx % w
    const gx = i0 + i
    const gz = k0 + (idx - i) / w

    // --- 1. 上端の格子点 ---
    // yTop が地面の中なら空気に出るまで遡る。急斜面では大半の柱がこれに当たるので、
    // 1 マスずつではなく指数的に跳ばしてから二分探索で詰める。
    let yc = yTop
    let air = readD(gx, yc, gz)
    if (air > 0) {
      let solidY = yTop
      let airY = -1
      for (let step = 1; step <= PILE_RISE; step *= 2) {
        const y = Math.min(yLimit, yTop + step)
        const v = readD(gx, y, gz)
        if (v <= 0) {
          airY = y
          air = v
          break
        }
        solidY = y
        if (y >= yLimit) break
      }
      if (airY < 0) {
        colState[idx] = COL_BLOCKED // 遡っても地面から抜けない
        return false
      }
      while (airY - solidY > 1) {
        const mid = (solidY + airY) >> 1
        const v = readD(gx, mid, gz)
        if (v > 0) solidY = mid
        else {
          airY = mid
          air = v
        }
      }
      yc = airY
    }
    let topY = yBottom - 1
    let topD = 0
    for (let y = yc - 1; y >= yBottom; y--) {
      const cur = readD(gx, y, gz)
      if (cur > 0) {
        topY = y
        topD = cur
        break
      }
      air = cur
    }
    if (topY < yBottom) {
      colState[idx] = COL_BLOCKED // 何も無い柱
      return false
    }
    const top = topY + topD / (topD - air)

    colState[idx] = COL_OPEN
    colOldTop[idx] = top
    colOldLo[idx] = top
    colBase[idx] = top
    colTop[idx] = top
    colTan[idx] = 0
    colMat[idx] = MAT_NONE

    // --- 2. 緩い層を切り出す ---
    // 自然地形が緩いのは編集点のすぐ周りだけ
    const nearEdit =
      Math.abs(gx - cx) <= ex + NATURAL_RADIUS / VOXEL_SIZE &&
      Math.abs(gz - cz) <= ez + NATURAL_RADIUS / VOXEL_SIZE
    let natural = -1 // 自然素材の判定は柱あたり 1 回だけ
    let naturalTop = Infinity
    let lo = topY + 1
    let loD = 0
    let tan = 0
    let mat = MAT_NONE
    for (let y = topY; y >= yBottom; y--) {
      const dv = y === topY ? topD : readD(gx, y, gz)
      if (dv <= 0) break
      const m = readMat(gx, y, gz)
      let t: number
      let id: number
      if (isLooseMaterial(m)) {
        t = LOOSE_TAN[m]
        id = m
      } else {
        // 自然地形は編集点の近く・地表から NATURAL_SKIN までしか緩くない
        if (!nearEdit) break
        if (naturalTop === Infinity) naturalTop = y
        if (naturalTop - y > NATURAL_SKIN) break
        if (natural < 0) natural = readNaturalLoose(gx, gz, top)
        if (natural === MAT_NONE) break
        t = LOOSE_TAN[natural]
        id = natural
      }
      if (t <= 0) break
      // 混ざっていたら一番寝る素材に合わせる
      if (tan === 0 || t < tan) tan = t
      if (mat === MAT_NONE) mat = id
      lo = y
      loD = dv
    }
    if (lo > topY) return true // 緩い層なし。受け取る側にはなれる

    // --- 3. 下端と落下先 ---
    const belowD = readD(gx, lo - 1, gz)
    let bottom: number
    let base: number
    if (belowD <= 0) {
      bottom = lo - 1 + -belowD / (loD - belowD)
      // 空気の上に乗っている＝落ちる。下の地面を探す
      let prev = belowD
      let ground = yBottom - 1
      for (let y = lo - 2; y >= yBottom; y--) {
        const cur = readD(gx, y, gz)
        if (cur > 0) {
          ground = y + cur / (cur - prev)
          break
        }
        prev = cur
      }
      if (ground < yBottom) {
        colState[idx] = COL_BLOCKED // 落ちる先が見つからない。動かさない
        return false
      }
      base = ground
    } else {
      // 非緩固体の上に乗っている。境界は格子の中間とみなす
      bottom = lo - 0.5
      base = bottom
    }

    colOldLo[idx] = bottom
    colBase[idx] = base
    colTop[idx] = base + (top - bottom)
    colTan[idx] = tan
    colMat[idx] = mat
    return true
  }

  // ブラシが当たった柱から始める
  for (let k = 0; k < d; k++) {
    for (let i = 0; i < w; i++) {
      const dx = i0 + i - cx
      const dz = k0 + k - cz
      if (Math.abs(dx) > ex + 1 || Math.abs(dz) > ez + 1) continue
      scan(i + k * w)
    }
  }

  // --- 4. 安息角まで崩す ---
  for (let pass = 0; pass < PILE_PASSES; pass++) {
    let moved = 0
    for (let k = 0; k < d; k++) {
      for (let i = 0; i < w; i++) {
        const idx = i + k * w
        if (colState[idx] !== COL_OPEN) continue
        let loose = colTop[idx] - colBase[idx]
        if (loose <= 1e-4) continue
        const maxStep = colTan[idx] * VOXEL_SIZE
        for (let dir = 0; dir < 4; dir++) {
          const ni = i + (dir === 0 ? 1 : dir === 1 ? -1 : 0)
          const nk = k + (dir === 2 ? 1 : dir === 3 ? -1 : 0)
          if (ni < 0 || ni >= w || nk < 0 || nk >= d) continue
          const nIdx = ni + nk * w
          if (!scan(nIdx)) continue
          const diff = colTop[idx] - colTop[nIdx] - maxStep
          if (diff <= 0) continue
          const m = Math.min(diff * PILE_RELAX, loose)
          if (m <= 1e-5) continue
          colTop[idx] -= m
          colTop[nIdx] += m
          // 受け取った側は、流れてきた土砂の性質を引き継ぐ
          if (colTan[nIdx] === 0) {
            colTan[nIdx] = colTan[idx]
            colMat[nIdx] = colMat[idx]
          }
          loose -= m
          moved += m
          if (loose <= 1e-4) break
        }
      }
    }
    if (moved < 1e-3) break
  }

  // --- 5. 動いた柱だけ書き戻す ---
  for (let k = 0; k < d; k++) {
    const gz = k0 + k
    for (let i = 0; i < w; i++) {
      const idx = i + k * w
      if (colState[idx] !== COL_OPEN) continue
      const top = colTop[idx]
      const base = colBase[idx]
      const oldTop = colOldTop[idx]
      const oldLo = colOldLo[idx]
      // 平衡状態なら 1 件も書かない（冪等。編集差分が無駄に膨らまない）
      if (Math.abs(top - oldTop) < 1e-3 && Math.abs(base - oldLo) < 1e-3) continue

      const gx = i0 + i
      const mat = colMat[idx]
      const y0 = Math.max(yBottom, Math.floor(Math.min(base, oldLo)))
      const y1 = Math.min(yLimit, Math.ceil(Math.max(top, oldTop)))
      for (let y = y0; y <= y1; y++) {
        const cur = readD(gx, y, gz)
        const curMat = readMat(gx, y, gz)
        const target = top - y
        // 元から緩かった格子点と空気は作り直す。それ以外の固体は union しかしない
        const wasLoose = cur <= 0 || (y > oldLo && y <= oldTop)
        const next = wasLoose ? target : Math.max(cur, target)
        const nextMat = wasLoose ? (target > 0 ? mat : MAT_NONE) : curMat
        if (next === cur && nextMat === curMat) continue
        write(gx, y, gz, next, nextMat)
        bounds.touched++
        if (cur <= 0 && next > 0) bounds.solidified++
        else if (cur > 0 && next <= 0) bounds.cleared++
        if (gx < bounds.minX) bounds.minX = gx
        if (y < bounds.minY) bounds.minY = y
        if (gz < bounds.minZ) bounds.minZ = gz
        if (gx > bounds.maxX) bounds.maxX = gx
        if (y > bounds.maxY) bounds.maxY = y
        if (gz > bounds.maxZ) bounds.maxZ = gz
      }
    }
  }

  return bounds
}

/**
 * 粒状の素材を盛る。普通に union してから {@link settleLoose} を掛けるだけ。
 * 置いた格子点には素材 ID が刻まれるので、あとから掘っても同じように崩れる。
 */
export function applyPileBrush(
  wx: number,
  wy: number,
  wz: number,
  shape: BrushShape,
  material: number,
  readD: CornerReader,
  readMat: CornerMatReader,
  readNaturalLoose: NaturalLooseReader,
  write: CornerWriter,
  clampMinY: number,
  clampMaxY: number,
): BrushBounds {
  const placed = applyBrush(
    wx,
    wy,
    wz,
    shape,
    'place',
    material,
    readD,
    readMat,
    write,
    clampMinY,
    clampMaxY,
  )
  mergeBounds(
    placed,
    settleLoose(
      wx,
      wy,
      wz,
      shape.ex,
      shape.ey,
      shape.ez,
      readD,
      readMat,
      readNaturalLoose,
      write,
      clampMinY,
      clampMaxY,
    ),
  )
  return placed
}

const UNVISITED = 0
const ANCHORED = 1
const FLOATING = 2

/**
 * 面で隣り合う固体が 1 個以下の格子点を空にする。
 * これがブラシの縁に残る「とげ」「薄片の先端」の正体で、
 * 小さな塊として描画されてしまう。
 *
 * 対象をブラシ表面の近傍（CLEAN_BAND の内側）に限っているので、
 * 押しっぱなしで何度適用しても穴がそれ以上広がることはない。
 * 幅 1 格子の触手だけが消え、板状の壁（面隣接が 4 個ある）はそのまま残る。
 */
function erodeThinShards(w: number, h: number, d: number): number {
  const n = w * h * d
  const strideK = w * h
  let total = 0

  for (let pass = 0; pass < ERODE_PASSES; pass++) {
    // 同時更新にするため、判定はパス開始時のスナップショットで行う
    for (let i = 0; i < n; i++) bufState[i] = bufD[i] > 0 ? 1 : 0
    let removed = 0
    for (let k = 1; k < d - 1; k++) {
      for (let j = 1; j < h - 1; j++) {
        const row = (j + k * h) * w
        for (let i = 1; i < w - 1; i++) {
          const idx = row + i
          if (bufState[idx] === 0) continue
          if (bufSdf[idx] > CLEAN_BAND) continue
          let c = 0
          if (bufState[idx - 1] !== 0) c++
          if (bufState[idx + 1] !== 0) c++
          if (bufState[idx - w] !== 0) c++
          if (bufState[idx + w] !== 0) c++
          if (bufState[idx - strideK] !== 0) c++
          if (bufState[idx + strideK] !== 0) c++
          if (c > 1) continue
          bufD[idx] = -Math.abs(bufD[idx]) - 0.05
          removed++
        }
      }
    }
    total += removed
    if (removed === 0) break
  }
  return total
}

/**
 * 読み込み範囲の外へつながっていない固体の連結成分のうち、小さいものを空にする。
 * 外殻に接している成分は本体につながっている可能性があるので必ず残す。
 *
 * 連結は 6 近傍（面で接している）で見る。斜めでしか繋がっていない小塊は
 * 見た目には本体から切り離された切れ端に見えるので、消す側に倒す。
 *
 * @returns 空にした格子点の数
 */
function removeSmallFragments(w: number, h: number, d: number, maxSize: number): number {
  const n = w * h * d
  bufState.fill(UNVISITED, 0, n)

  // 読み込み範囲の外殻にある固体を起点に、本体側を塗る。
  // ブラシの外へ抜ける経路は必ずこの殻を通るので、これで本体との連結が分かる。
  stack.length = 0
  for (let idx = 0; idx < n; idx++) {
    if (bufD[idx] <= 0 || bufState[idx] !== UNVISITED) continue
    if (bufSdf[idx] < REACH_PAD - 1) continue
    bufState[idx] = ANCHORED
    stack.push(idx)
  }
  flood(w, h, d, ANCHORED)

  // 残った固体は読み込み範囲の中で浮いている塊
  let removed = 0
  for (let idx = 0; idx < n; idx++) {
    if (bufD[idx] <= 0 || bufState[idx] !== UNVISITED) continue
    stack.length = 0
    component.length = 0
    bufState[idx] = FLOATING
    stack.push(idx)
    component.push(idx)
    flood(w, h, d, FLOATING, component)
    if (component.length > maxSize) continue
    for (const c of component) {
      // 符号を反転させて空にする。塊のすべての格子点が負になるので面ごと消える。
      bufD[c] = -Math.abs(bufD[c]) - 0.05
    }
    removed += component.length
  }
  return removed
}

const FACE: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
]

/** `stack` を起点に 6 近傍を塗りつぶす。 */
function flood(w: number, h: number, d: number, mark: number, collect?: number[]): void {
  while (stack.length > 0) {
    const idx = stack.pop()!
    const i = idx % w
    const rest = (idx - i) / w
    const j = rest % h
    const k = (rest - j) / h
    for (const [di, dj, dk] of FACE) {
      const ni = i + di
      if (ni < 0 || ni >= w) continue
      const nj = j + dj
      if (nj < 0 || nj >= h) continue
      const nk = k + dk
      if (nk < 0 || nk >= d) continue
      const nIdx = ni + (nj + nk * h) * w
      if (bufD[nIdx] <= 0 || bufState[nIdx] !== UNVISITED) continue
      bufState[nIdx] = mark
      stack.push(nIdx)
      collect?.push(nIdx)
    }
  }
}

export { MAT_NONE }
