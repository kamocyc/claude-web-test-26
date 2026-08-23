import * as THREE from 'three'
import {
  CHUNK_SIZE,
  CHUNK_Y_MAX,
  CHUNK_Y_MIN,
  GRID,
  MAT_NONE,
  PAD,
  VOXEL_SIZE,
  WORLD_MIN_Y,
  chunkKey,
  gridIndex,
} from './constants'
import { DensityField } from './density'
import { Chunk, localCornerIndex, ownerChunkCoord, unpackLocalIndex } from './Chunk'
import type { EditMap } from './Chunk'
import { applySphereBrush } from './edits'
import type { BrushMode } from './edits'
import { TREE_STRIDE } from './vegetation'
import { WorkerPool } from './WorkerPool'
import type { TreePrototype } from '../render/treeMeshes'
import type { MeshResponse } from './chunk.worker'
import type { WorldStore } from './storage'

const CHUNK_WORLD = CHUNK_SIZE * VOXEL_SIZE
const WORLD_MAX_Y = (CHUNK_Y_MAX + 1) * CHUNK_WORLD

/** 密度と勾配（= 法線の逆）を返すサンプル結果。 */
export interface FieldSample {
  d: number
  gx: number
  gy: number
  gz: number
}

interface PendingMesh {
  chunk: Chunk
  res: MeshResponse
}

export interface WorldOptions {
  seed: number
  viewDistance?: number
  store?: WorldStore | null
}

/**
 * チャンクのストリーミング、編集、密度サンプリングを束ねる。
 *
 * 密度はメインスレッドでは保持せず、必要になった時点で解析的に評価し
 * 編集差分を上書きする。こうすることでメモリを一切使わずに、
 * Worker が作ったメッシュと完全に一致する場をどこでも参照できる。
 */
export class World {
  readonly field: DensityField
  readonly seed: number
  readonly group = new THREE.Group()

  viewDistance: number

  private readonly pool = new WorkerPool()
  private readonly chunks = new Map<string, Chunk>()
  private readonly edits = new Map<string, EditMap>()
  private readonly pending: PendingMesh[] = []
  private readonly heightCache = new Map<number, number>()
  private readonly ringOffsets: Array<[number, number]> = []

  private material: THREE.Material | null = null
  private treeProtos: TreePrototype[] | null = null
  private treeMaterial: THREE.Material | null = null
  private readonly dummy = new THREE.Object3D()
  private readonly trunkBuf = new Float32Array(600 * 5)
  private store: WorldStore | null
  private jobCounter = 0
  private lastCenter = ''
  private desired = new Set<string>()

  /** 初期ロード進捗の判定用 */
  loadedChunks = 0
  requestedChunks = 0
  /** 表示中の木の本数（デバッグ表示用）。 */
  treeCount = 0

  constructor(opts: WorldOptions) {
    this.seed = opts.seed
    this.field = new DensityField(opts.seed)
    this.viewDistance = opts.viewDistance ?? 6
    this.store = opts.store ?? null
    this.group.name = 'terrain'
    this.buildRingOffsets(16)
  }

  setMaterial(material: THREE.Material): void {
    this.material = material
  }

  setTreeAssets(prototypes: TreePrototype[], material: THREE.Material): void {
    this.treeProtos = prototypes
    this.treeMaterial = material
  }

  /**
   * 半径 r 以内にある木の幹を集める。
   * 毎フレーム 1 回だけ呼んで Player に渡す想定なので、バッファを使い回す。
   */
  collectTrunks(x: number, y: number, z: number, r: number): Float32Array {
    let n = 0
    const r2 = r * r
    const cx0 = Math.floor((x - r) / CHUNK_WORLD)
    const cx1 = Math.floor((x + r) / CHUNK_WORLD)
    const cz0 = Math.floor((z - r) / CHUNK_WORLD)
    const cz1 = Math.floor((z + r) / CHUNK_WORLD)
    const cy0 = Math.floor((y - 8) / CHUNK_WORLD)
    const cy1 = Math.floor((y + 8) / CHUNK_WORLD)
    const buf = this.trunkBuf
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const t = this.chunks.get(chunkKey(cx, cy, cz))?.trunks
          if (!t) continue
          for (let i = 0; i < t.length; i += 5) {
            const dx = t[i] - x
            const dz = t[i + 2] - z
            if (dx * dx + dz * dz > r2) continue
            if (n + 5 > buf.length) return buf.subarray(0, n)
            buf[n] = t[i]
            buf[n + 1] = t[i + 1]
            buf[n + 2] = t[i + 2]
            buf[n + 3] = t[i + 3]
            buf[n + 4] = t[i + 4]
            n += 5
          }
        }
      }
    }
    return buf.subarray(0, n)
  }

  setEdits(all: Map<string, EditMap>): void {
    this.edits.clear()
    for (const [k, v] of all) this.edits.set(k, v)
    this.heightCache.clear()
    this.invalidateAll()
  }

  getEdits(key: string): EditMap | undefined {
    return this.edits.get(key)
  }

  get editedChunkCount(): number {
    return this.edits.size
  }

  get pendingJobs(): number {
    return this.pool.pending + this.pending.length
  }

  // ---------------------------------------------------------------- 密度参照

  private heightAtLattice(gx: number, gz: number): number {
    const key = gx * 1048576 + (gz + 524288)
    const hit = this.heightCache.get(key)
    if (hit !== undefined) return hit
    const h = this.field.height(gx * VOXEL_SIZE, gz * VOXEL_SIZE)
    if (this.heightCache.size > 16384) this.heightCache.clear()
    this.heightCache.set(key, h)
    return h
  }

  /** 格子コーナーの密度（編集を反映した最終値）。 */
  cornerDensity(gx: number, gy: number, gz: number): number {
    if (this.edits.size > 0) {
      const m = this.edits.get(
        chunkKey(ownerChunkCoord(gx), ownerChunkCoord(gy), ownerChunkCoord(gz)),
      )
      if (m) {
        const rec = m.get(localCornerIndex(gx, gy, gz))
        if (rec) return rec.d
      }
    }
    const wx = gx * VOXEL_SIZE
    const wz = gz * VOXEL_SIZE
    return this.field.density(
      wx,
      gy * VOXEL_SIZE,
      wz,
      this.heightAtLattice(gx, gz),
      this.field.flattenAt(wx, wz),
    )
  }

  cornerMaterial(gx: number, gy: number, gz: number): number {
    if (this.edits.size === 0) return MAT_NONE
    const m = this.edits.get(
      chunkKey(ownerChunkCoord(gx), ownerChunkCoord(gy), ownerChunkCoord(gz)),
    )
    if (!m) return MAT_NONE
    const rec = m.get(localCornerIndex(gx, gy, gz))
    return rec ? rec.mat : MAT_NONE
  }

  /**
   * 任意のワールド座標での密度と勾配を三線形補間で求める。
   * 8 コーナーから値と勾配を同時に得られるので、衝突判定 1 回あたり
   * 密度評価は 8 回で済む。
   */
  sample(x: number, y: number, z: number, out: FieldSample): FieldSample {
    const fx = x / VOXEL_SIZE
    const fy = y / VOXEL_SIZE
    const fz = z / VOXEL_SIZE
    const i = Math.floor(fx)
    const j = Math.floor(fy)
    const k = Math.floor(fz)
    const tx = fx - i
    const ty = fy - j
    const tz = fz - k

    const c000 = this.cornerDensity(i, j, k)
    const c100 = this.cornerDensity(i + 1, j, k)
    const c010 = this.cornerDensity(i, j + 1, k)
    const c110 = this.cornerDensity(i + 1, j + 1, k)
    const c001 = this.cornerDensity(i, j, k + 1)
    const c101 = this.cornerDensity(i + 1, j, k + 1)
    const c011 = this.cornerDensity(i, j + 1, k + 1)
    const c111 = this.cornerDensity(i + 1, j + 1, k + 1)

    const x0 = 1 - tx
    const y0 = 1 - ty
    const z0 = 1 - tz

    out.d =
      c000 * x0 * y0 * z0 +
      c100 * tx * y0 * z0 +
      c010 * x0 * ty * z0 +
      c110 * tx * ty * z0 +
      c001 * x0 * y0 * tz +
      c101 * tx * y0 * tz +
      c011 * x0 * ty * tz +
      c111 * tx * ty * tz

    const inv = 1 / VOXEL_SIZE
    out.gx =
      ((c100 - c000) * y0 * z0 +
        (c110 - c010) * ty * z0 +
        (c101 - c001) * y0 * tz +
        (c111 - c011) * ty * tz) *
      inv
    out.gy =
      ((c010 - c000) * x0 * z0 +
        (c110 - c100) * tx * z0 +
        (c011 - c001) * x0 * tz +
        (c111 - c101) * tx * tz) *
      inv
    out.gz =
      ((c001 - c000) * x0 * y0 +
        (c101 - c100) * tx * y0 +
        (c011 - c010) * x0 * ty +
        (c111 - c110) * tx * ty) *
      inv

    return out
  }

  densityAt(x: number, y: number, z: number): number {
    return this.sample(x, y, z, SCRATCH).d
  }

  isSolid(x: number, y: number, z: number): boolean {
    return this.densityAt(x, y, z) > 0
  }

  // ------------------------------------------------------------------ 編集

  /** 球ブラシを適用する。何か変化したら true。 */
  applyBrush(
    x: number,
    y: number,
    z: number,
    radius: number,
    mode: BrushMode,
    material: number,
  ): boolean {
    const bounds = applySphereBrush(
      x,
      y,
      z,
      radius,
      mode,
      material,
      (gx, gy, gz) => this.cornerDensity(gx, gy, gz),
      (gx, gy, gz) => this.cornerMaterial(gx, gy, gz),
      (gx, gy, gz, d, mat) => this.setEdit(gx, gy, gz, d, mat),
      WORLD_MIN_Y + 2,
      WORLD_MAX_Y - 2,
    )
    if (bounds.touched === 0) return false

    // 編集されたコーナーを含むパディング済みグリッドを持つチャンクをすべて作り直す
    const cx0 = ownerChunkCoord(bounds.minX - PAD)
    const cx1 = ownerChunkCoord(bounds.maxX + PAD)
    const cy0 = ownerChunkCoord(bounds.minY - PAD)
    const cy1 = ownerChunkCoord(bounds.maxY + PAD)
    const cz0 = ownerChunkCoord(bounds.minZ - PAD)
    const cz1 = ownerChunkCoord(bounds.maxZ + PAD)
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const chunk = this.chunks.get(chunkKey(cx, cy, cz))
          if (chunk) this.submit(chunk, -1e6)
        }
      }
    }
    return true
  }

  private setEdit(gx: number, gy: number, gz: number, d: number, mat: number): void {
    const key = chunkKey(ownerChunkCoord(gx), ownerChunkCoord(gy), ownerChunkCoord(gz))
    let m = this.edits.get(key)
    if (!m) {
      m = new Map()
      this.edits.set(key, m)
    }
    m.set(localCornerIndex(gx, gy, gz), { d, mat })
    this.store?.markDirty(key)
  }

  private collectEdits(
    cx: number,
    cy: number,
    cz: number,
  ): { idx: Int32Array; d: Float32Array; mat: Uint8Array } | null {
    if (this.edits.size === 0) return null

    const baseX = cx * CHUNK_SIZE - PAD
    const baseY = cy * CHUNK_SIZE - PAD
    const baseZ = cz * CHUNK_SIZE - PAD

    const idx: number[] = []
    const vals: number[] = []
    const mats: number[] = []

    for (let oz = -1; oz <= 1; oz++) {
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const m = this.edits.get(chunkKey(cx + ox, cy + oy, cz + oz))
          if (!m) continue
          const nx = (cx + ox) * CHUNK_SIZE
          const ny = (cy + oy) * CHUNK_SIZE
          const nz = (cz + oz) * CHUNK_SIZE
          for (const [li, rec] of m) {
            const [lx, ly, lz] = unpackLocalIndex(li)
            const gi = nx + lx - baseX
            if (gi < 0 || gi >= GRID) continue
            const gj = ny + ly - baseY
            if (gj < 0 || gj >= GRID) continue
            const gk = nz + lz - baseZ
            if (gk < 0 || gk >= GRID) continue
            idx.push(gridIndex(gi, gj, gk))
            vals.push(rec.d)
            mats.push(rec.mat)
          }
        }
      }
    }

    if (idx.length === 0) return null
    return {
      idx: new Int32Array(idx),
      d: new Float32Array(vals),
      mat: new Uint8Array(mats),
    }
  }

  private invalidateAll(): void {
    for (const chunk of this.chunks.values()) this.submit(chunk, 0)
  }

  // -------------------------------------------------------------- ロード管理

  private buildRingOffsets(max: number): void {
    for (let dz = -max; dz <= max; dz++) {
      for (let dx = -max; dx <= max; dx++) {
        this.ringOffsets.push([dx, dz])
      }
    }
    this.ringOffsets.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]))
  }

  /** プレイヤー位置に応じてチャンクを読み書きし、完成したメッシュを少しずつ反映する。 */
  update(px: number, py: number, pz: number, budgetMs = 4): void {
    const pcx = Math.floor(px / CHUNK_WORLD)
    const pcy = Math.floor(py / CHUNK_WORLD)
    const pcz = Math.floor(pz / CHUNK_WORLD)
    const center = chunkKey(pcx, pcy, pcz)
    if (center !== this.lastCenter) {
      this.lastCenter = center
      this.refreshDesired(pcx, pcy, pcz, py)
    }

    // 1 フレームで使う時間を決めて、その範囲でできるだけ多く反映する
    const start = performance.now()
    while (this.pending.length > 0) {
      const item = this.pending.shift()!
      this.applyMesh(item.chunk, item.res)
      if (performance.now() - start > budgetMs) break
    }
  }

  private refreshDesired(pcx: number, pcy: number, pcz: number, py: number): void {
    const R = this.viewDistance
    const R2 = R * R
    const desired = new Set<string>()

    for (const [dx, dz] of this.ringOffsets) {
      if (dx * dx + dz * dz > R2) continue
      if (Math.abs(dx) > R || Math.abs(dz) > R) continue
      const cx = pcx + dx
      const cz = pcz + dz

      // 列の中心高度から、地表を含む鉛直レンジだけを読み込む
      const h = this.field.height((cx + 0.5) * CHUNK_WORLD, (cz + 0.5) * CHUNK_WORLD)
      const lo = Math.min(h, py) - 40
      const hi = Math.max(h, py) + 40
      let cy0 = Math.floor(lo / CHUNK_WORLD)
      let cy1 = Math.floor(hi / CHUNK_WORLD)
      cy0 = Math.max(CHUNK_Y_MIN, Math.min(cy0, pcy - 1))
      cy1 = Math.min(CHUNK_Y_MAX, Math.max(cy1, pcy + 1))

      const dist2 = dx * dx + dz * dz
      for (let cy = cy0; cy <= cy1; cy++) {
        const key = chunkKey(cx, cy, cz)
        desired.add(key)
        let chunk = this.chunks.get(key)
        if (!chunk) {
          chunk = new Chunk(cx, cy, cz, key)
          this.chunks.set(key, chunk)
          this.requestedChunks++
          this.submit(chunk, dist2 + Math.abs(cy - pcy) * 0.5)
        } else {
          this.pool.reprioritize(key, dist2 + Math.abs(cy - pcy) * 0.5)
        }
      }
    }

    for (const [key, chunk] of this.chunks) {
      if (desired.has(key)) continue
      this.pool.cancel(key)
      this.treeCount -= countInstances(chunk)
      chunk.dispose(this.group)
      if (chunk.ready) this.loadedChunks--
      this.requestedChunks--
      this.chunks.delete(key)
    }

    this.desired = desired
  }

  private submit(chunk: Chunk, priority: number): void {
    const version = ++this.jobCounter
    chunk.requested = version
    const edits = this.collectEdits(chunk.cx, chunk.cy, chunk.cz)
    void this.pool
      .submit(
        chunk.key,
        {
          cx: chunk.cx,
          cy: chunk.cy,
          cz: chunk.cz,
          seed: this.seed,
          editIdx: edits ? edits.idx : null,
          editD: edits ? edits.d : null,
          editMat: edits ? edits.mat : null,
        },
        priority,
      )
      .then((res) => {
        if (chunk.requested !== version) return
        if (!this.chunks.has(chunk.key)) return
        this.pending.push({ chunk, res })
      })
  }

  private applyMesh(chunk: Chunk, res: MeshResponse): void {
    if (!this.chunks.has(chunk.key)) return
    this.treeCount -= countInstances(chunk)
    chunk.dispose(this.group)
    if (!chunk.ready) {
      chunk.ready = true
      this.loadedChunks++
    }
    if (res.empty || !res.positions || !res.indices || !res.normals || !res.mats) return
    if (!this.material) return

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(res.positions, 3))
    geo.setAttribute('normal', new THREE.BufferAttribute(res.normals, 3))
    geo.setAttribute('matw', new THREE.BufferAttribute(res.mats, 4))
    if (res.biome) geo.setAttribute('abiome', new THREE.BufferAttribute(res.biome, 2))
    geo.setIndex(new THREE.BufferAttribute(res.indices, 1))
    geo.computeBoundingSphere()

    const mesh = new THREE.Mesh(geo, this.material)
    mesh.position.set(chunk.cx * CHUNK_WORLD, chunk.cy * CHUNK_WORLD, chunk.cz * CHUNK_WORLD)
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.matrixAutoUpdate = false
    mesh.updateMatrix()
    chunk.mesh = mesh
    this.group.add(mesh)

    if (res.trees && res.trees.length > 0) this.applyTrees(chunk, res.trees)
  }

  /** 木のインスタンスを種類ごとの InstancedMesh にまとめる。 */
  private applyTrees(chunk: Chunk, trees: Float32Array): void {
    const protos = this.treeProtos
    const mat = this.treeMaterial
    if (!protos || !mat) return

    const byType: number[][] = protos.map(() => [])
    for (let i = 0; i < trees.length; i += TREE_STRIDE) {
      const t = trees[i + 5] | 0
      if (t >= 0 && t < byType.length) byType[t].push(i)
    }

    const trunks: number[] = []
    for (let t = 0; t < byType.length; t++) {
      const list = byType[t]
      if (list.length === 0) continue
      const proto = protos[t]
      const im = new THREE.InstancedMesh(proto.geometry, mat, list.length)
      im.castShadow = true
      im.receiveShadow = true
      im.matrixAutoUpdate = false
      for (let k = 0; k < list.length; k++) {
        const i = list[k]
        const s = trees[i + 3]
        this.dummy.position.set(trees[i], trees[i + 1], trees[i + 2])
        this.dummy.rotation.set(0, trees[i + 4], 0)
        this.dummy.scale.setScalar(s)
        this.dummy.updateMatrix()
        im.setMatrixAt(k, this.dummy.matrix)
        trunks.push(
          trees[i],
          trees[i + 1],
          trees[i + 2],
          proto.trunkRadius * s,
          proto.trunkHeight * s,
        )
      }
      im.instanceMatrix.needsUpdate = true
      im.computeBoundingSphere()
      this.group.add(im)
      chunk.treeMeshes.push(im)
      this.treeCount += list.length
    }
    chunk.trunks = new Float32Array(trunks)
  }

  /** 指定位置を含むチャンクがメッシュ化済みか。 */
  isChunkReady(x: number, y: number, z: number): boolean {
    const key = chunkKey(
      Math.floor(x / CHUNK_WORLD),
      Math.floor(y / CHUNK_WORLD),
      Math.floor(z / CHUNK_WORLD),
    )
    return this.chunks.get(key)?.ready ?? false
  }

  get desiredCount(): number {
    return this.desired.size
  }

  dispose(): void {
    this.pool.dispose()
    for (const chunk of this.chunks.values()) chunk.dispose(this.group)
    this.chunks.clear()
  }
}

const SCRATCH: FieldSample = { d: 0, gx: 0, gy: 0, gz: 0 }

function countInstances(chunk: Chunk): number {
  let n = 0
  for (const im of chunk.treeMeshes) n += im.count
  return n
}
