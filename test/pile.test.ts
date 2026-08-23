import { describe, expect, it } from 'vitest'
import { applyPileBrush, sphereBrush } from '../src/world/edits'
import { MAT_DIRT, MAT_NONE } from '../src/world/constants'

const REPOSE = 38
const MAX_STEP = Math.tan((REPOSE * Math.PI) / 180)

function makeField(initial: (x: number, y: number, z: number) => number) {
  const store = new Map<string, { d: number; mat: number }>()
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`
  return {
    store,
    readD: (x: number, y: number, z: number) => store.get(key(x, y, z))?.d ?? initial(x, y, z),
    readMat: (x: number, y: number, z: number) => store.get(key(x, y, z))?.mat ?? MAT_NONE,
    write: (x: number, y: number, z: number, d: number, mat: number) =>
      store.set(key(x, y, z), { d, mat }),
  }
}

/** 柱 (x,z) の地表の高さ。上から見て最初に固体になるところを線形補間する。 */
function surfaceHeight(
  readD: (x: number, y: number, z: number) => number,
  x: number,
  z: number,
  top = 40,
  bottom = -40,
): number {
  let prev = readD(x, top, z)
  for (let y = top - 1; y >= bottom; y--) {
    const cur = readD(x, y, z)
    if (cur > 0) return y + cur / (cur - prev)
    prev = cur
  }
  return bottom
}

/** 中心まわり range 内の地表の高さを集める。 */
function heights(
  readD: (x: number, y: number, z: number) => number,
  cx: number,
  cz: number,
  range: number,
): Map<string, number> {
  const m = new Map<string, number>()
  for (let z = cz - range; z <= cz + range; z++) {
    for (let x = cx - range; x <= cx + range; x++) m.set(`${x},${z}`, surfaceHeight(readD, x, z))
  }
  return m
}

/** 隣り合う柱の高さ差の最大値。 */
function worstSlope(h: Map<string, number>): number {
  let worst = 0
  for (const [k, v] of h) {
    const [x, z] = k.split(',').map(Number)
    for (const [dx, dz] of [
      [1, 0],
      [0, 1],
    ]) {
      const n = h.get(`${x + dx},${z + dz}`)
      if (n === undefined) continue
      worst = Math.max(worst, Math.abs(v - n))
    }
  }
  return worst
}

/** 地面 y = 0 の平らな場。 */
const flat = (_x: number, y: number) => -y

describe('土砂ブラシ', () => {
  it('安息角より急な斜面を作らない', () => {
    const f = makeField(flat)
    // 平らな地面のすぐ上に置く
    applyPileBrush(0, 0.4, 0, sphereBrush(2.5), MAT_DIRT, REPOSE, f.readD, f.readMat, f.write, -100, 100)

    const h = heights(f.readD, 0, 0, 9)
    expect(h.get('0,0')!, '中心が盛り上がっていない').toBeGreaterThan(0.5)
    // 格子 1 マスあたりの高さ差が tan(安息角) を超えない（緩和の残差ぶんだけ許容）
    expect(worstSlope(h)).toBeLessThan(MAX_STEP * 1.1)
  })

  it('球ブラシのまま固まらず、横に広がる', () => {
    const f = makeField(flat)
    applyPileBrush(0, 0.4, 0, sphereBrush(2.5), MAT_DIRT, REPOSE, f.readD, f.readMat, f.write, -100, 100)
    const h = heights(f.readD, 0, 0, 9)
    // 球なら半径 2.5 で切れるが、崩れるのでその外にも積もる
    expect(h.get('3,0')!, '球の外に広がっていない').toBeGreaterThan(0.3)

    // 斜面がちょうど安息角に張り付く（ただ低いだけでなく、円錐になっている）
    let atRepose = 0
    for (let x = -5; x < 5; x++) {
      if (Math.abs(Math.abs(h.get(`${x},0`)! - h.get(`${x + 1},0`)!) - MAX_STEP) < 0.02) atRepose++
    }
    expect(atRepose, '安息角ちょうどの斜面が現れない').toBeGreaterThanOrEqual(4)
  })

  it('空中に置いても地面まで落ちる', () => {
    const f = makeField(flat)
    applyPileBrush(0, 9, 0, sphereBrush(2), MAT_DIRT, REPOSE, f.readD, f.readMat, f.write, -100, 100)

    // 置いた高さには何も残らない
    for (let z = -3; z <= 3; z++) {
      for (let x = -3; x <= 3; x++) {
        expect(f.readD(x, 6, z), `(${x},6,${z}) が空中に残っている`).toBeLessThanOrEqual(0)
      }
    }
    expect(surfaceHeight(f.readD, 0, 0), '地面に積もっていない').toBeGreaterThan(0.4)
  })

  it('元の地形は削らない', () => {
    // 斜面を含む地形
    const field = (x: number, y: number, z: number) =>
      x * 0.35 + Math.sin(z * 0.4) * 1.2 - y
    const f = makeField(field)
    const before = heights(f.readD, 0, 0, 9)
    applyPileBrush(0, field(0, 0, 0) + 0.4, 0, sphereBrush(2.5), MAT_DIRT, REPOSE, f.readD, f.readMat, f.write, -100, 100)
    const after = heights(f.readD, 0, 0, 9)
    for (const [k, v] of before) {
      expect(after.get(k)!, `${k} の地面が下がった`).toBeGreaterThan(v - 1e-3)
    }
  })

  it('積み増すと高くなるが、傾斜は保たれる', () => {
    const f = makeField(flat)
    let last = 0
    for (let i = 0; i < 6; i++) {
      const top = surfaceHeight(f.readD, 0, 0)
      applyPileBrush(0, top + 0.4, 0, sphereBrush(2.5), MAT_DIRT, REPOSE, f.readD, f.readMat, f.write, -100, 100)
      const h = surfaceHeight(f.readD, 0, 0)
      expect(h, `${i} 回目で高くならなかった`).toBeGreaterThan(last)
      last = h
    }
    expect(worstSlope(heights(f.readD, 0, 0, 12))).toBeLessThan(MAX_STEP * 1.1)
  })

  it('置いた素材が記録される', () => {
    const f = makeField(flat)
    const b = applyPileBrush(0, 0.4, 0, sphereBrush(2.5), MAT_DIRT, REPOSE, f.readD, f.readMat, f.write, -100, 100)
    expect(b.solidified, '固体になった格子点が無い').toBeGreaterThan(0)
    let dirt = 0
    for (const v of f.store.values()) if (v.d > 0 && v.mat === MAT_DIRT) dirt++
    expect(dirt).toBeGreaterThan(0)
  })
})
