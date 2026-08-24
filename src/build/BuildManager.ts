import * as THREE from 'three'
import { BuildGrid, createPieceHit, snapPiece } from './BuildGrid'
import type { PieceHit, PlaceCheck, SolidFn } from './BuildGrid'
import { PIECE_COST, pieceAnchor, pieceBoxes, pieceYaw } from './pieces'
import type { Piece, PieceKind } from './pieces'
import { ghostMaterial, pieceGeometry, pieceMaterials } from '../render/buildMeshes'
import type { Box } from '../world/village'

interface InstanceGroup {
  kind: PieceKind
  mat: number
  pieces: Piece[]
  mesh: THREE.InstancedMesh | null
  dirty: boolean
}

/**
 * 置いた建築パーツの描画と保持。
 *
 * 判定は {@link BuildGrid}（three 非依存）に任せ、ここは
 * 「種類 × 素材」ごとの {@link THREE.InstancedMesh} と設置予定のゴーストだけを持つ。
 * 村の建物（`VillageManager`）と同じく、当たり判定は `Box` の配列で外へ渡す。
 */
export class BuildManager {
  readonly group = new THREE.Group()
  readonly grid = new BuildGrid()

  private readonly groups = new Map<string, InstanceGroup>()
  private readonly ghost: THREE.Mesh
  private readonly dummy = new THREE.Object3D()
  private readonly hit = createPieceHit()
  private readonly boxScratch: Box[] = []
  private colliders = 0

  constructor(scene: THREE.Scene) {
    this.group.name = 'build'
    scene.add(this.group)
    this.ghost = new THREE.Mesh(pieceGeometry('wall'), ghostMaterial(true))
    this.ghost.visible = false
    this.ghost.matrixAutoUpdate = true
    scene.add(this.ghost)
  }

  get count(): number {
    return this.grid.count
  }

  /**
   * 置いたパーツが持つ当たり判定の箱の総数（デバッグ表示用）。
   * HUD が毎フレーム読むので、置く／壊すときに足し引きして数え直さない。
   */
  get colliderCount(): number {
    return this.colliders
  }

  // ------------------------------------------------------------------ 置く／壊す

  canPlace(p: Piece, isSolid: SolidFn): PlaceCheck {
    return this.grid.canPlace(p, isSolid)
  }

  place(p: Piece): boolean {
    if (!this.grid.place(p)) return false
    this.colliders += pieceBoxes(p, this.boxScratch).length
    const g = this.groupOf(p.kind, p.mat)
    g.pieces.push(p)
    g.dirty = true
    return true
  }

  remove(p: Piece): Piece | null {
    const gone = this.grid.remove(p)
    if (!gone) return null
    this.colliders -= pieceBoxes(gone, this.boxScratch).length
    const g = this.groupOf(gone.kind, gone.mat)
    const i = g.pieces.indexOf(gone)
    if (i >= 0) g.pieces.splice(i, 1)
    g.dirty = true
    return gone
  }

  clear(): void {
    this.grid.clear()
    this.colliders = 0
    for (const g of this.groups.values()) {
      g.pieces.length = 0
      g.dirty = true
    }
    this.rebuild()
  }

  // ------------------------------------------------------------------ 参照

  collectColliders(x: number, z: number, r: number, out: Box[], y0?: number, y1?: number): Box[] {
    return this.grid.collectColliders(x, z, r, out, y0, y1)
  }

  raycast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDist: number,
  ): PieceHit | null {
    return this.grid.raycast(ox, oy, oz, dx, dy, dz, maxDist, this.hit)
  }

  nearest(x: number, y: number, z: number, range: number): Piece | null {
    return this.grid.nearest(x, y, z, range)
  }

  cost(kind: PieceKind): number {
    return PIECE_COST[kind]
  }

  // ------------------------------------------------------------------ 表示

  /** 変更のあった「種類 × 素材」だけ作り直す。何も変わっていなければ何もしない。 */
  rebuild(): void {
    for (const g of this.groups.values()) {
      if (!g.dirty) continue
      g.dirty = false
      const n = g.pieces.length
      if (g.mesh && g.mesh.instanceMatrix.count < n) {
        this.group.remove(g.mesh)
        g.mesh.dispose()
        g.mesh = null
      }
      if (n === 0) {
        if (g.mesh) g.mesh.count = 0
        continue
      }
      if (!g.mesh) {
        const capacity = Math.max(32, Math.ceil(n * 1.6))
        // 窓だけはジオメトリのグループで枠とガラスを塗り分けるのでマテリアルが 2 つになる
        const mesh = new THREE.InstancedMesh(
          pieceGeometry(g.kind),
          pieceMaterials(g.kind, g.mat) as THREE.Material,
          capacity,
        )
        mesh.castShadow = true
        mesh.receiveShadow = true
        mesh.frustumCulled = false
        g.mesh = mesh
        this.group.add(mesh)
      }
      for (let i = 0; i < n; i++) {
        this.applyTransform(g.pieces[i])
        g.mesh.setMatrixAt(i, this.dummy.matrix)
      }
      g.mesh.count = n
      g.mesh.instanceMatrix.needsUpdate = true
      g.mesh.computeBoundingSphere()
    }
  }

  /** 設置予定の半透明表示。`p` が null なら隠す。 */
  setGhost(p: Piece | null, ok: boolean): void {
    if (!p) {
      this.ghost.visible = false
      return
    }
    this.ghost.visible = true
    this.ghost.geometry = pieceGeometry(p.kind)
    this.ghost.material = ghostMaterial(ok)
    const a = pieceAnchor(p)
    this.ghost.position.set(a[0], a[1], a[2])
    this.ghost.rotation.set(0, pieceYaw(p), 0)
  }

  // -------------------------------------------------------------------- 保存

  serialize(): number[] {
    return this.grid.serialize()
  }

  load(data: unknown): void {
    this.grid.clear()
    for (const g of this.groups.values()) {
      g.pieces.length = 0
      g.dirty = true
    }
    this.grid.load(data)
    this.colliders = 0
    for (const p of this.grid.pieces()) {
      this.colliders += pieceBoxes(p, this.boxScratch).length
      const g = this.groupOf(p.kind, p.mat)
      g.pieces.push(p)
      g.dirty = true
    }
    this.rebuild()
  }

  private applyTransform(p: Piece): void {
    const a = pieceAnchor(p)
    this.dummy.position.set(a[0], a[1], a[2])
    this.dummy.rotation.set(0, pieceYaw(p), 0)
    this.dummy.scale.setScalar(1)
    this.dummy.updateMatrix()
  }

  private groupOf(kind: PieceKind, mat: number): InstanceGroup {
    const key = `${kind}|${mat}`
    let g = this.groups.get(key)
    if (!g) {
      g = { kind, mat, pieces: [], mesh: null, dirty: true }
      this.groups.set(key, g)
    }
    return g
  }
}

export { snapPiece }
export type { Piece, PieceKind, PieceHit, PlaceCheck, SolidFn }
