import type { Box } from '../world/village'

/**
 * 建築グリッドの 1 マス（m）。
 * 壁 1 枚の幅・床から天井までの階高がこれになる。`VOXEL_SIZE = 1` の整数倍なので、
 * 地形を直方体ブラシで削った面とも桁が合う。
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

export const PIECE_KINDS = ['wall', 'window', 'door', 'floor', 'stair', 'roof', 'block'] as const

export type PieceKind = (typeof PIECE_KINDS)[number]

export const PIECE_NAME: Record<PieceKind, string> = {
  wall: '壁',
  window: '窓',
  door: '戸口',
  floor: '床',
  stair: '階段',
  roof: '屋根',
  block: 'ブロック',
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
}

/**
 * 置いた建築パーツ 1 枚。
 *
 * セル座標は整数で、セル (cx, cy, cz) はワールドの
 * `[cx*CELL, cx*CELL+CELL] × …` を占める。
 * `rot` は Y 軸まわりの 90 度刻み。壁族は面の軸（0 = セルの -x 面 / 1 = -z 面）にだけ使い、
 * 床とブロックは無視、階段と屋根は昇る向きに使う。
 */
export interface Piece {
  kind: PieceKind
  cx: number
  cy: number
  cz: number
  rot: number
  /** 素材 ID（`MAT_PLANK` など）。地形の素材 ID をそのまま使う。 */
  mat: number
}

/** 壁・窓・戸口はセルの面に立つ「板」で、同じスロットを取り合う。 */
export function isPanel(kind: PieceKind): boolean {
  return kind === 'wall' || kind === 'window' || kind === 'door'
}

/** 階段・屋根・ブロックはセルの体積を取り合う。 */
export function isVolume(kind: PieceKind): boolean {
  return kind === 'stair' || kind === 'roof' || kind === 'block'
}

/**
 * 占有スロットのキー。
 *
 * 壁は「セルの -x 面 / -z 面」に正規化してあるので、
 * 隣のセルから見た同じ面が別スロットになることはなく、二重置きが起きない。
 */
export function slotKey(p: Piece): string {
  const slot = isPanel(p.kind) ? (p.rot & 1 ? 'wz' : 'wx') : p.kind === 'floor' ? 'f' : 'v'
  return `${slot}|${p.cx},${p.cy},${p.cz}`
}

/** 有効な `rot`（壁族は軸の 2 通り、床とブロックは 0 固定、階段と屋根は 4 通り）。 */
export function normalizeRot(kind: PieceKind, rot: number): number {
  const r = ((rot % 4) + 4) % 4
  if (isPanel(kind)) return r & 1
  if (kind === 'floor' || kind === 'block') return 0
  return r
}

/**
 * パーツの基準点（ワールド座標）。ここを原点として局所座標が定義され、
 * 描画のインスタンス行列も当たり判定もこの点と {@link pieceYaw} から作る。
 */
export function pieceAnchor(p: Piece, out: number[] = []): number[] {
  const C = BUILD_CELL
  if (isPanel(p.kind)) {
    // 板は面の中心に立つ。rot=0 は -x 面、rot=1 は -z 面
    if ((p.rot & 1) === 0) {
      out[0] = p.cx * C
      out[1] = p.cy * C + C / 2
      out[2] = p.cz * C + C / 2
    } else {
      out[0] = p.cx * C + C / 2
      out[1] = p.cy * C + C / 2
      out[2] = p.cz * C
    }
    return out
  }
  // 床・階段・屋根・ブロックはセル底面の中心
  out[0] = p.cx * C + C / 2
  out[1] = p.cy * C
  out[2] = p.cz * C + C / 2
  return out
}

/** 基準点まわりの Y 回転（ラジアン）。 */
export function pieceYaw(p: Piece): number {
  if (isPanel(p.kind)) return (p.rot & 1) * (Math.PI / 2)
  if (p.kind === 'stair' || p.kind === 'roof') return normalizeRot(p.kind, p.rot) * (Math.PI / 2)
  return 0
}

/**
 * ヨー θ = rot × 90°の回転。three の Y 回転に合わせて
 * `x' = x cosθ + z sinθ`, `z' = -x sinθ + z cosθ`。
 * 90 度刻みなので軸平行のまま、当たり判定の AABB が丸まらない。
 */
export function rotXZ(x: number, z: number, rot: number, out: number[] = []): number[] {
  switch (((rot % 4) + 4) % 4) {
    case 1:
      out[0] = z
      out[1] = -x
      break
    case 2:
      out[0] = -x
      out[1] = -z
      break
    case 3:
      out[0] = -z
      out[1] = x
      break
    default:
      out[0] = x
      out[1] = z
  }
  return out
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
  }
}

/** ワールド座標での当たり判定。`out` に詰めて返す。 */
export function pieceBoxes(p: Piece, out: Box[] = []): Box[] {
  out.length = 0
  const anchor = pieceAnchor(p)
  const yaw = isPanel(p.kind) ? 0 : normalizeRot(p.kind, p.rot)
  const a = [0, 0]
  const b = [0, 0]
  for (const box of localBoxes(p.kind)) {
    rotXZ(box.minX, box.minZ, yaw, a)
    rotXZ(box.maxX, box.maxZ, yaw, b)
    out.push({
      minX: anchor[0] + Math.min(a[0], b[0]),
      minY: anchor[1] + box.minY,
      minZ: anchor[2] + Math.min(a[1], b[1]),
      maxX: anchor[0] + Math.max(a[0], b[0]),
      maxY: anchor[1] + box.maxY,
      maxZ: anchor[2] + Math.max(a[1], b[1]),
    })
  }
  return out
}

/** パーツ全体を包む AABB。 */
export function pieceBounds(p: Piece): Box {
  const boxes = pieceBoxes(p)
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

/** ワールド座標 → セル座標。 */
export function cellOf(v: number): number {
  return Math.floor(v / BUILD_CELL)
}
