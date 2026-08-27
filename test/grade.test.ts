import { describe, expect, it } from 'vitest'
import { LEVEL_EPS, gradeLabel, readGrade } from '../src/player/grade'

/** 目の位置。ここを水平の基準にする。 */
const EYE = { x: 10, y: 5, z: -4 } as const

const read = (x: number, y: number, z: number) => readGrade(EYE.x, EYE.y, EYE.z, x, y, z)

/** ヨー θ・ピッチ φ の視線を距離 d 進んだ点（Player.step と同じ規約）。 */
function along(yaw: number, pitch: number, d: number): [number, number, number] {
  const h = Math.cos(pitch) * d
  return [EYE.x - Math.sin(yaw) * h, EYE.y + Math.sin(pitch) * d, EYE.z - Math.cos(yaw) * h]
}

describe('照準の勾配', () => {
  it('目と同じ高さなら水平', () => {
    const r = read(EYE.x + 8, EYE.y, EYE.z + 6)
    expect(r.level).toBe(true)
    expect(r.rise).toBe(0)
    expect(r.grade).toBe(0)
    expect(r.degrees).toBe(0)
    expect(gradeLabel(r)).toBe('水平')
  })

  it('カメラが完全に水平なら、どの向き・どの距離でも水平になる', () => {
    for (const yaw of [0, 0.7, 2.4, -1.9, Math.PI]) {
      for (const d of [1, 4.5, 9]) {
        const [x, y, z] = along(yaw, 0, d)
        const r = read(x, y, z)
        expect(r.level, `yaw=${yaw} d=${d}`).toBe(true)
        expect(gradeLabel(r)).toBe('水平')
      }
    }
  })

  it('勾配は 高さの差 ÷ 水平距離', () => {
    const r = read(EYE.x + 4, EYE.y - 1, EYE.z + 3) // 水平距離 5、1 m 下
    expect(r.run).toBeCloseTo(5, 10)
    expect(r.rise).toBeCloseTo(-1, 10)
    expect(r.grade).toBeCloseTo(-0.2, 10)
    expect(r.degrees).toBeCloseTo(-11.3099, 3)
    expect(r.level).toBe(false)
  })

  it('見上げれば上り、見下ろせば下り', () => {
    expect(read(EYE.x + 5, EYE.y + 2, EYE.z).rise).toBeGreaterThan(0)
    expect(read(EYE.x + 5, EYE.y - 2, EYE.z).rise).toBeLessThan(0)
    expect(gradeLabel(read(EYE.x + 5, EYE.y + 2, EYE.z))).toContain('上り')
    expect(gradeLabel(read(EYE.x + 5, EYE.y - 2, EYE.z))).toContain('下り')
  })

  it('角度はカメラのピッチと一致する', () => {
    for (const deg of [-60, -12.5, 3, 30, 75]) {
      const pitch = (deg * Math.PI) / 180
      const [x, y, z] = along(1.1, pitch, 7)
      expect(read(x, y, z).degrees, `${deg}°`).toBeCloseTo(deg, 6)
    }
  })

  it('水平とみなす幅は 0.5 % で、そこを外れると勾配として出る', () => {
    const inside = read(EYE.x + 100, EYE.y + 100 * (LEVEL_EPS * 0.9), EYE.z)
    const outside = read(EYE.x + 100, EYE.y + 100 * (LEVEL_EPS * 1.1), EYE.z)
    expect(inside.level).toBe(true)
    expect(outside.level).toBe(false)
  })

  it('ほぼ真下・真上は勾配ではなく「真下」「真上」', () => {
    const down = read(EYE.x + 0.01, EYE.y - 3, EYE.z)
    expect(down.vertical).toBe(true)
    expect(down.grade).toBe(-Infinity)
    expect(down.degrees).toBeCloseTo(-90, 0)
    expect(gradeLabel(down)).toContain('真下')
    expect(gradeLabel(read(EYE.x, EYE.y + 3, EYE.z))).toContain('真上')
  })

  it('表示には落差の実寸も出る', () => {
    expect(gradeLabel(read(EYE.x + 4, EYE.y - 1, EYE.z + 3))).toBe('下り 20.0%（11.3°）　1.00 m 下')
  })
})
