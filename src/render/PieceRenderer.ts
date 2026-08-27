import * as THREE from 'three'
import { pieceGeometry, pieceMaterials } from './buildMeshes'
import { yawRad } from '../build/pieces'
import type { Piece, PieceKind } from '../build/pieces'

interface InstanceGroup {
  kind: PieceKind
  mat: number
  pieces: Piece[]
  mesh: THREE.InstancedMesh | null
  dirty: boolean
}

/**
 * 建築パーツの描画。**「種類 × 素材」ごとの {@link THREE.InstancedMesh} 1 本**にまとめる。
 *
 * プレイヤーが建てたパーツ（`BuildManager`）と村の建物（`VillageManager`）が
 * これを共有しているので、**同じ種類のパーツは村でも自作でも寸分たがわず同じ見た目**になる。
 * 変更のあった組だけ作り直すので、`add`/`remove` を並べてから `rebuild()` を 1 回呼べばよい。
 */
export class PieceRenderer {
  readonly group = new THREE.Group()
  private readonly groups = new Map<string, InstanceGroup>()
  private readonly dummy = new THREE.Object3D()

  constructor(name: string) {
    this.group.name = name
  }

  add(p: Piece): void {
    const g = this.groupOf(p.kind, p.mat)
    g.pieces.push(p)
    g.dirty = true
  }

  /** 取り除けたら true。 */
  remove(p: Piece): boolean {
    const g = this.groupOf(p.kind, p.mat)
    const i = g.pieces.indexOf(p)
    if (i < 0) return false
    g.pieces.splice(i, 1)
    g.dirty = true
    return true
  }

  clear(): void {
    for (const g of this.groups.values()) {
      if (g.pieces.length === 0) continue
      g.pieces.length = 0
      g.dirty = true
    }
  }

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
        // 窓やベッドのように差し色を持つパーツは、ジオメトリのグループで塗り分けるので
        // マテリアルが 2 つになる
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
        const p = g.pieces[i]
        this.dummy.position.set(p.x, p.y, p.z)
        this.dummy.rotation.set(0, yawRad(p.yaw), 0)
        this.dummy.scale.setScalar(1)
        this.dummy.updateMatrix()
        g.mesh.setMatrixAt(i, this.dummy.matrix)
      }
      g.mesh.count = n
      g.mesh.instanceMatrix.needsUpdate = true
      g.mesh.computeBoundingSphere()
    }
  }

  /** 描いているインスタンスの総数（デバッグ表示用）。 */
  get count(): number {
    let n = 0
    for (const g of this.groups.values()) n += g.pieces.length
    return n
  }

  dispose(): void {
    for (const g of this.groups.values()) {
      if (!g.mesh) continue
      this.group.remove(g.mesh)
      g.mesh.dispose()
      g.mesh = null
    }
    this.groups.clear()
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
