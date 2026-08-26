import { DECK_T, GRADE_TOL, TRACK_INFO, pointAt } from './track'
import type { Segment } from './track'
import type { GroundFn } from './TrackGraph'

/**
 * 切り盛りの刻み（m）。1 コマの中の中心線のふくらみは
 * 最小半径 8 m でも `(刻み/2)² / (2R)` = 4 cm ほどなので、箱で近似して問題ない。
 */
export const GRADE_STEP = 2.4

/** 路盤より外へ広げる幅（m）。切土の壁と盛土の肩が路盤の縁に食い込まないようにする。 */
export const GRADE_MARGIN = 0.4

/** 盛土の根入れ（m）。地面より少し下から積んで、元の地面と縁が切れないようにする。 */
export const FILL_ANCHOR = 0.4

/** これ以下の食い違いは直さない（m）。 */
export const GRADE_MIN = 0.08

/**
 * 切土で路盤の上に空けておく高さ（m）。列車（車体高 2.4 m）が屋根を擦らずに通れる高さ。
 *
 * 削る量そのものは {@link GRADE_TOL} で頭打ちになっている（それより高い地面は
 * そもそも敷けない）ので、ここを高くしても掘りすぎにはならない。空を削るだけで、
 * 路肩に残った出っ張りが消えるぶん見通しが良くなる。
 */
export const CUT_CLEAR = 3

/**
 * 地形をこの形に削る／盛る、という 1 本の指示。
 *
 * 回転を持つ直方体で、`hx` が幅方向・`hz` が進行方向の半サイズ。
 * 向きの規約は {@link Collider} と同じ（局所 +x が右、+z が後ろ）なので、
 * そのまま `orientedBoxBrush` に渡せる。
 */
export interface GradeOp {
  /** `'dig'` = 切土、`'place'` = 盛土。 */
  mode: 'dig' | 'place'
  /** 箱の中心。 */
  x: number
  y: number
  z: number
  yaw: number
  hx: number
  hy: number
  hz: number
  /** 盛土に使う素材（切土では使わない）。 */
  mat: number
}

/**
 * 敷いた区間に合わせて地形を切り盛りする手順を組み立てる（three 非依存）。
 *
 * 目標の面は**路盤の底面**（中心線の {@link DECK_T} 下）。ここに地面をぴたりと
 * 合わせると、路盤が浮きも埋もれもせず地面に載る。
 *
 * - 地面が目標より高ければ、目標から {@link CUT_CLEAR} 上までを削る（切通し）
 * - 地面が目標より低ければ、目標まで積む（築堤）。ただし
 *   {@link GRADE_TOL} より深い谷はそのまま残し、橋脚に任せる
 *
 * 幅方向は中央と両肩の 3 点で地面を見るので、横断勾配のある斜面でも
 * 谷側の肩が宙に浮かない。
 */
export function gradeOps(seg: Segment, ground: GroundFn, out: GradeOp[] = []): GradeOp[] {
  out.length = 0
  if (seg.length <= 0) return out
  const half = TRACK_INFO[seg.kind].width / 2 + GRADE_MARGIN
  const n = Math.max(1, Math.ceil(seg.length / GRADE_STEP))
  const ds = seg.length / n
  // 継ぎ目に削り残しが出ないよう、進行方向だけ少し重ねる
  const hz = (ds / 2) * 1.05

  for (let i = 0; i < n; i++) {
    pointAt(seg, ds * (i + 0.5), PT)
    const x = PT[0]
    const z = PT[2]
    const yaw = PT[3]
    // 路盤の底面。ここに地面を合わせる
    const deck = PT[1] - DECK_T
    // 右 = (cos yaw, -sin yaw)
    const rx = Math.cos(yaw) * half
    const rz = -Math.sin(yaw) * half
    const gc = ground(x, z)
    const gl = ground(x - rx, z - rz)
    const gr = ground(x + rx, z + rz)

    // 切土: 肩まで含めていちばん高いところが路盤より上なら削る
    if (Math.max(gc, gl, gr) > deck + GRADE_MIN) {
      out.push({
        mode: 'dig',
        x,
        y: deck + CUT_CLEAR / 2,
        z,
        yaw,
        hx: half,
        hy: CUT_CLEAR / 2,
        hz,
        mat: seg.mat,
      })
    }

    // 盛土: 中央の地面との差で決める。深すぎる谷は橋脚に任せて積まない
    const fill = deck - gc
    if (fill > GRADE_MIN && fill <= GRADE_TOL) {
      // 肩が低いときはそちらまで届かせる（ただし切り盛りの上限までで止める）
      const foot = Math.max(Math.min(gc, gl, gr), deck - GRADE_TOL) - FILL_ANCHOR
      out.push({
        mode: 'place',
        x,
        y: (foot + deck) / 2,
        z,
        yaw,
        hx: half,
        hy: (deck - foot) / 2,
        hz,
        mat: seg.mat,
      })
    }
  }
  return out
}

const PT = [0, 0, 0, 0]
