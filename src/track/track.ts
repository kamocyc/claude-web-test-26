import type { Box } from '../world/village'
import { colliderBounds } from '../world/collision'
import type { Collider } from '../world/collision'

/**
 * 敷ける軌道の種類。線路（rail）と道路（road）で寸法と制限だけが違い、
 * 幾何・接続・当たり判定の規則はまったく同じものを共有する。
 */
export const TRACK_KINDS = ['rail', 'road'] as const

export type TrackKind = (typeof TRACK_KINDS)[number]

export interface TrackSpec {
  readonly name: string
  /** 歩ける面の幅（m）。 */
  readonly width: number
  /** 最小曲線半径（m）。これより急には曲げられない。 */
  readonly minRadius: number
  /** 最大勾配（1 = 45°）。 */
  readonly maxGrade: number
  /** 1 m 敷くのに要る材料（地形の素材と同じ「体積」）。 */
  readonly costPerMeter: number
}

/**
 * 種類ごとの寸法。建築の {@link BUILD_CELL} が 3 m である実寸スケールに合わせてある。
 * 線路は曲がれず登れず、道路は小回りが利いて急坂も登れる。
 */
export const TRACK_INFO: Record<TrackKind, TrackSpec> = {
  rail: { name: '線路', width: 3, minRadius: 15, maxGrade: 0.06, costPerMeter: 4 },
  road: { name: '道路', width: 5, minRadius: 8, maxGrade: 0.15, costPerMeter: 5 },
}

/** 当たり判定と描画のサンプル間隔（m）。 */
export const SAMPLE_STEP = 1.2

/** デッキ（路盤）の厚み（m）。中心線の高さが天面。 */
export const DECK_T = 0.35

/** 1 区間の長さの下限・上限・既定（m）。ホイールで変える。 */
export const MIN_SEG_LEN = 4
export const MAX_SEG_LEN = 24
export const DEFAULT_SEG_LEN = 12

/** これ未満の曲率は直線として扱う（1/R が 1 km 相当）。 */
const STRAIGHT_EPS = 1e-3

/**
 * 敷いた軌道 1 区間。
 *
 * 格子には乗らず、**平面では円弧・縦断では一定勾配**の帯として持つ。
 * 建築パーツ（{@link Piece}）と違ってヨーは 5° 刻みではなく連続値で、これは
 * 「前の区間の終端の向きをそのまま次の区間の始端にする」ため。丸めを挟むと
 * 継ぎ目に折れ目が出てしまう。
 *
 * 進行方向の規約は `Player.step` と同じで、ヨー θ の前方は `(-sinθ, -cosθ)`、
 * 右は `(cosθ, -sinθ)`。
 */
export interface Segment {
  kind: TrackKind
  /** 始点（軌道中心線・デッキ天面）。 */
  x: number
  y: number
  z: number
  /** 始端の進行方向（ラジアン）。 */
  yaw: number
  /** 曲率 1/R（符号つき。正で左へ曲がる。0 は直線）。 */
  curve: number
  /** 水平弧長（m）。 */
  length: number
  /** 終点までの高さ差（m）。 */
  rise: number
  /** 素材 ID（地形と共通）。 */
  mat: number
}

/** 円弧の解（曲率と弧長）。 */
export interface ArcFit {
  curve: number
  length: number
}

/** ヨー θ の前方ベクトル。 */
export function forwardX(yaw: number): number {
  return -Math.sin(yaw)
}

export function forwardZ(yaw: number): number {
  return -Math.cos(yaw)
}

/** -π..π に畳む。向きの差を測るときに使う。 */
export function normalizeAngle(a: number): number {
  let v = a
  while (v > Math.PI) v -= Math.PI * 2
  while (v < -Math.PI) v += Math.PI * 2
  return v
}

/**
 * 弧長 `s` の点と、そこでの進行方向。`out` に `[x, y, z, yaw]` を詰めて返す。
 *
 * `dP/ds = 前方(yaw + curve·s)` を積分したもの:
 * `x(s) = x + (cos(θ(s)) − cos(yaw)) / curve`、`z(s) = z − (sin(θ(s)) − sin(yaw)) / curve`。
 * 曲率が 0 に近いところでは 0 割になるので直線の式に落とす。
 */
export function pointAt(seg: Segment, s: number, out: number[] = []): number[] {
  const k = seg.curve
  const theta = seg.yaw + k * s
  if (Math.abs(k) < STRAIGHT_EPS) {
    out[0] = seg.x + forwardX(seg.yaw) * s
    out[2] = seg.z + forwardZ(seg.yaw) * s
  } else {
    out[0] = seg.x + (Math.cos(theta) - Math.cos(seg.yaw)) / k
    out[2] = seg.z - (Math.sin(theta) - Math.sin(seg.yaw)) / k
  }
  out[1] = seg.y + (seg.length > 0 ? (seg.rise * s) / seg.length : 0)
  out[3] = theta
  return out
}

/** 終点と終端の向き（`[x, y, z, yaw]`）。 */
export function segmentEnd(seg: Segment, out: number[] = []): number[] {
  return pointAt(seg, seg.length, out)
}

/**
 * 始点（`sx, sz`）と始端の向き（`syaw`）から、狙点（`tx, tz`）を通る円弧を解く。
 *
 * 始点を原点・前方を u 軸・右を v 軸とする局所座標へ移すと、曲率 k の弧は
 * `u = sin(φ)/k`、`v = (cos(φ) − 1)/k`（φ = k·s）を描く。ここから
 * `k = −2v / (u² + v²)`、`φ = atan2(u·k, 1 + v·k)` が出る。
 *
 * 狙点が後ろでも円は 1 つに決まる（180° 以上回り込む弧になる）ので、そのまま解く。
 * 曲率は呼び出し側が最小半径でクランプするので、振り返って狙えば
 * **曲がれる限界で回り込む**。真後ろ（横ずれが無い）のときだけ円が決まらないので、
 * 長さ 0 の直線を返してその場に留める。
 */
export function solveArc(
  sx: number,
  sz: number,
  syaw: number,
  tx: number,
  tz: number,
): ArcFit {
  const dx = tx - sx
  const dz = tz - sz
  const sin = Math.sin(syaw)
  const cos = Math.cos(syaw)
  // 前方成分と右成分
  const u = -dx * sin - dz * cos
  const v = dx * cos - dz * sin
  const d2 = u * u + v * v
  if (d2 < 1e-9) return { curve: 0, length: 0 }
  if (Math.abs(v) < 1e-6) return { curve: 0, length: Math.max(0, u) }

  const k = (-2 * v) / d2
  if (Math.abs(k) < STRAIGHT_EPS) return { curve: 0, length: u }

  let phi = Math.atan2(u * k, 1 + v * k)
  // atan2 は -π..π しか返さないので、進行方向（k と同じ符号）へ向き直す
  if (phi * k < 0) phi += Math.sign(k) * Math.PI * 2
  return { curve: k, length: phi / k }
}

/** 曲率を最小半径まで、弧長を `[MIN_SEG_LEN, maxLen]` に収める。 */
export function clampFit(kind: TrackKind, fit: ArcFit, maxLen: number): ArcFit {
  const maxCurve = 1 / TRACK_INFO[kind].minRadius
  const curve = Math.max(-maxCurve, Math.min(maxCurve, fit.curve))
  const hi = Math.max(MIN_SEG_LEN, Math.min(MAX_SEG_LEN, maxLen))
  const length = Math.max(MIN_SEG_LEN, Math.min(hi, fit.length))
  return { curve, length }
}

/** 高さ差を最大勾配に収める。 */
export function clampRise(kind: TrackKind, rise: number, length: number): number {
  const max = TRACK_INFO[kind].maxGrade * length
  return Math.max(-max, Math.min(max, rise))
}

/** 勾配（1 = 45°）。 */
export function grade(seg: Segment): number {
  return seg.length > 0 ? seg.rise / seg.length : 0
}

/** 曲線半径（m）。直線は Infinity。 */
export function radius(seg: Segment): number {
  return Math.abs(seg.curve) < STRAIGHT_EPS ? Infinity : 1 / Math.abs(seg.curve)
}

/** 弧長方向の分割数。分割の 1 つが {@link SAMPLE_STEP} を超えないようにする。 */
export function sampleCount(seg: Segment): number {
  return Math.max(1, Math.ceil(seg.length / SAMPLE_STEP))
}

/**
 * 区間を等間隔に刻んだ点列（`[x, y, z, yaw, …]` の平坦配列）。
 * 端を含むので要素数は `分割数 + 1` 個ぶん。描画も当たり判定もここから作る。
 */
export function sampleSegment(seg: Segment, out: number[] = []): number[] {
  out.length = 0
  const n = sampleCount(seg)
  const ds = seg.length / n
  for (let i = 0; i <= n; i++) {
    pointAt(seg, ds * i, PT)
    out.push(PT[0], PT[1], PT[2], PT[3])
  }
  return out
}

/**
 * デッキの当たり判定。刻みごとに**回転を持つ箱**（{@link Collider}）を 1 個出す。
 *
 * `localToWorld` の規約から局所 +x は右、局所 +z は後ろなので、
 * x が幅方向、z が進行方向になる。天面は中心線の高さそのもので、
 * 隣り合う箱の段差は最大勾配 × 刻み幅（線路 7 cm・道路 18 cm）と
 * `Player` が乗り上げられる 0.6 m を大きく下回る。だから敷いた軌道はそのまま歩ける。
 */
export function segmentColliders(seg: Segment, out: Collider[] = []): Collider[] {
  out.length = 0
  const half = TRACK_INFO[seg.kind].width / 2
  const n = sampleCount(seg)
  const ds = seg.length / n
  // 弧の外側に僅かな隙間ができないよう、進行方向だけ少し伸ばして重ねる
  const halfLen = (ds / 2) * 1.05
  for (let i = 0; i < n; i++) {
    pointAt(seg, ds * (i + 0.5), PT)
    out.push({
      minX: -half,
      minY: PT[1] - DECK_T,
      minZ: -halfLen,
      maxX: half,
      maxY: PT[1],
      maxZ: halfLen,
      ox: PT[0],
      oz: PT[2],
      cos: Math.cos(PT[3]),
      sin: Math.sin(PT[3]),
    })
  }
  return out
}

/** 区間全体のワールド外接箱。空間索引と粗い足切りに使う。 */
export function segmentBounds(seg: Segment, out: Box = emptyBox()): Box {
  const cols = segmentColliders(seg, BOUNDS_SCRATCH)
  out.minX = Infinity
  out.minY = Infinity
  out.minZ = Infinity
  out.maxX = -Infinity
  out.maxY = -Infinity
  out.maxZ = -Infinity
  for (const c of cols) {
    const b = colliderBounds(c, BOX_SCRATCH)
    if (b.minX < out.minX) out.minX = b.minX
    if (b.minY < out.minY) out.minY = b.minY
    if (b.minZ < out.minZ) out.minZ = b.minZ
    if (b.maxX > out.maxX) out.maxX = b.maxX
    if (b.maxY > out.maxY) out.maxY = b.maxY
    if (b.maxZ > out.maxZ) out.maxZ = b.maxZ
  }
  return out
}

/** 1 区間の材料。長さに比例する（撤去すると全額戻る）。 */
export function segmentCost(seg: Segment): number {
  return Math.max(1, Math.round(seg.length * TRACK_INFO[seg.kind].costPerMeter))
}

const PT = [0, 0, 0, 0]
const BOUNDS_SCRATCH: Collider[] = []
const BOX_SCRATCH = emptyBox()

function emptyBox(): Box {
  return { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 }
}
