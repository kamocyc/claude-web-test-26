import { SEA_LEVEL } from './constants'
import { desertness } from './density'
import type { Biome, DensityField } from './density'
import type { MeshData } from './surfaceNets'
import { mulberry32 } from './noise'

/** 1 本あたりの要素数: x, y, z, scale, rotY, type */
export const TREE_STRIDE = 6

export const TREE_BROADLEAF = 0
export const TREE_CONIFER = 1
export const TREE_CACTUS = 2
export const TREE_TYPE_COUNT = 3

/** 木を 1 本まで置ける格子の一辺（m）。 */
export const TREE_CELL = 4.6
const CELL = TREE_CELL
/** これより急な面には生えない。 */
const MIN_NY = 0.8

/** ワールド座標から、その点が属する木のセルキーを求める。 */
export function treeCellKey(x: number, z: number): number {
  return Math.floor(x / CELL) * 1048576 + (Math.floor(z / CELL) + 524288)
}

interface CellPlan {
  /** 置くならジッタ後の目標位置、置かないなら null */
  tx: number
  tz: number
  type: number
  scale: number
  rot: number
}

/**
 * メッシュの頂点から木の配置を決める。
 *
 * 地形の等値面はすでに Worker が持っているので、上向きの頂点をそのまま
 * 木の足場として使える。格子セルごとに 1 本までに絞ることで均等に散らばり、
 * 位置はセル座標のハッシュだけで決まるので再メッシュしても同じ場所に戻る。
 */
export function scatterTrees(
  field: DensityField,
  mesh: MeshData,
  ox: number,
  oy: number,
  oz: number,
  seed: number,
  chopped: Float64Array | null,
): Float32Array {
  const removed = chopped && chopped.length > 0 ? new Set<number>(chopped) : null
  const plans = new Map<number, CellPlan | null>()
  const best = new Map<number, { vi: number; d2: number }>()
  const bio: Biome = { temp: 0, humid: 0, mountain: 0 }

  const count = mesh.positions.length / 3
  for (let i = 0; i < count; i++) {
    if (mesh.normals[i * 3 + 1] < MIN_NY) continue
    const wy = oy + mesh.positions[i * 3 + 1]
    if (wy < SEA_LEVEL + 0.6 || wy > 118) continue
    const wx = ox + mesh.positions[i * 3]
    const wz = oz + mesh.positions[i * 3 + 2]

    const cellX = Math.floor(wx / CELL)
    const cellZ = Math.floor(wz / CELL)
    const key = cellX * 1048576 + (cellZ + 524288)

    let plan = plans.get(key)
    if (plan === undefined) {
      plan = removed?.has(key) ? null : planCell(field, cellX, cellZ, seed, bio)
      plans.set(key, plan)
    }
    if (plan === null) continue

    const dx = wx - plan.tx
    const dz = wz - plan.tz
    const d2 = dx * dx + dz * dz
    const cur = best.get(key)
    if (!cur || d2 < cur.d2) best.set(key, { vi: i, d2 })
  }

  const out = new Float32Array(best.size * TREE_STRIDE)
  let n = 0
  for (const [key, hit] of best) {
    const plan = plans.get(key)!
    out[n] = ox + mesh.positions[hit.vi * 3]
    out[n + 1] = oy + mesh.positions[hit.vi * 3 + 1] - 0.35
    out[n + 2] = oz + mesh.positions[hit.vi * 3 + 2]
    out[n + 3] = plan.scale
    out[n + 4] = plan.rot
    out[n + 5] = plan.type
    n += TREE_STRIDE
  }
  return out
}

/** セルに木を置くかどうかと、その種類・大きさを決める。 */
function planCell(
  field: DensityField,
  cellX: number,
  cellZ: number,
  seed: number,
  bio: Biome,
): CellPlan | null {
  const cx = (cellX + 0.5) * CELL
  const cz = (cellZ + 0.5) * CELL

  // 村の敷地内には生やさない
  const v = field.villageNear(cx, cz)
  if (v && Math.hypot(cx - v.cx, cz - v.cz) < v.radius * 0.78) return null

  field.biomeAt(cx, cz, bio)
  const desert = desertness(bio.temp, bio.humid)

  let density: number
  let type: number
  if (desert > 0.45) {
    density = 0.06 * desert
    type = TREE_CACTUS
  } else if (bio.temp < 0.34) {
    density = 0.14 + bio.humid * 0.34
    type = TREE_CONIFER
  } else if (bio.humid > 0.55) {
    density = 0.35 + (bio.humid - 0.55) * 1.5
    type = bio.temp < 0.5 ? TREE_CONIFER : TREE_BROADLEAF
  } else {
    density = 0.03 + bio.humid * 0.12
    type = TREE_BROADLEAF
  }
  density *= 1 - bio.mountain * 0.85
  if (density <= 0.002) return null

  const rand = cellRandom(cellX, cellZ, seed)
  if (rand() > density) return null

  return {
    tx: cx + (rand() - 0.5) * CELL * 0.8,
    tz: cz + (rand() - 0.5) * CELL * 0.8,
    type,
    scale: 0.72 + rand() * 0.7,
    rot: rand() * Math.PI * 2,
  }
}

function cellRandom(cellX: number, cellZ: number, seed: number): () => number {
  let h = (Math.imul(cellX, 2654435761) + Math.imul(cellZ, 40503) + Math.imul(seed, 2246822519)) | 0
  h = Math.imul(h ^ (h >>> 15), 2246822519)
  return mulberry32((h ^ (h >>> 13)) >>> 0)
}
