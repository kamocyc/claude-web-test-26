import * as THREE from 'three'
import {
  CHUNK_SIZE,
  CHUNK_Y_MAX,
  CHUNK_Y_MIN,
  GRID,
  MAT_DIRT,
  MAT_NONE,
  MAT_SAND,
  PAD,
  VOXEL_SIZE,
  WORLD_MIN_Y,
  chunkKey,
  gridIndex,
} from './constants'
import { DensityField } from './density'
import { Chunk, TREE_FIELDS, localCornerIndex, ownerChunkCoord, unpackLocalIndex } from './Chunk'
import type { EditMap } from './Chunk'
import { applyBrush, applyBrushes, applySmoothBrush, isLooseMaterial, settleLoose } from './edits'
import type { BrushBounds, BrushMode, BrushOp, BrushShape } from './edits'
import { TREE_CELL, TREE_STRIDE, treeCellKey } from './vegetation'
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
  private readonly chopped = new Set<number>()
  private readonly ringOffsets: Array<[number, number]> = []

  private material: THREE.Material | null = null
  private glassMaterial: THREE.Material | null = null
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

  setMaterial(material: THREE.Material, glass: THREE.Material): void {
    this.material = material
    this.glassMaterial = glass
  }

  setTreeAssets(prototypes: TreePrototype[], material: THREE.Material): void {
    this.treeProtos = prototypes
    this.treeMaterial = material
  }

  /**
   * 半径 r 以内にある木の当たり判定（幹と枝葉の縦円柱）を集める。
   * 1 本につき 5 要素 × 最大 2 本（x, y, z, 半径, 高さ）。
   *
   * 返り値は使い回しのバッファなので、次に呼ぶまでの間しか有効でない。
   * プレイヤーはフレームをまたいで持ち続けるため、MOB 側は別の `out` を渡すこと。
   */
  collectTrunks(x: number, y: number, z: number, r: number, out?: Float32Array): Float32Array {
    let n = 0
    const r2 = r * r
    const cx0 = Math.floor((x - r) / CHUNK_WORLD)
    const cx1 = Math.floor((x + r) / CHUNK_WORLD)
    const cz0 = Math.floor((z - r) / CHUNK_WORLD)
    const cz1 = Math.floor((z + r) / CHUNK_WORLD)
    const cy0 = Math.floor((y - 8) / CHUNK_WORLD)
    const cy1 = Math.floor((y + 8) / CHUNK_WORLD)
    const buf = out ?? this.trunkBuf
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const chunk = this.chunks.get(chunkKey(cx, cy, cz))
          const t = chunk?.trunks
          if (!chunk || !t) continue
          for (let i = 0; i < chunk.trunkLen; i += TREE_FIELDS) {
            const dx = t[i] - x
            const dz = t[i + 2] - z
            if (dx * dx + dz * dz > r2) continue
            if (n + 10 > buf.length) return buf.subarray(0, n)
            // 幹
            buf[n] = t[i]
            buf[n + 1] = t[i + 1]
            buf[n + 2] = t[i + 2]
            buf[n + 3] = t[i + 3]
            buf[n + 4] = t[i + 4]
            n += 5
            // 枝葉。幹だけだと斜面の上から梢を通り抜けられてしまう
            if (t[i + 5] > 0) {
              buf[n] = t[i]
              buf[n + 1] = t[i + 1] + t[i + 6]
              buf[n + 2] = t[i + 2]
              buf[n + 3] = t[i + 5]
              buf[n + 4] = t[i + 7] - t[i + 6]
              n += 5
            }
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

  /** ブラシを適用する。何も変化しなければ null。 */
  countCraftedVertices(): number {
    let n = 0
    for (const chunk of this.chunks.values()) {
      const attr = chunk.mesh?.geometry.getAttribute('matw2')
      if (!attr) continue
      const a = attr.array as ArrayLike<number>
      for (let i = 0; i < a.length; i += 4) if (a[i] + a[i + 1] + a[i + 2] > 0.5) n++
    }
    return n
  }

  applyBrush(
    x: number,
    y: number,
    z: number,
    shape: BrushShape,
    mode: BrushMode,
    material: number,
  ): BrushBounds | null {
    const bounds = applyBrush(
      x,
      y,
      z,
      shape,
      mode,
      material,
      this.readD,
      this.readMat,
      this.writeCorner,
      WORLD_MIN_Y + 2,
      WORLD_MAX_Y - 2,
    )
    // 崩すのは、緩い土砂に触ったとき・粒状の素材を置いたとき・
    // 土や砂の自然地形を掘ったときだけ。岩場や草地の掘削は今までどおりの負荷で済む。
    const needsSettle =
      bounds.looseTouched > 0 ||
      (mode === 'place' && isLooseMaterial(material)) ||
      (mode === 'dig' && this.naturalLoose(Math.round(x), Math.round(z), y) !== MAT_NONE)
    if (needsSettle) this.settle(x, y, z, shape.ex, shape.ey, shape.ez, bounds)
    return this.finishEdit(bounds)
  }

  /**
   * 自然地形（プレイヤーが置いたのではない部分）の素材が粒状かどうか。
   * 重みを混ぜて安息角を作ると草地の傾斜が浅くなって逆に崩れやすくなるので、
   * 土＋砂が十分に優勢なときだけ、優勢な方の素材 ID を返す。
   */
  private readonly naturalLoose = (gx: number, gz: number, y: number): number => {
    this.field.surfaceSample(gx, y, gz, 1, this.matScratch, 0)
    const dirt = this.matScratch[MAT_DIRT]
    const sand = this.matScratch[MAT_SAND]
    if (dirt + sand < 0.6) return MAT_NONE
    return sand > dirt ? MAT_SAND : MAT_DIRT
  }

  private readonly matScratch = new Float32Array(6)

  /** 緩い土砂を崩し、その影響範囲を `bounds` に取り込む。 */
  private settle(
    x: number,
    y: number,
    z: number,
    ex: number,
    ey: number,
    ez: number,
    bounds: BrushBounds,
  ): void {
    const s = settleLoose(
      x,
      y,
      z,
      ex,
      ey,
      ez,
      this.readD,
      this.readMat,
      this.naturalLoose,
      this.writeCorner,
      WORLD_MIN_Y + 2,
      WORLD_MAX_Y - 2,
    )
    if (s.touched === 0) return
    bounds.touched += s.touched
    bounds.minX = Math.min(bounds.minX, s.minX)
    bounds.minY = Math.min(bounds.minY, s.minY)
    bounds.minZ = Math.min(bounds.minZ, s.minZ)
    bounds.maxX = Math.max(bounds.maxX, s.maxX)
    bounds.maxY = Math.max(bounds.maxY, s.maxY)
    bounds.maxZ = Math.max(bounds.maxZ, s.maxZ)
  }

  /**
   * 複数のブラシをまとめて掛ける。何も変化しなければ null。
   *
   * 崩れ（{@link settleLoose}）は起こさない。軌道の切り盛りのように
   * **形をそのまま残したい**編集のためのもので、掛けた箱の面がそのまま地面になる。
   * メッシュの作り直しは最後に 1 回だけなので、細かい箱を何十本並べても
   * 1 回の編集と同じ負荷で済む。
   */
  applyBrushBatch(ops: readonly BrushOp[]): BrushBounds | null {
    if (ops.length === 0) return null
    const bounds = applyBrushes(
      ops,
      this.readD,
      this.readMat,
      this.writeCorner,
      WORLD_MIN_Y + 2,
      WORLD_MAX_Y - 2,
    )
    return this.finishEdit(bounds)
  }

  /** 凸凹をならす。何も変化しなければ null。 */
  applySmooth(x: number, y: number, z: number, radius: number, strength: number): BrushBounds | null {
    const bounds = applySmoothBrush(
      x,
      y,
      z,
      radius,
      strength,
      this.readD,
      this.readMat,
      this.writeCorner,
      WORLD_MIN_Y + 2,
      WORLD_MAX_Y - 2,
    )
    if (bounds.looseTouched > 0) this.settle(x, y, z, radius, radius, radius, bounds)
    return this.finishEdit(bounds)
  }

  private readonly readD = (gx: number, gy: number, gz: number): number =>
    this.cornerDensity(gx, gy, gz)
  private readonly readMat = (gx: number, gy: number, gz: number): number =>
    this.cornerMaterial(gx, gy, gz)
  private readonly writeCorner = (
    gx: number,
    gy: number,
    gz: number,
    d: number,
    mat: number,
  ): void => this.setEdit(gx, gy, gz, d, mat)

  /** 編集されたコーナーを含むチャンクを作り直す。 */
  private finishEdit(bounds: BrushBounds): BrushBounds | null {
    if (bounds.touched === 0) return null

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
    return bounds
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
          chopped: this.collectChopped(chunk.cx, chunk.cz),
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
    if (res.mats2) geo.setAttribute('matw2', new THREE.BufferAttribute(res.mats2, 4))
    if (res.biome) geo.setAttribute('abiome', new THREE.BufferAttribute(res.biome, 2))
    geo.setIndex(new THREE.BufferAttribute(res.indices, 1))
    geo.computeBoundingSphere()

    // ガラスは後ろにまとめてあるので、そこだけ透過マテリアルで描く
    const glassStart = res.glassStart ?? res.indices.length
    let material: THREE.Material | THREE.Material[] = this.material
    if (this.glassMaterial && glassStart < res.indices.length) {
      geo.addGroup(0, glassStart, 0)
      geo.addGroup(glassStart, res.indices.length - glassStart, 1)
      material = [this.material, this.glassMaterial]
    }
    const mesh = new THREE.Mesh(geo, material)
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
          proto.crownRadius * s,
          proto.crownBase * s,
          proto.crownTop * s,
          proto.hitRadius * s,
          proto.hitHeight * s,
          t * 65536 + k,
        )
      }
      im.instanceMatrix.needsUpdate = true
      im.computeBoundingSphere()
      this.group.add(im)
      chunk.treeMeshes.push(im)
      this.treeCount += list.length
    }
    chunk.trunks = new Float32Array(trunks)
    chunk.trunkLen = trunks.length
  }

  // ------------------------------------------------------------------ 伐採

  /** 保存されていた伐採状態を復元する。 */
  setChopped(keys: Iterable<number>): void {
    this.chopped.clear()
    for (const k of keys) this.chopped.add(k)
  }

  get choppedList(): number[] {
    return [...this.chopped]
  }

  get choppedCount(): number {
    return this.chopped.size
  }

  /** チャンクの範囲にかかる伐採済みセルだけを抜き出す。 */
  private collectChopped(cx: number, cz: number): Float64Array | null {
    if (this.chopped.size === 0) return null
    const x0 = cx * CHUNK_WORLD - 8
    const x1 = (cx + 1) * CHUNK_WORLD + 8
    const z0 = cz * CHUNK_WORLD - 8
    const z1 = (cz + 1) * CHUNK_WORLD + 8
    const out: number[] = []
    for (const key of this.chopped) {
      const cellX = Math.floor(key / 1048576)
      const cellZ = key - cellX * 1048576 - 524288
      const wx = cellX * TREE_CELL
      const wz = cellZ * TREE_CELL
      if (wx + TREE_CELL < x0 || wx > x1) continue
      if (wz + TREE_CELL < z0 || wz > z1) continue
      out.push(key)
    }
    return out.length > 0 ? new Float64Array(out) : null
  }

  /**
   * 木に照準を合わせているかを調べる。木全体を覆う垂直円柱との交差判定。
   */
  raycastTree(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDist: number,
    out: TreeHit,
  ): TreeHit | null {
    const ex = ox + dx * maxDist
    const ez = oz + dz * maxDist
    const cx0 = Math.floor((Math.min(ox, ex) - 3) / CHUNK_WORLD)
    const cx1 = Math.floor((Math.max(ox, ex) + 3) / CHUNK_WORLD)
    const cz0 = Math.floor((Math.min(oz, ez) - 3) / CHUNK_WORLD)
    const cz1 = Math.floor((Math.max(oz, ez) + 3) / CHUNK_WORLD)
    const ey = oy + dy * maxDist
    const cy0 = Math.floor((Math.min(oy, ey) - 10) / CHUNK_WORLD)
    const cy1 = Math.floor((Math.max(oy, ey) + 10) / CHUNK_WORLD)

    let best = Infinity
    let found = false
    const a = dx * dx + dz * dz
    if (a < 1e-8) return null

    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const chunk = this.chunks.get(chunkKey(cx, cy, cz))
          const t = chunk?.trunks
          if (!chunk || !t) continue
          for (let i = 0; i < chunk.trunkLen; i += TREE_FIELDS) {
            const r = t[i + 8]
            const px = ox - t[i]
            const pz = oz - t[i + 2]
            const b = 2 * (px * dx + pz * dz)
            const c = px * px + pz * pz - r * r
            const disc = b * b - 4 * a * c
            if (disc < 0) continue
            const sq = Math.sqrt(disc)
            let tt = (-b - sq) / (2 * a)
            if (tt < 0) tt = (-b + sq) / (2 * a)
            if (tt < 0 || tt > maxDist || tt >= best) continue
            const y = oy + dy * tt
            if (y < t[i + 1] || y > t[i + 1] + t[i + 9]) continue
            best = tt
            found = true
            out.distance = tt
            out.x = t[i]
            out.y = t[i + 1]
            out.z = t[i + 2]
            out.chunkKey = chunk.key
            out.index = i
          }
        }
      }
    }
    return found ? out : null
  }

  /**
   * 木を 1 本切り倒す。InstancedMesh からは即座に取り除き、
   * セルキーを記録して再メッシュ後も生えてこないようにする。
   */
  chopTree(hit: TreeHit): boolean {
    const chunk = this.chunks.get(hit.chunkKey)
    const t = chunk?.trunks
    if (!chunk || !t || hit.index >= chunk.trunkLen) return false

    const packed = t[hit.index + TREE_FIELDS - 1]
    const meshIndex = Math.floor(packed / 65536)
    const instanceIndex = packed - meshIndex * 65536
    const im = chunk.treeMeshes[meshIndex]
    if (im && im.count > 0) {
      const last = im.count - 1
      if (instanceIndex !== last) {
        im.getMatrixAt(last, this.dummy.matrix)
        im.setMatrixAt(instanceIndex, this.dummy.matrix)
        // 末尾を指していたレコードを差し替える
        const lastPacked = meshIndex * 65536 + last
        for (let k = 0; k < chunk.trunkLen; k += TREE_FIELDS) {
          if (t[k + TREE_FIELDS - 1] === lastPacked) {
            t[k + TREE_FIELDS - 1] = meshIndex * 65536 + instanceIndex
            break
          }
        }
      }
      im.count = last
      im.instanceMatrix.needsUpdate = true
    }

    const lastOff = chunk.trunkLen - TREE_FIELDS
    if (hit.index !== lastOff) {
      for (let k = 0; k < TREE_FIELDS; k++) t[hit.index + k] = t[lastOff + k]
    }
    chunk.trunkLen = lastOff
    this.treeCount--
    this.chopped.add(treeCellKey(hit.x, hit.z))
    return true
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

/** `raycastTree` の結果。x, y, z は木の根元の位置。 */
export interface TreeHit {
  distance: number
  x: number
  y: number
  z: number
  chunkKey: string
  index: number
}

export function createTreeHit(): TreeHit {
  return { distance: 0, x: 0, y: 0, z: 0, chunkKey: '', index: 0 }
}
