/**
 * 照準の勾配。**目の高さを水平の基準**にして、狙っている点がそこから
 * どれだけ上下しているかを測る。
 *
 * 基準を目に取るので、**カメラが完全に水平なら必ず「水平」になる**。
 * 狙点は視線の上にあり、目からの高さの差は「水平距離 × tan(ピッチ)」なので、
 * ピッチが 0 なら差もちょうど 0 になるため。
 *
 * 狙点はブラシの中心ではなく**地面に当たった点**で測る。ブラシの中心は
 * 法線ぶんずらしてあり（掘るなら内側・盛るなら外側）、そのずれの縦成分が
 * 混ざると上の「ピッチ 0 なら水平」が崩れる。
 */

/** これ以下の勾配は「水平」と出す（0.5 % ≒ 0.29°）。 */
export const LEVEL_EPS = 0.005

/** 水平距離がこれより短ければ、勾配ではなく「真上・真下」として扱う。 */
export const VERTICAL_RUN = 0.05

export interface GradeReading {
  /** 目の高さからの高さの差（m）。上が正。 */
  rise: number
  /** 目から狙点までの水平距離（m）。 */
  run: number
  /** 勾配 `rise / run`。ほぼ真上・真下なら ±Infinity。 */
  grade: number
  /** 見上げ角（度）。上が正で −90..90。真上・真下でも値が出る。 */
  degrees: number
  /** 水平とみなせるか。 */
  level: boolean
  /** ほぼ真上・真下か。 */
  vertical: boolean
}

export function emptyGrade(): GradeReading {
  return { rise: 0, run: 0, grade: 0, degrees: 0, level: true, vertical: false }
}

export function readGrade(
  eyeX: number,
  eyeY: number,
  eyeZ: number,
  x: number,
  y: number,
  z: number,
  out: GradeReading = emptyGrade(),
): GradeReading {
  const rise = y - eyeY
  const run = Math.hypot(x - eyeX, z - eyeZ)
  out.rise = rise
  out.run = run
  out.vertical = run < VERTICAL_RUN
  out.grade = out.vertical ? (rise >= 0 ? Infinity : -Infinity) : rise / run
  // 角度は真上・真下でも素直に出る（atan2 の第 2 引数が 0 でも ±90° になる）
  out.degrees = (Math.atan2(rise, run) * 180) / Math.PI
  out.level = !out.vertical && Math.abs(out.grade) <= LEVEL_EPS
  return out
}

/** HUD に出す一行。 */
export function gradeLabel(r: GradeReading): string {
  const drop = `${Math.abs(r.rise).toFixed(2)} m ${r.rise > 0 ? '上' : '下'}`
  if (r.vertical) return `${r.rise >= 0 ? '真上' : '真下'}　${drop}`
  if (r.level) return '水平'
  const dir = r.rise > 0 ? '上り' : '下り'
  return `${dir} ${Math.abs(r.grade * 100).toFixed(1)}%（${Math.abs(r.degrees).toFixed(1)}°）　${drop}`
}
