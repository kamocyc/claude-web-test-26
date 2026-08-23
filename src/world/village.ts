import { SEA_LEVEL, VILLAGE_CELL } from './constants'
import { mulberry32, smoothstep } from './noise'

export interface Box {
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
}

export type BuildingKind = 'house' | 'hall' | 'shed' | 'well' | 'tower'

export interface Building {
  kind: BuildingKind
  x: number
  z: number
  /** x 方向の全幅・z 方向の全奥行き（回転は 90 度単位なので AABB のまま扱える）。 */
  w: number
  d: number
  wallH: number
  roofH: number
  /** 0:+x 1:-x 2:+z 3:-z のどの面にドアを開けるか。 */
  doorSide: number
  /** 屋根の棟が x 方向に走るか。 */
  ridgeAlongX: boolean
  palette: number
}

export interface Village {
  key: number
  cx: number
  cz: number
  radius: number
  /** 村の敷地を平らにする高さ。 */
  platformY: number
  buildings: Building[]
  /** 広場から各建物へ伸びる道（x1, z1, x2, z2）。 */
  paths: Array<[number, number, number, number]>
}

const WALL_T = 0.34
const DOOR_W = 1.5
const DOOR_H = 2.15

function cellRandom(vx: number, vz: number, seed: number): () => number {
  let h = (Math.imul(vx, 374761393) + Math.imul(vz, 668265263) + Math.imul(seed, 2246822519)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return mulberry32((h ^ (h >>> 16)) >>> 0)
}

/**
 * セル (vx, vz) に村があるかを決定論的に判定し、レイアウトまで生成する。
 * 地形の平坦化にも建物の描画にも同じ結果を使うため、純粋関数にしてある。
 */
export function makeVillage(
  vx: number,
  vz: number,
  seed: number,
  baseHeight: (x: number, z: number) => number,
): Village | null {
  const rand = cellRandom(vx, vz, seed)
  if (rand() > 0.62) return null

  // セル内で数か所試す。海や急斜面が多いので 1 回だけだとほとんど village が出ない。
  let cx = 0
  let cz = 0
  let platformY = 0
  let ok = false
  for (let attempt = 0; attempt < 5 && !ok; attempt++) {
    cx = (vx + 0.18 + rand() * 0.64) * VILLAGE_CELL
    cz = (vz + 0.18 + rand() * 0.64) * VILLAGE_CELL
    platformY = baseHeight(cx, cz)
    // 海の中や山の上には作らない
    if (platformY < SEA_LEVEL + 3 || platformY > 84) continue

    // 元の地形が荒すぎる場所は避ける（平坦化が不自然になるため）
    let lo = platformY
    let hi = platformY
    for (const [dx, dz] of PROBE_OFFSETS) {
      const h = baseHeight(cx + dx, cz + dz)
      if (h < lo) lo = h
      if (h > hi) hi = h
    }
    if (hi - lo > 22) continue
    ok = true
  }
  if (!ok) return null

  const radius = 42 + rand() * 20
  const buildings: Building[] = []
  const paths: Array<[number, number, number, number]> = []

  // 中央の井戸
  buildings.push({
    kind: 'well',
    x: cx,
    z: cz,
    w: 2.6,
    d: 2.6,
    wallH: 1.1,
    roofH: 1.3,
    doorSide: 0,
    ridgeAlongX: true,
    palette: 0,
  })

  const count = 6 + Math.floor(rand() * 6)
  for (let i = 0; i < count; i++) {
    const ang = (i / count) * Math.PI * 2 + (rand() - 0.5) * 0.55
    const dist = radius * 0.32 + rand() * radius * 0.30
    const bx = cx + Math.cos(ang) * dist
    const bz = cz + Math.sin(ang) * dist

    const roll = rand()
    const kind: BuildingKind = roll < 0.12 ? 'hall' : roll < 0.26 ? 'shed' : 'house'
    let w: number
    let d: number
    let wallH: number
    if (kind === 'hall') {
      w = 9 + rand() * 3
      d = 6.5 + rand() * 2
      wallH = 4.2
    } else if (kind === 'shed') {
      w = 4 + rand() * 1.5
      d = 3.4 + rand() * 1.2
      wallH = 2.5
    } else {
      w = 5.5 + rand() * 2.5
      d = 4.8 + rand() * 2
      wallH = 3.1 + rand() * 0.7
    }
    if (rand() < 0.5) {
      const t = w
      w = d
      d = t
    }

    // 既存の建物と重ならないように
    let clash = false
    for (const other of buildings) {
      const need = (Math.max(w, d) + Math.max(other.w, other.d)) * 0.5 + 3
      if (Math.hypot(bx - other.x, bz - other.z) < need) {
        clash = true
        break
      }
    }
    if (clash) continue

    // 広場の側にドアを向ける
    const dx = cx - bx
    const dz = cz - bz
    const doorSide = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 0 : 1) : dz > 0 ? 2 : 3

    buildings.push({
      kind,
      x: bx,
      z: bz,
      w,
      d,
      wallH,
      roofH: 1.6 + rand() * 1.3,
      doorSide,
      ridgeAlongX: w >= d,
      palette: Math.floor(rand() * 4),
    })
    paths.push([cx, cz, bx, bz])
  }

  // 見張り台
  if (rand() < 0.7) {
    const ang = rand() * Math.PI * 2
    const bx = cx + Math.cos(ang) * radius * 0.64
    const bz = cz + Math.sin(ang) * radius * 0.64
    buildings.push({
      kind: 'tower',
      x: bx,
      z: bz,
      w: 3.2,
      d: 3.2,
      wallH: 7.5,
      roofH: 1.8,
      doorSide: 0,
      ridgeAlongX: true,
      palette: 2,
    })
    paths.push([cx, cz, bx, bz])
  }

  return { key: villageKey(vx, vz), cx, cz, radius, platformY, buildings, paths }
}

const PROBE_OFFSETS: Array<[number, number]> = [
  [-32, 0],
  [32, 0],
  [0, -32],
  [0, 32],
  [-23, -23],
  [23, 23],
  [-23, 23],
  [23, -23],
]

export function villageKey(vx: number, vz: number): number {
  return vx * 100003 + vz
}

/**
 * 敷地の平坦化の強さ（0..1）。
 * 内側 0.70r は完全に平ら、そこから 1.15r まで滑らかに元の地形へ戻す。
 */
export function flattenWeight(v: Village, x: number, z: number): number {
  const dist = Math.hypot(x - v.cx, z - v.cz)
  return smoothstep(v.radius * 1.15, v.radius * 0.7, dist)
}

/** 平坦化が届く最大距離。チャンクの読み込み判定などに使う。 */
export function flattenReach(v: Village): number {
  return v.radius * 1.15
}

/** 広場と道の上にいる度合い（0..1）。地面を土に塗るのに使う。 */
export function pathWeight(v: Village, x: number, z: number): number {
  let t = smoothstep(9.5, 4.5, Math.hypot(x - v.cx, z - v.cz))
  for (let i = 0; i < v.paths.length; i++) {
    const p = v.paths[i]
    t = Math.max(t, smoothstep(2.8, 1.2, distanceToSegment(x, z, p[0], p[1], p[2], p[3])))
  }
  // 建物の下は道にしない
  return t
}

function distanceToSegment(
  px: number,
  pz: number,
  x1: number,
  z1: number,
  x2: number,
  z2: number,
): number {
  const dx = x2 - x1
  const dz = z2 - z1
  const len2 = dx * dx + dz * dz
  if (len2 < 1e-6) return Math.hypot(px - x1, pz - z1)
  let t = ((px - x1) * dx + (pz - z1) * dz) / len2
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return Math.hypot(px - (x1 + dx * t), pz - (z1 + dz * t))
}

/**
 * 建物の壁を軸平行ボックスに分解する。ドアの部分は開口として抜く。
 * 描画も物理もこの同じ配列を使うので、見た目と当たり判定が必ず一致する。
 */
export function buildingBoxes(b: Building, baseY: number): Box[] {
  const out: Box[] = []
  const hw = b.w / 2
  const hd = b.d / 2
  const y0 = baseY
  const y1 = baseY + b.wallH

  if (b.kind === 'well') {
    // 井戸：低い石囲いを 4 枚
    const r = hw
    push(out, b.x - r, y0, b.z - r, b.x + r, y0 + b.wallH, b.z - r + 0.3)
    push(out, b.x - r, y0, b.z + r - 0.3, b.x + r, y0 + b.wallH, b.z + r)
    push(out, b.x - r, y0, b.z - r, b.x - r + 0.3, y0 + b.wallH, b.z + r)
    push(out, b.x + r - 0.3, y0, b.z - r, b.x + r, y0 + b.wallH, b.z + r)
    return out
  }

  // 0:+x 1:-x 2:+z 3:-z
  addWall(out, b, 0, b.x + hw - WALL_T, b.x + hw, b.z - hd, b.z + hd, y0, y1, false)
  addWall(out, b, 1, b.x - hw, b.x - hw + WALL_T, b.z - hd, b.z + hd, y0, y1, false)
  addWall(out, b, 2, b.x - hw, b.x + hw, b.z + hd - WALL_T, b.z + hd, y0, y1, true)
  addWall(out, b, 3, b.x - hw, b.x + hw, b.z - hd, b.z - hd + WALL_T, y0, y1, true)
  return out
}

function addWall(
  out: Box[],
  b: Building,
  side: number,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
  y0: number,
  y1: number,
  alongX: boolean,
): void {
  const hasDoor = b.doorSide === side && b.kind !== 'tower'
  if (!hasDoor) {
    push(out, minX, y0, minZ, maxX, y1, maxZ)
    return
  }
  const doorY = Math.min(y0 + DOOR_H, y1)
  if (alongX) {
    const c = b.x
    push(out, minX, y0, minZ, c - DOOR_W / 2, y1, maxZ)
    push(out, c + DOOR_W / 2, y0, minZ, maxX, y1, maxZ)
    if (doorY < y1) push(out, c - DOOR_W / 2, doorY, minZ, c + DOOR_W / 2, y1, maxZ)
  } else {
    const c = b.z
    push(out, minX, y0, minZ, maxX, y1, c - DOOR_W / 2)
    push(out, minX, y0, c + DOOR_W / 2, maxX, y1, maxZ)
    if (doorY < y1) push(out, minX, doorY, c - DOOR_W / 2, maxX, y1, c + DOOR_W / 2)
  }
}

function push(
  out: Box[],
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): void {
  out.push({ minX, minY, minZ, maxX, maxY, maxZ })
}
