import { describe, expect, it } from 'vitest'
import { DensityField } from '../src/world/density'
import { SAMPLE_SEED } from '../src/world/constants'
import { TREE_STRIDE, scatterTrees } from '../src/world/vegetation'
import type { MeshData } from '../src/world/surfaceNets'

/**
 * 平らな地面を模したメッシュ。1 m 間隔の上向き頂点を並べる。
 * `low` を渡すと、同じ x,z にもう 1 枚「掘った跡の床」を敷く（そちらを編集済みにする）。
 */
function flatMesh(size: number, y: number, low: number | null): MeshData {
  const pos: number[] = []
  const nrm: number[] = []
  const edited: number[] = []
  for (let k = 0; k < size; k++) {
    for (let i = 0; i < size; i++) {
      // 掘った床を先に入れる。素朴に「近い頂点」を選ぶだけだとこちらが勝つ
      if (low !== null) {
        pos.push(i + 0.5, low, k + 0.5)
        nrm.push(0, 1, 0)
        edited.push(1)
      }
      pos.push(i + 0.5, y, k + 0.5)
      nrm.push(0, 1, 0)
      edited.push(0)
    }
  }
  const n = pos.length / 3
  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nrm),
    mats: new Float32Array(n * 4),
    mats2: new Float32Array(n * 4),
    biome: new Float32Array(n * 2),
    indices: new Uint32Array(0),
    glassStart: 0,
    edited: new Uint8Array(edited),
  }
}

/** 木がそれなりに生える場所を探す。 */
function forestOrigin(field: DensityField): { ox: number; oz: number; count: number } {
  for (let i = 0; i < 60; i++) {
    const ox = Math.cos(i * 1.7) * i * 60
    const oz = Math.sin(i * 1.7) * i * 60
    const trees = scatterTrees(field, flatMesh(40, 40, null), ox, 0, oz, SAMPLE_SEED, null)
    const count = trees.length / TREE_STRIDE
    if (count >= 4) return { ox, oz, count }
  }
  throw new Error('木が生える場所が見つからない')
}

describe('木の配置', () => {
  const field = new DensityField(SAMPLE_SEED)
  const spot = forestOrigin(field)

  it('編集していない地面には木が生える', () => {
    expect(spot.count).toBeGreaterThanOrEqual(4)
  })

  it('掘った跡には木が生えない', () => {
    const mesh = flatMesh(40, 40, null)
    mesh.edited.fill(1)
    const trees = scatterTrees(field, mesh, spot.ox, 0, spot.oz, SAMPLE_SEED, null)
    expect(trees.length / TREE_STRIDE, '掘った面に木が生えた').toBe(0)
  })

  it('木の下を掘っても、木が穴の底へ沈まない', () => {
    // 元の地面（y=40）と、その下に掘った床（y=32）が同じ列に並んでいる状態
    const trees = scatterTrees(field, flatMesh(40, 40, 32), spot.ox, 0, spot.oz, SAMPLE_SEED, null)
    expect(trees.length / TREE_STRIDE, '木が消えてしまった').toBeGreaterThanOrEqual(4)
    for (let i = 0; i < trees.length; i += TREE_STRIDE) {
      expect(trees[i + 1], `木が穴の底 (y=${trees[i + 1].toFixed(1)}) に沈んだ`).toBeGreaterThan(38)
    }
  })
})
