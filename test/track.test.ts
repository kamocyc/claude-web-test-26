import { describe, expect, it } from 'vitest'
import {
  DECK_T,
  GRADE_TOL,
  MAX_SEG_LEN,
  MIN_SEG_LEN,
  TRACK_INFO,
  clampFit,
  clampRise,
  normalizeAngle,
  pointAt,
  radius,
  sampleSegment,
  segmentColliders,
  segmentCost,
  segmentEnd,
  solveArc,
} from '../src/track/track'
import type { Segment, TrackKind } from '../src/track/track'
import { TrackGraph } from '../src/track/TrackGraph'
import type { GroundFn, TrackEnd, TrackPlan } from '../src/track/TrackGraph'
import type { Collider } from '../src/world/collision'
import { MAT_ROCK } from '../src/world/constants'

function seg(over: Partial<Segment> = {}): Segment {
  return {
    kind: 'rail',
    x: 0,
    y: 10,
    z: 0,
    yaw: 0,
    curve: 0,
    length: 12,
    rise: 0,
    mat: MAT_ROCK,
    ...over,
  }
}

/** 始点・向きから狙点へ解いた区間（クランプ無し）。 */
function arcTo(
  sx: number,
  sy: number,
  sz: number,
  syaw: number,
  tx: number,
  ty: number,
  tz: number,
  kind: TrackKind = 'rail',
): Segment {
  const fit = solveArc(sx, sz, syaw, tx, tz)
  return { kind, x: sx, y: sy, z: sz, yaw: syaw, ...fit, rise: ty - sy, mat: MAT_ROCK }
}

describe('円弧の幾何', () => {
  it('ヨー 0 の前方は -Z、右は +X', () => {
    const s = seg({ yaw: 0, length: 10 })
    const end = segmentEnd(s)
    expect(end[0]).toBeCloseTo(0, 9)
    expect(end[2]).toBeCloseTo(-10, 9)
  })

  it('狙点をぴったり通る弧を解く（直線・左・右）', () => {
    const targets: [number, number][] = [
      [0, -20], // 正面
      [-6, -18], // 左手前
      [7, -15], // 右手前
    ]
    for (const [tx, tz] of targets) {
      const s = arcTo(0, 10, 0, 0.7, tx, 10, tz)
      const end = segmentEnd(s)
      expect(end[0]).toBeCloseTo(tx, 6)
      expect(end[2]).toBeCloseTo(tz, 6)
      expect(s.length).toBeGreaterThan(0)
    }
  })

  it('終端の向きは弧の接線と一致する（始端から curve×長さ だけ回る）', () => {
    const s = arcTo(3, 10, -4, 1.2, -10, 10, -18)
    const end = segmentEnd(s)
    expect(normalizeAngle(end[3] - (s.yaw + s.curve * s.length))).toBeCloseTo(0, 9)
    // 少し先の点との差分が終端の向きと一致する
    const a = pointAt(s, s.length - 1e-4)
    const dx = end[0] - a[0]
    const dz = end[2] - a[2]
    expect(normalizeAngle(Math.atan2(-dx, -dz) - end[3])).toBeCloseTo(0, 5)
  })

  it('左の狙点は左へ、右の狙点は右へ曲がる', () => {
    // ヨー 0（-Z 向き）のとき、-X は左、+X は右
    expect(solveArc(0, 0, 0, -5, -20).curve).toBeGreaterThan(0)
    expect(solveArc(0, 0, 0, 5, -20).curve).toBeLessThan(0)
    expect(Math.abs(solveArc(0, 0, 0, 0, -20).curve)).toBeLessThan(1e-9)
  })

  it('真後ろの狙点は円が決まらないので長さ 0 になる', () => {
    const back = solveArc(0, 0, 0, 0, 20)
    expect(back.curve).toBe(0)
    expect(back.length).toBe(0)
  })

  it('後ろを狙うと回り込む弧になる（180° 以上でも狙点を通る）', () => {
    // ヨー 0（-Z 向き）で、右斜め後ろを狙う
    const fit = solveArc(0, 0, 0, 6, 10)
    expect(fit.length).toBeGreaterThan(0)
    expect(Math.abs(fit.curve * fit.length)).toBeGreaterThan(Math.PI)
    const s = seg({ x: 0, y: 0, z: 0, yaw: 0, ...fit })
    const end = segmentEnd(s)
    expect(end[0]).toBeCloseTo(6, 6)
    expect(end[2]).toBeCloseTo(10, 6)
  })

  it('接続すると始点・向きが前の区間の終端に一致する（折れ目が出ない）', () => {
    let prev = arcTo(0, 20, 0, 0.4, -9, 21, -14)
    for (let i = 0; i < 3; i++) {
      const end = segmentEnd(prev)
      const next = arcTo(end[0], end[1], end[2], end[3], end[0] - 4, end[1] + 0.5, end[2] - 16)
      expect(next.x).toBeCloseTo(end[0], 12)
      expect(next.y).toBeCloseTo(end[1], 12)
      expect(next.z).toBeCloseTo(end[2], 12)
      expect(normalizeAngle(next.yaw - end[3])).toBeCloseTo(0, 12)
      prev = next
    }
  })
})

describe('制限', () => {
  it('最小半径より急な弧はクランプされる', () => {
    const fit = clampFit('rail', solveArc(0, 0, 0, -8, -8), MAX_SEG_LEN)
    const s = seg({ ...fit })
    expect(radius(s)).toBeGreaterThanOrEqual(TRACK_INFO.rail.minRadius - 1e-9)
    // 道路の方が小回りが利く
    expect(TRACK_INFO.road.minRadius).toBeLessThan(TRACK_INFO.rail.minRadius)
  })

  it('長さはホイールの上限と MIN/MAX に収まる', () => {
    expect(clampFit('rail', { curve: 0, length: 100 }, 12).length).toBe(12)
    expect(clampFit('rail', { curve: 0, length: 1 }, 12).length).toBe(MIN_SEG_LEN)
    expect(clampFit('rail', { curve: 0, length: 100 }, 999).length).toBe(MAX_SEG_LEN)
  })

  it('勾配は種類ごとの上限に収まる', () => {
    expect(clampRise('rail', 10, 20)).toBeCloseTo(20 * TRACK_INFO.rail.maxGrade, 9)
    expect(clampRise('rail', -10, 20)).toBeCloseTo(-20 * TRACK_INFO.rail.maxGrade, 9)
    expect(clampRise('road', 1, 20)).toBe(1)
  })
})

describe('当たり判定', () => {
  it('デッキが幅いっぱいを覆い、天面が中心線の高さになる', () => {
    const s = seg({ length: 12, curve: 0, yaw: 0 })
    const cols = segmentColliders(s)
    expect(cols.length).toBeGreaterThan(1)
    for (const c of cols) {
      expect(c.maxX - c.minX).toBeCloseTo(TRACK_INFO.rail.width, 9)
      expect(c.maxY - c.minY).toBeCloseTo(DECK_T, 9)
      expect(c.maxY).toBeCloseTo(s.y, 9)
    }
  })

  it('隣り合う箱の段差が乗り越えられる高さ（0.6 m）より小さい', () => {
    for (const kind of ['rail', 'road'] as TrackKind[]) {
      const length = MAX_SEG_LEN
      const s = seg({ kind, length, rise: TRACK_INFO[kind].maxGrade * length, curve: 0.05 })
      const cols = segmentColliders(s)
      for (let i = 1; i < cols.length; i++) {
        expect(Math.abs(cols[i].maxY - cols[i - 1].maxY)).toBeLessThan(0.6)
      }
    }
  })

  it('刻んだ点は始点から終点までを等間隔に覆う', () => {
    const s = seg({ length: 12, curve: 0.04, rise: 0.5 })
    const pts = sampleSegment(s)
    const end = segmentEnd(s)
    expect(pts[0]).toBeCloseTo(s.x, 9)
    expect(pts[1]).toBeCloseTo(s.y, 9)
    expect(pts[pts.length - 4]).toBeCloseTo(end[0], 9)
    expect(pts[pts.length - 3]).toBeCloseTo(end[1], 9)
    expect(pts[pts.length - 2]).toBeCloseTo(end[2], 9)
  })
})

describe('材料', () => {
  it('長さに比例し、種類ごとの単価がかかる', () => {
    expect(segmentCost(seg({ length: 10 }))).toBe(10 * TRACK_INFO.rail.costPerMeter)
    expect(segmentCost(seg({ kind: 'road', length: 10 }))).toBe(10 * TRACK_INFO.road.costPerMeter)
    expect(segmentCost(seg({ length: 20 }))).toBe(2 * segmentCost(seg({ length: 10 })))
  })
})

// ------------------------------------------------------------------ 敷設と接続

/** 平らな地面（高さ 0）。 */
const flat: GroundFn = () => 0

/** 指定の高さの地面。 */
const level = (h: number): GroundFn => () => h

function graphWith(): TrackGraph {
  return new TrackGraph()
}

function planFrom(
  g: TrackGraph,
  railhead: TrackEnd | null,
  aim: [number, number, number],
  ground: GroundFn = flat,
  kind: TrackKind = 'rail',
  maxLen = 12,
  grade: number | null = null,
  obstacles?: Collider[],
): TrackPlan {
  return g.plan({
    kind,
    mat: MAT_ROCK,
    maxLen,
    railhead,
    aimX: aim[0],
    aimY: aim[1],
    aimZ: aim[2],
    camYaw: 0,
    grade,
    terrain: {
      ground,
      obstacles: obstacles
        ? (_x, _z, _r, out) => {
            out.length = 0
            out.push(...obstacles)
            return out
          }
        : undefined,
    },
  })
}

describe('敷設', () => {
  it('レールヘッドが無いときは狙点から新しい線が始まる', () => {
    const g = graphWith()
    const plan = planFrom(g, null, [4, 0, -3])
    expect(plan.from).toBeNull()
    expect(plan.check).toBe('ok')
    expect(plan.seg.x).toBeCloseTo(4, 9)
    expect(plan.seg.z).toBeCloseTo(-3, 9)
    expect(plan.seg.curve).toBe(0)
    expect(plan.seg.length).toBe(12)
  })

  it('路盤は地面の上に載る（軌道面が地表 + 路盤の厚み）', () => {
    const g = graphWith()
    // 狙点は地表そのもの（地面の高さ 2 のところを狙う）
    const plan = planFrom(g, null, [0, 2, 0], level(2))
    expect(plan.seg.y).toBeCloseTo(2 + DECK_T, 9)
    // 平らな地面なら勾配はつかない
    expect(plan.seg.rise).toBeCloseTo(0, 9)
    // 既に敷いた軌道の上を狙ったときは、その高さをそのまま使う
    const onTrack = g.plan({
      kind: 'rail',
      mat: MAT_ROCK,
      maxLen: 12,
      railhead: null,
      aimX: 0,
      aimY: 9,
      aimZ: 0,
      aimOnTrack: true,
      camYaw: 0,
      terrain: { ground: level(2) },
    })
    expect(onTrack.seg.y).toBeCloseTo(9, 9)
  })

  it('端点から伸ばすと前の区間と繋がり、向きも引き継ぐ', () => {
    const g = graphWith()
    expect(g.place(planFrom(g, null, [0, 0, 0]).seg)).toBe(true)
    const first = [...g.segments()][0]
    const end = segmentEnd(first)

    const head = g.nearestEnd(end[0], end[1], end[2], 2, 'rail')
    expect(head).not.toBeNull()
    const plan = planFrom(g, head, [end[0] - 5, 0, end[2] - 10])
    expect(plan.check).toBe('ok')
    expect(plan.seg.x).toBeCloseTo(end[0], 9)
    expect(plan.seg.y).toBeCloseTo(end[1], 9)
    expect(plan.seg.z).toBeCloseTo(end[2], 9)
    expect(normalizeAngle(plan.seg.yaw - end[3])).toBeCloseTo(0, 9)
    expect(g.place(plan.seg)).toBe(true)
    expect(g.count).toBe(2)
  })

  it('繋がった端点はもうレールヘッドにならない（自由端だけを返す）', () => {
    const g = graphWith()
    g.place(planFrom(g, null, [0, 0, 0]).seg)
    const first = [...g.segments()][0]
    const end = segmentEnd(first)
    const head = g.nearestEnd(end[0], end[1], end[2], 2, 'rail')
    g.place(planFrom(g, head, [end[0], 0, end[2] - 12]).seg)
    // 継ぎ目は塞がり、両端の外側だけが空いている
    expect(g.nearestEnd(end[0], end[1], end[2], 1, 'rail')).toBeNull()
    expect(g.nearestEnd(first.x, first.y, first.z, 1, 'rail')).not.toBeNull()
  })

  it('狙点の近くの自由端へ繋ぎに行く', () => {
    const g = graphWith()
    // 2 本の線を向かい合わせに置き、片方からもう片方の端へ繋ぐ
    g.place(planFrom(g, null, [0, 0, 0]).seg)
    const a = [...g.segments()][0]
    const aEnd = segmentEnd(a)
    const far: Segment = {
      kind: 'rail',
      x: aEnd[0],
      y: 0,
      z: aEnd[2] - 14,
      yaw: 0,
      curve: 0,
      length: 12,
      rise: 0,
      mat: MAT_ROCK,
    }
    g.place(far)
    const head = g.nearestEnd(aEnd[0], aEnd[1], aEnd[2], 2, 'rail')
    const plan = planFrom(g, head, [far.x, far.y, far.z], flat, 'rail', 12)
    expect(plan.joinTo).not.toBeNull()
    const e = segmentEnd(plan.seg)
    expect(Math.hypot(e[0] - far.x, e[2] - far.z)).toBeLessThan(0.6)
    expect(plan.check).toBe('ok')
  })

  it('同じところへ二重に敷けない', () => {
    const g = graphWith()
    const plan = planFrom(g, null, [0, 0, 0])
    expect(g.place(plan.seg)).toBe(true)
    const again = planFrom(g, null, [0, 0, 0])
    expect(again.check).toBe('overlap')
    expect(g.place(again.seg)).toBe(false)
  })

  it('少しの段差なら敷ける（敷くときに切り盛りして合わせる）', () => {
    const g = graphWith()
    // 路盤の底面は狙点と同じ高さなので、地面が GRADE_TOL まで高くても切土で通る
    expect(planFrom(g, null, [0, 0, 0], level(GRADE_TOL - 0.5)).check).toBe('ok')
    // 低いほうは橋脚で渡すので、もともと通る
    expect(planFrom(new TrackGraph(), null, [0, 0, 0], level(-GRADE_TOL - 3)).check).toBe('ok')
  })

  it('切土が深すぎる区間は敷けない', () => {
    const g = graphWith()
    expect(planFrom(g, null, [0, 0, 0], level(GRADE_TOL + 1)).check).toBe('buried')
  })

  it('地面に埋まる区間は敷けない', () => {
    const g = graphWith()
    expect(planFrom(g, null, [0, 0, 0], level(5)).check).toBe('buried')
    // 掘った跡は密度場で見るので、切通しの中なら通る
    const cut = g.plan({
      kind: 'rail',
      mat: MAT_ROCK,
      maxLen: 12,
      railhead: null,
      aimX: 0,
      aimY: 0,
      aimZ: 0,
      camYaw: 0,
      terrain: { ground: level(5), solid: () => false },
    })
    expect(cut.check).toBe('ok')
  })

  it('斜面にぶつかる手前で区間を切り詰める（勾配は変えない）', () => {
    const g = graphWith()
    // 6 m 先から急に立ち上がる崖
    const cliff: GroundFn = (_x, z) => (z < -6 ? 20 : 0)
    const plan = planFrom(g, null, [0, 0, 0], cliff)
    expect(plan.check).toBe('ok')
    expect(plan.seg.length).toBeLessThan(12)
    expect(plan.seg.length).toBeGreaterThanOrEqual(MIN_SEG_LEN)
    // 崖へ向かうので最大勾配で登り、詰めても縦断の形（勾配）は変わらない
    expect(plan.seg.rise / plan.seg.length).toBeCloseTo(TRACK_INFO.rail.maxGrade, 9)
  })

  it('切り詰めても最短長に届かなければ敷けない', () => {
    const g = graphWith()
    const wall: GroundFn = (_x, z) => (z < -2 ? 20 : 0)
    expect(planFrom(g, null, [0, 0, 0], wall).check).toBe('buried')
  })

  it('橋脚が高くなりすぎる区間は敷けない', () => {
    const g = graphWith()
    expect(planFrom(g, null, [0, 0, 0], level(-40)).check).toBe('toohigh')
  })

  it('狙点が手前でも、ホイールで決めた長さまで伸びる', () => {
    const g = graphWith()
    const head: TrackEnd = { seg: null as never, atEnd: true, x: 0, y: 0, z: 0, yaw: 0 }
    // 狙点は 5 m 先（手の届く範囲）。それでも 20 m 敷ける
    const long = planFrom(g, head, [0, 0, -5], flat, 'rail', 20)
    expect(long.seg.length).toBe(20)
    expect(long.wanted).toBe(20)
    expect(long.trim).toBe('none')
    // 長さを変えればそのぶん伸び縮みする
    expect(planFrom(g, head, [0, 0, -5], flat, 'rail', 8).seg.length).toBe(8)
    expect(planFrom(g, head, [0, 0, -5], flat, 'rail', 24).seg.length).toBe(24)
  })

  it('狙点は曲がり方だけを決める（長さは変わらない）', () => {
    const g = graphWith()
    const head: TrackEnd = { seg: null as never, atEnd: true, x: 0, y: 0, z: 0, yaw: 0 }
    const straight = planFrom(g, head, [0, 0, -6], flat, 'rail', 16).seg
    const left = planFrom(g, head, [-4, 0, -6], flat, 'rail', 16).seg
    const right = planFrom(g, head, [4, 0, -6], flat, 'rail', 16).seg
    expect(straight.length).toBe(16)
    expect(left.length).toBe(16)
    expect(right.length).toBe(16)
    expect(straight.curve).toBeCloseTo(0, 9)
    expect(left.curve).toBeGreaterThan(0)
    expect(right.curve).toBeLessThan(0)
  })

  it('勾配は自動なら終点の地面に合わせ、指定すればその勾配で伸びる', () => {
    const g = graphWith()
    const head: TrackEnd = { seg: null as never, atEnd: true, x: 0, y: 0, z: 0, yaw: 0 }
    // 12 m 先が 0.24 m 高い坂（2 %）。自動ならそこへ乗るように登る
    // （始端の高さ 0 は地面と同じなので、路盤の厚みぶんが上乗せされる）
    const slope: GroundFn = (_x, z) => -z * 0.02
    const auto = planFrom(g, head, [0, 0, -6], slope, 'rail', 12).seg
    expect(auto.rise).toBeCloseTo(0.24 + DECK_T, 6)
    expect(Math.abs(auto.rise / auto.length)).toBeLessThanOrEqual(TRACK_INFO.rail.maxGrade)

    // 指定すればその勾配（上限まで）
    const down = planFrom(g, head, [0, 0, -6], slope, 'rail', 12, -0.04).seg
    expect(down.rise / down.length).toBeCloseTo(-0.04, 9)
    const level = planFrom(g, head, [0, 0, -6], slope, 'rail', 12, 0).seg
    expect(level.rise).toBe(0)
  })

  it('家にぶつかる区間は手前で止まり、理由が分かる', () => {
    const g = graphWith()
    const head: TrackEnd = { seg: null as never, atEnd: true, x: 0, y: 0, z: 0, yaw: 0 }
    // 進行方向（-z）の 10 m 先に建物の壁
    const wall: Collider = { minX: -4, maxX: 4, minY: -1, maxY: 4, minZ: -11, maxZ: -10 }
    const plan = planFrom(g, head, [0, 0, -6], flat, 'rail', 20, null, [wall])
    expect(plan.check).toBe('ok')
    expect(plan.trim).toBe('blocked')
    expect(plan.wanted).toBe(20)
    expect(plan.seg.length).toBeLessThan(10)
    expect(plan.seg.length).toBeGreaterThanOrEqual(MIN_SEG_LEN)
    // 壁がすぐ目の前なら、そもそも敷けない
    const near: Collider = { minX: -4, maxX: 4, minY: -1, maxY: 4, minZ: -3, maxZ: -2 }
    expect(planFrom(g, head, [0, 0, -6], flat, 'rail', 20, null, [near]).check).toBe('blocked')
  })

  it('地面にぶつかって切り詰めたときも理由が分かる', () => {
    const g = graphWith()
    const cliff: GroundFn = (_x, z) => (z < -8 ? 20 : 0)
    const plan = planFrom(g, null, [0, 0, 0], cliff, 'rail', 20)
    expect(plan.check).toBe('ok')
    expect(plan.trim).toBe('buried')
    expect(plan.wanted).toBe(20)
    expect(plan.seg.length).toBeLessThan(20)
    // 平らなところなら切り詰めない
    expect(planFrom(g, null, [40, 0, 40], flat, 'rail', 20).trim).toBe('none')
  })

  it('道路は線路より小回りが利き、急坂も登れる', () => {
    const g = graphWith()
    const head: TrackEnd = { seg: null as never, atEnd: true, x: 0, y: 0, z: 0, yaw: 0 }
    const rail = planFrom(g, head, [-9, 3, -9], flat, 'rail', 20).seg
    const road = planFrom(g, head, [-9, 3, -9], flat, 'road', 20).seg
    expect(Math.abs(road.curve)).toBeGreaterThan(Math.abs(rail.curve))
    // 同じ勾配を指定しても、上限が違うので道路のほうが急に登れる
    const railUp = planFrom(g, head, [-9, 3, -9], flat, 'rail', 20, 0.3).seg
    const roadUp = planFrom(g, head, [-9, 3, -9], flat, 'road', 20, 0.3).seg
    expect(railUp.rise / railUp.length).toBeCloseTo(TRACK_INFO.rail.maxGrade, 9)
    expect(roadUp.rise / roadUp.length).toBeCloseTo(TRACK_INFO.road.maxGrade, 9)
  })
})

describe('当たり判定の受け渡しと保存', () => {
  it('collectColliders は out を空にせず追記する', () => {
    const g = graphWith()
    g.place(planFrom(g, null, [0, 0, 0]).seg)
    const out: Collider[] = [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }]
    g.collectColliders(0, -3, 2, out)
    expect(out.length).toBeGreaterThan(1)
  })

  it('撤去すると区間も当たり判定も消える', () => {
    const g = graphWith()
    g.place(planFrom(g, null, [0, 0, 0]).seg)
    const seg = [...g.segments()][0]
    expect(g.colliderCount).toBeGreaterThan(0)
    expect(g.remove(seg)).toBe(seg)
    expect(g.count).toBe(0)
    expect(g.colliderCount).toBe(0)
  })

  it('保存して読み直すと同じ軌道になる', () => {
    const g = graphWith()
    g.place(planFrom(g, null, [0, 0, 0]).seg)
    const head = g.nearestEnd(...(segmentEnd([...g.segments()][0]).slice(0, 3) as [
      number,
      number,
      number,
    ]), 2, 'rail')
    g.place(planFrom(g, head, [-6, 1, -20]).seg)

    const data = g.serialize()
    const back = new TrackGraph()
    back.load(data)
    expect(back.count).toBe(g.count)
    expect(back.serialize().sort()).toEqual(data.sort())
  })

  it('壊れた保存データは 1 件ずつ捨てる', () => {
    const g = graphWith()
    g.load([99, 0, 0, 0, 0, 0, 10, 0, 2, 0, 0, 0, 0, 0, 0, 10, 0, 2])
    expect(g.count).toBe(1)
    g.load('nonsense')
    expect(g.count).toBe(0)
  })
})
