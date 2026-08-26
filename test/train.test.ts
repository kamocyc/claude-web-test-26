import { describe, expect, it } from 'vitest'
import { TrackNetwork, pathLength, pathPoint } from '../src/train/network'
import { DWELL, MAX_SPEED, STATION_MIN_GAP, Train } from '../src/train/trains'
import type { Station } from '../src/train/trains'
import { normalizeAngle, segmentEnd } from '../src/track/track'
import type { Segment, TrackKind } from '../src/track/track'
import { MAT_ROCK } from '../src/world/constants'

function seg(
  x: number,
  z: number,
  yaw: number,
  length: number,
  kind: TrackKind = 'rail',
  curve = 0,
): Segment {
  return { kind, x, y: 10, z, yaw, curve, length, rise: 0, mat: MAT_ROCK }
}

/** ヨー 0（-Z 向き）に真っ直ぐ繋いだ n 本の線路。 */
function straightLine(n: number, length = 12): Segment[] {
  const out: Segment[] = []
  let z = 0
  for (let i = 0; i < n; i++) {
    out.push(seg(0, z, 0, length))
    z -= length
  }
  return out
}

function station(s: Segment, at: number): Station {
  const e = [0, 0, 0, 0]
  const p = { ...s, length: at }
  segmentEnd(p, e)
  return { x: e[0], y: e[1], z: e[2], mat: MAT_ROCK }
}

describe('線路の網', () => {
  it('端点が同じ区間どうしは 1 つのノードにまとまる', () => {
    const net = new TrackNetwork()
    net.build(straightLine(3))
    expect(net.segmentCount).toBe(3)
    expect(net.nodeCount).toBe(4)
  })

  it('道路は網に入らない（列車は線路だけを走る）', () => {
    const net = new TrackNetwork()
    net.build([seg(0, 0, 0, 12), seg(20, 0, 0, 12, 'road')])
    expect(net.segmentCount).toBe(1)
  })

  it('いちばん近い線路上の点を返す', () => {
    const net = new TrackNetwork()
    const line = straightLine(2)
    net.build(line)
    const at = net.locate(0.4, 10, -13, 4)
    expect(at).not.toBeNull()
    expect(at!.seg).toBe(line[1])
    expect(at!.s).toBeGreaterThanOrEqual(0)
    expect(net.locate(0, 10, 300, 4)).toBeNull()
  })

  it('繋がった線路をまたいで経路が引ける', () => {
    const net = new TrackNetwork()
    const line = straightLine(3)
    net.build(line)
    const legs = net.path({ seg: line[0], s: 4 }, { seg: line[2], s: 6 })
    expect(legs).not.toBeNull()
    // 4 → 12（8 m）、12 m、6 m
    expect(pathLength(legs!)).toBeCloseTo(8 + 12 + 6, 6)
    const start = pathPoint(legs!, 0)
    const end = pathPoint(legs!, pathLength(legs!))
    expect(start[2]).toBeCloseTo(-4, 6)
    expect(end[2]).toBeCloseTo(-30, 6)
  })

  it('逆向きに辿るときは進行方向を向く', () => {
    const net = new TrackNetwork()
    const line = straightLine(2)
    net.build(line)
    const forward = net.path({ seg: line[0], s: 0 }, { seg: line[1], s: 12 })!
    const back = net.path({ seg: line[1], s: 12 }, { seg: line[0], s: 0 })!
    expect(pathLength(forward)).toBeCloseTo(pathLength(back), 9)
    const fy = pathPoint(forward, 5)[3]
    const by = pathPoint(back, 5)[3]
    expect(Math.abs(normalizeAngle(by - fy - Math.PI))).toBeLessThan(1e-9)
  })

  it('向きが逆に敷かれた区間でも繋がる', () => {
    // 2 本目を終点側から敷いた形（端点は共有している）
    const a = seg(0, 0, 0, 12)
    const b = seg(0, -24, Math.PI, 12)
    const net = new TrackNetwork()
    net.build([a, b])
    expect(net.nodeCount).toBe(3)
    const legs = net.path({ seg: a, s: 0 }, { seg: b, s: 0 })
    expect(legs).not.toBeNull()
    expect(pathLength(legs!)).toBeCloseTo(24, 6)
    expect(pathPoint(legs!, 24)[2]).toBeCloseTo(-24, 6)
  })

  it('繋がっていなければ経路は無い', () => {
    const net = new TrackNetwork()
    const a = seg(0, 0, 0, 12)
    const b = seg(100, 0, 0, 12)
    net.build([a, b])
    expect(net.path({ seg: a, s: 0 }, { seg: b, s: 0 })).toBeNull()
  })
})

describe('列車', () => {
  const line = straightLine(3)
  const net = new TrackNetwork()
  net.build(line)
  const resolve = (from: Station, to: Station) => {
    const a = net.locate(from.x, from.y, from.z, 2)
    const b = net.locate(to.x, to.y, to.z, 2)
    return a && b ? net.path(a, b) : null
  }
  const stations: Station[] = [station(line[0], 0), station(line[2], 12)]

  function run(t: Train, seconds: number): void {
    for (let i = 0; i < Math.round(seconds * 60); i++) t.update(1 / 60, stations, resolve)
  }

  /** 条件が満たされるまで進める（何秒かかるかは加減速の設定次第なので待ち方で書く）。 */
  function runUntil(t: Train, done: () => boolean, maxSeconds = 60): void {
    for (let i = 0; i < Math.round(maxSeconds * 60); i++) {
      if (done()) return
      t.update(1 / 60, stations, resolve)
    }
    throw new Error('列車が条件に届かなかった')
  }

  it('駅から駅へ走り、着いたら止まる', () => {
    const t = new Train([0, 1], MAT_ROCK)
    run(t, 0.1)
    expect(t.pos[2]).toBeCloseTo(0, 3)
    runUntil(t, () => t.hop === 1)
    // 36 m 先の駅にぴたりと止まっている
    expect(t.pos[2]).toBeCloseTo(stations[1].z, 1)
    expect(t.speed).toBe(0)
  })

  it('最高速度を超えず、着く前に減速する', () => {
    const t = new Train([0, 1], MAT_ROCK)
    let top = 0
    let braked = false
    for (let i = 0; i < 60 * 20; i++) {
      t.update(1 / 60, stations, resolve)
      top = Math.max(top, t.speed)
      if (top > 1 && t.speed < top - 0.5) braked = true
    }
    expect(top).toBeLessThanOrEqual(MAX_SPEED + 1e-6)
    expect(braked).toBe(true)
  })

  it('終点に着くと折り返して戻ってくる', () => {
    const t = new Train([0, 1], MAT_ROCK)
    runUntil(t, () => t.hop === 1)
    expect(t.dir).toBe(-1)
    // 停車時間のあいだは動かない
    const held = t.pos[2]
    run(t, DWELL * 0.5)
    expect(t.pos[2]).toBeCloseTo(held, 3)
    runUntil(t, () => t.hop === 0)
    expect(t.pos[2]).toBeCloseTo(stations[0].z, 1)
    expect(t.dir).toBe(1)
  })

  it('線路が繋がっていない路線では立ち往生する', () => {
    const far: Station[] = [stations[0], { x: 500, y: 10, z: 0, mat: MAT_ROCK }]
    const t = new Train([0, 1], MAT_ROCK)
    for (let i = 0; i < 120; i++) t.update(1 / 60, far, resolve)
    expect(t.stuck).toBe(true)
    expect(t.running).toBe(false)
  })

  it('駅が 2 つ未満の路線は走らない', () => {
    const t = new Train([0], MAT_ROCK)
    run(t, 1)
    expect(t.stuck).toBe(true)
  })

  it('駅どうしの最小間隔は車体より長い', () => {
    expect(STATION_MIN_GAP).toBeGreaterThan(7)
  })
})
