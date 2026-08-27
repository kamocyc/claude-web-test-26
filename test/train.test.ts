import { describe, expect, it } from 'vitest'
import { TrackNetwork, pathLength, pathPoint } from '../src/train/network'
import {
  CAB_BACK,
  CAR_H,
  CAR_LEN,
  CAR_W,
  DWELL,
  HOOD_TOP,
  MAX_SPEED,
  ROOF_TOP,
  STATION_MIN_GAP,
  Train,
} from '../src/train/trains'
import type { Station } from '../src/train/trains'
import { HIT_DAMAGE_MAX, HIT_DAMAGE_MIN, HIT_SPEED, carColliders, trainImpact } from '../src/train/impact'
import { buildTrainMesh } from '../src/render/trainMeshes'
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

describe('列車の当たり判定', () => {
  /** ヨー θ、レール天面 y = 10 に置いた車体。 */
  function car(yaw = 0, x = 0, z = 0): number[] {
    return [x, 10, z, yaw]
  }

  it('車体は前半と運転台の 2 つの箱で、運転台だけ屋根まで高い', () => {
    const [hood, cab] = carColliders(car())
    expect(hood.minY).toBe(10)
    expect(hood.maxY).toBeCloseTo(10 + HOOD_TOP, 9)
    expect(hood.minZ).toBeCloseTo(-CAR_LEN / 2, 9)
    expect(hood.maxZ).toBeCloseTo(CAR_LEN / 2, 9)
    expect(hood.maxX - hood.minX).toBeCloseTo(CAR_W, 9)
    // 運転台は後ろ寄りにあり、屋根のぶんだけ高い
    expect(cab.maxY).toBeCloseTo(10 + ROOF_TOP, 9)
    expect(cab.maxY).toBeGreaterThan(hood.maxY)
    expect((cab.minZ + cab.maxZ) / 2).toBeGreaterThan(0)
  })

  it('当たり判定は見た目の車体をちょうど包む', () => {
    // 車体（children[0]）と、屋根・煙突・車輪（children[1]）
    const mesh = buildTrainMesh(MAT_ROCK)
    const extent = (child: unknown) => {
      const pos = (child as { geometry: { attributes: { position: { array: ArrayLike<number> } } } })
        .geometry.attributes.position.array
      const e = { minY: Infinity, maxY: -Infinity, maxX: 0, maxZ: 0 }
      for (let i = 0; i < pos.length; i += 3) {
        e.maxX = Math.max(e.maxX, Math.abs(pos[i]))
        e.minY = Math.min(e.minY, pos[i + 1])
        e.maxY = Math.max(e.maxY, pos[i + 1])
        e.maxZ = Math.max(e.maxZ, Math.abs(pos[i + 2]))
      }
      return e
    }
    const body = extent(mesh.children[0])
    const trim = extent(mesh.children[1])
    // 車体は当たり判定の中に収まる
    expect(body.minY).toBeCloseTo(0.35, 6)
    expect(body.maxY).toBeCloseTo(CAR_H, 6)
    expect(body.maxX).toBeLessThanOrEqual(CAR_W / 2 + 1e-6)
    expect(body.maxZ).toBeLessThanOrEqual(CAR_LEN / 2 + 1e-6)
    // 立てる面は屋根のてっぺん（車輪だけは飾りなので少しはみ出る）
    expect(Math.max(body.maxY, trim.maxY)).toBeCloseTo(ROOF_TOP, 6)
    expect(trim.minY).toBeCloseTo(0, 6)
  })

  it('走っている列車は線路の上のものをはねる', () => {
    const hit = trainImpact(car(), MAX_SPEED, 0, 10, -3, 0.38, 1.78)
    expect(hit).not.toBeNull()
    expect(hit!.damage).toBeCloseTo(HIT_DAMAGE_MAX, 6)
    // 先頭に当たったので、おおむね進行方向（ヨー 0 なら -Z）へ飛ぶ
    expect(hit!.nz).toBeLessThan(-0.7)
    // ただし線路の上に落ちて轢かれ直さないよう、少しは横へ逸れる
    expect(Math.abs(hit!.nx)).toBeGreaterThan(0.1)
    expect(Math.hypot(hit!.nx, hit!.nz)).toBeCloseTo(1, 9)
    expect(hit!.push).toBeGreaterThan(0)
    expect(hit!.lift).toBeGreaterThan(0)
  })

  it('止まっている（遅い）列車ははねない', () => {
    expect(trainImpact(car(), 0, 0, 10, -3, 0.38, 1.78)).toBeNull()
    expect(trainImpact(car(), HIT_SPEED - 0.01, 0, 10, -3, 0.38, 1.78)).toBeNull()
    expect(trainImpact(car(), HIT_SPEED, 0, 10, -3, 0.38, 1.78)).not.toBeNull()
  })

  it('屋根の上に立っているとはねられない', () => {
    // ボイラーの上
    expect(trainImpact(car(), MAX_SPEED, 0, 10 + HOOD_TOP, -3, 0.38, 1.78)).toBeNull()
    // 運転台の屋根の上
    expect(trainImpact(car(), MAX_SPEED, 0, 10 + ROOF_TOP, CAB_BACK, 0.38, 1.78)).toBeNull()
    // 同じ場所でも足が低ければはねられる
    expect(trainImpact(car(), MAX_SPEED, 0, 10, CAB_BACK, 0.38, 1.78)).not.toBeNull()
  })

  it('車体の外や下にいるとはねられない', () => {
    // 横にどく
    expect(trainImpact(car(), MAX_SPEED, CAR_W, 10, 0, 0.38, 1.78)).toBeNull()
    // 前後に離れる
    expect(trainImpact(car(), MAX_SPEED, 0, 10, -CAR_LEN, 0.38, 1.78)).toBeNull()
    // 橋の下をくぐる
    expect(trainImpact(car(), MAX_SPEED, 0, 6, 0, 0.38, 1.78)).toBeNull()
  })

  it('横に当たると線路の外へ払われ、速いほど強く飛ぶ', () => {
    const side = trainImpact(car(), MAX_SPEED, 1.4, 10, 0, 0.38, 1.78)
    expect(side).not.toBeNull()
    // ヨー 0 の右は +X。真横なので前後の成分は無い
    expect(side!.nx).toBeCloseTo(1, 6)
    expect(side!.nz).toBeCloseTo(0, 6)

    const slow = trainImpact(car(), HIT_SPEED, 1.4, 10, 0, 0.38, 1.78)!
    expect(slow.damage).toBeCloseTo(HIT_DAMAGE_MIN, 6)
    expect(slow.damage).toBeLessThan(side!.damage)
    expect(slow.push).toBeLessThan(side!.push)
  })

  it('車体が回っていても、飛ぶ向きは車体から見た向きどおり', () => {
    const yaw = Math.PI / 2
    // ヨー π/2 の前方は -X、右は -Z。前方 3 m・右 0.5 m に立つ
    const hit = trainImpact(car(yaw), MAX_SPEED, -3, 10, -0.5, 0.38, 1.78)
    expect(hit).not.toBeNull()
    // 前方（-X）が主で、当たった側（-Z）へ逸れる
    expect(hit!.nx).toBeLessThan(-0.7)
    expect(hit!.nz).toBeLessThan(-0.1)
  })

  it('走ると 1 フレーム前の位置が残る（屋根の上を運ぶのに使う）', () => {
    const line = straightLine(2, 20)
    const net = new TrackNetwork()
    net.build(line)
    const stations = [station(line[0], 0), station(line[1], 18)]
    const resolve = (a: Station, b: Station) => {
      const p = net.locate(a.x, a.y, a.z, 2)
      const q = net.locate(b.x, b.y, b.z, 2)
      return p && q ? net.path(p, q) : null
    }
    const t = new Train([0, 1], MAT_ROCK)
    for (let i = 0; i < 200; i++) t.update(1 / 60, stations, resolve)
    expect(t.speed).toBeGreaterThan(1)
    const moved = Math.hypot(t.pos[0] - t.prev[0], t.pos[2] - t.prev[2])
    expect(moved).toBeGreaterThan(0)
    expect(moved).toBeCloseTo(t.speed / 60, 2)
  })
})
