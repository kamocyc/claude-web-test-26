import { describe, expect, it } from 'vitest'
import {
  applyBrush,
  applySmoothBrush,
  boxBrush,
  snapBoxCenter,
  sphereBrush,
} from '../src/world/edits'
import { GRID, MAT_NONE, PAD, gridIndex } from '../src/world/constants'
import { surfaceNets } from '../src/world/surfaceNets'

/** GRID^3 の密度グリッド。格子座標 = チャンクローカル座標（0 が原点）。 */
function makeGrid(fill: (x: number, y: number, z: number) => number) {
  const d = new Float32Array(GRID * GRID * GRID)
  const mat = new Uint8Array(GRID * GRID * GRID).fill(MAT_NONE)
  for (let k = 0; k < GRID; k++) {
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        d[gridIndex(i, j, k)] = fill(i - PAD, j - PAD, k - PAD)
      }
    }
  }
  const inside = (x: number, y: number, z: number) =>
    x + PAD >= 0 && x + PAD < GRID && y + PAD >= 0 && y + PAD < GRID && z + PAD >= 0 && z + PAD < GRID
  return {
    d,
    mat,
    readD: (x: number, y: number, z: number) =>
      inside(x, y, z) ? d[gridIndex(x + PAD, y + PAD, z + PAD)] : fill(x, y, z),
    readMat: (x: number, y: number, z: number) =>
      inside(x, y, z) ? mat[gridIndex(x + PAD, y + PAD, z + PAD)] : MAT_NONE,
    write: (x: number, y: number, z: number, v: number, m: number) => {
      expect(inside(x, y, z)).toBe(true) // グリッドの外へ書いていたら測定が壊れている
      d[gridIndex(x + PAD, y + PAD, z + PAD)] = v
      mat[gridIndex(x + PAD, y + PAD, z + PAD)] = m
    },
  }
}

function boxSdf(
  px: number,
  py: number,
  pz: number,
  cx: number,
  cy: number,
  cz: number,
  h: number,
): number {
  const qx = Math.abs(px - cx) - h
  const qy = Math.abs(py - cy) - h
  const qz = Math.abs(pz - cz) - h
  const ox = Math.max(qx, 0)
  const oy = Math.max(qy, 0)
  const oz = Math.max(qz, 0)
  return Math.hypot(ox, oy, oz) + Math.min(Math.max(qx, qy, qz), 0)
}

/** 抽出した面が、狙った直方体の表面からどれだけ離れているか。 */
function worstOffBox(g: Float32Array, cx: number, cy: number, cz: number, h: number): number {
  const m = surfaceNets(g, 0, 0, 0, null, null)
  expect(m).not.toBeNull()
  let worst = 0
  for (let i = 0; i < m!.positions.length; i += 3) {
    const e = Math.abs(
      boxSdf(m!.positions[i], m!.positions[i + 1], m!.positions[i + 2], cx, cy, cz, h),
    )
    if (e > worst) worst = e
  }
  return worst
}

const C = 16
const H = 3

describe('直方体ブラシ', () => {
  it('格子に合わせて掘ると完全に鋭い直方体になる', () => {
    // 一様に固体な場を掘れば、出てくる面はブラシの形そのもの
    const g = makeGrid(() => 20)
    applyBrush(C, C, C, boxBrush(H, H, H), 'dig', 0, g.readD, g.readMat, g.write, -1000, 1000)

    // Surface Nets の頂点が面・稜・角の上に厳密に乗る = 面取りゼロ
    // 切れ端の掃除を通したあとでも稜が削られないことも同時に見ている
    expect(worstOffBox(g.d, C, C, C, H)).toBeLessThan(1e-6)
  })

  it('格子からずらすと稜が面取りされる（丸めが効いている証拠）', () => {
    const g = makeGrid(() => 20)
    const c = C + 0.37
    applyBrush(c, c, c, boxBrush(H, H, H), 'dig', 0, g.readD, g.readMat, g.write, -1000, 1000)
    expect(worstOffBox(g.d, c, c, c, H)).toBeGreaterThan(0.2)
  })

  it('設置も鋭い直方体になる', () => {
    // 一様に空な場に置く
    const g = makeGrid(() => -20)
    applyBrush(C, C, C, boxBrush(H, H, H), 'place', 1, g.readD, g.readMat, g.write, -1000, 1000)
    // 残差 0.1mm は面取りではなく SURFACE_BIAS ぶんの一様な外向きオフセット
    expect(worstOffBox(g.d, C, C, C, H)).toBeLessThan(5e-4)
  })

  it('snapBoxCenter は面を整数座標に乗せる', () => {
    // 半サイズが整数 → 中心も整数
    expect(snapBoxCenter(3.2, 2)).toBe(3)
    // 半サイズが 0.5 刻み → 中心も 0.5 刻み。面 (中心 ± 半サイズ) は整数になる
    const c = snapBoxCenter(3.2, 1.5)
    expect(c - 1.5).toBe(Math.round(c - 1.5))
    expect(c + 1.5).toBe(Math.round(c + 1.5))
  })

  it('球ブラシは従来どおり真球のくぼみになる', () => {
    const g = makeGrid(() => 20)
    applyBrush(C, C, C, sphereBrush(4), 'dig', 0, g.readD, g.readMat, g.write, -1000, 1000)
    const m = surfaceNets(g.d, 0, 0, 0, null, null)!
    let worst = 0
    for (let i = 0; i < m.positions.length; i += 3) {
      const e = Math.abs(
        Math.hypot(m.positions[i] - C, m.positions[i + 1] - C, m.positions[i + 2] - C) - 4,
      )
      if (e > worst) worst = e
    }
    expect(worst).toBeLessThan(0.12)
  })
})

/** ブラシ中心から半径 rr 以内の表面の、平均からのばらつき（= 凸凹の大きさ）。 */
function roughness(g: Float32Array, cx: number, cz: number, rr: number): number {
  const m = surfaceNets(g, 0, 0, 0, null, null)!
  const ys: number[] = []
  for (let i = 0; i < m.positions.length; i += 3) {
    if (Math.hypot(m.positions[i] - cx, m.positions[i + 2] - cz) > rr) continue
    ys.push(m.positions[i + 1])
  }
  expect(ys.length).toBeGreaterThan(20)
  const mean = ys.reduce((a, b) => a + b, 0) / ys.length
  return Math.sqrt(ys.reduce((a, b) => a + (b - mean) ** 2, 0) / ys.length)
}

describe('ならしブラシ', () => {
  const bumpy = (x: number, y: number, z: number) =>
    C - y + Math.sin(x * 1.7) * Math.cos(z * 2.1) * 1.2

  it('凸凹が小さくなる', () => {
    const g = makeGrid(bumpy)
    const before = roughness(g.d, C, C, 2)
    applySmoothBrush(C, C, C, 5, 1, g.readD, g.readMat, g.write, -1000, 1000)
    const after = roughness(g.d, C, C, 2)
    // 波の振幅がはっきり落ちること（理論値は 0.31 倍）
    expect(after).toBeLessThan(before * 0.6)
  })

  it('繰り返しかけても平らな斜面は動かない', () => {
    // 一次関数はラプラシアンが 0 なので、いくらならしても変化しないはず
    const g = makeGrid((x, y) => C - y + x * 0.3)
    for (let i = 0; i < 3; i++) {
      const b = applySmoothBrush(C, C, C, 5, 1, g.readD, g.readMat, g.write, -1000, 1000)
      expect(b.touched).toBe(0)
    }
  })

  it('ブラシの外は書き換えない', () => {
    const g = makeGrid(bumpy)
    const written: number[][] = []
    const spy = (x: number, y: number, z: number, v: number, m: number) => {
      written.push([x, y, z])
      g.write(x, y, z, v, m)
    }
    applySmoothBrush(C, C, C, 4, 1, g.readD, g.readMat, spy, -1000, 1000)
    expect(written.length).toBeGreaterThan(0)
    for (const [x, y, z] of written) {
      expect(Math.hypot(x - C, y - C, z - C)).toBeLessThanOrEqual(4)
    }
  })

  it('素材は変えない', () => {
    const g = makeGrid(bumpy)
    for (let i = 0; i < g.mat.length; i++) g.mat[i] = 2
    applySmoothBrush(C, C, C, 4, 1, g.readD, g.readMat, g.write, -1000, 1000)
    for (let i = 0; i < g.mat.length; i++) expect(g.mat[i]).toBe(2)
  })
})
