import { describe, expect, it } from 'vitest'
import { applySphereBrush } from '../src/world/edits'
import { MAT_NONE } from '../src/world/constants'

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

describe('球ブラシ', () => {
  it('掘った跡が真球のくぼみになる', () => {
    // 一様に固体（d = 5）な場を掘る
    const f = makeField(() => 5)
    applySphereBrush(0, 0, 0, 4, 'dig', 0, f.readD, f.readMat, f.write, -1000, 1000)

    for (const [k, v] of f.store) {
      const [x, y, z] = k.split(',').map(Number)
      const dist = Math.hypot(x, y, z)
      if (dist < 3.5) expect(v.d).toBeLessThan(0) // 内側は空洞
      if (dist > 4.5) expect(v.d).toBeGreaterThan(0) // 外側は固体のまま
    }
  })

  it('同じブラシを何度掛けても値が発散しない（冪等）', () => {
    const f = makeField(() => 5)
    for (let i = 0; i < 8; i++) {
      applySphereBrush(0, 0, 0, 4, 'dig', 0, f.readD, f.readMat, f.write, -1000, 1000)
    }
    const once = makeField(() => 5)
    applySphereBrush(0, 0, 0, 4, 'dig', 0, once.readD, once.readMat, once.write, -1000, 1000)
    for (const [k, v] of f.store) {
      expect(v.d).toBeCloseTo(once.store.get(k)!.d, 10)
    }
  })

  it('掘る→盛るを往復しても密度が暴走しない', () => {
    const f = makeField(() => 5)
    for (let i = 0; i < 20; i++) {
      applySphereBrush(0, 0, 0, 3, 'dig', 0, f.readD, f.readMat, f.write, -1000, 1000)
      applySphereBrush(0, 0, 0, 3, 'place', 2, f.readD, f.readMat, f.write, -1000, 1000)
    }
    for (const v of f.store.values()) {
      expect(Number.isFinite(v.d)).toBe(true)
      expect(Math.abs(v.d)).toBeLessThan(20)
    }
  })

  it('設置は素材 ID を記録する', () => {
    const f = makeField(() => -5) // 空中
    applySphereBrush(0, 0, 0, 3, 'place', 2, f.readD, f.readMat, f.write, -1000, 1000)
    let solidWithMat = 0
    for (const v of f.store.values()) {
      if (v.d > 0) {
        expect(v.mat).toBe(2)
        solidWithMat++
      }
    }
    expect(solidWithMat).toBeGreaterThan(20)
  })
})
