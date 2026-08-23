import { Noise, clamp, smoothstep } from './noise'
import {
  BEDROCK_Y,
  CAVE_MIN_Y,
  CHUNK_SIZE,
  GRID,
  PAD,
  SEA_LEVEL,
  VOXEL_SIZE,
} from './constants'

/** 3D 項が地表からどれだけ離れたら効かなくなるか。 */
const SURFACE_BAND = 16
const OVERHANG_AMP = 9.5

/**
 * 連続的な密度場。`density(x, y, z) > 0` が固体。
 * ボクセル格子ではなくこの連続関数がワールドの「真の表現」であり、
 * Surface Nets で等値面を取り出すことで完全に滑らかな地形になる。
 */
export class DensityField {
  readonly seed: number
  private readonly n: Noise

  constructor(seed: number) {
    this.seed = seed
    this.n = new Noise(seed)
  }

  /** 地表高度（ワールド座標 x, z）。 */
  height(x: number, z: number): number {
    const n = this.n

    // ドメインワープ：等方的なノイズ感を消して river/尾根らしい流れを作る
    const wx = x + n.fbm2(x * 0.0035 + 91.3, z * 0.0035 - 17.7, 2) * 28
    const wz = z + n.fbm2(x * 0.0035 - 55.1, z * 0.0035 + 63.9, 2) * 28

    const cont = n.fbm2(wx * 0.0011, wz * 0.0011, 4)
    let h = -14 + cont * 46

    const mask = smoothstep(0.05, 0.55, n.fbm2(wx * 0.00085 + 311, wz * 0.00085 - 127, 3))
    const ridge = n.ridged2(wx * 0.0031, wz * 0.0031, 5)
    h += mask * Math.pow(ridge, 1.7) * 82

    h += n.fbm2(wx * 0.011, wz * 0.011, 4) * (5 + mask * 9)
    h += n.fbm2(wx * 0.045, wz * 0.045, 3) * 1.7

    // 海岸線付近を平坦化して砂浜を作る（連続なブレンドなので段差は出ない）
    const flat = smoothstep(11, 2.5, Math.abs(h - SEA_LEVEL))
    h = h + (h - SEA_LEVEL) * -0.62 * flat

    return h
  }

  /**
   * 密度。`h` に事前計算済みの `height(x, z)` を渡せる（列ごとにキャッシュ可能）。
   */
  density(x: number, y: number, z: number, h = this.height(x, z)): number {
    const n = this.n
    let d = h - y

    // 地表付近だけ 3D ノイズを足してオーバーハングや崖の抉れを作る
    const ad = Math.abs(d)
    if (ad < SURFACE_BAND) {
      const m = 1 - smoothstep(6, SURFACE_BAND, ad)
      d += n.fbm3(x * 0.021, y * 0.026, z * 0.021, 3) * OVERHANG_AMP * m
    }

    // 洞窟：2 つの尾根ノイズの積 = 細長いトンネル
    if (y > CAVE_MIN_Y && y < h - 3) {
      const r1 = n.ridged3(x * 0.0132 + 11, y * 0.019 + 7, z * 0.0132 - 5, 2)
      const r2 = n.ridged3(x * 0.0132 - 31, y * 0.019 + 41, z * 0.0132 + 23, 2)
      let c = smoothstep(0.79, 0.96, r1) * smoothstep(0.79, 0.96, r2)
      if (c > 0) {
        c *= smoothstep(0, 12, h - 3 - y)
        c *= smoothstep(CAVE_MIN_Y, CAVE_MIN_Y + 26, y)
        d -= c * 30
      }
    }

    // 奈落防止：最下部は必ず固体
    d += smoothstep(BEDROCK_Y + 16, BEDROCK_Y, y) * 80

    return d
  }

  /**
   * 頂点位置と法線から素材の重み（grass/dirt/rock/sand）を求める。
   * 出力は合計 1 に正規化された 4 要素。
   */
  materialWeights(x: number, y: number, z: number, ny: number, out: Float32Array, at: number): void {
    const slope = 1 - ny
    const patch = this.n.fbm2(x * 0.021 + 7, z * 0.021 - 3, 2)

    let rock = smoothstep(0.34, 0.72, slope + patch * 0.1)
    rock = Math.max(rock, smoothstep(62, 92, y))

    const shore = smoothstep(4.5, 0.8, Math.abs(y - SEA_LEVEL))
    const shallow = smoothstep(-1.5, -6, y) * smoothstep(-30, -14, y)
    const sand = clamp(Math.max(shore, shallow) * (1 - rock), 0, 1)

    let dirt = smoothstep(0.15, 0.44, slope) * (1 - rock) * (1 - sand)
    dirt = Math.max(dirt, (1 - rock) * (1 - sand) * clamp(patch * 0.8, 0, 1) * 0.45)

    const grass = Math.max(0, 1 - rock - sand - dirt)

    const sum = rock + sand + dirt + grass || 1
    out[at] = grass / sum
    out[at + 1] = dirt / sum
    out[at + 2] = rock / sum
    out[at + 3] = sand / sum
  }
}

export interface ChunkFieldResult {
  /** GRID^3 の密度。全体が同符号（等値面なし）なら null。 */
  density: Float32Array | null
}

interface ColumnData {
  heights: Float32Array
  hMin: number
  hMax: number
}

/**
 * 列（cx, cz）ごとの高度マップのキャッシュ。
 * 同じ列の上下のチャンクは同じ高度マップを使うので、これだけで
 * 2D ノイズの評価回数が鉛直チャンク数ぶんの 1 になる。
 */
export class ColumnHeightCache {
  private readonly map = new Map<string, ColumnData>()

  constructor(private readonly capacity = 16) {}

  get(field: DensityField, cx: number, cz: number): ColumnData {
    const key = `${cx},${cz}`
    const hit = this.map.get(key)
    if (hit) return hit

    const ox = cx * CHUNK_SIZE - PAD
    const oz = cz * CHUNK_SIZE - PAD
    const heights = new Float32Array(GRID * GRID)
    let hMin = Infinity
    let hMax = -Infinity
    for (let k = 0; k < GRID; k++) {
      const wz = (oz + k) * VOXEL_SIZE
      for (let i = 0; i < GRID; i++) {
        const h = field.height((ox + i) * VOXEL_SIZE, wz)
        heights[i + k * GRID] = h
        if (h < hMin) hMin = h
        if (h > hMax) hMax = h
      }
    }

    const data: ColumnData = { heights, hMin, hMax }
    if (this.map.size >= this.capacity) {
      const oldest = this.map.keys().next()
      if (!oldest.done) this.map.delete(oldest.value)
    }
    this.map.set(key, data)
    return data
  }
}

/**
 * チャンクの密度グリッドを生成する。
 * 列ごとの 2D 高度をキャッシュし、地表から十分離れた領域では 3D ノイズを省くことで
 * 地表以外のチャンクをほぼゼロコストにする。
 */
export function generateChunkDensity(
  field: DensityField,
  cx: number,
  cy: number,
  cz: number,
  hasEdits: boolean,
  cache?: ColumnHeightCache,
): ChunkFieldResult {
  const ox = cx * CHUNK_SIZE - PAD
  const oy = cy * CHUNK_SIZE - PAD
  const oz = cz * CHUNK_SIZE - PAD

  const column = (cache ?? DEFAULT_COLUMN_CACHE).get(field, cx, cz)
  const heights = column.heights
  const hMin = column.hMin
  const hMax = column.hMax

  const yLo = oy * VOXEL_SIZE
  const yHi = (oy + GRID - 1) * VOXEL_SIZE

  if (!hasEdits) {
    // 完全に空中：等値面なし
    if (yLo > hMax + SURFACE_BAND + OVERHANG_AMP) return { density: null }
    // 完全に地中かつ洞窟レンジ外、かつ岩盤より上：等値面なし
    if (yHi < hMin - SURFACE_BAND - OVERHANG_AMP && yLo > CAVE_MIN_Y && yLo > BEDROCK_Y + 16) {
      return { density: null }
    }
  }

  const density = new Float32Array(GRID * GRID * GRID)
  let anySolid = false
  let anyAir = false

  for (let k = 0; k < GRID; k++) {
    const wz = (oz + k) * VOXEL_SIZE
    for (let j = 0; j < GRID; j++) {
      const wy = (oy + j) * VOXEL_SIZE
      const rowBase = GRID * (j + GRID * k)
      for (let i = 0; i < GRID; i++) {
        const h = heights[i + k * GRID]
        const d = field.density((ox + i) * VOXEL_SIZE, wy, wz, h)
        density[i + rowBase] = d
        if (d > 0) anySolid = true
        else anyAir = true
      }
    }
  }

  if (!hasEdits && (!anySolid || !anyAir)) return { density: null }
  return { density }
}

const DEFAULT_COLUMN_CACHE = new ColumnHeightCache(4)
