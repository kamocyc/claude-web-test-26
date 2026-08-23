import { CELLS, CELL_BASE, GRID, PAD, VOXEL_SIZE } from './constants'

export interface MeshData {
  positions: Float32Array
  normals: Float32Array
  /** 頂点ごとの素材の重み (grass, dirt, rock, sand)。合計 1。 */
  mats: Float32Array
  indices: Uint32Array
}

/** 頂点位置と法線 y から素材の重みを `out[at..at+3]` に書き込む。 */
export type MaterialSampler = (
  wx: number,
  wy: number,
  wz: number,
  ny: number,
  out: Float32Array,
  at: number,
) => void

/** 立方体のコーナー: bit0 = x, bit1 = y, bit2 = z */
const EDGES: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [2, 3], [4, 5], [6, 7], // x
  [0, 2], [1, 3], [4, 6], [5, 7], // y
  [0, 4], [1, 5], [2, 6], [3, 7], // z
]

/**
 * Naive Surface Nets。
 * 符号が混在するセルごとに 1 頂点を置き、位置はエッジ交差点の平均とする。
 * 隣接チャンクは同じ密度関数から同じコーナー値を得るため、境界セルの頂点は
 * 数値的に完全一致し、継ぎ目が発生しない。
 *
 * @param density GRID^3 の密度（> 0 が固体）
 * @param ox,oy,oz チャンク原点（格子座標 0 のコーナー）のワールド座標
 * @param matOverride プレイヤーが設置した素材 ID（255 = なし）。省略可。
 * @param sampler 自然な素材の重みを返す関数。省略時は草 100%。
 */
export function surfaceNets(
  density: Float32Array,
  ox: number,
  oy: number,
  oz: number,
  matOverride: Uint8Array | null,
  sampler: MaterialSampler | null,
): MeshData | null {
  const cellVert = new Int32Array(CELLS * CELLS * CELLS).fill(-1)

  const positions: number[] = []
  const normals: number[] = []
  const mats: number[] = []
  const indices: number[] = []

  const d = new Float32Array(8)
  const cornerIdx = new Int32Array(8)
  const gx = new Float32Array(8)
  const gy = new Float32Array(8)
  const gz = new Float32Array(8)
  const w = new Float32Array(4)
  const acc = new Float32Array(4)

  const strideY = GRID
  const strideZ = GRID * GRID

  // --- パス 1: セルごとに頂点を作る ---
  for (let ck = 0; ck < CELLS; ck++) {
    const k0 = CELL_BASE + ck
    for (let cj = 0; cj < CELLS; cj++) {
      const j0 = CELL_BASE + cj
      for (let ci = 0; ci < CELLS; ci++) {
        const i0 = CELL_BASE + ci

        const base = i0 + strideY * j0 + strideZ * k0
        let mask = 0
        for (let b = 0; b < 8; b++) {
          const idx = base + (b & 1) + ((b >> 1) & 1) * strideY + ((b >> 2) & 1) * strideZ
          cornerIdx[b] = idx
          const v = density[idx]
          d[b] = v
          if (v > 0) mask |= 1 << b
        }
        if (mask === 0 || mask === 255) continue

        // エッジ交差点の平均
        let px = 0
        let py = 0
        let pz = 0
        let count = 0
        for (let e = 0; e < 12; e++) {
          const a = EDGES[e][0]
          const b = EDGES[e][1]
          const sa = (mask >> a) & 1
          const sb = (mask >> b) & 1
          if (sa === sb) continue
          const da = d[a]
          const db = d[b]
          const t = da / (da - db)
          const ax = a & 1
          const ay = (a >> 1) & 1
          const az = (a >> 2) & 1
          px += ax + ((b & 1) - ax) * t
          py += ay + (((b >> 1) & 1) - ay) * t
          pz += az + (((b >> 2) & 1) - az) * t
          count++
        }
        const inv = 1 / count
        px *= inv
        py *= inv
        pz *= inv

        // 8 コーナーの勾配（中央差分）を三線形補間して法線を得る
        for (let b = 0; b < 8; b++) {
          const idx = cornerIdx[b]
          gx[b] = (density[idx + 1] - density[idx - 1]) * 0.5
          gy[b] = (density[idx + strideY] - density[idx - strideY]) * 0.5
          gz[b] = (density[idx + strideZ] - density[idx - strideZ]) * 0.5
        }
        let nx = trilinear(gx, px, py, pz)
        let ny = trilinear(gy, px, py, pz)
        let nz = trilinear(gz, px, py, pz)
        const len = Math.hypot(nx, ny, nz) || 1
        // 密度が正 = 内側なので、外向き法線は勾配の逆
        nx = -nx / len
        ny = -ny / len
        nz = -nz / len

        // チャンクローカル座標（原点は格子座標 0 のコーナー）
        const lx = (i0 - PAD + px) * VOXEL_SIZE
        const ly = (j0 - PAD + py) * VOXEL_SIZE
        const lz = (k0 - PAD + pz) * VOXEL_SIZE

        const vi = positions.length / 3
        positions.push(lx, ly, lz)
        normals.push(nx, ny, nz)

        // 素材：プレイヤー設置分を優先しつつ自然素材と混ぜる
        acc[0] = 0
        acc[1] = 0
        acc[2] = 0
        acc[3] = 0
        let solid = 0
        let overridden = 0
        for (let b = 0; b < 8; b++) {
          if (d[b] <= 0) continue
          solid++
          if (matOverride) {
            const m = matOverride[cornerIdx[b]]
            if (m < 4) {
              acc[m] += 1
              overridden++
            }
          }
        }
        const natural = solid - overridden
        if (natural > 0) {
          if (sampler) {
            sampler(ox + lx, oy + ly, oz + lz, ny, w, 0)
          } else {
            w[0] = 1
            w[1] = 0
            w[2] = 0
            w[3] = 0
          }
          acc[0] += w[0] * natural
          acc[1] += w[1] * natural
          acc[2] += w[2] * natural
          acc[3] += w[3] * natural
        }
        const total = acc[0] + acc[1] + acc[2] + acc[3] || 1
        mats.push(acc[0] / total, acc[1] / total, acc[2] / total, acc[3] / total)

        cellVert[ci + CELLS * (cj + CELLS * ck)] = vi
      }
    }
  }

  if (positions.length === 0) return null

  // --- パス 2: 符号が変化するエッジごとに四角形を張る ---
  // このチャンクが所有するのは格子座標 [0, CHUNK_SIZE) のコーナー = セル index [1, CELLS)
  for (let ck = 1; ck < CELLS; ck++) {
    for (let cj = 1; cj < CELLS; cj++) {
      for (let ci = 1; ci < CELLS; ci++) {
        const gi = CELL_BASE + ci
        const gj = CELL_BASE + cj
        const gk = CELL_BASE + ck
        const idx = gi + strideY * gj + strideZ * gk
        const d0 = density[idx]
        const s0 = d0 > 0

        const c = ci + CELLS * (cj + CELLS * ck)

        // x 方向のエッジ → 垂直軸は (y, z)
        if (s0 !== density[idx + 1] > 0) {
          quad(
            indices,
            cellVert[c - CELLS - CELLS * CELLS],
            cellVert[c - CELLS * CELLS],
            cellVert[c],
            cellVert[c - CELLS],
            !s0,
          )
        }
        // y 方向のエッジ → 垂直軸は (z, x)
        if (s0 !== density[idx + strideY] > 0) {
          quad(
            indices,
            cellVert[c - CELLS * CELLS - 1],
            cellVert[c - 1],
            cellVert[c],
            cellVert[c - CELLS * CELLS],
            !s0,
          )
        }
        // z 方向のエッジ → 垂直軸は (x, y)
        if (s0 !== density[idx + strideZ] > 0) {
          quad(
            indices,
            cellVert[c - 1 - CELLS],
            cellVert[c - CELLS],
            cellVert[c],
            cellVert[c - 1],
            !s0,
          )
        }
      }
    }
  }

  if (indices.length === 0) return null

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    mats: new Float32Array(mats),
    indices: new Uint32Array(indices),
  }
}

/**
 * A→B→C→D は軸の正方向から見て反時計回りに並ぶ。
 * `flip` が真（＝エッジの正側が固体）のとき、外向き法線は軸の負方向なので巻き順を反転する。
 */
function quad(out: number[], a: number, b: number, c: number, dd: number, flip: boolean): void {
  if (a < 0 || b < 0 || c < 0 || dd < 0) return
  if (flip) {
    out.push(a, c, b, a, dd, c)
  } else {
    out.push(a, b, c, a, c, dd)
  }
}

function trilinear(v: Float32Array, x: number, y: number, z: number): number {
  const x0 = 1 - x
  const y0 = 1 - y
  const z0 = 1 - z
  return (
    v[0] * x0 * y0 * z0 +
    v[1] * x * y0 * z0 +
    v[2] * x0 * y * z0 +
    v[3] * x * y * z0 +
    v[4] * x0 * y0 * z +
    v[5] * x * y0 * z +
    v[6] * x0 * y * z +
    v[7] * x * y * z
  )
}
