import { BUILD_CELL } from '../build/pieces'
import { SEA_LEVEL, VILLAGE_CELL } from './constants'
import { mulberry32, smoothstep } from './noise'

export type { Box } from './collision'

export type BuildingKind = 'house' | 'hall' | 'shed' | 'well' | 'tower'

/**
 * 村の建物 1 棟の**間取り**。
 *
 * 壁や屋根そのものはここには入っていない。建物は
 * {@link import('../build/villagePieces').buildingPieces} が
 * **プレイヤーが使うのと同じ建築パーツ**へ展開する。
 * だから寸法は自由な実数ではなく、パーツの基準寸法 {@link BUILD_CELL} の
 * **セル数**で持つ（`cw` × `cd` マス、壁は `levels` 段）。
 */
export interface Building {
  kind: BuildingKind
  /** 建物の中心（ワールド）。 */
  x: number
  z: number
  /** 間口・奥行きのマス数。1 マス = {@link BUILD_CELL} m。 */
  cw: number
  cd: number
  /** 積んだ壁の段数。1 段 = {@link BUILD_CELL} m。 */
  levels: number
  /** x 方向の全幅・z 方向の全奥行き（m）。`cw`/`cd` から決まる。 */
  w: number
  d: number
  /** 壁の高さ（m）。`levels` から決まる。 */
  wallH: number
  /** 0:+x 1:-x 2:+z 3:-z のどの面にドアを開けるか。 */
  doorSide: number
  /** 屋根の棟が x 方向に走るか。棟と直交する側は必ず 2 マス。 */
  ridgeAlongX: boolean
  palette: number
  /** 窓の open/閉じや家具の並べ方を決める種。建物ごとに固定。 */
  seed: number
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

function cellRandom(vx: number, vz: number, seed: number): () => number {
  let h = (Math.imul(vx, 374761393) + Math.imul(vz, 668265263) + Math.imul(seed, 2246822519)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return mulberry32((h ^ (h >>> 16)) >>> 0)
}

/**
 * 間取りを 1 つ組み立てる。棟と直交する側を 2 マスに固定しているのは、
 * 屋根パーツが 1 マスで 1 マスぶん昇る（45°）ので、**2 マスあれば
 * 左右の斜面がちょうど真ん中で棟を作る**ため。
 */
function makeBuilding(
  kind: BuildingKind,
  x: number,
  z: number,
  along: number,
  levels: number,
  ridgeAlongX: boolean,
  doorSide: number,
  palette: number,
  seed: number,
): Building {
  // 屋根を載せる建物は、棟と直交する側が必ず 2 マス（屋根パーツ 2 枚で棟ができる）。
  // 井戸には屋根が無いので `along` 四方のまま
  const cw = kind === 'well' ? along : ridgeAlongX ? along : 2
  const cd = kind === 'well' ? along : ridgeAlongX ? 2 : along
  return {
    kind,
    x,
    z,
    cw,
    cd,
    levels,
    w: cw * BUILD_CELL,
    d: cd * BUILD_CELL,
    wallH: levels * BUILD_CELL,
    doorSide,
    ridgeAlongX,
    palette,
    seed,
  }
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

  // パーツで組むと 1 棟が 6〜12 m になるので、敷地は以前より広く取る
  const radius = 54 + rand() * 22
  const buildings: Building[] = []
  const paths: Array<[number, number, number, number]> = []

  // 中央の井戸（1 マスの囲いと、桶を吊るす柱と梁）
  buildings.push(makeBuilding('well', cx, cz, 1, 0, true, 0, 0, (rand() * 2 ** 30) >>> 0))

  const count = 7 + Math.floor(rand() * 6)
  for (let i = 0; i < count; i++) {
    const ang = (i / count) * Math.PI * 2 + (rand() - 0.5) * 0.55
    const dist = radius * 0.30 + rand() * radius * 0.34
    const bx = cx + Math.cos(ang) * dist
    const bz = cz + Math.sin(ang) * dist

    const roll = rand()
    const kind: BuildingKind = roll < 0.14 ? 'hall' : roll < 0.30 ? 'shed' : 'house'
    let along: number
    let levels: number
    if (kind === 'hall') {
      along = 3 + Math.floor(rand() * 2)
      levels = 2 // 仕切りの無い 6 m の大広間
    } else if (kind === 'shed') {
      along = 2
      levels = 1
    } else {
      along = 2 + Math.floor(rand() * 2)
      levels = rand() < 0.45 ? 2 : 1 // 2 段なら中に床と階段が入る
    }
    const ridgeAlongX = rand() < 0.5

    // 既存の建物と重ならないように
    const w = (ridgeAlongX ? along : 2) * BUILD_CELL
    const d = (ridgeAlongX ? 2 : along) * BUILD_CELL
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

    buildings.push(
      makeBuilding(
        kind,
        bx,
        bz,
        along,
        levels,
        ridgeAlongX,
        doorSide,
        Math.floor(rand() * 4),
        (rand() * 2 ** 30) >>> 0,
      ),
    )
    paths.push([cx, cz, bx, bz])
  }

  // 見張り台。2 段の壁の上が手すり付きの露台になる
  if (rand() < 0.7) {
    const ang = rand() * Math.PI * 2
    const bx = cx + Math.cos(ang) * radius * 0.66
    const bz = cz + Math.sin(ang) * radius * 0.66
    const dx = cx - bx
    const dz = cz - bz
    const doorSide = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 0 : 1) : dz > 0 ? 2 : 3
    buildings.push(
      makeBuilding('tower', bx, bz, 2, 2, true, doorSide, 2, (rand() * 2 ** 30) >>> 0),
    )
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
