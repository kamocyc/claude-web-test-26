/// <reference lib="webworker" />
import { CHUNK_SIZE, GRID, VOXEL_SIZE } from './constants'
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
}

export interface MeshResponse {
  id: number
  empty: boolean
  positions?: Float32Array
  normals?: Float32Array
  mats?: Float32Array
  biome?: Float32Array
  indices?: Uint32Array
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
  if (editCount > 0 && req.editIdx && req.editD) {
    const idx = req.editIdx
    const vals = req.editD
    const mats = req.editMat
    for (let n = 0; n < editCount; n++) {
      const gi = idx[n]
      if (gi < 0 || gi >= density.length) continue
      density[gi] = vals[n]
      const m = mats ? mats[n] : 255
      if (m < 4) {
        if (!matOverride) matOverride = new Uint8Array(GRID * GRID * GRID).fill(255)
        matOverride[gi] = m
      }
    }
  }

  const ox = req.cx * CHUNK_SIZE * VOXEL_SIZE
  const oy = req.cy * CHUNK_SIZE * VOXEL_SIZE
  const oz = req.cz * CHUNK_SIZE * VOXEL_SIZE

  const mesh = surfaceNets(density, ox, oy, oz, matOverride, (wx, wy, wz, ny, out, at) =>
    f.surfaceSample(wx, wy, wz, ny, out, at),
  )

  if (!mesh) {
    ;(self as unknown as Worker).postMessage({ id: req.id, empty: true } satisfies MeshResponse)
    return
  }

  const trees = scatterTrees(f, mesh, ox, oy, oz, req.seed)

  const res: MeshResponse = {
    id: req.id,
    empty: false,
    positions: mesh.positions,
    normals: mesh.normals,
    mats: mesh.mats,
    biome: mesh.biome,
    indices: mesh.indices,
    trees,
  }
  ;(self as unknown as Worker).postMessage(res, [
    mesh.positions.buffer,
    mesh.normals.buffer,
    mesh.mats.buffer,
    mesh.biome.buffer,
    mesh.indices.buffer,
    trees.buffer,
  ])
}
