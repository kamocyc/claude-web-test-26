import { colliderBounds, localToWorld } from '../world/collision'
import type { Box, Collider } from '../world/collision'

/**
 * 建築パーツの基準寸法（m）。
 * 壁 1 枚の幅・床から天井までの階高がこれになる。
 * 格子ではなく**パーツの大きさ**として使う（位置は連続値）。
 */
export const BUILD_CELL = 3

/** 壁・床・屋根の厚み（m）。 */
export const PANEL_T = 0.3

/**
 * 階段の段数。1 段 0.5 m で、`Player.resolveBoxes` が乗り越えられる 0.6 m より低い。
 * ここを増やすと登れなくなるので、段の高さが 0.6 m を超えない範囲で決めること。
 */
export const STAIR_STEPS = 6

/** 屋根の当たり判定を階段状に近似する段数。細かいほど歩いたときの上下動が小さい。 */
export const ROOF_STEPS = 12

/** 戸口の開口。半幅と高さ（m）。プレイヤーの半径 0.38 に対して余裕を取る。 */
export const DOOR_HALF_W = 0.7
export const DOOR_H = 2.2

/** 窓のガラス面の半サイズ（m）。 */
export const WINDOW_HALF = 0.8

/** 柱・梁の断面の半径（m）。角材なので一辺は倍の 0.34。 */
export const POST_R = 0.17

/** 柵（手すり）の高さと厚みの半分（m）。 */
export const FENCE_H = 1.1
export const FENCE_T = 0.07

/** 妻壁（三角の壁）の当たり判定を階段状に近似する段数。屋根と同じ刻みにしてある。 */
export const GABLE_STEPS = ROOF_STEPS

/** ヨーの刻み数。360° / 72 = 5°。 */
export const YAW_STEPS = 72

/** ヨー 1 刻みのラジアン。 */
export const YAW_STEP = (Math.PI * 2) / YAW_STEPS

/**
 * パーツの種類。
 *
 * **並び順は保存データの ID そのもの**なので、新しい種類は必ず末尾に足すこと
 * （`BuildGrid.serialize` が `PIECE_KINDS.indexOf` を書き出している）。
 * 前半が躯体、後半が内装。
 */
export const PIECE_KINDS = [
  'wall',
  'window',
  'door',
  'floor',
  'stair',
  'roof',
  'block',
  'gable',
  'pillar',
  'beam',
  'fence',
  'bed',
  'chest',
  'table',
  'chair',
  'shelf',
] as const

export type PieceKind = (typeof PIECE_KINDS)[number]

export const PIECE_NAME: Record<PieceKind, string> = {
  wall: '壁',
  window: '窓',
  door: '戸口',
  floor: '床',
  stair: '階段',
  roof: '屋根',
  block: 'ブロック',
  gable: '妻壁',
  pillar: '柱',
  beam: '梁',
  fence: '柵',
  bed: 'ベッド',
  chest: 'チェスト',
  table: 'テーブル',
  chair: '椅子',
  shelf: '棚',
}

/**
 * 1 枚あたりの材料。単位は地形の素材と同じ「体積」（掘ると固体 → 空になった格子点の数）。
 * だいたい実体積に合わせてあるので、掘った量と建てられる量の釣り合いが崩れない。
 */
export const PIECE_COST: Record<PieceKind, number> = {
  wall: 4,
  window: 4,
  door: 4,
  floor: 4,
  stair: 14,
  roof: 5,
  block: 27,
  gable: 2,
  pillar: 1,
  beam: 1,
  fence: 1,
  // 家具はどれも 1 m³ に満たない。体積どおりだと 0 になってしまうので 1〜2 に丸める
  bed: 2,
  chest: 1,
  table: 1,
  chair: 1,
  shelf: 1,
}

/**
 * 置いた建築パーツ 1 枚。
 *
 * 格子には乗らず、**基準点は連続座標**で持つ。基準点はパーツの局所座標の原点で、
 * 描画のジオメトリのアンカーと当たり判定の原点を兼ねる（壁は面の中心、
 * 床・階段・屋根・ブロックは底面の中心）。
 *
 * `yaw` は Y 軸まわりの回転を **5° 刻みの整数 0..71** で持つ。度やラジアンではなく
 * 整数にしてあるので、保存が正確で、「同じ向きか」を誤差なしで比べられる。
 * これが接続点スナップで隣り合うパーツがぴたりと噛み合うことの根拠になる。
 */
export interface Piece {
  kind: PieceKind
  x: number
  y: number
  z: number
  yaw: number
  /** 素材 ID（`MAT_PLANK` など）。地形の素材 ID をそのまま使う。 */
  mat: number
}

/** 壁・窓・戸口は面に立つ「板」。 */
export function isPanel(kind: PieceKind): boolean {
  return kind === 'wall' || kind === 'window' || kind === 'door'
}

/** 0..71 に丸める。 */
export function normalizeYaw(yaw: number): number {
  return ((Math.round(yaw) % YAW_STEPS) + YAW_STEPS) % YAW_STEPS
}

/** ヨー（0..71）→ ラジアン。 */
export function yawRad(yaw: number): number {
  return yaw * YAW_STEP
}

/** ラジアン → 最寄りのヨー（0..71）。 */
export function yawFromRad(rad: number): number {
  return normalizeYaw(rad / YAW_STEP)
}

/** 表示用の度数（0..355）。 */
export function yawDeg(yaw: number): number {
  return normalizeYaw(yaw) * 5
}

/**
 * 局所座標（基準点が原点、回転前）での当たり判定の箱。
 * 描画のジオメトリもこの寸法から作るので、見た目と当たり判定は必ず一致する
 * （屋根だけは滑らかな斜面を描き、判定は {@link ROOF_STEPS} 段の階段で近似する）。
 */
export function localBoxes(kind: PieceKind): Box[] {
  const C = BUILD_CELL
  const h = C / 2
  const t = PANEL_T / 2

  switch (kind) {
    case 'wall':
    case 'window':
      // 窓もガラスが嵌まっているので通り抜けられない
      return [{ minX: -t, minY: -h, minZ: -h, maxX: t, maxY: h, maxZ: h }]

    case 'door': {
      const w = DOOR_HALF_W
      const top = -h + DOOR_H
      return [
        { minX: -t, minY: -h, minZ: -h, maxX: t, maxY: h, maxZ: -w },
        { minX: -t, minY: -h, minZ: w, maxX: t, maxY: h, maxZ: h },
        { minX: -t, minY: top, minZ: -w, maxX: t, maxY: h, maxZ: w },
      ]
    }

    case 'floor':
      return [{ minX: -h, minY: 0, minZ: -h, maxX: h, maxY: PANEL_T, maxZ: h }]

    case 'block':
      return [{ minX: -h, minY: 0, minZ: -h, maxX: h, maxY: C, maxZ: h }]

    case 'stair': {
      // +x 側へ昇る中身の詰まった階段。段の重なりが無いので描画にもそのまま使える
      const d = C / STAIR_STEPS
      const out: Box[] = []
      for (let i = 0; i < STAIR_STEPS; i++) {
        out.push({
          minX: -h + i * d,
          minY: 0,
          minZ: -h,
          maxX: -h + (i + 1) * d,
          maxY: (i + 1) * d,
          maxZ: h,
        })
      }
      return out
    }

    case 'roof': {
      // +x 側へ昇る薄板。上は歩け、下は空洞
      const d = C / ROOF_STEPS
      const out: Box[] = []
      for (let i = 0; i < ROOF_STEPS; i++) {
        const top = (i + 1) * d
        out.push({
          minX: -h + i * d,
          minY: top - PANEL_T - d,
          minZ: -h,
          maxX: -h + (i + 1) * d,
          maxY: top,
          maxZ: h,
        })
      }
      return out
    }

    case 'gable': {
      // 屋根の妻を塞ぐ直角三角形の壁。面は x = 0、+z 側が棟（高さ C）。
      // 屋根と同じ 45° なので、屋根パーツの下にぴたりと収まる
      const d = C / GABLE_STEPS
      const out: Box[] = []
      for (let i = 0; i < GABLE_STEPS; i++) {
        out.push({
          minX: -t,
          minY: 0,
          minZ: -h + i * d,
          maxX: t,
          maxY: (i + 1) * d,
          maxZ: -h + (i + 1) * d,
        })
      }
      return out
    }

    case 'pillar':
      return [{ minX: -POST_R, minY: 0, minZ: -POST_R, maxX: POST_R, maxY: C, maxZ: POST_R }]

    case 'beam':
      // 局所 x 方向へ 1 マス渡す横材
      return [{ minX: -h, minY: 0, minZ: -POST_R, maxX: h, maxY: POST_R * 2, maxZ: POST_R }]

    case 'fence':
      // 見た目は柱と横桟だが、当たり判定は 1 枚の薄い板にまとめる。
      // 桟の隙間に体が挟まる（＝すり抜ける）のを避けるため
      return [{ minX: -FENCE_T, minY: 0, minZ: -h, maxX: FENCE_T, maxY: FENCE_H, maxZ: h }]

    // ---- 内装。どれも底面の中心が基準点で、正面は局所 +x 側 ----

    case 'bed': {
      const out: Box[] = []
      for (const sx of [-0.88, 0.88]) {
        for (const sz of [-0.38, 0.38]) {
          out.push({ minX: sx - 0.06, minY: 0, minZ: sz - 0.06, maxX: sx + 0.06, maxY: 0.25, maxZ: sz + 0.06 })
        }
      }
      out.push({ minX: -1, minY: 0.25, minZ: -0.5, maxX: 1, maxY: 0.5, maxZ: 0.5 })
      out.push({ minX: -1, minY: 0.5, minZ: -0.5, maxX: -0.85, maxY: 1, maxZ: 0.5 }) // 頭板
      out.push({ minX: 0.85, minY: 0.5, minZ: -0.5, maxX: 1, maxY: 0.72, maxZ: 0.5 }) // 足板
      // ここから先は布（別マテリアル）
      out.push({ minX: -0.85, minY: 0.5, minZ: -0.48, maxX: 0.85, maxY: 0.72, maxZ: 0.48 })
      out.push({ minX: -0.82, minY: 0.72, minZ: -0.34, maxX: -0.45, maxY: 0.84, maxZ: 0.34 })
      return out
    }

    case 'chest':
      return [
        { minX: -0.32, minY: 0, minZ: -0.45, maxX: 0.32, maxY: 0.55, maxZ: 0.45 },
        { minX: -0.32, minY: 0.55, minZ: -0.45, maxX: 0.32, maxY: 0.72, maxZ: 0.45 },
        // ここから先は鉄の帯（別マテリアル）
        { minX: -0.34, minY: 0, minZ: -0.28, maxX: 0.34, maxY: 0.74, maxZ: -0.18 },
        { minX: -0.34, minY: 0, minZ: 0.18, maxX: 0.34, maxY: 0.74, maxZ: 0.28 },
        { minX: 0.32, minY: 0.44, minZ: -0.08, maxX: 0.37, maxY: 0.62, maxZ: 0.08 },
      ]

    case 'table': {
      const out: Box[] = [{ minX: -0.8, minY: 0.68, minZ: -0.5, maxX: 0.8, maxY: 0.78, maxZ: 0.5 }]
      for (const sx of [-0.68, 0.68]) {
        for (const sz of [-0.38, 0.38]) {
          out.push({ minX: sx - 0.06, minY: 0, minZ: sz - 0.06, maxX: sx + 0.06, maxY: 0.68, maxZ: sz + 0.06 })
        }
      }
      return out
    }

    case 'chair': {
      const out: Box[] = [
        { minX: -0.24, minY: 0.42, minZ: -0.24, maxX: 0.24, maxY: 0.5, maxZ: 0.24 },
        { minX: -0.24, minY: 0.5, minZ: -0.24, maxX: -0.16, maxY: 0.95, maxZ: 0.24 },
      ]
      for (const sx of [-0.18, 0.18]) {
        for (const sz of [-0.18, 0.18]) {
          out.push({ minX: sx - 0.04, minY: 0, minZ: sz - 0.04, maxX: sx + 0.04, maxY: 0.42, maxZ: sz + 0.04 })
        }
      }
      return out
    }

    case 'shelf': {
      const out: Box[] = [
        { minX: -0.2, minY: 0, minZ: -0.6, maxX: -0.12, maxY: 1.8, maxZ: 0.6 }, // 背板
        { minX: -0.2, minY: 0, minZ: -0.6, maxX: 0.2, maxY: 1.8, maxZ: -0.52 },
        { minX: -0.2, minY: 0, minZ: 0.52, maxX: 0.2, maxY: 1.8, maxZ: 0.6 },
        { minX: -0.2, minY: 1.72, minZ: -0.52, maxX: 0.2, maxY: 1.8, maxZ: 0.52 },
        { minX: -0.2, minY: 0, minZ: -0.52, maxX: 0.2, maxY: 0.08, maxZ: 0.52 },
      ]
      for (const y of [0.5, 0.95, 1.35]) {
        out.push({ minX: -0.12, minY: y, minZ: -0.52, maxX: 0.2, maxY: y + 0.06, maxZ: 0.52 })
      }
      return out
    }
  }
}

/**
 * {@link localBoxes} のうち、ここから先が**差し色のマテリアル**で描かれる箱の番号。
 * ベッドの布、チェストの鉄帯のように、1 つのパーツで 2 色使いたいときに使う。
 * 差し色が無いパーツは箱の数（＝全部が主素材）を返す。
 */
export function accentStart(kind: PieceKind): number {
  if (kind === 'bed') return 7
  if (kind === 'chest') return 2
  return localBoxes(kind).length
}

/** 局所座標での外接箱。 */
export function localBounds(kind: PieceKind): Box {
  const boxes = localBoxes(kind)
  const out = { ...boxes[0] }
  for (const b of boxes) {
    if (b.minX < out.minX) out.minX = b.minX
    if (b.minY < out.minY) out.minY = b.minY
    if (b.minZ < out.minZ) out.minZ = b.minZ
    if (b.maxX > out.maxX) out.maxX = b.maxX
    if (b.maxY > out.maxY) out.maxY = b.maxY
    if (b.maxZ > out.maxZ) out.maxZ = b.maxZ
  }
  return out
}

/**
 * ワールドでの当たり判定。x/z はローカルのまま、回転の中心と cos/sin を添えて返す
 * （{@link Collider} を参照）。`out` に詰めて返す。
 */
export function pieceColliders(p: Piece, out: Collider[] = []): Collider[] {
  out.length = 0
  const rad = yawRad(p.yaw)
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  for (const b of localBoxes(p.kind)) {
    out.push({
      minX: b.minX,
      minY: p.y + b.minY,
      minZ: b.minZ,
      maxX: b.maxX,
      maxY: p.y + b.maxY,
      maxZ: b.maxZ,
      ox: p.x,
      oz: p.z,
      cos,
      sin,
    })
  }
  return out
}

/** 回転を含めたワールドの外接箱。空間索引と粗い足切りに使う。 */
export function pieceBounds(p: Piece, out: Box = EMPTY_BOX()): Box {
  const local = localBounds(p.kind)
  const rad = yawRad(p.yaw)
  return colliderBounds(
    {
      minX: local.minX,
      minY: p.y + local.minY,
      minZ: local.minZ,
      maxX: local.maxX,
      maxY: p.y + local.maxY,
      maxZ: local.maxZ,
      ox: p.x,
      oz: p.z,
      cos: Math.cos(rad),
      sin: Math.sin(rad),
    },
    out,
  )
}

/** パーツの中心（ワールド）。スナップ候補の採点に使う。 */
export function pieceCenter(p: Piece, out: number[] = []): number[] {
  const local = localBounds(p.kind)
  const rad = yawRad(p.yaw)
  localToWorld(
    { ...local, ox: p.x, oz: p.z, cos: Math.cos(rad), sin: Math.sin(rad) },
    (local.minX + local.maxX) / 2,
    (local.minZ + local.maxZ) / 2,
    PAIR,
  )
  out[0] = PAIR[0]
  out[1] = p.y + (local.minY + local.maxY) / 2
  out[2] = PAIR[1]
  return out
}

/**
 * 接続点（局所座標、`[x, y, z, …]` の平坦配列）。
 *
 * 置くときは「既存パーツの接続点」と「これから置くパーツの接続点」を一致させるので、
 * **隣り合うパーツは必ず隙間なく噛み合う**。辺の中点があることで
 * 「床のこの辺に壁を立てる」が一発で決まる。
 */
export function snapPoints(kind: PieceKind): number[] {
  const C = BUILD_CELL
  const h = C / 2
  const T = PANEL_T

  if (isPanel(kind)) {
    // 面（x = 0）の 4 隅と 4 辺の中点
    return [
      0, -h, -h, 0, -h, h, 0, h, -h, 0, h, h,
      0, -h, 0, 0, h, 0, 0, 0, -h, 0, 0, h,
    ]
  }

  switch (kind) {
    case 'floor':
      // 上面と下面の 4 隅・4 辺中点。上面の辺中点が「その辺に壁を立てる」に効く
      return [
        -h, 0, -h, -h, 0, h, h, 0, -h, h, 0, h,
        0, 0, -h, 0, 0, h, -h, 0, 0, h, 0, 0,
        -h, T, -h, -h, T, h, h, T, -h, h, T, h,
        0, T, -h, 0, T, h, -h, T, 0, h, T, 0,
      ]

    case 'block':
      // 8 隅と 6 面の中心
      return [
        -h, 0, -h, -h, 0, h, h, 0, -h, h, 0, h,
        -h, C, -h, -h, C, h, h, C, -h, h, C, h,
        0, 0, 0, 0, C, 0,
        -h, h, 0, h, h, 0, 0, h, -h, 0, h, h,
      ]

    case 'stair':
      // 昇り口（-x 側）の辺と、昇りきった先（+x 側の上端）の辺
      return [-h, 0, -h, -h, 0, h, -h, 0, 0, h, 0, -h, h, 0, h, h, C, -h, h, C, h, h, C, 0]

    case 'roof':
      // 軒（-x 側）と棟（+x 側）
      return [-h, 0, -h, -h, 0, h, -h, 0, 0, h, C, -h, h, C, h, h, C, 0]

    case 'gable':
      // 底辺（軒桁に乗る辺）と、棟側の垂直な辺
      return [0, 0, -h, 0, 0, h, 0, 0, 0, 0, C, h, 0, C / 2, h, 0, C / 2, 0]

    case 'pillar':
      // 上下の中心と、上下の 4 隅。隅があるので壁の下端の角にも噛む
      return [
        0, 0, 0, 0, C, 0, 0, C / 2, 0,
        -POST_R, 0, -POST_R, POST_R, 0, -POST_R, -POST_R, 0, POST_R, POST_R, 0, POST_R,
        -POST_R, C, -POST_R, POST_R, C, -POST_R, -POST_R, C, POST_R, POST_R, C, POST_R,
      ]

    case 'beam': {
      const T = POST_R * 2
      // 両端と中央、その上面
      return [-h, 0, 0, h, 0, 0, 0, 0, 0, -h, T, 0, h, T, 0, 0, T, 0]
    }

    case 'fence':
      // 面の下辺・上辺の両端と中点
      return [
        0, 0, -h, 0, 0, h, 0, 0, 0,
        0, FENCE_H, -h, 0, FENCE_H, h, 0, FENCE_H, 0,
      ]
  }

  // 内装は「底面の 4 隅・4 辺の中点・中心」と「上面の中心」。
  // 床の上面の接続点にそのまま噛むので、部屋の中へ迷いなく置ける
  return footprintPoints(kind)
}

/** 底面の 4 隅・4 辺の中点・中心と、上面の中心。 */
function footprintPoints(kind: PieceKind): number[] {
  const b = localBounds(kind)
  const x0 = b.minX
  const x1 = b.maxX
  const z0 = b.minZ
  const z1 = b.maxZ
  const cx = (x0 + x1) / 2
  const cz = (z0 + z1) / 2
  const y = b.minY
  return [
    x0, y, z0, x1, y, z0, x0, y, z1, x1, y, z1,
    cx, y, z0, cx, y, z1, x0, y, cz, x1, y, cz,
    cx, y, cz, cx, b.maxY, cz,
  ]
}

function EMPTY_BOX(): Box {
  return { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 }
}

const PAIR = [0, 0]
