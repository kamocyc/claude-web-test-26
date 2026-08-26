import { pathLength, pathPoint } from './network'
import type { Leg } from './network'

/** 駅 1 つの材料。 */
export const STATION_COST = 60

/** 列車 1 編成の材料。 */
export const TRAIN_COST = 240

/** 駅どうしをこれより近くには置けない（m）。 */
export const STATION_MIN_GAP = 12

/** ホームの長さ・幅・高さ（m）。 */
export const PLATFORM_LEN = 10
export const PLATFORM_W = 3
export const PLATFORM_H = 0.9

/** 車体の長さ・幅・高さ（m）。 */
export const CAR_LEN = 7
export const CAR_W = 2.6
export const CAR_H = 2.4

/** 最高速度（m/s）と、加速・減速（m/s²）。 */
export const MAX_SPEED = 13
export const ACCEL = 3.2
export const BRAKE = 3.6

/** 駅での停車時間（秒）。 */
export const DWELL = 4

/** 発車前の間（秒）。走り出す前に一拍おく。 */
const START_DWELL = 1.2

/** 経路が見つからないときに、探し直すまでの間（秒）。 */
const RETRY = 1.5

/** 駅。線路の上の 1 点として持ち、位置から区間を引き直せるようにしておく。 */
export interface Station {
  /** 線路の中心線上（デッキ天面）の位置。 */
  x: number
  y: number
  z: number
  /** 素材 ID。ホームの色になる。 */
  mat: number
}

/** 駅から駅への道順を引く関数。繋がっていなければ null。 */
export type Resolve = (from: Station, to: Station) => Leg[] | null

/**
 * 路線を 1 編成が往復する列車。
 *
 * 選んだ駅を順に辿り、終点まで行ったら向きを変えて戻ってくる
 * （最後にもう一度始発駅を選んでおけば、そのまま環状に回る）。
 * 経路は**停車のたびに引き直す**ので、途中の線路を敷き替えても次の発車から反映される。
 * 三次元の描画は持たず、位置と向きだけを返す。
 */
export class Train {
  legs: Leg[] = []
  total = 0
  traveled = 0
  speed = 0
  /** いま出発した駅の、路線内での位置。 */
  hop = 0
  /** 路線を辿る向き。終点で反転する。 */
  dir: 1 | -1 = 1
  dwell = START_DWELL
  /** 経路が見つからない（線路が繋がっていない）。 */
  stuck = false
  /** 位置と向き `[x, y, z, yaw]`。 */
  readonly pos = [0, 0, 0, 0]

  private retry = 0

  constructor(
    readonly route: number[],
    readonly mat: number,
  ) {}

  /** 次に向かう駅の、路線内での位置。 */
  get nextHop(): number {
    return this.hop + this.dir
  }

  /** 走行中か（停車中・立ち往生中は false）。 */
  get running(): boolean {
    return this.legs.length > 0 && this.dwell <= 0 && !this.stuck
  }

  update(dt: number, stations: readonly Station[], resolve: Resolve): void {
    if (this.route.length < 2) {
      this.stuck = true
      return
    }

    if (this.legs.length === 0) {
      if (this.stuck) {
        this.retry -= dt
        if (this.retry > 0) return
      }
      this.plan(stations, resolve)
      if (this.stuck) return
    }

    if (this.dwell > 0) {
      this.dwell -= dt
      return
    }

    // 残りの距離でちょうど止まれる速さを上限にする（駅の手前で自然に減速する）
    const remaining = Math.max(0, this.total - this.traveled)
    const limit = Math.min(MAX_SPEED, Math.sqrt(2 * BRAKE * remaining))
    const d = limit - this.speed
    this.speed += Math.max(-BRAKE * dt, Math.min(ACCEL * dt, d))
    this.speed = Math.max(0, this.speed)
    this.traveled += this.speed * dt

    if (this.traveled >= this.total - 0.02) {
      // 到着。次の駅へ向き直り、終点なら折り返す
      pathPoint(this.legs, this.total, this.pos)
      this.legs.length = 0
      this.traveled = 0
      this.speed = 0
      this.dwell = DWELL
      this.hop += this.dir
      if (this.hop >= this.route.length - 1) this.dir = -1
      else if (this.hop <= 0) this.dir = 1
      return
    }
    pathPoint(this.legs, this.traveled, this.pos)
  }

  /** いまの駅から次の駅への経路を引く。 */
  private plan(stations: readonly Station[], resolve: Resolve): void {
    const from = stations[this.route[this.hop]]
    const to = stations[this.route[this.nextHop]]
    if (!from || !to) {
      this.stuck = true
      this.retry = RETRY
      return
    }
    const legs = resolve(from, to)
    if (!legs || legs.length === 0) {
      this.stuck = true
      this.retry = RETRY
      // 立ち往生中も駅の上に居させる
      this.pos[0] = from.x
      this.pos[1] = from.y
      this.pos[2] = from.z
      return
    }
    this.stuck = false
    this.legs = legs
    this.total = pathLength(legs)
    this.traveled = 0
    this.speed = 0
    pathPoint(legs, 0, this.pos)
  }
}
