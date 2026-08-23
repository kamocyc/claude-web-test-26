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
}

/**
 * 球ブラシを密度場に適用する。
 *
 * ブラシを符号付き距離場として扱い、
 *   設置 = union      : d = max(d,  r - dist)
 *   掘削 = subtraction: d = min(d, dist - r)
 * とすることで、何度掛けても値が発散せず、常に真円のくぼみ・膨らみになる。
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
  }

  for (let k = k0; k <= k1; k++) {
    const dz = k - cz
    for (let j = j0; j <= j1; j++) {
      const dy = j - cy
      for (let i = i0; i <= i1; i++) {
        const dx = i - cx
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
        if (dist > reach) continue

        const sphere = r - dist
        const cur = readD(i, j, k)
        const next = mode === 'place' ? Math.max(cur, sphere) : Math.min(cur, -sphere)
        const curMat = readMat(i, j, k)
        let nextMat = curMat
        if (mode === 'place' && next > 0 && sphere > -0.5) nextMat = material
        if (next === cur && nextMat === curMat) continue

        write(i, j, k, next, nextMat)
        bounds.touched++
        if (cur <= 0 && next > 0) bounds.solidified++
        else if (cur > 0 && next <= 0) bounds.cleared++
        if (i < bounds.minX) bounds.minX = i
        if (j < bounds.minY) bounds.minY = j
        if (k < bounds.minZ) bounds.minZ = k
        if (i > bounds.maxX) bounds.maxX = i
        if (j > bounds.maxY) bounds.maxY = j
        if (k > bounds.maxZ) bounds.maxZ = k
      }
    }
  }

  return bounds
}

export { MAT_NONE }
