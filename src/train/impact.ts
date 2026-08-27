import {
  CAB_BACK,
  CAB_HALF_LEN,
  CAB_HALF_W,
  CAR_H,
  CAR_LEN,
  CAR_W,
  HOOD_TOP,
  MAX_SPEED,
  ROOF_TOP,
} from './trains'
import type { Collider } from '../world/collision'

/**
 * 列車の当たり判定と、はねられたときの扱い（three 非依存）。
 *
 * 車体は**回転を持つ箱 2 つ**として置く。前半（台枠とボイラー）は低く、
 * 運転台だけが高い。こうすると見た目どおりの高さに立てて、
 * ボイラーの上から運転台の屋根へはよじ登れない（0.8 m の段差は
 * `Player.BOX_STEP` を超えるので、跳ばないと乗れない）。
 *
 * 押しのけと乗り上げは既存の箱の仕組み（`Player.resolveBoxes` /
 * `MobManager.resolveBoxes`）にそのまま任せ、こちらは
 * **走っている車体に轢かれたか**の判定だけを持つ。
 */

/** ぶつかったと見なす最低速度（m/s）。これ以下の列車はただの障害物。 */
export const HIT_SPEED = 2

/** 屋根に乗っている扱いにする余裕（m）。足がこれより上なら轢かれない。 */
export const ROOF_TOL = 0.3

/** ダメージ。`HIT_SPEED` のときが下限、最高速のときが上限。 */
export const HIT_DAMAGE_MIN = 5
export const HIT_DAMAGE_MAX = 18

/** はね飛ばす速さ（水平）と、持ち上げる速さ（m/s）。 */
export const KNOCK_MIN = 8
export const KNOCK_MAX = 20
export const KNOCK_LIFT = 8

/**
 * 真正面ではねられたときに、横へ寄せる量。
 *
 * 進行方向へ真っ直ぐ飛ばすと線路の上に落ちて、追いついた列車にまた轢かれる。
 * 少し横へ逸らしておくと 1 回で軌道の外まで飛ぶ。
 */
const SIDE_BIAS = 0.6

/** はねられた結果。 */
export interface Impact {
  /** はね飛ばす向き（水平の単位ベクトル）。 */
  nx: number
  nz: number
  /** 水平にはね飛ばす速さと、持ち上げる速さ（m/s）。 */
  push: number
  lift: number
  damage: number
}

/**
 * 車体の当たり判定を `out` に**詰め直して**返す（`[前半, 運転台]` の 2 つ）。
 *
 * `pos` は {@link Train.pos}（レール天面の中心と向き）。
 */
export function carColliders(pos: readonly number[], out: Collider[] = []): Collider[] {
  out.length = 0
  const cos = Math.cos(pos[3])
  const sin = Math.sin(pos[3])
  // 前半。台枠とボイラーぶんの高さしかないので、ここに立つと腰の高さ
  out.push({
    ox: pos[0],
    oz: pos[2],
    cos,
    sin,
    minX: -CAR_W / 2,
    maxX: CAR_W / 2,
    minZ: -CAR_LEN / 2,
    maxZ: CAR_LEN / 2,
    minY: pos[1],
    maxY: pos[1] + HOOD_TOP,
  })
  // 運転台。屋根のてっぺんまで
  out.push({
    ox: pos[0],
    oz: pos[2],
    cos,
    sin,
    minX: -CAB_HALF_W,
    maxX: CAB_HALF_W,
    minZ: CAB_BACK - CAB_HALF_LEN,
    maxZ: CAB_BACK + CAB_HALF_LEN,
    minY: pos[1],
    maxY: pos[1] + ROOF_TOP,
  })
  return out
}

/** 車体のその位置（ローカル座標）での天面の高さ（レール天面から）。 */
export function carTop(lx: number, lz: number, grow = 0): number {
  const inCab =
    Math.abs(lx) < CAB_HALF_W + grow && Math.abs(lz - CAB_BACK) < CAB_HALF_LEN + grow
  return inCab ? ROOF_TOP : HOOD_TOP
}

/**
 * 走っている車体が、そこに立っている者（プレイヤーか MOB）を轢いたか。
 *
 * 轢かないのは 3 つ。**遅い**（`HIT_SPEED` 未満）、**屋根の上に乗っている**、
 * **車体より下にいる**（橋の下をくぐっている）。
 *
 * はね飛ぶ向きは当たった場所で決まる。先頭に当たれば前へ突き飛ばされ、
 * 横に当たれば線路の外へ払われる。
 */
export function trainImpact(
  pos: readonly number[],
  speed: number,
  x: number,
  y: number,
  z: number,
  radius: number,
  height: number,
  out: Impact = { nx: 0, nz: 0, push: 0, lift: 0, damage: 0 },
): Impact | null {
  if (!(speed >= HIT_SPEED)) return null

  const cos = Math.cos(pos[3])
  const sin = Math.sin(pos[3])
  // ワールド → 車体ローカル（右が +x、後ろが +z）
  const dx = x - pos[0]
  const dz = z - pos[2]
  const lx = dx * cos - dz * sin
  const lz = dx * sin + dz * cos

  const halfW = CAR_W / 2 + radius
  const halfL = CAR_LEN / 2 + radius
  if (Math.abs(lx) >= halfW || Math.abs(lz) >= halfL) return null
  // 屋根に乗っているなら轢かない（一緒に運ばれる）
  if (y >= pos[1] + carTop(lx, lz, radius) - ROOF_TOL) return null
  // 車体より下（橋の下）はすり抜ける
  if (y + height <= pos[1]) return null
  if (y >= pos[1] + CAR_H) return null

  const t = Math.min(1, (speed - HIT_SPEED) / (MAX_SPEED - HIT_SPEED))
  out.damage = HIT_DAMAGE_MIN + (HIT_DAMAGE_MAX - HIT_DAMAGE_MIN) * t
  out.push = KNOCK_MIN + (KNOCK_MAX - KNOCK_MIN) * t
  out.lift = KNOCK_LIFT

  // 先端寄りなら前へ、横寄りなら横へ。真正面でも少し横へ逸らす
  let ox = lx / halfW
  let oz = -Math.max(0, -lz / halfL)
  if (Math.abs(ox) < SIDE_BIAS) ox = ox < 0 ? -SIDE_BIAS : SIDE_BIAS
  const len = Math.hypot(ox, oz)
  ox /= len
  oz /= len
  // ローカル → ワールド
  out.nx = ox * cos + oz * sin
  out.nz = -ox * sin + oz * cos
  return out
}
