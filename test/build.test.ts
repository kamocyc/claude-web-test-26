import { describe, expect, it } from 'vitest'
import { BuildGrid } from '../src/build/BuildGrid'
import {
  BUILD_CELL,
  PANEL_T,
  PIECE_COST,
  PIECE_KINDS,
  STAIR_STEPS,
  localBoxes,
  normalizeYaw,
  pieceColliders,
  snapPoints,
  yawDeg,
  yawRad,
} from '../src/build/pieces'
import type { Piece, PieceKind } from '../src/build/pieces'
import { colliderContains, obbOverlap } from '../src/world/collision'
import type { Collider } from '../src/world/collision'
import { MAT_PLANK } from '../src/world/constants'

/** y < 0 が地面の、平らな偽の地形。 */
const flatGround = (_x: number, y: number, _z: number): boolean => y < 0

/** 何も無い空間。 */
const noGround = (): boolean => false

function piece(kind: PieceKind, x: number, y: number, z: number, deg = 0): Piece {
  return { kind, x, y, z, yaw: normalizeYaw(deg / 5), mat: MAT_PLANK }
}

function insideAny(cols: Collider[], x: number, y: number, z: number): boolean {
  return cols.some((c) => colliderContains(c, x, y, z))
}

function volume(kind: PieceKind): number {
  let v = 0
  for (const b of localBoxes(kind)) {
    v += (b.maxX - b.minX) * (b.maxY - b.minY) * (b.maxZ - b.minZ)
  }
  return v
}

describe('パーツの当たり判定', () => {
  it('戸口には人が通れる開口がある', () => {
    // 面は x = 0、幅は z ∈ [-1.5, 1.5]、足元は y = 0
    const cols = pieceColliders(piece('door', 0, 1.5, 0))
    expect(insideAny(cols, 0, 1.0, 0)).toBe(false)
    expect(insideAny(cols, 0, 0.2, 0)).toBe(false)
    // 両脇とまぐさは塞がっている
    expect(insideAny(cols, 0, 1.0, -1.2)).toBe(true)
    expect(insideAny(cols, 0, 1.0, 1.2)).toBe(true)
    expect(insideAny(cols, 0, 2.6, 0)).toBe(true)
  })

  it('窓は塞がっていて通り抜けられない', () => {
    expect(insideAny(pieceColliders(piece('window', 0, 1.5, 0)), 0, 1.5, 0)).toBe(true)
  })

  it('階段は 1 段が乗り越えられる高さで、1 マスぶん昇る', () => {
    const cols = pieceColliders(piece('stair', 0, 0, 0)).slice().sort((a, b) => a.maxY - b.maxY)
    expect(cols.length).toBe(STAIR_STEPS)
    let prev = 0
    for (const c of cols) {
      // Player.resolveBoxes が乗り越えられるのは 0.6 m 未満
      expect(c.maxY - prev).toBeLessThan(0.6)
      prev = c.maxY
    }
    expect(prev).toBeCloseTo(BUILD_CELL, 6)
  })

  it('屋根は薄く、上を歩ける段になっている', () => {
    const cols = pieceColliders(piece('roof', 0, 0, 0))
    const top = cols.reduce((a, b) => (a.maxY > b.maxY ? a : b))
    expect(top.maxY).toBeCloseTo(BUILD_CELL, 6)
    for (const c of cols) expect(c.maxY - c.minY).toBeLessThan(PANEL_T + BUILD_CELL / 6)
  })

  it('回転しても寸法は変わらない（判定はローカルのまま持つ）', () => {
    const a = pieceColliders(piece('wall', 0, 1.5, 0, 0))[0]
    const b = pieceColliders(piece('wall', 0, 1.5, 0, 35))[0]
    expect(b.maxX - b.minX).toBeCloseTo(a.maxX - a.minX, 10)
    expect(b.maxZ - b.minZ).toBeCloseTo(a.maxZ - a.minZ, 10)
    expect(yawRad(piece('wall', 0, 0, 0, 35).yaw)).toBeCloseTo((35 * Math.PI) / 180, 10)
  })
})

describe('OBB', () => {
  it('45° に回した壁は、軸平行の箱なら入る位置でも当たらない', () => {
    const c = pieceColliders(piece('wall', 0, 1.5, 0, 45))[0]
    // (1, 1.5, -1) は外接箱（±1.17）の中だが、板の面からは 1.4 m 離れている
    expect(colliderContains(c, 1, 1.5, -1)).toBe(false)
    // 板に沿った点は中
    expect(colliderContains(c, 0.707, 1.5, 0.707)).toBe(true)
  })

  it('回転を持たない箱は、これまでの軸平行判定と同じ結果になる', () => {
    const plain: Collider = { minX: -1, minY: 0, minZ: -2, maxX: 1, maxY: 3, maxZ: 2 }
    const naive = (x: number, y: number, z: number) =>
      x > plain.minX && x < plain.maxX && y > plain.minY && y < plain.maxY && z > plain.minZ && z < plain.maxZ
    for (const [x, y, z] of [
      [0, 1, 0],
      [1.5, 1, 0],
      [0, 4, 0],
      [-0.9, 2.9, 1.9],
      [0, 1, 2.1],
    ]) {
      expect(colliderContains(plain, x, y, z)).toBe(naive(x, y, z))
    }
    const other: Collider = { minX: 0.5, minY: 1, minZ: 0, maxX: 3, maxY: 2, maxZ: 1 }
    expect(obbOverlap(plain, other, 0)).toBe(true)
    expect(obbOverlap(plain, { ...other, minX: 1.2, maxX: 4 }, 0)).toBe(false)
  })
})

describe('接続点スナップ', () => {
  it('壁の隣に置いた壁は、同じ向きで隙間なく並ぶ', () => {
    const g = new BuildGrid()
    const a = piece('wall', 0, 1.5, 0)
    g.place(a)
    // a の +z 端のすぐ外を狙う
    const r = g.snap('wall', MAT_PLANK, 0, 0, 1.5, 1.6, 0)
    expect(r.point, '接続点に吸着していない').not.toBeNull()
    expect(r.piece.yaw).toBe(a.yaw)
    expect(r.piece.x).toBeCloseTo(0, 6)
    expect(r.piece.y).toBeCloseTo(1.5, 6)
    expect(r.piece.z, '隣に 1 マスぶんずれて並ばない').toBeCloseTo(BUILD_CELL, 6)
  })

  it('35° に回した壁の隣に置いた壁も、同じ 35° を継承して隙間なく並ぶ', () => {
    const g = new BuildGrid()
    const a = piece('wall', 0, 1.5, 0, 35)
    g.place(a)
    const rad = yawRad(a.yaw)
    // a の +z 端（ローカル (0, 0, 1.5)）のワールド位置
    const ex = 1.5 * Math.sin(rad)
    const ez = 1.5 * Math.cos(rad)
    const r = g.snap('wall', MAT_PLANK, 0, ex + 0.05, 1.5, ez + 0.05, 0)

    expect(r.point).not.toBeNull()
    expect(yawDeg(r.piece.yaw), '向きを継承していない').toBe(35)
    expect(
      Math.hypot(r.piece.x - a.x, r.piece.z - a.z),
      '隙間なく並んでいない',
    ).toBeCloseTo(BUILD_CELL, 6)
    expect(r.piece.y).toBeCloseTo(a.y, 6)
    // 実際に置けること（重なっていない）
    expect(g.canPlace(r.piece, noGround)).toBe('ok')
  })

  it('向きのオフセットを足すと、継承した向きからその分だけ回る', () => {
    const g = new BuildGrid()
    g.place(piece('floor', 0, 0, 0, 20))
    const r = g.snap('wall', MAT_PLANK, normalizeYaw(90 / 5), 1.4, 0.3, 0.2, 0)
    expect(yawDeg(r.piece.yaw)).toBe(110)
  })

  it('床の辺に壁を立てると、床の上端にぴたりと乗る', () => {
    const g = new BuildGrid()
    const f = piece('floor', 0, 0, 0)
    g.place(f)
    // 床の +x 側の辺の上を狙う
    const r = g.snap('wall', MAT_PLANK, 0, 1.5, PANEL_T + 0.05, 0, 0)
    expect(r.point).not.toBeNull()
    // 壁の下端 = 基準点 - 1.5 が床の上面に乗る
    expect(r.piece.y - BUILD_CELL / 2).toBeCloseTo(PANEL_T, 6)
  })

  it('近くに何も無ければ地形の上に置く（底面が照準点に乗る）', () => {
    const g = new BuildGrid()
    const r = g.snap('floor', MAT_PLANK, 0, 4.06, 12.5, -2.1, 0)
    expect(r.point).toBeNull()
    expect(r.piece.y).toBeCloseTo(12.5, 6)
    // 水平は粗い格子に丸める
    expect(r.piece.x).toBeCloseTo(4, 6)
    expect(r.piece.z).toBeCloseTo(-2, 6)
  })

  it('すべてのパーツが接続点を持つ', () => {
    for (const kind of PIECE_KINDS) {
      const pts = snapPoints(kind)
      expect(pts.length % 3, kind).toBe(0)
      expect(pts.length / 3, kind).toBeGreaterThanOrEqual(6)
    }
  })
})

describe('重なりと支持', () => {
  it('同じ場所には二重に置けない', () => {
    const g = new BuildGrid()
    g.place(piece('wall', 0, 1.5, 0))
    expect(g.canPlace(piece('wall', 0, 1.5, 0), flatGround)).toBe('overlap')
    expect(g.place(piece('window', 0, 1.5, 0))).toBe(false)
  })

  it('面で接するだけなら重なりではない', () => {
    const g = new BuildGrid()
    g.place(piece('wall', 0, 1.5, 0))
    expect(g.canPlace(piece('wall', 0, 1.5, BUILD_CELL), noGround)).toBe('ok')
  })

  it('直角に交わる 2 枚の壁は、角で少し食い込んでも置ける', () => {
    const g = new BuildGrid()
    g.place(piece('floor', 0, 0, 0))
    const y = PANEL_T + BUILD_CELL / 2
    // 床の +x 辺と +z 辺に立てる。板は角で 0.15 m 交わる
    expect(g.place(piece('wall', 1.5, y, 0, 0))).toBe(true)
    expect(g.canPlace(piece('wall', 0, y, 1.5, 90), noGround), '角で弾かれた').toBe('ok')
  })

  it('35° に傾けた部屋を、床と 4 枚の壁で囲める', () => {
    const g = new BuildGrid()
    const deg = 35
    const rad = (deg * Math.PI) / 180
    // 局所 +x / +z のワールド向き
    const ux = Math.cos(rad)
    const uz = -Math.sin(rad)
    const vx = Math.sin(rad)
    const vz = Math.cos(rad)
    const y = PANEL_T + BUILD_CELL / 2
    expect(g.place(piece('floor', 0, 0, 0, deg))).toBe(true)
    const walls: Array<[number, number, number]> = [
      [ux * 1.5, uz * 1.5, deg],
      [-ux * 1.5, -uz * 1.5, deg],
      [vx * 1.5, vz * 1.5, deg + 90],
      [-vx * 1.5, -vz * 1.5, deg + 90],
    ]
    for (const [x, z, d] of walls) {
      const w = piece('wall', x, y, z, d)
      expect(g.canPlace(w, noGround), `${d}° の壁が置けない`).toBe('ok')
      expect(g.place(w)).toBe(true)
    }
    expect(g.count).toBe(5)
  })

  it('地面に接していれば置ける', () => {
    const g = new BuildGrid()
    expect(g.canPlace(piece('floor', 0, 0, 0), flatGround)).toBe('ok')
    expect(g.canPlace(piece('wall', 0, 1.5, 0), flatGround)).toBe('ok')
  })

  it('宙に浮いた場所には置けない', () => {
    const g = new BuildGrid()
    expect(g.canPlace(piece('floor', 0, 9, 0), flatGround)).toBe('unsupported')
    expect(g.canPlace(piece('wall', 0, 1.5, 0), noGround)).toBe('unsupported')
  })

  it('35° に回した床の上の壁も支持される', () => {
    const g = new BuildGrid()
    g.place(piece('floor', 0, 0, 0, 35))
    const r = g.snap('wall', MAT_PLANK, 0, 1.2, PANEL_T + 0.05, 0.9, 0)
    expect(g.canPlace(r.piece, noGround)).toBe('ok')
    expect(yawDeg(r.piece.yaw)).toBe(35)
  })
})

describe('レイキャスト', () => {
  it('回転したパーツにも正しく当たる', () => {
    const g = new BuildGrid()
    g.place(piece('wall', 0, 1.5, 0, 45))
    const out = {
      piece: piece('wall', 0, 0, 0),
      distance: 0,
      nx: 0,
      ny: 0,
      nz: 0,
    }
    const hit = g.raycast(-5, 1.5, 0, 1, 0, 0, 20, out)
    expect(hit).not.toBeNull()
    // 板は厚み 0.3 なので、手前の面は原点から 0.15 / cos45 ぶん手前
    expect(hit!.distance).toBeCloseTo(5 - 0.15 / Math.cos(Math.PI / 4), 4)
    expect(hit!.nx, '法線がレイの方を向いていない').toBeLessThan(0)
  })

  it('手前のパーツを返す', () => {
    const g = new BuildGrid()
    g.place(piece('block', 4.5, 0, 1.5))
    g.place(piece('block', 7.5, 0, 1.5))
    const out = { piece: piece('wall', 0, 0, 0), distance: 0, nx: 0, ny: 0, nz: 0 }
    const hit = g.raycast(-1, 1.5, 1.5, 1, 0, 0, 20, out)
    expect(hit!.piece.x).toBeCloseTo(4.5, 6)
    expect(hit!.distance).toBeCloseTo(4, 6)
  })

  it('何も無ければ null', () => {
    const g = new BuildGrid()
    const out = { piece: piece('wall', 0, 0, 0), distance: 0, nx: 0, ny: 0, nz: 0 }
    expect(g.raycast(0, 1, 0, 0, 0, 1, 9, out)).toBeNull()
  })
})

describe('保存', () => {
  it('往復しても同じ姿勢になる', () => {
    const g = new BuildGrid()
    g.place(piece('wall', 1.25, 1.5, -3, 35))
    g.place(piece('stair', 4.5, 0, 6, 250))
    const data = g.serialize()

    const again = new BuildGrid()
    again.load(data)
    expect(again.count).toBe(2)
    const list = [...again.pieces()].sort((a, b) => a.x - b.x)
    expect(list[0].kind).toBe('wall')
    expect(list[0].x).toBeCloseTo(1.25, 6)
    expect(yawDeg(list[0].yaw)).toBe(35)
    expect(list[1].kind).toBe('stair')
    expect(yawDeg(list[1].yaw)).toBe(250)
  })

  it('壊れた要素は 1 件ずつ捨てる', () => {
    const g = new BuildGrid()
    g.load([999, 0, 0, 0, 0, 0, 0, 1, 2, 3, 7, MAT_PLANK, 0, NaN, 0, 0, 0, MAT_PLANK])
    expect(g.count).toBe(1)
    const only = [...g.pieces()][0]
    expect(only.x).toBe(1)
    expect(yawDeg(only.yaw)).toBe(35)
  })

  it('格子だった頃の保存データを読める', () => {
    const g = new BuildGrid()
    // [壁, cx=1, cy=0, cz=2, rot=0, 素材] と [床, cx=1, cy=0, cz=2, rot=0, 素材]
    const wall = PIECE_KINDS.indexOf('wall')
    const floor = PIECE_KINDS.indexOf('floor')
    g.loadLegacy(
      [wall, 1, 0, 2, 0, MAT_PLANK, wall, 1, 0, 2, 1, MAT_PLANK, floor, 1, 0, 2, 0, MAT_PLANK],
      BUILD_CELL,
    )
    expect(g.count).toBe(3)
    const list = [...g.pieces()]
    // セルの -x 面の壁: x = 3、面の中心は y = 1.5、z = 7.5
    const wx = list.find((p) => p.kind === 'wall' && p.yaw === 0)!
    expect([wx.x, wx.y, wx.z]).toEqual([3, 1.5, 7.5])
    // セルの -z 面の壁は 90° 回っている
    const wz = list.find((p) => p.kind === 'wall' && p.yaw !== 0)!
    expect(yawDeg(wz.yaw)).toBe(90)
    expect([wz.x, wz.y, wz.z]).toEqual([4.5, 1.5, 6])
    // 床はセル底面の中心
    const f = list.find((p) => p.kind === 'floor')!
    expect([f.x, f.y, f.z]).toEqual([4.5, 0, 7.5])
  })

  it('保存データでないものを渡しても落ちない', () => {
    const g = new BuildGrid()
    g.place(piece('wall', 0, 1.5, 0))
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

describe('建てたものの上と中', () => {
  /** y < 0 が地面の平らな世界。 */
  function flatWorld(): import('../src/world/World').World {
    return {
      sample(_x: number, y: number, _z: number, out: { d: number; gx: number; gy: number; gz: number }) {
        out.d = -y
        out.gx = 0
        out.gy = -1
        out.gz = 0
        return out
      },
      densityAt: (_x: number, y: number) => -y,
    } as unknown as import('../src/world/World').World
  }

  /** 何も無い空間（地形は無限に下）。 */
  function emptyWorld(): import('../src/world/World').World {
    return {
      sample(_x: number, _y: number, _z: number, out: { d: number; gx: number; gy: number; gz: number }) {
        out.d = -1000
        out.gx = 0
        out.gy = -1
        out.gz = 0
        return out
      },
      densityAt: () => -1000,
    } as unknown as import('../src/world/World').World
  }

  function controls(keys: string[], yaw = 0): import('../src/player/Controls').Controls {
    return { keys: new Set(keys), yaw, pitch: 0 } as unknown as import('../src/player/Controls').Controls
  }

  async function run(
    g: BuildGrid,
    world: import('../src/world/World').World,
    c: import('../src/player/Controls').Controls,
    start: [number, number, number],
    frames: number,
  ) {
    const { Player } = await import('../src/player/Player')
    const p = new Player()
    p.position.set(start[0], start[1], start[2])
    let peak = p.position.y
    for (let i = 0; i < frames; i++) {
      p.boxes = g.collectColliders(p.position.x, p.position.z, 1.2, [])
      p.update(1 / 60, world, c)
      peak = Math.max(peak, p.position.y)
    }
    return { p, peak }
  }

  it('落ちずに床の上に立ち、接地扱いになる', async () => {
    const g = new BuildGrid()
    g.place(piece('floor', 0, 3, 0))
    const { p } = await run(g, emptyWorld(), controls([]), [0, 3 + PANEL_T + 0.1, 0], 90)
    expect(p.position.y, '床をすり抜けた').toBeCloseTo(3 + PANEL_T, 2)
    expect(p.onGround, '床の上が空中扱いになっている').toBe(true)
  })

  it('床の上でジャンプできる', async () => {
    const g = new BuildGrid()
    g.place(piece('floor', 0, 3, 0))
    const { peak } = await run(g, emptyWorld(), controls(['Space']), [0, 3 + PANEL_T + 0.1, 0], 90)
    expect(peak, 'ジャンプできていない').toBeGreaterThan(3 + PANEL_T + 1)
  })

  it('置いた階段は歩いて登れる', async () => {
    const g = new BuildGrid()
    g.place(piece('stair', 0, 0, 0))
    // ヨー -π/2 で「前」が +x。階段は +x へ昇る
    const { peak } = await run(g, flatWorld(), controls(['KeyW'], -Math.PI / 2), [-2.1, 0.02, 0], 120)
    expect(peak, `階段を登れていない (y=${peak.toFixed(2)})`).toBeGreaterThan(BUILD_CELL - 0.2)
  })

  it('45° に回した戸口はくぐれて、同じ場所の壁は通り抜けられない', async () => {
    const { worldToLocal } = await import('../src/world/collision')
    const c45 = Math.cos(Math.PI / 4)
    // 面のローカル +x 向きへ歩く（ワールドでは (cos45, -sin45)）
    const yaw = -Math.PI / 4
    const start: [number, number, number] = [-1.4 * c45, 0.02, 1.4 * c45]

    const through = async (kind: PieceKind) => {
      const g = new BuildGrid()
      const wall = piece(kind, 0, 1.5, 0, 45)
      g.place(wall)
      const { p } = await run(g, flatWorld(), controls(['KeyW'], yaw), start, 180)
      const local = worldToLocal(
        { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0, ox: wall.x, oz: wall.z, cos: c45, sin: c45 },
        p.position.x,
        p.position.z,
        [0, 0],
      )
      return local[0]
    }

    expect(await through('door'), '斜めの戸口をくぐれない').toBeGreaterThan(0.5)
    expect(await through('wall'), '斜めの壁を通り抜けた').toBeLessThan(0)
  })
})
