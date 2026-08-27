import { describe, expect, it } from 'vitest'
import { flattenWeight, makeVillage } from '../src/world/village'
import type { Building } from '../src/world/village'
import { buildingPieces, villagePieces } from '../src/build/villagePieces'
import { BUILD_CELL, PIECE_KINDS, pieceColliders, yawRad } from '../src/build/pieces'
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

  it('敷地の中心は完全に平坦化され、外では元の地形に戻る', () => {
    expect(flattenWeight(v, v.cx, v.cz)).toBeCloseTo(1, 6)
    expect(flattenWeight(v, v.cx + v.radius * 0.6, v.cz)).toBeCloseTo(1, 6)
    expect(flattenWeight(v, v.cx + v.radius * 1.2, v.cz)).toBe(0)
    // 中心の地表高度は敷地高さと一致する
    expect(field.height(v.cx, v.cz)).toBeCloseTo(v.platformY, 4)
  })
})
