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
 * この数以下の格子点しか持たない塊は切れ端とみなして消す。
 * 8 点 = だいたい 1m 角。掘ったときに残る目に見えるゴミはほぼこの大きさ以下。
 */
export const MAX_FRAGMENT_CORNERS = 8

/**
 * ブラシ球からこの距離までを掃除の対象にする。外側は絶対に削らない。
 * 読み込み範囲は r + 2 なので、面隣接を数える 1 格子ぶんの余裕がある。
 */
const CLEAN_BAND = 1.0

/** 読み込んでいない格子点の印。空気として扱われ、書き戻されない。 */
const OUTSIDE = -1e9

/** とげを削る回数。2 回で「幅 1 格子の触手」まで消える。 */
const ERODE_PASSES = 2

// 呼び出しごとの確保を避けるための作業バッファ
let bufD: Float32Array = new Float32Array(0)
let bufOrigD: Float32Array = new Float32Array(0)
let bufMat: Uint8Array = new Uint8Array(0)
let bufOrigMat: Uint8Array = new Uint8Array(0)
let bufState: Uint8Array = new Uint8Array(0)
const stack: number[] = []
const component: number[] = []

function ensure(n: number): void {
  if (bufD.length >= n) return
  bufD = new Float32Array(n)
  bufOrigD = new Float32Array(n)
  bufMat = new Uint8Array(n)
  bufOrigMat = new Uint8Array(n)
  bufState = new Uint8Array(n)
}

/**
 * 球ブラシを密度場に適用する。
 *
 * ブラシを符号付き距離場として扱い、
 *   設置 = union      : d = max(d,  r - dist)
 *   掘削 = subtraction: d = min(d, dist - r)
 * とすることで、何度掛けても値が発散せず、常に真円のくぼみ・膨らみになる。
 *
 * 掘ったあとは、影響範囲の中で本体から切り離された小さな塊を取り除く。
 * 地形の等値面は「密度が正の格子点」があるところにしか生まれないので、
 * 格子点の連結成分を見れば目に見える切れ端を漏れなく検出できる。
 */
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
  const cx = wx / VOXEL_SIZE
  const cy = wy / VOXEL_SIZE
  const cz = wz / VOXEL_SIZE
  const r = radius / VOXEL_SIZE
  // 影響範囲より少し広く走査して、境界のコーナーも滑らかに更新する
  const reach = r + 2

  const i0 = Math.floor(cx - reach)
  const i1 = Math.ceil(cx + reach)
  const j0 = Math.max(Math.floor(clampMinY / VOXEL_SIZE), Math.floor(cy - reach))
  const j1 = Math.min(Math.ceil(clampMaxY / VOXEL_SIZE), Math.ceil(cy + reach))
  const k0 = Math.floor(cz - reach)
  const k1 = Math.ceil(cz + reach)

  const bounds: BrushBounds = {
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

  const w = i1 - i0 + 1
  const h = j1 - j0 + 1
  const dz = k1 - k0 + 1
  if (w <= 0 || h <= 0 || dz <= 0) return bounds
  ensure(w * h * dz)

  // --- 1. ブラシの届く範囲だけ現在の値を読み込み、その場で球を合成する ---
  // 範囲外は OUTSIDE のままにしておく。書き戻されず、掃除の対象にもならない。
  const ox = i0 - cx
  const oy = j0 - cy
  const oz = k0 - cz
  const reach2 = reach * reach
  for (let k = 0; k < dz; k++) {
    const dzz = oz + k
    for (let j = 0; j < h; j++) {
      const dyy = oy + j
      const row = (j + k * h) * w
      const planar = dyy * dyy + dzz * dzz
      for (let i = 0; i < w; i++) {
        const idx = row + i
        const dxx = ox + i
        const dist2 = dxx * dxx + planar
        if (dist2 > reach2) {
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
        const sphere = r - Math.sqrt(dist2)
        const next = mode === 'place' ? Math.max(cur, sphere) : Math.min(cur, -sphere)
        bufD[idx] = next
        bufMat[idx] = mode === 'place' && next > 0 && sphere > -0.5 ? material : m
      }
    }
  }

  // --- 2. 掘ったときは切れ端を掃除する ---
  if (mode === 'dig') {
    const limit = r + CLEAN_BAND
    bounds.fragmentsRemoved =
      erodeThinShards(w, h, dz, ox, oy, oz, limit * limit) +
      removeSmallFragments(w, h, dz, ox, oy, oz, reach, MAX_FRAGMENT_CORNERS)
  }

  // --- 3. 変化した格子点だけ書き戻す ---
  for (let k = 0; k < dz; k++) {
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
 * 対象をブラシ球の近傍（limit2 の内側）に限っているので、
 * 押しっぱなしで何度適用しても穴がそれ以上広がることはない。
 * 幅 1 格子の触手だけが消え、板状の壁（面隣接が 4 個ある）はそのまま残る。
 */
function erodeThinShards(
  w: number,
  h: number,
  d: number,
  ox: number,
  oy: number,
  oz: number,
  limit2: number,
): number {
  const n = w * h * d
  const strideK = w * h
  let total = 0

  for (let pass = 0; pass < ERODE_PASSES; pass++) {
    // 同時更新にするため、判定はパス開始時のスナップショットで行う
    for (let i = 0; i < n; i++) bufState[i] = bufD[i] > 0 ? 1 : 0
    let removed = 0
    for (let k = 1; k < d - 1; k++) {
      const dz = oz + k
      for (let j = 1; j < h - 1; j++) {
        const dy = oy + j
        const row = (j + k * h) * w
        const planar = dy * dy + dz * dz
        for (let i = 1; i < w - 1; i++) {
          const idx = row + i
          if (bufState[idx] === 0) continue
          const dx = ox + i
          if (dx * dx + planar > limit2) continue
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
 * 箱の外へつながっていない固体の連結成分のうち、小さいものを空にする。
 * 箱の面に接している成分は本体につながっている可能性があるので必ず残す。
 *
 * 連結は 6 近傍（面で接している）で見る。斜めでしか繋がっていない小塊は
 * 見た目には本体から切り離された切れ端に見えるので、消す側に倒す。
 *
 * @returns 空にした格子点の数
 */
function removeSmallFragments(
  w: number,
  h: number,
  d: number,
  ox: number,
  oy: number,
  oz: number,
  reach: number,
  maxSize: number,
): number {
  const n = w * h * d
  bufState.fill(UNVISITED, 0, n)

  // 読み込み範囲の外殻にある固体を起点に、本体側を塗る。
  // ブラシの外へ抜ける経路は必ずこの殻を通るので、これで本体との連結が分かる。
  const shell2 = (reach - 1) * (reach - 1)
  stack.length = 0
  for (let k = 0; k < d; k++) {
    const dz = oz + k
    for (let j = 0; j < h; j++) {
      const dy = oy + j
      const row = (j + k * h) * w
      const planar = dy * dy + dz * dz
      for (let i = 0; i < w; i++) {
        const idx = row + i
        if (bufD[idx] <= 0 || bufState[idx] !== UNVISITED) continue
        const dx = ox + i
        if (dx * dx + planar < shell2) continue
        bufState[idx] = ANCHORED
        stack.push(idx)
      }
    }
  }
  flood(w, h, d, ANCHORED)

  // 残った固体は箱の中で浮いている塊
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
