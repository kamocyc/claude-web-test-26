/**
 * 村の建物を**プレイヤーが使うのと同じ建築パーツ**へ展開する。
 *
 * 村専用の壁や屋根はもう無い。生えているのは `wall` / `roof` / `stair` / `bed` …
 * といった `PieceKind` だけなので、
 *
 * - 見た目は `pieceGeometry` が返す**同じジオメトリ**、
 * - 当たり判定は `pieceColliders` が返す**同じ箱**、
 * - 寸法は `BUILD_CELL` の**同じ格子**
 *
 * になる。つまり「村の家の隣に自分で建て増す」と継ぎ目なく噛み合う。
 *
 * three に依存しない純粋関数なので、間取りの検算は単体テストでできる。
 */
import { MAT_BRICK, MAT_PLANK, MAT_ROCK } from '../world/constants'
import { mulberry32 } from '../world/noise'
import type { Building, Village } from '../world/village'
import { BUILD_CELL, PANEL_T, POST_R, localBounds } from './pieces'
import type { Piece, PieceKind } from './pieces'

/** 建物 1 棟に使う素材の組み合わせ。建材としてクラフトできるものだけで組む。 */
interface Palette {
  wall: number
  roof: number
  frame: number
}

const PALETTES: readonly Palette[] = [
  { wall: MAT_PLANK, roof: MAT_BRICK, frame: MAT_ROCK },
  { wall: MAT_BRICK, roof: MAT_ROCK, frame: MAT_PLANK },
  { wall: MAT_ROCK, roof: MAT_PLANK, frame: MAT_ROCK },
  { wall: MAT_PLANK, roof: MAT_ROCK, frame: MAT_PLANK },
]

/** 向き 0:+x 1:-x 2:+z 3:-z の単位ベクトル。`Building.doorSide` と同じ番号。 */
const DIR_X = [1, -1, 0, 0]
const DIR_Z = [0, 0, 1, -1]

/**
 * 局所 +x をその向きへ向けるヨー（5° 刻み）。
 *
 * 板（壁・窓・戸口）は面が局所 x = 0 なので、これを使うと面がその向きに直交する。
 * 階段・屋根は局所 +x へ昇り、家具は局所 +x が正面。**1 つの表で全部が決まる**。
 */
const YAW_TOWARD = [0, 36, 54, 18]

/** 家具を壁に着けるときの、壁からの余白（m）。 */
const WALL_GAP = 0.18

/**
 * 戸口を開けるマスの番号。ドア面に沿って並ぶマスの真ん中。
 * 壁を立てるときと、戸口の位置を外から尋ねるときで**同じ規則**を使うためのもの。
 */
function doorCellIndex(b: Building): number {
  return Math.floor((b.doorSide >= 2 ? b.cw : b.cd) / 2)
}

/** 戸口の中心（ワールド）。マス数が偶数だと建物の中心とはずれる。 */
export function doorPosition(b: Building): { x: number; z: number } {
  const C = BUILD_CELL
  const x0 = b.x - (b.cw / 2) * C
  const z0 = b.z - (b.cd / 2) * C
  const k = doorCellIndex(b)
  const alongX = b.doorSide >= 2
  return {
    x: alongX ? x0 + (k + 0.5) * C : b.doorSide === 0 ? x0 + b.cw * C : x0,
    z: alongX ? (b.doorSide === 2 ? z0 + b.cd * C : z0) : z0 + (k + 0.5) * C,
  }
}

/**
 * 村ひとつぶんの建築パーツ。
 *
 * 基準面を敷地高さの {@link PANEL_T} 下に置くので、**1 階の床板の上面が
 * ちょうど外の地面と同じ高さ**になる。戸口に段差が生まれず、そのまま歩いて入れる。
 */
export function villagePieces(v: Village, out: Piece[] = []): Piece[] {
  out.length = 0
  for (const b of v.buildings) buildingPieces(b, v.platformY - PANEL_T, out)
  return out
}

/** 建物 1 棟ぶんの建築パーツを `out` に**足す**。 */
export function buildingPieces(b: Building, baseY: number, out: Piece[] = []): Piece[] {
  const pal = PALETTES[b.palette % PALETTES.length]
  const rand = mulberry32(b.seed >>> 0)
  if (b.kind === 'well') {
    addWell(out, b, baseY, pal)
    return out
  }

  const C = BUILD_CELL
  const ctx: Ctx = {
    b,
    baseY,
    pal,
    rand,
    out,
    x0: b.x - (b.cw / 2) * C,
    z0: b.z - (b.cd / 2) * C,
  }

  addWalls(ctx)
  addCornerPosts(ctx)
  const decks = deckLevels(b)
  addDecksAndStairs(ctx, decks)
  addRoof(ctx)
  return out
}

interface Ctx {
  b: Building
  baseY: number
  pal: Palette
  rand: () => number
  out: Piece[]
  /** -x 面・-z 面のワールド座標。 */
  x0: number
  z0: number
}

function push(
  out: Piece[],
  kind: PieceKind,
  x: number,
  y: number,
  z: number,
  yaw: number,
  mat: number,
): void {
  out.push({ kind, x, y, z, yaw, mat })
}

function cellX(c: Ctx, i: number): number {
  return c.x0 + (i + 0.5) * BUILD_CELL
}

function cellZ(c: Ctx, j: number): number {
  return c.z0 + (j + 0.5) * BUILD_CELL
}

/**
 * 井戸。1 マスぶんの柵で囲い、両側の柱に梁を渡して桶を吊る形にする。
 * 屋根が要らないので、村でいちばん小さい「建物」になる。
 */
function addWell(out: Piece[], b: Building, baseY: number, pal: Palette): void {
  const C = BUILD_CELL
  const h = C / 2
  for (let side = 0; side < 4; side++) {
    push(out, 'fence', b.x + DIR_X[side] * h, baseY, b.z + DIR_Z[side] * h, YAW_TOWARD[side], pal.wall)
  }
  push(out, 'pillar', b.x, baseY, b.z - h, 0, pal.frame)
  push(out, 'pillar', b.x, baseY, b.z + h, 0, pal.frame)
  // 梁は柱の頭に載せる（梁の高さは POST_R * 2）
  push(out, 'beam', b.x, baseY + C - POST_R * 2, b.z, YAW_TOWARD[2], pal.frame)
}

/**
 * 外周の壁。段ごと・マスごとに 1 枚ずつ立て、
 * 1 階のドア面の真ん中だけを戸口に、残りの一部を窓に差し替える。
 */
function addWalls(c: Ctx): void {
  const { b, pal } = c
  const C = BUILD_CELL
  const windowChance = b.kind === 'shed' ? 0.15 : 0.45

  for (let f = 0; f < b.levels; f++) {
    const y = c.baseY + f * C + C / 2
    for (let side = 0; side < 4; side++) {
      const alongX = side >= 2 // ±z 面は x 方向に並ぶ
      const n = alongX ? b.cw : b.cd
      const mid = doorCellIndex(b)
      for (let k = 0; k < n; k++) {
        const x = alongX ? cellX(c, k) : side === 0 ? c.x0 + b.cw * C : c.x0
        const z = alongX ? (side === 2 ? c.z0 + b.cd * C : c.z0) : cellZ(c, k)
        const isDoor = f === 0 && side === b.doorSide && k === mid
        const kind: PieceKind = isDoor ? 'door' : c.rand() < windowChance ? 'window' : 'wall'
        push(c.out, kind, x, y, z, YAW_TOWARD[side], pal.wall)
      }
    }
  }
}

/** 四隅の柱。段ごとに 1 本ずつ積む（ハーフティンバー風の見た目になる）。 */
function addCornerPosts(c: Ctx): void {
  const { b, pal } = c
  const C = BUILD_CELL
  const x1 = c.x0 + b.cw * C
  const z1 = c.z0 + b.cd * C
  for (let f = 0; f < b.levels; f++) {
    const y = c.baseY + f * C
    for (const x of [c.x0, x1]) {
      for (const z of [c.z0, z1]) push(c.out, 'pillar', x, y, z, 0, pal.frame)
    }
  }
}

/**
 * 床を張る段。0 は地面の床。家と見張り台は段ごとに床が入り、
 * 大広間は仕切らずに 2 段ぶんの吹き抜けにする。見張り台は壁の上にもう 1 枚（露台）。
 */
function deckLevels(b: Building): number[] {
  if (b.kind === 'hall' || b.kind === 'shed') return [0]
  const out: number[] = []
  for (let L = 0; L < b.levels; L++) out.push(L)
  if (b.kind === 'tower') out.push(b.levels)
  return out
}

/**
 * 床・階段・内装。
 *
 * 階段は 1 マスで 1 段ぶん昇るので、**上の床はその真上のマスを抜く**。
 * 抜かないと昇りきった先が天井になって出られない。
 */
function addDecksAndStairs(c: Ctx, decks: number[]): void {
  const { b, pal } = c
  const C = BUILD_CELL
  const top = decks[decks.length - 1]

  for (const L of decks) {
    const y = c.baseY + L * C
    const below = decks.includes(L - 1) ? stairCell(b, L - 1) : null
    const here = decks.includes(L + 1) ? stairCell(b, L) : null

    for (let j = 0; j < b.cd; j++) {
      for (let i = 0; i < b.cw; i++) {
        if (below && below.i === i && below.j === j) continue // 階段の吹き抜け
        push(c.out, 'floor', cellX(c, i), y, cellZ(c, j), 0, MAT_PLANK)
      }
    }

    if (here) {
      // 床板の上から昇り始めるので、昇りきった高さが上の床の上面と揃う
      push(c.out, 'stair', cellX(c, here.i), y + PANEL_T, cellZ(c, here.j), YAW_TOWARD[here.dir], pal.frame)
    }

    if (L === top && b.kind === 'tower') addLookout(c, y)
    else furnish(c, L, y + PANEL_T, here, below)
  }
}

/**
 * 段 L の階段が使うマスと昇る向き。
 * 段ごとに反対の隅から昇らせるので、上下の階段が同じ場所で重ならない。
 */
function stairCell(b: Building, level: number): { i: number; j: number; dir: number } {
  return level % 2 === 0
    ? { i: 0, j: 0, dir: 0 }
    : { i: b.cw - 1, j: b.cd - 1, dir: 1 }
}

/** 見張り台の露台。手すりで囲い、四隅の柱で屋根を持ち上げる。 */
function addLookout(c: Ctx, deckY: number): void {
  const { b, pal } = c
  const C = BUILD_CELL
  const y = deckY + PANEL_T
  for (let side = 0; side < 4; side++) {
    const alongX = side >= 2
    const n = alongX ? b.cw : b.cd
    for (let k = 0; k < n; k++) {
      const x = alongX ? cellX(c, k) : side === 0 ? c.x0 + b.cw * C : c.x0
      const z = alongX ? (side === 2 ? c.z0 + b.cd * C : c.z0) : cellZ(c, k)
      push(c.out, 'fence', x, y, z, YAW_TOWARD[side], pal.wall)
    }
  }
  for (const x of [c.x0, c.x0 + b.cw * C]) {
    for (const z of [c.z0, c.z0 + b.cd * C]) push(c.out, 'pillar', x, y, z, 0, pal.frame)
  }
}

/**
 * 切妻屋根と妻壁。
 *
 * 屋根パーツは 1 マス進んで 1 マス昇る（45°）ので、棟と直交する側が 2 マスなら
 * **左右の斜面がちょうど真ん中で棟を作る**。`Building` がその側を必ず 2 マスに
 * 固定しているのはこのため。妻壁は同じ 45° の直角三角形なので、
 * 屋根の下の三角の隙間にそのまま収まる。
 */
function addRoof(c: Ctx): void {
  const { b, pal } = c
  const C = BUILD_CELL
  // 見張り台だけは、壁の上の露台（床板 1 枚）と、それに立つ柱 1 本ぶん屋根が高い
  const wallTop = c.baseY + b.levels * C
  const eaveY = b.kind === 'tower' ? wallTop + PANEL_T + C : wallTop

  if (b.ridgeAlongX) {
    const ridgeZ = c.z0 + C
    for (let i = 0; i < b.cw; i++) {
      push(c.out, 'roof', cellX(c, i), eaveY, ridgeZ - C / 2, YAW_TOWARD[2], pal.roof)
      push(c.out, 'roof', cellX(c, i), eaveY, ridgeZ + C / 2, YAW_TOWARD[3], pal.roof)
    }
    for (const x of [c.x0, c.x0 + b.cw * C]) {
      push(c.out, 'gable', x, eaveY, ridgeZ - C / 2, 0, pal.wall)
      push(c.out, 'gable', x, eaveY, ridgeZ + C / 2, 36, pal.wall)
    }
    return
  }

  const ridgeX = c.x0 + C
  for (let j = 0; j < b.cd; j++) {
    push(c.out, 'roof', ridgeX - C / 2, eaveY, cellZ(c, j), YAW_TOWARD[0], pal.roof)
    push(c.out, 'roof', ridgeX + C / 2, eaveY, cellZ(c, j), YAW_TOWARD[1], pal.roof)
  }
  for (const z of [c.z0, c.z0 + b.cd * C]) {
    push(c.out, 'gable', ridgeX - C / 2, eaveY, z, 18, pal.wall)
    push(c.out, 'gable', ridgeX + C / 2, eaveY, z, 54, pal.wall)
  }
}

// ------------------------------------------------------------------------ 内装

/** その段に並べる家具。手前から順に、空いているマスへ収めていく。 */
function furnitureList(b: Building, level: number): PieceKind[] {
  switch (b.kind) {
    case 'hall':
      return ['table', 'table', 'shelf', 'chest', 'shelf', 'chair']
    case 'shed':
      return ['chest', 'chest', 'shelf']
    case 'tower':
      return level === 0 ? ['chest', 'shelf'] : ['bed', 'chest']
    default:
      if (b.levels === 1) return ['bed', 'table', 'chest', 'shelf']
      // 2 階建ては 1 階が居間、2 階が寝室
      return level === 0 ? ['table', 'shelf', 'chest'] : ['bed', 'bed', 'chest', 'shelf']
  }
}

/** 家具を置ける場所。マスごとに「壁に着けられる向き」と「真ん中が空いているか」を持つ。 */
interface Slot {
  i: number
  j: number
  dirs: number[]
  centerFree: boolean
}

/**
 * 1 つの段に家具を並べる。
 *
 * 階段のマス・その吹き抜けのマス・戸口の正面のマスは避ける
 * （床が無かったり、動線を塞いだりするため）。
 * ベッド・チェスト・棚は**背中を壁に着けて**、テーブルはマスの真ん中に椅子を添えて置く。
 */
function furnish(
  c: Ctx,
  level: number,
  floorY: number,
  stairHere: { i: number; j: number } | null,
  stairBelow: { i: number; j: number } | null,
): void {
  const { b } = c
  const wanted = furnitureList(b, level)
  const doorCell = level === 0 ? doorApproach(b) : null

  const slots: Slot[] = []
  for (let j = 0; j < b.cd; j++) {
    for (let i = 0; i < b.cw; i++) {
      if (stairHere && stairHere.i === i && stairHere.j === j) continue
      if (stairBelow && stairBelow.i === i && stairBelow.j === j) continue
      if (doorCell && doorCell.i === i && doorCell.j === j) continue
      const dirs: number[] = []
      if (i === b.cw - 1) dirs.push(0)
      if (i === 0) dirs.push(1)
      if (j === b.cd - 1) dirs.push(2)
      if (j === 0) dirs.push(3)
      slots.push({ i, j, dirs, centerFree: true })
    }
  }
  if (slots.length === 0) return

  // 建物ごとに並べ始めるマスをずらす。同じ間取りでも中身が同じにならないように
  let cursor = Math.floor(c.rand() * slots.length)

  for (const kind of wanted) {
    for (let n = 0; n < slots.length; n++) {
      const s = slots[(cursor + n) % slots.length]
      if (kind === 'table' || kind === 'chair') {
        if (!s.centerFree) continue
        s.centerFree = false
        addTable(c, s, floorY, kind === 'table')
      } else {
        if (s.dirs.length === 0) continue
        const dir = s.dirs.splice(Math.floor(c.rand() * s.dirs.length), 1)[0]
        addAgainstWall(c, kind, s, dir, floorY)
      }
      cursor = (cursor + n + 1) % slots.length
      break
    }
  }
}

/** 戸口の正面のマス（そこには家具を置かない）。 */
function doorApproach(b: Building): { i: number; j: number } {
  const k = doorCellIndex(b)
  if (b.doorSide === 0) return { i: b.cw - 1, j: k }
  if (b.doorSide === 1) return { i: 0, j: k }
  if (b.doorSide === 2) return { i: k, j: b.cd - 1 }
  return { i: k, j: 0 }
}

/**
 * 背中を壁に着けて置く。壁からの距離はパーツの**背面までの奥行き**から決めるので、
 * ベッドでも棚でも同じ 1 行で済む。
 */
function addAgainstWall(c: Ctx, kind: PieceKind, s: Slot, dir: number, floorY: number): void {
  const back = -localBounds(kind).minX
  const off = BUILD_CELL / 2 - WALL_GAP - back
  push(
    c.out,
    kind,
    cellX(c, s.i) + DIR_X[dir] * off,
    floorY,
    cellZ(c, s.j) + DIR_Z[dir] * off,
    YAW_TOWARD[dir ^ 1],
    MAT_PLANK,
  )
}

/** マスの真ん中にテーブルと、それを挟む椅子 2 脚。 */
function addTable(c: Ctx, s: Slot, floorY: number, withTable: boolean): void {
  const x = cellX(c, s.i)
  const z = cellZ(c, s.j)
  if (withTable) push(c.out, 'table', x, floorY, z, 0, MAT_PLANK)
  push(c.out, 'chair', x - 1.1, floorY, z, YAW_TOWARD[0], MAT_PLANK)
  push(c.out, 'chair', x + 1.1, floorY, z, YAW_TOWARD[1], MAT_PLANK)
}
