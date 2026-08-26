import { describe, expect, it } from 'vitest'
import {
  CUT_CLEAR,
  FILL_ANCHOR,
  GRADE_MARGIN,
  GRADE_STEP,
  gradeOps,
} from '../src/track/grading'
import type { GradeOp } from '../src/track/grading'
import { DECK_T, GRADE_TOL, TRACK_INFO, pointAt } from '../src/track/track'
import type { Segment } from '../src/track/track'
import { MAT_ROCK } from '../src/world/constants'
import type { GroundFn } from '../src/track/TrackGraph'

function seg(over: Partial<Segment> = {}): Segment {
  return {
    kind: 'rail',
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    curve: 0,
    length: 12,
    rise: 0,
    mat: MAT_ROCK,
    ...over,
  }
}

const level = (h: number): GroundFn => () => h

/** 箱の上端・下端（ワールド）。 */
const top = (o: GradeOp): number => o.y + o.hy
const bottom = (o: GradeOp): number => o.y - o.hy

describe('切り盛り', () => {
  it('地面が路盤とそろっているところは何もしない', () => {
    // 路盤の天面が 0.35 なので、底面は 0。地面も 0
    const ops = gradeOps(seg({ y: DECK_T }), level(0))
    expect(ops).toHaveLength(0)
  })

  it('地面が低いところは路盤の底面まで盛る', () => {
    const ops = gradeOps(seg({ y: DECK_T }), level(-1))
    expect(ops.length).toBeGreaterThan(0)
    for (const o of ops) {
      expect(o.mode).toBe('place')
      // 天面は路盤の底面ぴったり（浮きも埋もれもしない）
      expect(top(o)).toBeCloseTo(0, 9)
      // 元の地面より少し下から積んで、地面と縁を切らない
      expect(bottom(o)).toBeCloseTo(-1 - FILL_ANCHOR, 9)
      expect(o.mat).toBe(MAT_ROCK)
    }
  })

  it('地面が高いところは路盤の底面から上を削る', () => {
    const ops = gradeOps(seg({ y: DECK_T }), level(1.2))
    expect(ops.length).toBeGreaterThan(0)
    for (const o of ops) {
      expect(o.mode).toBe('dig')
      expect(bottom(o)).toBeCloseTo(0, 9)
      // 路盤の上には列車が通れる高さを空ける
      expect(top(o)).toBeCloseTo(CUT_CLEAR, 9)
    }
    expect(CUT_CLEAR).toBeGreaterThan(2.4)
  })

  it('深すぎる谷は盛らない（橋脚に任せる）', () => {
    expect(gradeOps(seg({ y: DECK_T }), level(-GRADE_TOL + 0.5))).not.toHaveLength(0)
    const deep = gradeOps(seg({ y: DECK_T }), level(-GRADE_TOL - 0.5))
    expect(deep).toHaveLength(0)
  })

  it('横断勾配のある斜面では、谷側の肩まで届くように盛る', () => {
    // 右（+x）へ下る斜面。中心は路盤の 0.5 m 下、右肩はさらに下
    const slope: GroundFn = (x) => -0.5 - x * 0.2
    const ops = gradeOps(seg({ y: DECK_T }), slope)
    expect(ops.length).toBeGreaterThan(0)
    const half = TRACK_INFO.rail.width / 2 + GRADE_MARGIN
    for (const o of ops) {
      // yaw = 0 なので右は +x。いちばん低い肩の下まで積む
      expect(bottom(o)).toBeCloseTo(-0.5 - o.x * 0.2 - half * 0.2 - FILL_ANCHOR, 6)
      expect(top(o)).toBeCloseTo(0, 9)
    }
  })

  it('箱は路盤より少し広く、区間を隙間なく覆う', () => {
    const s = seg({ y: DECK_T, length: 12 })
    const ops = gradeOps(s, level(-1))
    const half = TRACK_INFO.rail.width / 2
    for (const o of ops) {
      expect(o.hx).toBeCloseTo(half + GRADE_MARGIN, 9)
      // 進行方向は刻みの半分よりわずかに長く、隣と重なる
      expect(o.hz).toBeGreaterThan(o.hz / 1.05)
      expect(o.hz * 2).toBeGreaterThan(s.length / ops.length)
    }
    // 刻みは GRADE_STEP 以下
    expect(s.length / ops.length).toBeLessThanOrEqual(GRADE_STEP + 1e-9)
    // 端から端まで並ぶ
    const first = ops[0]
    const last = ops[ops.length - 1]
    expect(Math.hypot(first.x - s.x, first.z - s.z)).toBeLessThan(GRADE_STEP)
    const e = pointAt(s, s.length)
    expect(Math.hypot(last.x - e[0], last.z - e[2])).toBeLessThan(GRADE_STEP)
  })

  it('曲がった区間でも中心線に沿って並び、向きが接線を向く', () => {
    const s = seg({ y: DECK_T, curve: 1 / 20, length: 18, rise: 0.6 })
    const ops = gradeOps(s, level(-1))
    expect(ops.length).toBeGreaterThan(1)
    const n = ops.length
    const ds = s.length / n
    for (let i = 0; i < n; i++) {
      const p = pointAt(s, ds * (i + 0.5))
      expect(ops[i].x).toBeCloseTo(p[0], 9)
      expect(ops[i].z).toBeCloseTo(p[2], 9)
      expect(ops[i].yaw).toBeCloseTo(p[3], 9)
      // 勾配なりに高さも上がっていく
      expect(top(ops[i])).toBeCloseTo(p[1] - DECK_T, 9)
    }
  })

  it('道路は線路より広く均される', () => {
    const rail = gradeOps(seg({ y: DECK_T }), level(-1))
    const road = gradeOps(seg({ kind: 'road', y: DECK_T }), level(-1))
    expect(road[0].hx).toBeGreaterThan(rail[0].hx)
    expect(road[0].hx).toBeCloseTo(TRACK_INFO.road.width / 2 + GRADE_MARGIN, 9)
  })

  it('長さ 0 の区間では何もしない', () => {
    expect(gradeOps(seg({ length: 0 }), level(-1))).toHaveLength(0)
  })
})
