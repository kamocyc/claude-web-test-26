import { describe, expect, it } from 'vitest'
import { MAX_FRAGMENT_CORNERS, applySphereBrush } from '../src/world/edits'
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

  it('掘った縁にとげ（面で 1 個以下しか繋がらない固体）を残さない', () => {
    // 波打つ薄い地面。掃除しないとブラシの縁にとげが残る形。
    const f = makeField(
      (x, y, z) =>
        2.2 -
        Math.abs(y - (x + z) * 0.35) * 2.0 +
        Math.sin(x * 1.9) * Math.cos(z * 2.3) * 1.4 +
        Math.sin(y * 2.7) * 0.9,
    )
    applySphereBrush(0, 0, 0, 3, 'dig', 0, f.readD, f.readMat, f.write, -1000, 1000)

    const solid = new Set<string>()
    for (let z = -8; z <= 8; z++)
      for (let y = -8; y <= 8; y++)
        for (let x = -8; x <= 8; x++) if (f.readD(x, y, z) > 0) solid.add(`${x},${y},${z}`)

    const face = [
      [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
    ]
    let weak = 0
    for (const k of solid) {
      const [x, y, z] = k.split(',').map(Number)
      // 走査範囲の縁は隣を数えきれないので除く
      if (Math.abs(x) >= 7 || Math.abs(y) >= 7 || Math.abs(z) >= 7) continue
      // 掃除の対象はブラシ球の近傍だけ
      if (Math.hypot(x, y, z) > 4) continue
      let n = 0
      for (const [dx, dy, dz] of face) if (solid.has(`${x + dx},${y + dy},${z + dz}`)) n++
      if (n <= 1) weak++
    }
    expect(weak, 'ブラシの縁にとげが残っている').toBe(0)
  })

  it('掘ると近くの浮いた小塊が消える', () => {
    // 原点付近は空、(3,1,1) にだけ孤立した固体がある
    const f = makeField((x, y, z) => (x === 3 && y === 1 && z === 1 ? 1 : -5))
    expect(f.readD(3, 1, 1)).toBeGreaterThan(0)
    const b = applySphereBrush(0, 0, 0, 3, 'dig', 0, f.readD, f.readMat, f.write, -1000, 1000)
    expect(f.readD(3, 1, 1), '浮いた小塊が残っている').toBeLessThanOrEqual(0)
    expect(b.fragmentsRemoved).toBeGreaterThan(0)
  })

  it('板状の壁は削らない', () => {
    // x = 2 の 1 格子ぶんの薄い壁。面で 4 個繋がっているので残るべき。
    const f = makeField((x) => (x === 2 ? 1 : -5))
    applySphereBrush(0, 0, 0, 1.2, 'dig', 0, f.readD, f.readMat, f.write, -1000, 1000)
    for (let z = -1; z <= 1; z++) {
      for (let y = -1; y <= 1; y++) {
        expect(f.readD(2, y, z), `壁 (2,${y},${z}) が削られた`).toBeGreaterThan(0)
      }
    }
  })

  it('押しっぱなしでも穴がそれ以上広がらない', () => {
    const jagged = (x: number, y: number, z: number) =>
      (Math.imul(x * 7 + y * 13 + z * 23, 2654435761) >>> 28) % 5 === 0 ? 2 : -2
    const f = makeField(jagged)
    for (let i = 0; i < 2; i++) {
      applySphereBrush(0, 0, 0, 3, 'dig', 0, f.readD, f.readMat, f.write, -1000, 1000)
    }
    const snapshot = new Map([...f.store].map(([k, v]) => [k, v.d]))
    for (let i = 0; i < 8; i++) {
      applySphereBrush(0, 0, 0, 3, 'dig', 0, f.readD, f.readMat, f.write, -1000, 1000)
    }
    expect(f.store.size, '格子点が増え続けている').toBe(snapshot.size)
    for (const [k, v] of f.store) expect(v.d).toBeCloseTo(snapshot.get(k)!, 10)
  })

  it('切れ端とみなす大きさの上限は 1m 角ていど', () => {
    expect(MAX_FRAGMENT_CORNERS).toBeLessThanOrEqual(8)
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
