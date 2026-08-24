/// <reference lib="webworker" />
import { CHUNK_SIZE, GRID, MATERIAL_COUNT, VOXEL_SIZE } from './constants'
import { ColumnHeightCache, DensityField, generateChunkDensity } from './density'
import { surfaceNets } from './surfaceNets'
import { scatterTrees } from './vegetation'

export interface MeshRequest {
  id: number
  cx: number
  cy: number
  cz: number
  seed: number
  /** チャンクのパディング済みグリッド内のインデックス */
  editIdx: Int32Array | null
  editD: Float32Array | null
  editMat: Uint8Array | null
  /** 伐採済みの木のセルキー。 */
  chopped: Float64Array | null
}

export interface MeshResponse {
  id: number
  empty: boolean
  positions?: Float32Array
  normals?: Float32Array
  mats?: Float32Array
  mats2?: Float32Array
  biome?: Float32Array
  indices?: Uint32Array
  glassStart?: number
  /** 木のインスタンス（TREE_STRIDE ごとに 1 本）。 */
  trees?: Float32Array
}

let field: DensityField | null = null
const columns = new ColumnHeightCache(24)

function fieldFor(seed: number): DensityField {
  if (!field || field.seed !== seed) field = new DensityField(seed)
  return field
}

self.onmessage = (ev: MessageEvent<MeshRequest>) => {
  const req = ev.data
  const f = fieldFor(req.seed)
  const editCount = req.editIdx ? req.editIdx.length : 0

  const { density } = generateChunkDensity(f, req.cx, req.cy, req.cz, editCount > 0, columns)
  if (!density) {
    ;(self as unknown as Worker).postMessage({ id: req.id, empty: true } satisfies MeshResponse)
    return
  }

  let matOverride: Uint8Array | null = null
  // 編集されたコーナーの目印。掘った跡や盛った土の上に木を生やさないために使う
  let editedCorner: Uint8Array | null = null
  if (editCount > 0 && req.editIdx && req.editD) {
    const idx = req.editIdx
    const vals = req.editD
    const mats = req.editMat
    editedCorner = new Uint8Array(GRID * GRID * GRID)
    for (let n = 0; n < editCount; n++) {
      const gi = idx[n]
      if (gi < 0 || gi >= density.length) continue
      density[gi] = vals[n]
      editedCorner[gi] = 1
      const m = mats ? mats[n] : 255
      if (m < MATERIAL_COUNT) {
        if (!matOverride) matOverride = new Uint8Array(GRID * GRID * GRID).fill(255)
        matOverride[gi] = m
      }
    }
  }

  const ox = req.cx * CHUNK_SIZE * VOXEL_SIZE
  const oy = req.cy * CHUNK_SIZE * VOXEL_SIZE
  const oz = req.cz * CHUNK_SIZE * VOXEL_SIZE

  const mesh = surfaceNets(
    density,
    ox,
    oy,
    oz,
    matOverride,
    (wx, wy, wz, ny, out, at) => f.surfaceSample(wx, wy, wz, ny, out, at),
    editedCorner,
  )

  if (!mesh) {
    ;(self as unknown as Worker).postMessage({ id: req.id, empty: true } satisfies MeshResponse)
    return
  }

  const trees = scatterTrees(f, mesh, ox, oy, oz, req.seed, req.chopped)

  const res: MeshResponse = {
    id: req.id,
    empty: false,
    positions: mesh.positions,
    normals: mesh.normals,
    mats: mesh.mats,
    mats2: mesh.mats2,
    biome: mesh.biome,
    indices: mesh.indices,
    glassStart: mesh.glassStart,
    trees,
  }
  ;(self as unknown as Worker).postMessage(res, [
    mesh.positions.buffer,
    mesh.normals.buffer,
    mesh.mats.buffer,
    mesh.mats2.buffer,
    mesh.biome.buffer,
    mesh.indices.buffer,
    trees.buffer,
  ])
}
