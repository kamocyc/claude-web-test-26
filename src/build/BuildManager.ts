import * as THREE from 'three'
import { BuildGrid, createPieceHit } from './BuildGrid'
import type { PieceHit, PlaceCheck, SnapResult, SolidFn } from './BuildGrid'
import { PIECE_COST, pieceColliders, yawRad } from './pieces'
import type { Piece, PieceKind } from './pieces'
import { ghostMaterial, pieceGeometry, snapMarkerMaterial } from '../render/buildMeshes'
import { PieceRenderer } from '../render/PieceRenderer'
import type { Collider } from '../world/collision'

/**
 * 置いた建築パーツの描画と保持。
 *
 * 判定は {@link BuildGrid}（three 非依存）に任せ、描画は {@link PieceRenderer} に任せる。
 * ここが持つのは設置予定のゴーストと吸着の印だけ。
 * 描画を村（`VillageManager`）と共有しているので、**自分で建てたパーツと村の建物は
 * 同じジオメトリ・同じマテリアルで描かれる**。
 */
export class BuildManager {
  readonly grid = new BuildGrid()

  private readonly renderer = new PieceRenderer('build')
  private readonly ghost: THREE.Mesh
  /** どの接続点に噛んだかを見せる印。これが無いと吸着先が読めない。 */
  private readonly marker: THREE.Mesh
  private readonly hit = createPieceHit()
  private readonly boxScratch: Collider[] = []
  private colliders = 0

  constructor(scene: THREE.Scene) {
    scene.add(this.renderer.group)
    this.ghost = new THREE.Mesh(pieceGeometry('wall'), ghostMaterial(true))
    this.ghost.visible = false
    this.ghost.matrixAutoUpdate = true
    scene.add(this.ghost)
    this.marker = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), snapMarkerMaterial)
    this.marker.visible = false
    scene.add(this.marker)
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
    this.colliders += pieceColliders(p, this.boxScratch).length
    this.renderer.add(p)
    return true
  }

  remove(p: Piece): Piece | null {
    const gone = this.grid.remove(p)
    if (!gone) return null
    this.colliders -= pieceColliders(gone, this.boxScratch).length
    this.renderer.remove(gone)
    return gone
  }

  clear(): void {
    this.grid.clear()
    this.colliders = 0
    this.renderer.clear()
    this.rebuild()
  }

  // ------------------------------------------------------------------ 参照

  collectColliders(
    x: number,
    z: number,
    r: number,
    out: Collider[],
    y0?: number,
    y1?: number,
  ): Collider[] {
    return this.grid.collectColliders(x, z, r, out, y0, y1)
  }

  /** 照準の点から置くパーツの姿勢を決める。 */
  snap(
    kind: PieceKind,
    mat: number,
    yawOffset: number,
    px: number,
    py: number,
    pz: number,
    camYaw: number,
  ): SnapResult {
    return this.grid.snap(kind, mat, yawOffset, px, py, pz, camYaw)
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
    this.renderer.rebuild()
  }

  /** 設置予定の半透明表示と、吸着した接続点の印。`p` が null なら隠す。 */
  setGhost(p: Piece | null, ok: boolean, snapPoint: readonly number[] | null = null): void {
    if (!p) {
      this.ghost.visible = false
      this.marker.visible = false
      return
    }
    this.ghost.visible = true
    this.ghost.geometry = pieceGeometry(p.kind)
    this.ghost.material = ghostMaterial(ok)
    this.ghost.position.set(p.x, p.y, p.z)
    this.ghost.rotation.set(0, yawRad(p.yaw), 0)
    this.marker.visible = snapPoint !== null
    if (snapPoint) this.marker.position.set(snapPoint[0], snapPoint[1], snapPoint[2])
  }

  // -------------------------------------------------------------------- 保存

  serialize(): number[] {
    return this.grid.serialize()
  }

  /** 旧形式（格子）の保存データを読む。 */
  loadLegacy(data: unknown, cell: number): void {
    this.rebuildFrom(() => this.grid.loadLegacy(data, cell))
  }

  load(data: unknown): void {
    this.rebuildFrom(() => this.grid.load(data))
  }

  private rebuildFrom(fill: () => void): void {
    this.grid.clear()
    this.renderer.clear()
    fill()
    this.colliders = 0
    for (const p of this.grid.pieces()) {
      this.colliders += pieceColliders(p, this.boxScratch).length
      this.renderer.add(p)
    }
    this.rebuild()
  }
}

export type { Piece, PieceKind, PieceHit, PlaceCheck, SnapResult, SolidFn }
