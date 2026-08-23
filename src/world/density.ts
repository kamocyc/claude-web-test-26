import { Noise, clamp, smoothstep } from './noise'
import {
  BEDROCK_Y,
  CAVE_MIN_Y,
  CHUNK_SIZE,
  GRID,
  PAD,
  SEA_LEVEL,
  VILLAGE_CELL,
  VOXEL_SIZE,
} from './constants'
import { flattenReach, flattenWeight, makeVillage, pathWeight, villageKey } from './village'
import type { Village } from './village'

/** 3D 項が地表からどれだけ離れたら効かなくなるか。 */
const SURFACE_BAND = 17
const OVERHANG_AMP = 13

/** 高度の緩やかな上限（山が世界の天井を突き抜けないように）。 */
const SOFT_CAP = 130
const CAP_RANGE = 40

export interface Biome {
  /** 0 = 寒冷, 1 = 高温 */
  temp: number
  /** 0 = 乾燥, 1 = 湿潤 */
  humid: number
  /** 0 = 平地, 1 = 山岳 */
  mountain: number
}

/**
 * 連続的な密度場。`density(x, y, z) > 0` が固体。
 * ボクセル格子ではなくこの連続関数がワールドの「真の表現」であり、
 * Surface Nets で等値面を取り出すことで完全に滑らかな地形になる。
 */
export class DensityField {
  readonly seed: number
  private readonly n: Noise
  private readonly villages = new Map<number, Village | null>()
  private readonly scratchHeight: Biome = { temp: 0.5, humid: 0.5, mountain: 0 }
  private readonly scratchSurface: Biome = { temp: 0.5, humid: 0.5, mountain: 0 }

  constructor(seed: number) {
    this.seed = seed
    this.n = new Noise(seed)
  }

  // ------------------------------------------------------------- バイオーム

  /** ワールド座標でのバイオーム。地形と揃うようドメインワープ後の座標で評価する。 */
  biomeAt(x: number, z: number, out: Biome = { temp: 0, humid: 0, mountain: 0 }): Biome {
    const n = this.n
    const wx = x + n.fbm2(x * 0.0035 + 91.3, z * 0.0035 - 17.7, 2) * 28
    const wz = z + n.fbm2(x * 0.0035 - 55.1, z * 0.0035 + 63.9, 2) * 28
    return this.biomeWarped(wx, wz, out)
  }

  private biomeWarped(wx: number, wz: number, out: Biome): Biome {
    const n = this.n
    out.temp = clamp(n.fbm2(wx * 0.00038 + 701, wz * 0.00038 - 419, 3) * 0.62 + 0.5, 0, 1)
    out.humid = clamp(n.fbm2(wx * 0.00051 - 223, wz * 0.00051 + 887, 3) * 0.66 + 0.5, 0, 1)
    out.mountain = smoothstep(0.02, 0.5, n.fbm2(wx * 0.00085 + 311, wz * 0.00085 - 127, 3))
    return out
  }

  // ----------------------------------------------------------------- 高さ場

  /**
   * 村による平坦化を含まない素の地形高度。
   * 村の敷地高さを決めるときに再帰しないよう、村の処理と分けてある。
   */
  baseHeight(x: number, z: number): number {
    const n = this.n

    // ドメインワープ：等方的なノイズ感を消して尾根や谷の「流れ」を作る
    const wx = x + n.fbm2(x * 0.0035 + 91.3, z * 0.0035 - 17.7, 2) * 28
    const wz = z + n.fbm2(x * 0.0035 - 55.1, z * 0.0035 + 63.9, 2) * 28

    const bio = this.biomeWarped(wx, wz, this.scratchHeight)
    const mask = bio.mountain

    // 大陸：fbm の実効レンジで正規化してから振幅を掛け、陸と海がほぼ半々になるようにする
    const cont = clamp(n.fbm2(wx * 0.0011, wz * 0.0011, 4) / 0.52, -1, 1)
    let h = -4 + cont * 48

    // 山：尾根ノイズを鋭くし、振幅を上げる
    const ridge = n.ridged2(wx * 0.0031, wz * 0.0031, 5)
    h += mask * Math.pow(ridge, 2.0) * 132
    // 二次尾根で断崖と段丘を作る
    h += mask * mask * n.ridged2(wx * 0.0098 + 61, wz * 0.0098 - 44, 3) * 24

    // 丘：湿潤な平地はなだらか、山地はうねる
    const plains = (1 - mask) * smoothstep(0.55, 0.2, Math.abs(bio.humid - 0.45))
    h += n.fbm2(wx * 0.011, wz * 0.011, 4) * (4 + mask * 15 - plains * 2.5)

    // 砂漠の砂丘
    const desert = desertness(bio.temp, bio.humid) * (1 - mask)
    if (desert > 0.01) {
      h += Math.abs(n.fbm2(wx * 0.021 + 17, wz * 0.021 - 9, 2)) * desert * 10
    }

    h += n.fbm2(wx * 0.045, wz * 0.045, 3) * (1.3 + mask * 2.6)

    // 川と湖。海面は一枚の平面なので、y<0 まで彫れば自動的に水が入る。
    if (h < 150) {
      const rn = n.fbm2(wx * 0.00155 + 55, wz * 0.00155 - 91, 3)
      const river = 1 - Math.min(1, Math.abs(rn) / 0.062)
      if (river > 0) {
        const s = river * river * (1 - mask * 0.9) * smoothstep(125, 28, h)
        if (s > 0.001) h += (SEA_LEVEL - 2.6 - h) * s * 0.92
      }
      const lake =
        smoothstep(0.34, 0.72, n.fbm2(wx * 0.00088 + 404, wz * 0.00088 - 771, 3)) *
        (1 - mask) *
        smoothstep(48, 8, h)
      if (lake > 0.001) h += (SEA_LEVEL - 3.4 - h) * lake * 0.9
    }

    // 海岸線付近を平坦化して砂浜を作る（連続なブレンドなので段差は出ない）
    const flat = smoothstep(11, 2.5, Math.abs(h - SEA_LEVEL))
    h += (h - SEA_LEVEL) * -0.62 * flat

    // 高すぎる山を丸めてワールドの天井を超えないようにする
    if (h > SOFT_CAP) h = SOFT_CAP + (1 - Math.exp(-(h - SOFT_CAP) / CAP_RANGE)) * CAP_RANGE

    return h
  }

  /** 村による平坦化の強さ（0..1）。地形の 3D ノイズを抑えるのにも使う。 */
  flattenAt(x: number, z: number): number {
    const v = this.villageNear(x, z)
    return v ? flattenWeight(v, x, z) : 0
  }

  /** 村の敷地の平坦化まで含めた最終的な地表高度。 */
  height(x: number, z: number): number {
    const h = this.baseHeight(x, z)
    const v = this.villageNear(x, z)
    if (!v) return h
    const t = flattenWeight(v, x, z)
    return t > 0 ? h + (v.platformY - h) * t : h
  }

  // --------------------------------------------------------------------- 村

  /** 点 (x, z) に影響する村（無ければ null）。セル単位でキャッシュする。 */
  villageNear(x: number, z: number): Village | null {
    const fx = x / VILLAGE_CELL
    const fz = z / VILLAGE_CELL
    const bx = Math.floor(fx)
    const bz = Math.floor(fz)
    // 村の半径はセルよりずっと小さいので、近い側の 2x2 セルだけ見れば足りる
    const sx = fx - bx < 0.5 ? -1 : 1
    const sz = fz - bz < 0.5 ? -1 : 1
    for (let i = 0; i < 4; i++) {
      const vx = bx + (i & 1 ? sx : 0)
      const vz = bz + (i & 2 ? sz : 0)
      const v = this.village(vx, vz)
      if (!v) continue
      if (Math.hypot(x - v.cx, z - v.cz) <= flattenReach(v)) return v
    }
    return null
  }

  /** セル座標から村を取得（無ければ null）。 */
  village(vx: number, vz: number): Village | null {
    const key = villageKey(vx, vz)
    const hit = this.villages.get(key)
    if (hit !== undefined) return hit
    const made = makeVillage(vx, vz, this.seed, (x, z) => this.baseHeight(x, z))
    if (this.villages.size > 512) this.villages.clear()
    this.villages.set(key, made)
    return made
  }

  // ------------------------------------------------------------------- 密度

  /**
   * 密度。`h` に事前計算済みの `height(x, z)` を渡せる（列ごとにキャッシュ可能）。
   */
  density(
    x: number,
    y: number,
    z: number,
    h = this.height(x, z),
    flat = this.flattenAt(x, z),
  ): number {
    const n = this.n
    let d = h - y
    const solidify = 1 - flat

    // 地表付近だけ 3D ノイズを足してオーバーハングや崖の抉れを作る。
    // 村の敷地では抑えて、建物が乗る平らな地面を保つ。
    const ad = Math.abs(d)
    if (ad < SURFACE_BAND && solidify > 0.002) {
      const m = 1 - smoothstep(6, SURFACE_BAND, ad)
      d += n.fbm3(x * 0.021, y * 0.026, z * 0.021, 3) * OVERHANG_AMP * m * solidify
    }

    // 洞窟：2 つの尾根ノイズの積 = 細長いトンネル
    if (y > CAVE_MIN_Y && y < h - 3) {
      const r1 = n.ridged3(x * 0.0132 + 11, y * 0.019 + 7, z * 0.0132 - 5, 2)
      const r2 = n.ridged3(x * 0.0132 - 31, y * 0.019 + 41, z * 0.0132 + 23, 2)
      let c = smoothstep(0.79, 0.96, r1) * smoothstep(0.79, 0.96, r2)
      if (c > 0) {
        c *= smoothstep(0, 12, h - 3 - y)
        c *= smoothstep(CAVE_MIN_Y, CAVE_MIN_Y + 26, y)
        // 村の直下は洞窟で抜けないようにする
        c *= 1 - flat * smoothstep(26, 6, h - y)
        d -= c * 30
      }
    }

    // 奈落防止：最下部は必ず固体
    d += smoothstep(BEDROCK_Y + 16, BEDROCK_Y, y) * 80

    return d
  }

  /**
   * 頂点の素材の重み（grass/dirt/rock/sand）とバイオーム（temp/humid）を
   * `out[at .. at+5]` に書き込む。素材の合計は 1 に正規化される。
   */
  surfaceSample(
    x: number,
    y: number,
    z: number,
    ny: number,
    out: Float32Array,
    at: number,
  ): void {
    const bio = this.biomeAt(x, z, this.scratchSurface)
    // villageNear() が baseHeight() 経由で別の scratch を触るので、先に値を取り出しておく
    const temp = bio.temp
    const humid = bio.humid
    const mountain = bio.mountain
    const slope = 1 - ny
    const patch = this.n.fbm2(x * 0.021 + 7, z * 0.021 - 3, 2)

    let rock = smoothstep(0.34, 0.72, slope + patch * 0.1)
    rock = Math.max(rock, smoothstep(66, 100, y))
    rock = Math.max(rock, mountain * smoothstep(0.18, 0.5, slope) * 0.9)

    const desert = desertness(temp, humid)
    const shore = smoothstep(4.5, 0.8, Math.abs(y - SEA_LEVEL))
    const shallow = smoothstep(-1.5, -6, y) * smoothstep(-30, -14, y)
    const sand = clamp(Math.max(shore, shallow, desert * 0.94) * (1 - rock), 0, 1)

    let dirt = smoothstep(0.15, 0.44, slope) * (1 - rock) * (1 - sand)
    dirt = Math.max(dirt, (1 - rock) * (1 - sand) * clamp(patch * 0.8, 0, 1) * 0.45)

    // 村の広場と道は踏み固められた土にする
    const v = this.villageNear(x, z)
    if (v) {
      const road = pathWeight(v, x, z) * (1 - rock)
      if (road > dirt) dirt = road
    }

    const grass = Math.max(0, 1 - rock - sand - dirt)
    const sum = rock + sand + dirt + grass || 1
    out[at] = grass / sum
    out[at + 1] = dirt / sum
    out[at + 2] = rock / sum
    out[at + 3] = sand / sum
    out[at + 4] = temp
    out[at + 5] = humid
  }
}

/** 高温・乾燥なほど 1 に近づく砂漠度。 */
export function desertness(temp: number, humid: number): number {
  return smoothstep(0.56, 0.78, temp) * smoothstep(0.44, 0.2, humid)
}

export interface ChunkFieldResult {
  /** GRID^3 の密度。全体が同符号（等値面なし）なら null。 */
  density: Float32Array | null
}

interface ColumnData {
  heights: Float32Array
  /** 村による平坦化の重み（列ごと）。 */
  flats: Float32Array
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
    const flats = new Float32Array(GRID * GRID)
    let hMin = Infinity
    let hMax = -Infinity
    for (let k = 0; k < GRID; k++) {
      const wz = (oz + k) * VOXEL_SIZE
      for (let i = 0; i < GRID; i++) {
        const wx = (ox + i) * VOXEL_SIZE
        const h = field.height(wx, wz)
        heights[i + k * GRID] = h
        flats[i + k * GRID] = field.flattenAt(wx, wz)
        if (h < hMin) hMin = h
        if (h > hMax) hMax = h
      }
    }

    const data: ColumnData = { heights, flats, hMin, hMax }
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
  const flats = column.flats
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
        const ci = i + k * GRID
        const h = heights[ci]
        const d = field.density((ox + i) * VOXEL_SIZE, wy, wz, h, flats[ci])
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
