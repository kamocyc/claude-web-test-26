import * as THREE from 'three'
import { CHUNK_SIZE } from './constants'

/** 1 つの格子コーナーに対するプレイヤーの編集結果（絶対値で保持）。 */
export interface EditRecord {
  d: number
  mat: number
}

/** 所有チャンク内のローカルコーナーインデックス → 編集内容 */
export type EditMap = Map<number, EditRecord>

/** グローバル格子座標 → その座標を所有するチャンク座標 */
export function ownerChunkCoord(g: number): number {
  return Math.floor(g / CHUNK_SIZE)
}

/** グローバル格子座標 → 所有チャンク内のローカルインデックス */
export function localCornerIndex(gx: number, gy: number, gz: number): number {
  const lx = gx - ownerChunkCoord(gx) * CHUNK_SIZE
  const ly = gy - ownerChunkCoord(gy) * CHUNK_SIZE
  const lz = gz - ownerChunkCoord(gz) * CHUNK_SIZE
  return lx + CHUNK_SIZE * (ly + CHUNK_SIZE * lz)
}

export function unpackLocalIndex(i: number): [number, number, number] {
  const lx = i % CHUNK_SIZE
  const ly = ((i - lx) / CHUNK_SIZE) % CHUNK_SIZE
  const lz = (i - lx - ly * CHUNK_SIZE) / (CHUNK_SIZE * CHUNK_SIZE)
  return [lx, ly, lz]
}

export class Chunk {
  mesh: THREE.Mesh | null = null
  /** 木の InstancedMesh（種類ごと）。 */
  treeMeshes: THREE.InstancedMesh[] = []
  /** 幹の当たり判定 (x, y, z, 半径, 高さ) の並び。 */
  trunks: Float32Array | null = null
  /** 最後に投入したジョブの世代。古い結果を破棄するために使う。 */
  requested = 0
  /** 一度でもメッシュ化が完了したか（初期ロード待ちの判定に使う）。 */
  ready = false

  constructor(
    readonly cx: number,
    readonly cy: number,
    readonly cz: number,
    readonly key: string,
  ) {}

  dispose(parent: THREE.Object3D): void {
    if (this.mesh) {
      parent.remove(this.mesh)
      this.mesh.geometry.dispose()
      this.mesh = null
    }
    for (const im of this.treeMeshes) {
      parent.remove(im)
      im.dispose() // ジオメトリは共有プロトタイプなので破棄しない
    }
    this.treeMeshes.length = 0
    this.trunks = null
  }
}
