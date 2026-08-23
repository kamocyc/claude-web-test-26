import { VOXEL_SIZE } from './constants'
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
}

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
    sdf: (dx, dy, dz) => {
      const qx = Math.abs(dx) - ax
      const qy = Math.abs(dy) - ay
      const qz = Math.abs(dz) - az
      const ox = qx > 0 ? qx : 0
      const oy = qy > 0 ? qy : 0
      const oz = qz > 0 ? qz : 0
      const outside = Math.sqrt(ox * ox + oy * oy + oz * oz)
      const inside = Math.min(Math.max(qx, qy, qz), 0)
      return outside + inside
    },
    span: (dx, dz, out) => {
      const hit = Math.abs(dx) <= ax && Math.abs(dz) <= az
      out.lo = hit ? -ay : 1
      out.hi = hit ? ay : -1
      return out
    },
  }
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
  }
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
): BrushBounds {
  const cx = wx / VOXEL_SIZE
  const cy = wy / VOXEL_SIZE
  const cz = wz / VOXEL_SIZE

  const bounds = emptyBounds()
  const reg = region(cx, cy, cz, shape.ex, shape.ey, shape.ez, clampMinY, clampMaxY)
  if (!reg) return bounds
  const { w, h, d, i0, j0, k0, ox, oy, oz } = reg

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
        const next = place ? Math.max(cur, SURFACE_BIAS - s) : Math.min(cur, s)
        bufD[idx] = next
        bufMat[idx] = place && next > 0 && s < 0.5 ? material : m
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
const PILE_SPREAD = 8

/** ブラシの底からこの深さまで落ちる。 */
const PILE_FALL = 6

/** 安息角に達するまでの緩和回数と 1 回あたりの移動割合。 */
const PILE_PASSES = 64
const PILE_RELAX = 0.25

const COL_UNSCANNED = 0
const COL_OPEN = 1
const COL_BLOCKED = 2

// 柱ごとの作業配列
let colBase: Float32Array = new Float32Array(0)
let colTop: Float32Array = new Float32Array(0)
let colState: Uint8Array = new Uint8Array(0)
const scratchSpan: Span = { lo: 0, hi: 0 }

function ensureColumns(n: number): void {
  if (colBase.length >= n) return
  colBase = new Float32Array(n)
  colTop = new Float32Array(n)
  colState = new Uint8Array(n)
}

/**
 * 粒状の素材（土・砂）を盛る。ブラシの形に固まらず、**落ちて安息角の山になる**。
 *
 * 密度場を直接崩すのではなく、柱ごとの高さ場に置き換えて解く:
 *
 * 1. ブラシの footprint の各柱について、いまの地表の高さ `base` を求める
 *    （上から下へ最初に固体になるところ。線形補間するので段差にならない）
 * 2. ブラシがその柱を貫く長さのうち **地表より上の分** を、その柱に積む
 *    （地表より下はもともと固体なので、置いても何も増えない）
 * 3. 隣り合う柱の高さ差が `tan(安息角)` を超えているあいだ、超過分を隣へ流す。
 *    流せるのは今回積んだ分だけなので、元の地形は削れない
 * 4. 柱ごとに、元の地表の 1 つ下から新しい地表までを密度場に union する
 *
 * 落下は 1 の時点で織り込まれている。空中に置いても、その柱の地表の上に積まれる。
 * 地表の探索は必要になった柱だけ遅延して行う（山が届かない柱は読まない）。
 *
 * @param repose 安息角（度）。土 38°、砂 32° 程度。
 */
export function applyPileBrush(
  wx: number,
  wy: number,
  wz: number,
  shape: BrushShape,
  material: number,
  repose: number,
  readD: CornerReader,
  readMat: CornerMatReader,
  write: CornerWriter,
  clampMinY: number,
  clampMaxY: number,
): BrushBounds {
  const cx = wx / VOXEL_SIZE
  const cy = wy / VOXEL_SIZE
  const cz = wz / VOXEL_SIZE
  const bounds = emptyBounds()

  const rx = shape.ex + PILE_SPREAD / VOXEL_SIZE
  const rz = shape.ez + PILE_SPREAD / VOXEL_SIZE
  const i0 = Math.floor(cx - rx)
  const i1 = Math.ceil(cx + rx)
  const k0 = Math.floor(cz - rz)
  const k1 = Math.ceil(cz + rz)
  const yTop = Math.min(Math.ceil(clampMaxY / VOXEL_SIZE), Math.ceil(cy + shape.ey) + 1)
  const yBottom = Math.max(
    Math.floor(clampMinY / VOXEL_SIZE),
    Math.floor(cy - shape.ey - PILE_FALL / VOXEL_SIZE),
  )
  const w = i1 - i0 + 1
  const d = k1 - k0 + 1
  if (w <= 0 || d <= 0 || yTop <= yBottom) return bounds
  const n = w * d
  ensureColumns(n)
  colState.fill(COL_UNSCANNED, 0, n)

  /** 柱の地表を測る。天井まで詰まっていれば壁として扱う。 */
  function scan(idx: number): boolean {
    if (colState[idx] !== COL_UNSCANNED) return colState[idx] === COL_OPEN
    const i = idx % w
    const gx = i0 + i
    const gz = k0 + (idx - i) / w
    let prev = readD(gx, yTop, gz)
    if (prev > 0) {
      colState[idx] = COL_BLOCKED
      return false
    }
    let base = yBottom
    for (let y = yTop - 1; y >= yBottom; y--) {
      const cur = readD(gx, y, gz)
      if (cur > 0) {
        base = y + cur / (cur - prev)
        break
      }
      prev = cur
    }
    colState[idx] = COL_OPEN
    colBase[idx] = base
    colTop[idx] = base
    return true
  }

  // --- 1〜2. ブラシが当たる柱だけ測って、地表より上の分を積む ---
  for (let k = 0; k < d; k++) {
    const dz = k0 + k - cz
    for (let i = 0; i < w; i++) {
      const span = shape.span(i0 + i - cx, dz, scratchSpan)
      if (span.hi <= span.lo) continue
      const idx = i + k * w
      if (!scan(idx)) continue
      const hi = cy + span.hi
      const lo = Math.max(colBase[idx], cy + span.lo)
      if (hi > lo) colTop[idx] = colBase[idx] + (hi - lo)
    }
  }

  // --- 3. 安息角まで崩す ---
  const maxStep = Math.tan((repose * Math.PI) / 180) * VOXEL_SIZE
  for (let pass = 0; pass < PILE_PASSES; pass++) {
    let moved = 0
    for (let k = 0; k < d; k++) {
      for (let i = 0; i < w; i++) {
        const idx = i + k * w
        if (colState[idx] !== COL_OPEN) continue
        let loose = colTop[idx] - colBase[idx]
        if (loose <= 1e-4) continue
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
          loose -= m
          moved += m
          if (loose <= 1e-4) break
        }
      }
    }
    if (moved < 1e-3) break
  }

  // --- 4. 柱ごとに密度場へ union する ---
  const yLimit = Math.ceil(clampMaxY / VOXEL_SIZE)
  for (let k = 0; k < d; k++) {
    const gz = k0 + k
    for (let i = 0; i < w; i++) {
      const idx = i + k * w
      if (colState[idx] !== COL_OPEN) continue
      const base = colBase[idx]
      const top = colTop[idx]
      if (top - base < 1e-3) continue
      const gx = i0 + i
      // 元の地表の 1 つ下から新しい地表の 1 つ上までを、半空間 `top - y` と union する。
      // 範囲を切っているので、下にある洞窟は埋まらない。
      const y0 = Math.max(yBottom, Math.floor(base))
      const y1 = Math.min(yLimit, Math.ceil(top))
      for (let y = y0; y <= y1; y++) {
        const cur = readD(gx, y, gz)
        const next = Math.max(cur, top - y)
        if (next === cur) continue
        write(gx, y, gz, next, next > 0 ? material : readMat(gx, y, gz))
        bounds.touched++
        if (cur <= 0 && next > 0) bounds.solidified++
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
