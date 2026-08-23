import { describe, expect, it } from 'vitest'
import { applyBrush, applySmoothBrush, applySphereBrush, boxBrush, snapBoxCenter } from '../src/world/edits'
import { DensityField } from '../src/world/density'
import { SAMPLE_SEED } from '../src/world/constants'

/**
 * 実際の地形を掘って、目に見える切れ端が増えないことを確かめる。
 *
 * 「切れ端」の正体は、面で 1 個以下しか隣り合っていない固体の格子点。
 * Surface Nets は密度が正の格子点があるところにしか面を作らないので、
 * この数を見れば見た目のゴミを漏れなく数えられる。
 */
const FACE = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const

function makeWorld(field: DensityField) {
  const store = new Map<string, number>()
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`
  return {
    readD: (x: number, y: number, z: number) => store.get(key(x, y, z)) ?? field.density(x, y, z),
    readMat: () => 255,
    write: (x: number, y: number, z: number, d: number) => store.set(key(x, y, z), d),
  }
}

/** 中心から半径 range 以内で、面隣接が 1 個以下の固体格子点を数える。 */
function countWeak(
  readD: (x: number, y: number, z: number) => number,
  cx: number,
  cy: number,
  cz: number,
  range: number,
): number {
  const solid = new Set<string>()
  const r = range + 2
  for (let z = -r; z <= r; z++) {
    for (let y = -r; y <= r; y++) {
      for (let x = -r; x <= r; x++) {
        if (readD(cx + x, cy + y, cz + z) > 0) solid.add(`${x},${y},${z}`)
      }
    }
  }
  let weak = 0
  for (const k of solid) {
    const [x, y, z] = k.split(',').map(Number)
    if (Math.hypot(x, y, z) > range) continue
    let n = 0
    for (const [dx, dy, dz] of FACE) if (solid.has(`${x + dx},${y + dy},${z + dz}`)) n++
    if (n <= 1) weak++
  }
  return weak
}

describe('掘ったあとの地形の質', () => {
  const field = new DensityField(SAMPLE_SEED)

  // 地表が海面より上で、緩すぎない斜面をいくつか選ぶ
  const spots: Array<[number, number]> = []
  for (let i = 1; i < 4000 && spots.length < 3; i++) {
    const x = Math.round(Math.cos(i * 1.7) * i * 1.1 + 40)
    const z = Math.round(Math.sin(i * 1.7) * i * 1.1 - 30)
    const h = field.height(x, z)
    if (h < 12 || h > 60) continue
    const slope = Math.abs(field.height(x + 3, z) - field.height(x - 3, z)) / 6
    if (slope < 0.3 || slope > 1.4) continue
    if (spots.every(([px, pz]) => Math.hypot(px - x, pz - z) > 150)) spots.push([x, z])
  }

  it('掘る場所が見つかる', () => {
    expect(spots.length).toBe(3)
  })

  for (const [sx, sz] of spots) {
    it(`(${sx}, ${sz}) を掘っても切れ端が増えない`, () => {
      const w = makeWorld(field)
      const sy = Math.round(field.height(sx, sz))
      const before = countWeak(w.readD, sx, sy, sz, 8)

      // 視線を振りながら掘るのを模して、地表に沿って球を並べる
      for (let i = -4; i <= 4; i++) {
        const x = sx + i * 1.1
        const z = sz + Math.sin(i * 0.7) * 1.2
        const y = field.height(x, z) - 0.3
        applySphereBrush(x, y, z, 2.5, 'dig', 0, w.readD, w.readMat, w.write, -120, 180)
      }

      const after = countWeak(w.readD, sx, sy, sz, 8)
      expect(after, `掘る前 ${before} → 掘った後 ${after}`).toBeLessThanOrEqual(before)
    })

    it(`(${sx}, ${sz}) を直方体で掘っても切れ端が増えない`, () => {
      const w = makeWorld(field)
      const sy = Math.round(field.height(sx, sz))
      const before = countWeak(w.readD, sx, sy, sz, 8)

      const half = 1.5
      for (let i = -2; i <= 2; i++) {
        const x = snapBoxCenter(sx + i * 2, half)
        const z = snapBoxCenter(sz + Math.sin(i * 0.7) * 1.5, half)
        const y = snapBoxCenter(field.height(x, z) - 0.3, half)
        applyBrush(x, y, z, boxBrush(half, half, half), 'dig', 0, w.readD, w.readMat, w.write, -120, 180)
      }

      const after = countWeak(w.readD, sx, sy, sz, 8)
      expect(after, `掘る前 ${before} → 掘った後 ${after}`).toBeLessThanOrEqual(before)
    })

    it(`(${sx}, ${sz}) をならしても切れ端が増えない`, () => {
      const w = makeWorld(field)
      const sy = Math.round(field.height(sx, sz))
      const before = countWeak(w.readD, sx, sy, sz, 8)

      for (let i = 0; i < 4; i++) {
        applySmoothBrush(sx, sy, sz, 4, 1, w.readD, w.readMat, w.write, -120, 180)
      }

      const after = countWeak(w.readD, sx, sy, sz, 8)
      expect(after, `ならす前 ${before} → ならした後 ${after}`).toBeLessThanOrEqual(before)
    })
  }
})
