import { describe, expect, it } from 'vitest'
import { BuildGrid, snapPiece } from '../src/build/BuildGrid'
import {
  BUILD_CELL,
  PANEL_T,
  PIECE_COST,
  PIECE_KINDS,
  STAIR_STEPS,
  localBoxes,
  pieceBoxes,
  slotKey,
} from '../src/build/pieces'
import type { Piece, PieceKind } from '../src/build/pieces'
import type { Box } from '../src/world/village'
import { MAT_PLANK } from '../src/world/constants'

/** y < 0 が地面の、平らな偽の地形。 */
const flatGround = (_x: number, y: number, _z: number): boolean => y < 0

/** 何も無い空間。 */
const noGround = (): boolean => false

function piece(kind: PieceKind, cx: number, cy: number, cz: number, rot = 0): Piece {
  return { kind, cx, cy, cz, rot, mat: MAT_PLANK }
}

function inside(b: Box, x: number, y: number, z: number): boolean {
  return x > b.minX && x < b.maxX && y > b.minY && y < b.maxY && z > b.minZ && z < b.maxZ
}

function insideAny(boxes: Box[], x: number, y: number, z: number): boolean {
  return boxes.some((b) => inside(b, x, y, z))
}

function volume(kind: PieceKind): number {
  let v = 0
  for (const b of localBoxes(kind)) {
    v += (b.maxX - b.minX) * (b.maxY - b.minY) * (b.maxZ - b.minZ)
  }
  return v
}

describe('スロット', () => {
  it('隣のセルから見た同じ面の壁は同じスロットになる', () => {
    // セル 1 の -x 面 = セル 0 の +x 面。どちらを狙っても x = 3 の面に落ちる
    const fromRight = snapPiece('wall', 3.1, 1, 4, 0, 0, 0, 0, MAT_PLANK)
    const fromLeft = snapPiece('wall', 2.9, 1, 4, 0, 0, 0, 0, MAT_PLANK)
    expect(slotKey(fromRight)).toBe(slotKey(fromLeft))
    expect(fromRight.cx).toBe(1)
  })

  it('同じ面に 2 枚は置けない', () => {
    const g = new BuildGrid()
    expect(g.place(piece('wall', 0, 0, 0))).toBe(true)
    expect(g.place(piece('window', 0, 0, 0))).toBe(false)
    expect(g.count).toBe(1)
  })

  it('壁・床・体積は同じセルに共存できる', () => {
    const g = new BuildGrid()
    expect(g.place(piece('wall', 0, 0, 0, 0))).toBe(true)
    expect(g.place(piece('wall', 0, 0, 0, 1))).toBe(true)
    expect(g.place(piece('floor', 0, 0, 0))).toBe(true)
    expect(g.place(piece('block', 0, 0, 0))).toBe(true)
    expect(g.count).toBe(4)
  })

  it('階段・屋根・ブロックは同じセルの体積を取り合う', () => {
    const g = new BuildGrid()
    expect(g.place(piece('stair', 0, 0, 0))).toBe(true)
    expect(g.place(piece('roof', 0, 0, 0))).toBe(false)
    expect(g.place(piece('block', 0, 0, 0))).toBe(false)
  })
})

describe('当たり判定', () => {
  it('戸口には人が通れる開口がある', () => {
    const boxes = pieceBoxes(piece('door', 0, 0, 0))
    // 面は x = 0、セルは z ∈ [0,3]。中央の足元は通り抜けられる
    expect(insideAny(boxes, 0, 1.0, 1.5)).toBe(false)
    expect(insideAny(boxes, 0, 0.2, 1.5)).toBe(false)
    // 両脇とまぐさは塞がっている
    expect(insideAny(boxes, 0, 1.0, 0.3)).toBe(true)
    expect(insideAny(boxes, 0, 1.0, 2.7)).toBe(true)
    expect(insideAny(boxes, 0, 2.6, 1.5)).toBe(true)
  })

  it('窓は塞がっていて通り抜けられない', () => {
    const boxes = pieceBoxes(piece('window', 0, 0, 0))
    expect(insideAny(boxes, 0, 1.5, 1.5)).toBe(true)
  })

  it('階段は 1 段が乗り越えられる高さで、1 マスぶん昇る', () => {
    const boxes = pieceBoxes(piece('stair', 0, 0, 0)).slice().sort((a, b) => a.maxY - b.maxY)
    expect(boxes.length).toBe(STAIR_STEPS)
    let prev = 0
    for (const b of boxes) {
      // Player.resolveBoxes が乗り越えられるのは 0.6 m 未満
      expect(b.maxY - prev).toBeLessThan(0.6)
      prev = b.maxY
    }
    expect(prev).toBeCloseTo(BUILD_CELL, 6)
  })

  it('階段の向きは 90 度ずつ回る', () => {
    const anchorZ = 1.5
    const top = pieceBoxes(piece('stair', 0, 0, 0, 1)).reduce((a, b) => (a.maxY > b.maxY ? a : b))
    // rot=1 は -z 側へ昇る
    expect((top.minZ + top.maxZ) / 2).toBeLessThan(anchorZ)
  })

  it('屋根は薄く、上を歩ける段になっている', () => {
    const boxes = pieceBoxes(piece('roof', 0, 0, 0))
    const top = boxes.reduce((a, b) => (a.maxY > b.maxY ? a : b))
    expect(top.maxY).toBeCloseTo(BUILD_CELL, 6)
    for (const b of boxes) expect(b.maxY - b.minY).toBeLessThan(PANEL_T + BUILD_CELL / 6)
  })

  it('付近の当たり判定を out に追記する（村の壁を消さない）', () => {
    const g = new BuildGrid()
    g.place(piece('wall', 0, 0, 0))
    const village: Box[] = [{ minX: 90, minY: 0, minZ: 90, maxX: 91, maxY: 1, maxZ: 91 }]
    g.collectColliders(0, 1.5, 1.5, village)
    expect(village.length).toBe(2)
  })
})

describe('支持', () => {
  it('地面に接していれば置ける', () => {
    const g = new BuildGrid()
    expect(g.canPlace(piece('floor', 0, 0, 0), flatGround)).toBe('ok')
    expect(g.canPlace(piece('wall', 0, 0, 0), flatGround)).toBe('ok')
  })

  it('宙に浮いた場所には置けない', () => {
    const g = new BuildGrid()
    expect(g.canPlace(piece('floor', 0, 3, 0), flatGround)).toBe('unsupported')
    expect(g.canPlace(piece('wall', 0, 0, 0), noGround)).toBe('unsupported')
  })

  it('既にあるパーツに接していれば置ける', () => {
    const g = new BuildGrid()
    g.place(piece('block', 0, 0, 0))
    // ブロックの天面 (y=3) に立つ壁
    expect(g.canPlace(piece('wall', 0, 1, 0), noGround)).toBe('ok')
    // 2 マス上は届かない
    expect(g.canPlace(piece('wall', 0, 3, 0), noGround)).toBe('unsupported')
  })

  it('埋まっているスロットは occupied を返す', () => {
    const g = new BuildGrid()
    g.place(piece('floor', 0, 0, 0))
    expect(g.canPlace(piece('floor', 0, 0, 0), flatGround)).toBe('occupied')
  })
})

describe('スナップ', () => {
  it('壁は最寄りの鉛直グリッド面に吸着する', () => {
    const p = snapPiece('wall', 5.9, 1, 4, 0, 0, 0, 0, MAT_PLANK)
    expect(p.rot).toBe(0)
    expect(p.cx).toBe(2) // x = 6 の面
    expect(p.cy).toBe(0)
    expect(p.cz).toBe(1)

    const q = snapPiece('wall', 4, 1, 5.9, 0, 0, 0, 0, MAT_PLANK)
    expect(q.rot).toBe(1) // z = 6 の面
    expect(q.cz).toBe(2)
  })

  it('床は最寄りの水平グリッド面に吸着する', () => {
    expect(snapPiece('floor', 4, 2.9, 4, 0, 0, 0, 0, MAT_PLANK).cy).toBe(1)
    expect(snapPiece('floor', 4, 1.1, 4, 0, 0, 0, 0, MAT_PLANK).cy).toBe(0)
  })

  it('体積のパーツは照準の点を含むセルに入る', () => {
    const p = snapPiece('block', 4, 2.9, 7.5, 0, 0, 0, 0, MAT_PLANK)
    expect([p.cx, p.cy, p.cz]).toEqual([1, 0, 2])
  })

  it('面の外側へ寄せるので、地形の上を狙うと手前のセルになる', () => {
    // ちょうど y = 3 の面に立っていても、法線が上なら上のセルの床になる
    const p = snapPiece('block', 4, 3, 4, 0, 1, 0, 0, MAT_PLANK)
    expect(p.cy).toBe(1)
  })
})

describe('レイキャスト', () => {
  it('手前のパーツを返す', () => {
    const g = new BuildGrid()
    g.place(piece('block', 1, 0, 0))
    g.place(piece('block', 2, 0, 0))
    const out = { piece: piece('wall', 0, 0, 0), distance: 0, nx: 0, ny: 0, nz: 0 }
    const hit = g.raycast(-1, 1.5, 1.5, 1, 0, 0, 20, out)
    expect(hit).not.toBeNull()
    expect(hit!.piece.cx).toBe(1)
    expect(hit!.distance).toBeCloseTo(4, 6)
    expect(hit!.nx).toBe(-1)
  })

  it('何も無ければ null', () => {
    const g = new BuildGrid()
    const out = { piece: piece('wall', 0, 0, 0), distance: 0, nx: 0, ny: 0, nz: 0 }
    expect(g.raycast(0, 1, 0, 0, 0, 1, 9, out)).toBeNull()
  })
})

describe('保存', () => {
  it('往復しても同じ並びになる', () => {
    const g = new BuildGrid()
    g.place(piece('wall', 0, 0, 0))
    g.place(piece('stair', 1, 0, 2, 3))
    g.place(piece('floor', -2, 1, 5))
    const data = g.serialize()

    const again = new BuildGrid()
    again.load(data)
    expect(again.count).toBe(3)
    for (const p of g.pieces()) {
      const q = again.get(slotKey(p))
      expect(q).toBeDefined()
      expect(q!.kind).toBe(p.kind)
      expect(q!.rot).toBe(p.rot)
      expect(q!.mat).toBe(p.mat)
    }
  })

  it('壊れた要素は 1 件ずつ捨てる', () => {
    const g = new BuildGrid()
    g.load([999, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, MAT_PLANK, 0, NaN, 0, 0, 0, MAT_PLANK])
    expect(g.count).toBe(1)
    expect(g.get('wx|1,1,1')).toBeDefined()
  })

  it('保存データでないものを渡しても落ちない', () => {
    const g = new BuildGrid()
    g.place(piece('wall', 0, 0, 0))
    g.load(null)
    expect(g.count).toBe(0)
  })
})

describe('材料', () => {
  it('コストが実体積とかけ離れていない', () => {
    // 掘った体積 = 盛れる体積、という既存の釣り合いを崩さないための歯止め。
    // 壁族は開口があっても同じ値（穴を開けたぶん安くはならない）
    const panel = volume('wall')
    const ref: Record<PieceKind, number> = {
      wall: panel,
      window: panel,
      door: panel,
      floor: volume('floor'),
      stair: volume('stair'),
      roof: volume('roof'),
      block: volume('block'),
    }
    for (const kind of PIECE_KINDS) {
      expect(PIECE_COST[kind], `${kind} が安すぎる`).toBeGreaterThan(ref[kind] * 0.7)
      expect(PIECE_COST[kind], `${kind} が高すぎる`).toBeLessThan(ref[kind] * 1.7)
    }
  })

  it('ブロック 1 個はセル 1 マスぶんの体積になる', () => {
    expect(PIECE_COST.block).toBe(BUILD_CELL ** 3)
  })
})

describe('ジオメトリ', () => {
  it('屋根の斜面は外を向いている（巻き順が裏返っていない）', async () => {
    const { pieceGeometry } = await import('../src/render/buildMeshes')
    const n = pieceGeometry('roof').getAttribute('normal')
    // roofGeometry は上面 → 下面 の順に面を出す（1 面 = 三角形 2 枚 = 6 頂点）
    for (let i = 0; i < 6; i++) expect(n.getY(i), '上面が下を向いている').toBeGreaterThan(0)
    for (let i = 6; i < 12; i++) expect(n.getY(i), '下面が上を向いている').toBeLessThan(0)
  })

  it('壁と床のジオメトリは当たり判定と同じ大きさになる', async () => {
    const { pieceGeometry } = await import('../src/render/buildMeshes')
    for (const kind of ['wall', 'floor', 'block', 'stair', 'door'] as const) {
      const geo = pieceGeometry(kind)
      geo.computeBoundingBox()
      const bb = geo.boundingBox!
      const boxes = localBoxes(kind)
      const minX = Math.min(...boxes.map((b) => b.minX))
      const maxY = Math.max(...boxes.map((b) => b.maxY))
      expect(bb.min.x, kind).toBeCloseTo(minX, 6)
      expect(bb.max.y, kind).toBeCloseTo(maxY, 6)
    }
  })
})

describe('建てた床の上', () => {
  // 何も無い空間（地形は無限に下）。床の当たり判定だけで支える
  const emptyWorld = {
    sample(_x: number, _y: number, _z: number, out: { d: number; gx: number; gy: number; gz: number }) {
      out.d = -1000
      out.gx = 0
      out.gy = -1
      out.gz = 0
      return out
    },
    densityAt: () => -1000,
  } as unknown as import('../src/world/World').World

  function controls(keys: string[]): import('../src/player/Controls').Controls {
    return { keys: new Set(keys), yaw: 0, pitch: 0 } as unknown as import('../src/player/Controls').Controls
  }

  async function standOnFloor(keys: string[], seconds: number) {
    const { Player } = await import('../src/player/Player')
    const g = new BuildGrid()
    const slab = piece('floor', 0, 1, 0)
    g.place(slab)
    const p = new Player()
    p.position.set(1.5, BUILD_CELL + PANEL_T + 0.1, 1.5)
    const c = controls(keys)
    let peak = p.position.y
    for (let i = 0; i < Math.round(seconds * 60); i++) {
      p.boxes = g.collectColliders(p.position.x, p.position.z, 1.2, [])
      p.update(1 / 60, emptyWorld, c)
      peak = Math.max(peak, p.position.y)
    }
    return { p, peak, top: BUILD_CELL + PANEL_T }
  }

  it('落ちずに床の上に立ち、接地扱いになる', async () => {
    const { p, top } = await standOnFloor([], 1.5)
    expect(p.position.y, '床をすり抜けた').toBeCloseTo(top, 2)
    expect(p.onGround, '床の上が空中扱いになっている').toBe(true)
  })

  it('床の上でジャンプできる', async () => {
    const { peak, top } = await standOnFloor(['Space'], 1.5)
    expect(peak, 'ジャンプできていない').toBeGreaterThan(top + 1)
  })

  it('置いた階段は歩いて登れる', async () => {
    const { Player } = await import('../src/player/Player')
    // y < 0 が地面の平らな世界。階段はその上に載る
    const flat = {
      sample(_x: number, y: number, _z: number, out: { d: number; gx: number; gy: number; gz: number }) {
        out.d = -y
        out.gx = 0
        out.gy = -1
        out.gz = 0
        return out
      },
      densityAt: (_x: number, y: number) => -y,
    } as unknown as import('../src/world/World').World

    const g = new BuildGrid()
    g.place(piece('stair', 0, 0, 0))
    const p = new Player()
    p.position.set(-0.6, 0.02, 1.5)
    // ヨー -π/2 で「前」が +x。階段は +x へ昇る
    const c = { keys: new Set(['KeyW']), yaw: -Math.PI / 2, pitch: 0 } as unknown as
      import('../src/player/Controls').Controls
    let peak = p.position.y
    for (let i = 0; i < 120; i++) {
      p.boxes = g.collectColliders(p.position.x, p.position.z, 1.2, [])
      p.update(1 / 60, flat, c)
      peak = Math.max(peak, p.position.y)
    }
    // 3 m を昇りきる（登りきると先は地面なので、到達した高さで見る）
    expect(peak, `階段を登れていない (y=${peak.toFixed(2)})`).toBeGreaterThan(BUILD_CELL - 0.2)
  })
})
