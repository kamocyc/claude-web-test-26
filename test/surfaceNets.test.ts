import { describe, expect, it } from 'vitest'
import { surfaceNets } from '../src/world/surfaceNets'
import { CHUNK_SIZE, GRID, PAD, VOXEL_SIZE, gridIndex } from '../src/world/constants'
import { DensityField, generateChunkDensity } from '../src/world/density'

/** 中心 c 半径 r の球を密度場として GRID^3 に焼く。座標はチャンクローカル。 */
function sphereGrid(cx: number, cy: number, cz: number, r: number): Float32Array {
  const d = new Float32Array(GRID * GRID * GRID)
  for (let k = 0; k < GRID; k++) {
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const x = (i - PAD) * VOXEL_SIZE
        const y = (j - PAD) * VOXEL_SIZE
        const z = (k - PAD) * VOXEL_SIZE
        d[gridIndex(i, j, k)] = r - Math.hypot(x - cx, y - cy, z - cz)
      }
    }
  }
  return d
}

describe('surfaceNets', () => {
  const R = 10
  const C = 16
  const mesh = surfaceNets(sphereGrid(C, C, C, R), 0, 0, 0, null, null)!

  it('球の等値面を抽出する', () => {
    expect(mesh).not.toBeNull()
    expect(mesh.positions.length / 3).toBeGreaterThan(1000)
  })

  it('全頂点が半径の上に乗る（ボクセル的な段差が出ない）', () => {
    let worst = 0
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const err = Math.abs(
        Math.hypot(mesh.positions[i] - C, mesh.positions[i + 1] - C, mesh.positions[i + 2] - C) - R,
      )
      worst = Math.max(worst, err)
    }
    // 段差のあるボクセル表現なら 0.5 前後の誤差が出る
    expect(worst).toBeLessThan(0.12)
  })

  it('法線が解析的な外向き法線と一致する', () => {
    let worstDot = 1
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const dx = mesh.positions[i] - C
      const dy = mesh.positions[i + 1] - C
      const dz = mesh.positions[i + 2] - C
      const len = Math.hypot(dx, dy, dz)
      const dot =
        (dx / len) * mesh.normals[i] +
        (dy / len) * mesh.normals[i + 1] +
        (dz / len) * mesh.normals[i + 2]
      worstDot = Math.min(worstDot, dot)
    }
    expect(worstDot).toBeGreaterThan(0.985)
  })

  it('三角形の巻き順がすべて外向き（裏面が出ない）', () => {
    const p = mesh.positions
    let bad = 0
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const a = mesh.indices[t] * 3
      const b = mesh.indices[t + 1] * 3
      const c = mesh.indices[t + 2] * 3
      const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]]
      const e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]]
      const n = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ]
      const cxv = (p[a] + p[b] + p[c]) / 3 - C
      const cyv = (p[a + 1] + p[b + 1] + p[c + 1]) / 3 - C
      const czv = (p[a + 2] + p[b + 2] + p[c + 2]) / 3 - C
      if (n[0] * cxv + n[1] * cyv + n[2] * czv <= 0) bad++
    }
    expect(bad).toBe(0)
  })

  it('全ての頂点が三角形から参照される', () => {
    const used = new Set<number>()
    for (const i of mesh.indices) used.add(i)
    expect(used.size).toBe(mesh.positions.length / 3)
  })
})

describe('チャンク境界', () => {
  it('隣接チャンクを独立にメッシュ化しても境界の頂点が完全に一致する', () => {
    const field = new DensityField(4242)
    const collect = (cx: number, cy: number, cz: number) => {
      const { density } = generateChunkDensity(field, cx, cy, cz, false)
      expect(density).not.toBeNull()
      const m = surfaceNets(
        density!,
        cx * CHUNK_SIZE,
        cy * CHUNK_SIZE,
        cz * CHUNK_SIZE,
        null,
        null,
      )
      expect(m).not.toBeNull()
      return m!
    }

    // 地表を含む鉛直チャンクを高度から求める
    const h = field.height(32, 16)
    const cy = Math.floor(h / CHUNK_SIZE)
    const a = collect(0, cy, 0)
    const b = collect(1, cy, 0)

    // 共有セル（ワールド格子 x ∈ [31, 32]）にある頂点をワールド座標で集める
    const pick = (m: { positions: Float32Array }, offsetX: number) => {
      const out: Array<[number, number, number]> = []
      for (let i = 0; i < m.positions.length; i += 3) {
        const wx = m.positions[i] + offsetX
        if (wx >= 31 - 1e-6 && wx <= 32 + 1e-6) {
          out.push([wx, m.positions[i + 1], m.positions[i + 2]])
        }
      }
      out.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2])
      return out
    }

    const left = pick(a, 0)
    const right = pick(b, CHUNK_SIZE)
    expect(left.length).toBeGreaterThan(10)
    expect(right.length).toBe(left.length)
    for (let i = 0; i < left.length; i++) {
      expect(left[i][0]).toBeCloseTo(right[i][0], 5)
      expect(left[i][1]).toBeCloseTo(right[i][1], 5)
      expect(left[i][2]).toBeCloseTo(right[i][2], 5)
    }
  })
})
