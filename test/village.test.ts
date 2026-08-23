import { describe, expect, it } from 'vitest'
import { buildingBoxes, flattenWeight, makeVillage } from '../src/world/village'
import type { Box } from '../src/world/village'
import { DensityField } from '../src/world/density'

const field = new DensityField(20260823)
const baseHeight = (x: number, z: number) => field.baseHeight(x, z)

function findVillage() {
  for (let vx = -8; vx <= 8; vx++) {
    for (let vz = -8; vz <= 8; vz++) {
      const v = makeVillage(vx, vz, field.seed, baseHeight)
      if (v && v.buildings.length >= 5) return { v, vx, vz }
    }
  }
  throw new Error('村が 1 つも生成されなかった')
}

function inside(b: Box, x: number, y: number, z: number): boolean {
  return x > b.minX && x < b.maxX && y > b.minY && y < b.maxY && z > b.minZ && z < b.maxZ
}

describe('村', () => {
  const { v, vx, vz } = findVillage()

  it('同じシードなら何度作っても同じ村になる', () => {
    const again = makeVillage(vx, vz, field.seed, baseHeight)!
    expect(again.cx).toBeCloseTo(v.cx, 10)
    expect(again.platformY).toBeCloseTo(v.platformY, 10)
    expect(again.buildings.length).toBe(v.buildings.length)
  })

  it('海の中や山の上には作らない', () => {
    expect(v.platformY).toBeGreaterThan(0)
    expect(v.platformY).toBeLessThan(90)
  })

  it('建物どうしが重ならない', () => {
    for (let i = 0; i < v.buildings.length; i++) {
      for (let j = i + 1; j < v.buildings.length; j++) {
        const a = v.buildings[i]
        const b = v.buildings[j]
        const gapX = Math.abs(a.x - b.x) - (a.w + b.w) / 2
        const gapZ = Math.abs(a.z - b.z) - (a.d + b.d) / 2
        expect(Math.max(gapX, gapZ), `建物 ${i} と ${j} が重なっている`).toBeGreaterThan(0)
      }
    }
  })

  it('壁にドアの開口があり、そこは通り抜けられる', () => {
    const house = v.buildings.find((b) => b.kind === 'house')!
    const boxes = buildingBoxes(house, 0)
    expect(boxes.length).toBeGreaterThan(4) // 開口のぶん壁が分割される

    // ドア面の中心・腰の高さは、どの壁ボックスにも入らない
    const hw = house.w / 2
    const hd = house.d / 2
    const eps = 0.02
    const p =
      house.doorSide === 0
        ? [house.x + hw - eps, 1.0, house.z]
        : house.doorSide === 1
          ? [house.x - hw + eps, 1.0, house.z]
          : house.doorSide === 2
            ? [house.x, 1.0, house.z + hd - eps]
            : [house.x, 1.0, house.z - hd + eps]
    for (const b of boxes) {
      expect(inside(b, p[0], p[1], p[2]), 'ドアの位置が壁で塞がれている').toBe(false)
    }

    // ドアの真横（開口の外）は壁で塞がれている
    const q =
      house.doorSide <= 1 ? [p[0], 1.0, house.z + hd * 0.75] : [house.x + hw * 0.75, 1.0, p[2]]
    expect(boxes.some((b) => inside(b, q[0], q[1], q[2])), 'ドア以外の壁が抜けている').toBe(true)
  })

  it('敷地の中心は完全に平坦化され、外では元の地形に戻る', () => {
    expect(flattenWeight(v, v.cx, v.cz)).toBeCloseTo(1, 6)
    expect(flattenWeight(v, v.cx + v.radius * 0.6, v.cz)).toBeCloseTo(1, 6)
    expect(flattenWeight(v, v.cx + v.radius * 1.2, v.cz)).toBe(0)
    // 中心の地表高度は敷地高さと一致する
    expect(field.height(v.cx, v.cz)).toBeCloseTo(v.platformY, 4)
  })
})
