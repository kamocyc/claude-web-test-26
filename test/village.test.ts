import { describe, expect, it } from 'vitest'
import { Player } from '../src/player/Player'
import type { World } from '../src/world/World'
import type { Controls } from '../src/player/Controls'
import { BuildGrid } from '../src/build/BuildGrid'
import { flattenWeight, makeVillage } from '../src/world/village'
import type { Building } from '../src/world/village'
import { buildingPieces, doorPosition, villagePieces } from '../src/build/villagePieces'
import { BUILD_CELL, PANEL_T, PIECE_KINDS, pieceColliders, yawRad } from '../src/build/pieces'
import type { Piece, PieceKind } from '../src/build/pieces'
import { colliderContains } from '../src/world/collision'
import type { Collider } from '../src/world/collision'
import { DensityField } from '../src/world/density'

const field = new DensityField(20260823)
const baseHeight = (x: number, z: number) => field.baseHeight(x, z)

function findVillage() {
  for (let vx = -8; vx <= 8; vx++) {
    for (let vz = -8; vz <= 8; vz++) {
      const v = makeVillage(vx, vz, field.seed, baseHeight)
      if (v && v.buildings.length >= 5) return { v, vx, vz }
    }
  }
  throw new Error('村が 1 つも生成されなかった')
}

/** 建物 1 棟ぶんの当たり判定をすべて平らに並べる。 */
function collidersOf(b: Building, baseY = 0): Collider[] {
  const out: Collider[] = []
  for (const p of buildingPieces(b, baseY)) out.push(...pieceColliders(p))
  return out
}

function insideAny(cols: Collider[], x: number, y: number, z: number): boolean {
  return cols.some((c) => colliderContains(c, x, y, z))
}

function kinds(pieces: Piece[]): Set<PieceKind> {
  return new Set(pieces.map((p) => p.kind))
}

/** y < 0 が地面の、平らな疑似ワールド（`World.sample` と同じ形）。 */
const flatWorld = {
  sample(_x: number, y: number, _z: number, out: { d: number; gx: number; gy: number; gz: number }) {
    out.d = -y
    out.gx = 0
    out.gy = -1
    out.gz = 0
    return out
  },
  densityAt: (_x: number, y: number) => -y,
} as unknown as World

function walking(yaw: number, sprint = false): Controls {
  const keys = sprint ? ['KeyW', 'ShiftLeft'] : ['KeyW']
  return { keys: new Set(keys), yaw, pitch: 0 } as unknown as Controls
}

/** 地面 y = 0 に建てた 1 棟だけの当たり判定。 */
function houseGrid(b: Building): BuildGrid {
  const g = new BuildGrid()
  // villagePieces と同じく、床板の上面が地面（y = 0）に来るように置く
  g.fill(buildingPieces(b, -PANEL_T))
  return g
}

/** 建物 1 棟の中でプレイヤーを歩かせ、毎フレーム当たり判定を集め直す。 */
function walk(
  g: BuildGrid,
  p: Player,
  yaw: number,
  frames: number,
  opts: { sprint?: boolean; each?: () => void } = {},
): void {
  const cols: Collider[] = []
  for (let i = 0; i < frames; i++) {
    cols.length = 0
    g.collectColliders(p.position.x, p.position.z, 1.4, cols)
    p.boxes = cols
    p.update(1 / 60, flatWorld, walking(yaw, opts.sprint ?? false))
    opts.each?.()
  }
}

/** 戸口から見て建物の内側を向く単位ベクトル。 */
function inward(b: Building): [number, number] {
  return [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ][b.doorSide] as [number, number]
}

describe('村', () => {
  const { v, vx, vz } = findVillage()

  it('同じシードなら何度作っても同じ村になる', () => {
    const again = makeVillage(vx, vz, field.seed, baseHeight)!
    expect(again.cx).toBeCloseTo(v.cx, 10)
    expect(again.platformY).toBeCloseTo(v.platformY, 10)
    expect(again.buildings.length).toBe(v.buildings.length)
    // 建築パーツへの展開も決定論的（同じ列がそのまま出る）
    expect(villagePieces(again)).toEqual(villagePieces(v))
  })

  it('海の中や山の上には作らない', () => {
    expect(v.platformY).toBeGreaterThan(0)
    expect(v.platformY).toBeLessThan(90)
  })

  it('建物どうしが重ならない', () => {
    for (let i = 0; i < v.buildings.length; i++) {
      for (let j = i + 1; j < v.buildings.length; j++) {
        const a = v.buildings[i]
        const b = v.buildings[j]
        const gapX = Math.abs(a.x - b.x) - (a.w + b.w) / 2
        const gapZ = Math.abs(a.z - b.z) - (a.d + b.d) / 2
        expect(Math.max(gapX, gapZ), `建物 ${i} と ${j} が重なっている`).toBeGreaterThan(0)
      }
    }
  })

  it('寸法がパーツの基準寸法の整数倍になっている', () => {
    for (const b of v.buildings) {
      expect(b.w).toBeCloseTo(b.cw * BUILD_CELL, 10)
      expect(b.d).toBeCloseTo(b.cd * BUILD_CELL, 10)
      expect(b.wallH).toBeCloseTo(b.levels * BUILD_CELL, 10)
      // 棟と直交する側は必ず 2 マス（屋根パーツ 2 枚でちょうど棟ができる）
      if (b.kind !== 'well') expect(b.ridgeAlongX ? b.cd : b.cw).toBe(2)
      else expect([b.cw, b.cd]).toEqual([1, 1])
    }
  })

  it('建物はすべて既存の建築パーツだけでできている', () => {
    const pieces = villagePieces(v)
    expect(pieces.length).toBeGreaterThan(100)
    for (const p of pieces) {
      expect(PIECE_KINDS, `${p.kind} は建築パーツではない`).toContain(p.kind)
      expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true)
      expect(p.yaw).toBeGreaterThanOrEqual(0)
      expect(p.yaw).toBeLessThan(72)
    }
  })

  it('壁にドアの開口があり、そこは通り抜けられる', () => {
    const house = v.buildings.find((b) => b.kind === 'house')!
    const pieces = buildingPieces(house, 0)
    const door = pieces.find((p) => p.kind === 'door')!
    const cols = collidersOf(house)

    // 戸口の面の中心・腰の高さは、どの当たり判定にも入らない
    expect(insideAny(cols, door.x, door.y - 0.5, door.z), 'ドアの位置が塞がれている').toBe(false)

    // 開口の真横（板の幅方向へ 1.2 m）は壁で塞がれている
    const rad = yawRad(door.yaw)
    const sx = door.x + Math.sin(rad) * 1.2
    const sz = door.z + Math.cos(rad) * 1.2
    expect(insideAny(cols, sx, door.y - 0.5, sz), 'ドアの脇の壁が抜けている').toBe(true)
  })

  it('家には床と屋根と内装（ベッド・チェスト）が入っている', () => {
    for (const b of v.buildings.filter((x) => x.kind === 'house')) {
      const k = kinds(buildingPieces(b, 0))
      for (const need of ['floor', 'roof', 'gable', 'door', 'bed', 'chest'] as PieceKind[]) {
        expect(k.has(need), `家に ${need} が無い`).toBe(true)
      }
    }
  })

  it('2 階建ての家には階段があり、昇りきった先の床が抜けている', () => {
    const two = v.buildings.find((b) => b.kind === 'house' && b.levels === 2)
    if (!two) return
    const pieces = buildingPieces(two, 0)
    const stair = pieces.find((p) => p.kind === 'stair')!
    // 階段のマスの真上に 2 階の床は無い（あると昇りきった先が天井になる）
    const upper = pieces.filter(
      (p) => p.kind === 'floor' && Math.abs(p.y - BUILD_CELL) < 1e-6,
    )
    for (const f of upper) {
      expect(Math.hypot(f.x - stair.x, f.z - stair.z), '階段の真上が床で塞がれている')
        .toBeGreaterThan(0.5)
    }
    // 昇りきる高さが 2 階の床の上面と揃っている
    expect(stair.y + BUILD_CELL).toBeCloseTo(BUILD_CELL + 0.3, 6)
  })

  it('見張り台には手すりが立っている', () => {
    const tower = v.buildings.find((b) => b.kind === 'tower')
    if (!tower) return
    expect(kinds(buildingPieces(tower, 0)).has('fence')).toBe(true)
  })

  it('家具は床の上に乗っている', () => {
    for (const b of v.buildings) {
      for (const p of buildingPieces(b, 0)) {
        if (p.kind !== 'bed' && p.kind !== 'chest' && p.kind !== 'shelf') continue
        // 床板の上面（段の高さ + 板厚）にぴたりと乗る
        const level = Math.round((p.y - 0.3) / BUILD_CELL)
        expect(p.y, `${p.kind} が宙に浮いている`).toBeCloseTo(level * BUILD_CELL + 0.3, 6)
      }
    }
  })

  it('1 階の床は外の地面と同じ高さ（戸口に段差ができない）', () => {
    const pieces = villagePieces(v)
    const ground = pieces.filter((p) => p.kind === 'floor' && p.y < v.platformY)
    expect(ground.length).toBeGreaterThan(0)
    for (const f of ground) {
      // 床板の上面 = 敷地高さ
      expect(f.y + PANEL_T).toBeCloseTo(v.platformY, 6)
    }
  })

  it('家の中から壁をすり抜けられない', () => {
    for (const b of v.buildings) {
      if (b.kind === 'well' || b.kind === 'tower') continue
      const g = houseGrid(b)
      const door = doorPosition(b)
      const [ix, iz] = inward(b)
      // 戸口から 1.6 m 入った所（階段や家具に重ならない場所）から、全方位へ突進する
      const sx = door.x + ix * 1.6
      const sz = door.z + iz * 1.6
      for (let a = 0; a < 16; a++) {
        const p = new Player()
        p.position.set(sx, 0.2, sz)
        // 建物の外へ出た最初の場所
        const cross: number[] = []
        walk(g, p, (a / 16) * Math.PI * 2, 600, {
          sprint: true,
          each: () => {
            if (cross.length > 0) return
            if (
              Math.abs(p.position.x - b.x) > b.w / 2 ||
              Math.abs(p.position.z - b.z) > b.d / 2
            ) {
              cross.push(p.position.x, p.position.z)
            }
          },
        })
        // 外へ出たなら、それは戸口のはず
        if (cross.length === 0) continue
        const away = Math.hypot(cross[0] - door.x, cross[1] - door.z)
        expect(
          away,
          `${b.kind} ${b.cw}x${b.cd} が (${cross[0].toFixed(2)}, ${cross[1].toFixed(2)}) で壁を抜けた`,
        ).toBeLessThan(1.6)
      }
    }
  })

  it('戸口は段差に引っかからずに歩いて入れる', () => {
    for (const b of v.buildings) {
      if (b.kind === 'well') continue
      const g = houseGrid(b)
      const door = doorPosition(b)
      const [ix, iz] = inward(b)
      const p = new Player()
      // 戸口の 2.5 m 手前から、戸口へ向かってまっすぐ歩く
      p.position.set(door.x - ix * 2.5, 0.2, door.z - iz * 2.5)
      let best = -Infinity
      let insideY: number | null = null
      // 前進は -Z 方向なので、向き (ix, iz) へ進むヨーは atan2(-ix, -iz)
      walk(g, p, Math.atan2(-ix, -iz), 240, {
        each: () => {
          const d = (p.position.x - door.x) * ix + (p.position.z - door.z) * iz
          if (d > best) best = d
          if (insideY === null && d > 1.2) insideY = p.position.y
        },
      })
      expect(best, `${b.kind} の戸口で止まった（${best.toFixed(2)} m）`).toBeGreaterThan(1.2)
      // 敷居に乗り上げて浮いたままになっていない（床の上面 = 外の地面 = y 0）
      expect(Math.abs(insideY ?? 99), '敷居に乗り上げている').toBeLessThan(0.12)
    }
  })

  it('敷地の中心は完全に平坦化され、外では元の地形に戻る', () => {
    expect(flattenWeight(v, v.cx, v.cz)).toBeCloseTo(1, 6)
    expect(flattenWeight(v, v.cx + v.radius * 0.6, v.cz)).toBeCloseTo(1, 6)
    expect(flattenWeight(v, v.cx + v.radius * 1.2, v.cz)).toBe(0)
    // 中心の地表高度は敷地高さと一致する
    expect(field.height(v.cx, v.cz)).toBeCloseTo(v.platformY, 4)
  })
})
