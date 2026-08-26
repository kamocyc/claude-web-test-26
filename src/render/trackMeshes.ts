import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { quadFacing } from './geoUtil'
import { DECK_T, TRACK_INFO, pointAt, sampleSegment } from '../track/track'
import type { Segment } from '../track/track'

/** 軌間（レール中心の間隔、m）。 */
const GAUGE = 1.5
/** レール頭頂までの高さと、レールの半幅（m）。 */
const RAIL_TOP = 0.16
const RAIL_BOTTOM = 0.02
const RAIL_HALF = 0.07
/** 枕木の間隔（m）。 */
const TIE_SPACING = 1.2
/** 橋脚の間隔（m）と柱の半径（m）。 */
const PILLAR_SPACING = 3
const PILLAR_HALF = 0.22
/** 橋脚を立て始める地面との差（m）。 */
const PILLAR_MIN = 0.3

/** レールの鋼色。素材が何であれレールはこの色で描く。 */
export const railMaterial = new THREE.MeshStandardMaterial({
  color: 0xb4bcc6,
  roughness: 0.42,
  metalness: 0.25,
})

/** 道路の中央線。 */
export const laneMaterial = new THREE.MeshStandardMaterial({
  color: 0xe8e2cf,
  roughness: 0.8,
  metalness: 0,
})

export interface TrackGeometry {
  /** 素材の色で描く部分（路盤・枕木・橋脚）。 */
  body: THREE.BufferGeometry
  /** 常に同じ色で描く部分（レール、道路の中央線）。無ければ null。 */
  accent: THREE.BufferGeometry | null
}

/**
 * 区間 1 本のジオメトリ。
 *
 * 当たり判定（{@link segmentColliders}）と同じ刻みの点列から作るので、
 * **見えている面と歩ける面が必ず一致する**。地面が路盤より低いところには
 * 橋脚（トレッスル）を自動で立てて、宙に浮いて見えないようにする。
 */
export function buildTrackGeometry(
  seg: Segment,
  ground: (x: number, z: number) => number,
): TrackGeometry {
  const info = TRACK_INFO[seg.kind]
  const half = info.width / 2
  const pts = sampleSegment(seg)

  const body: number[] = []
  const accent: number[] = []

  // 路盤。底面を少し広げて土手のように見せる
  ribbon(body, pts, half, half + 0.4, 0, -DECK_T, 0)

  if (seg.kind === 'rail') {
    // 枕木は路盤の天面にわずかに顔を出す程度（歩く面は路盤の天面のまま）
    forEachStation(seg, TIE_SPACING, (x, y, z, yaw) => {
      boxAt(body, x, y, z, yaw, half * 0.85, 0.13, -0.16, 0.03)
    })
    ribbon(accent, pts, RAIL_HALF, RAIL_HALF, RAIL_TOP, RAIL_BOTTOM, -GAUGE / 2)
    ribbon(accent, pts, RAIL_HALF, RAIL_HALF, RAIL_TOP, RAIL_BOTTOM, GAUGE / 2)
  } else {
    // 縁石と、4 m ごとの中央線
    ribbon(body, pts, 0.2, 0.2, 0.12, -0.02, -(half - 0.2))
    ribbon(body, pts, 0.2, 0.2, 0.12, -0.02, half - 0.2)
    forEachStation(seg, 4, (x, y, z, yaw) => {
      boxAt(accent, x, y, z, yaw, 0.14, 0.9, 0.0, 0.03)
    })
  }

  // 橋脚
  forEachStation(seg, PILLAR_SPACING, (x, y, z, yaw) => {
    const deck = y - DECK_T
    const g = ground(x, z)
    if (deck - g < PILLAR_MIN) return
    const top = deck + 0.05
    const foot = g - 0.6
    for (const side of [-1, 1]) {
      const px = x + Math.cos(yaw) * side * half * 0.6
      const pz = z - Math.sin(yaw) * side * half * 0.6
      boxAt(body, px, 0, pz, yaw, PILLAR_HALF, PILLAR_HALF, foot, top)
    }
    // 柱の頭をつなぐ横木
    boxAt(body, x, 0, z, yaw, half * 0.8, PILLAR_HALF * 0.8, top - 0.3, top)
  })

  return { body: geometryFrom(body), accent: accent.length > 0 ? geometryFrom(accent) : null }
}

/** 複数の区間のジオメトリを 1 本にまとめる。空なら null。 */
export function mergeTrackGeometries(parts: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (parts.length === 0) return null
  const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false)
  if (parts.length > 1) for (const p of parts) p.dispose()
  merged?.computeBoundingSphere()
  return merged
}

/**
 * 点列に沿って角柱の帯を張る。
 *
 * `halfTop`/`halfBottom` は天面と底面の半幅（違えると台形になる）、
 * `top`/`bottom` は中心線からの高さ、`offset` は横方向のずらし量（レールや縁石に使う）。
 * ヨー θ の右は `(cosθ, -sinθ)`。
 */
function ribbon(
  out: number[],
  pts: number[],
  halfTop: number,
  halfBottom: number,
  top: number,
  bottom: number,
  offset: number,
): void {
  const n = pts.length / 4
  if (n < 2) return
  // 各断面の 4 隅（左上・右上・右下・左下）
  const corners: number[] = []
  const rights: number[] = []
  for (let i = 0; i < n; i++) {
    const x = pts[i * 4]
    const y = pts[i * 4 + 1]
    const z = pts[i * 4 + 2]
    const yaw = pts[i * 4 + 3]
    const rx = Math.cos(yaw)
    const rz = -Math.sin(yaw)
    rights.push(rx, rz)
    const cx = x + rx * offset
    const cz = z + rz * offset
    corners.push(
      cx - rx * halfTop, y + top, cz - rz * halfTop,
      cx + rx * halfTop, y + top, cz + rz * halfTop,
      cx + rx * halfBottom, y + bottom, cz + rz * halfBottom,
      cx - rx * halfBottom, y + bottom, cz - rz * halfBottom,
    )
  }
  const at = (i: number, c: number): [number, number, number] => [
    corners[(i * 4 + c) * 3],
    corners[(i * 4 + c) * 3 + 1],
    corners[(i * 4 + c) * 3 + 2],
  ]
  for (let i = 0; i < n - 1; i++) {
    const rx = rights[i * 2]
    const rz = rights[i * 2 + 1]
    face(out, [0, 1, 0], at(i, 0), at(i, 1), at(i + 1, 1), at(i + 1, 0)) // 天面
    face(out, [0, -1, 0], at(i, 3), at(i, 2), at(i + 1, 2), at(i + 1, 3)) // 底面
    face(out, [-rx, 0, -rz], at(i, 0), at(i, 3), at(i + 1, 3), at(i + 1, 0)) // 左
    face(out, [rx, 0, rz], at(i, 1), at(i, 2), at(i + 1, 2), at(i + 1, 1)) // 右
  }
  // 前後の小口
  const f0 = [Math.sin(pts[3]), 0, Math.cos(pts[3])] as [number, number, number]
  const fn = [-Math.sin(pts[(n - 1) * 4 + 3]), 0, -Math.cos(pts[(n - 1) * 4 + 3])] as [
    number,
    number,
    number,
  ]
  face(out, f0, at(0, 0), at(0, 1), at(0, 2), at(0, 3))
  face(out, fn, at(n - 1, 0), at(n - 1, 1), at(n - 1, 2), at(n - 1, 3))
}

/** ヨーに沿って向いた箱（枕木・橋脚・中央線）。y は中心線からの相対。 */
function boxAt(
  out: number[],
  x: number,
  y: number,
  z: number,
  yaw: number,
  halfWidth: number,
  halfLength: number,
  y0: number,
  y1: number,
): void {
  const rx = Math.cos(yaw)
  const rz = -Math.sin(yaw)
  // 前方 = (-sinθ, -cosθ)
  const fx = -Math.sin(yaw)
  const fz = -Math.cos(yaw)
  const corner = (sw: number, sl: number, yy: number): [number, number, number] => [
    x + rx * halfWidth * sw + fx * halfLength * sl,
    y + yy,
    z + rz * halfWidth * sw + fz * halfLength * sl,
  ]
  const a = corner(-1, -1, y1)
  const b = corner(1, -1, y1)
  const c = corner(1, 1, y1)
  const d = corner(-1, 1, y1)
  const a2 = corner(-1, -1, y0)
  const b2 = corner(1, -1, y0)
  const c2 = corner(1, 1, y0)
  const d2 = corner(-1, 1, y0)
  face(out, [0, 1, 0], a, b, c, d)
  face(out, [0, -1, 0], a2, b2, c2, d2)
  face(out, [rx, 0, rz], b, c, c2, b2)
  face(out, [-rx, 0, -rz], a, d, d2, a2)
  face(out, [fx, 0, fz], d, c, c2, d2)
  face(out, [-fx, 0, -fz], a, b, b2, a2)
}

/** 区間を等間隔に歩いて、各点で処理する（端は含み、間隔は詰めて割り切る）。 */
function forEachStation(
  seg: Segment,
  spacing: number,
  fn: (x: number, y: number, z: number, yaw: number) => void,
): void {
  const n = Math.max(1, Math.round(seg.length / spacing))
  const ds = seg.length / n
  for (let i = 0; i <= n; i++) {
    pointAt(seg, ds * i, PT)
    fn(PT[0], PT[1], PT[2], PT[3])
  }
}

type Pt = [number, number, number]

function face(out: number[], hint: Pt, a: Pt, b: Pt, c: Pt, d: Pt): void {
  quadFacing(
    out,
    hint[0], hint[1], hint[2],
    a[0], a[1], a[2],
    b[0], b[1], b[2],
    c[0], c[1], c[2],
    d[0], d[1], d[2],
  )
}

function geometryFrom(v: number[]): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(v), 3))
  geo.computeVertexNormals()
  return geo
}

const PT = [0, 0, 0, 0]
