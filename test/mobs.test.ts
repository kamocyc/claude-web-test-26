import { describe, expect, it, vi } from 'vitest'
import { MobManager } from '../src/mobs/MobManager'
import { MOB_DEFS } from '../src/mobs/mobs'
import type { World } from '../src/world/World'

/**
 * 地面 y = 0 の平らな世界。密度は `-y` なので勾配は (0,-1,0)、
 * つまり World.sample が返すものと同じ形になる。
 */
function makeWorld(h: (x: number) => number, dh: (x: number) => number): World {
  return {
    sample(x: number, y: number, _z: number, out: { d: number; gx: number; gy: number; gz: number }) {
      out.d = h(x) - y
      out.gx = dh(x)
      out.gy = -1
      out.gz = 0
      return out
    },
    densityAt: (x: number, y: number) => h(x) - y,
    field: {
      height: (x: number) => h(x),
      villageNear: () => null,
      biomeAt: () => ({ temp: 0.5, humid: 0.5, mountain: 0 }),
    },
  } as unknown as World
}

function flatWorld(): World {
  return {
    sample(_x: number, y: number, _z: number, out: { d: number; gx: number; gy: number; gz: number }) {
      out.d = -y
      out.gx = 0
      out.gy = -1
      out.gz = 0
      return out
    },
    densityAt: (_x: number, y: number) => -y,
    field: {
      height: () => 0,
      villageNear: () => null,
      biomeAt: () => ({ temp: 0.5, humid: 0.5, mountain: 0 }),
    },
  } as unknown as World
}

describe('MOB', () => {
  it('湧かせると数が増え、消すと 0 に戻る', () => {
    const m = new MobManager()
    m.spawn('deer', 0, 1, 0)
    m.spawn('wraith', 4, 1, 0)
    expect(m.total).toBe(2)
    expect(m.count('deer')).toBe(1)
    m.clear()
    expect(m.total).toBe(0)
  })

  it('重力で地面に落ちて止まる', () => {
    const m = new MobManager()
    const world = flatWorld()
    const mob = m.spawn('deer', 0, 6, 0)
    // 逃げも消滅もしない距離にプレイヤーを置く
    for (let i = 0; i < 240; i++) m.update(1 / 60, world, 40, 0, 40, 1)
    expect(mob.pos.y, `地面に落ちていない (y=${mob.pos.y})`).toBeLessThan(0.6)
    expect(mob.pos.y, '地面をすり抜けた').toBeGreaterThan(-0.6)
    expect(mob.onGround).toBe(true)
  })

  it('倒すとドロップし、奈落に落ちただけならドロップしない', () => {
    const world = flatWorld()

    const killed = new MobManager()
    const gotKilled = vi.fn()
    killed.onDrop = gotKilled
    const a = killed.spawn('deer', 0, 1, 0)
    expect(killed.hurt(a, 999, 0, 0)).toBe(true)
    killed.update(0.016, world, 0, 0, 0, 1)
    expect(gotKilled).toHaveBeenCalledWith('hide', 2, a)

    const fell = new MobManager()
    const gotFell = vi.fn()
    fell.onDrop = gotFell
    const b = fell.spawn('deer', 0, 1, 0)
    b.hp = 0
    fell.update(0.016, world, 0, 0, 0, 1)
    expect(gotFell, '倒していないのにドロップした').not.toHaveBeenCalled()
  })

  it('敵は近づくと攻撃してくる', () => {
    const m = new MobManager()
    const world = flatWorld()
    const hits: number[] = []
    m.onAttack = (d) => hits.push(d)
    m.spawn('wraith', 1.0, 0, 0)
    for (let i = 0; i < 120; i++) m.update(1 / 60, world, 0, 0, 0, 0)
    expect(hits.length, '殴ってこない').toBeGreaterThan(0)
    expect(hits[0]).toBe(MOB_DEFS.wraith.attack)
  })

  it('動物と村人は攻撃してこない', () => {
    for (const kind of ['deer', 'villager'] as const) {
      const m = new MobManager()
      const world = flatWorld()
      const hits: number[] = []
      m.onAttack = (d) => hits.push(d)
      m.spawn(kind, 0.8, 0, 0)
      for (let i = 0; i < 120; i++) m.update(1 / 60, world, 0, 0, 0, 1)
      expect(hits.length, `${kind} が殴ってきた`).toBe(0)
    }
  })

  it('動物はプレイヤーから逃げる', () => {
    const m = new MobManager()
    const world = flatWorld()
    const deer = m.spawn('deer', 3, 0, 0)
    const before = Math.hypot(deer.pos.x, deer.pos.z)
    for (let i = 0; i < 120; i++) m.update(1 / 60, world, 0, 0, 0, 1)
    const after = Math.hypot(deer.pos.x, deer.pos.z)
    expect(after, `逃げていない ${before} → ${after}`).toBeGreaterThan(before + 1)
  })

  it('視線上の MOB だけ当たる', () => {
    const m = new MobManager()
    m.spawn('deer', 0, 0, -5)
    // 真正面（-z 方向）
    expect(m.raycast(0, 1, 0, 0, 0, -1, 9)).not.toBeNull()
    // 横を向いている
    expect(m.raycast(0, 1, 0, 1, 0, 0, 9)).toBeNull()
    // 届かない
    expect(m.raycast(0, 1, 0, 0, 0, -1, 3)).toBeNull()
  })

  it('遠ざかると消える', () => {
    const m = new MobManager()
    const world = flatWorld()
    m.spawn('deer', 0, 1, 0)
    m.update(0.016, world, 500, 0, 500, 1)
    expect(m.total).toBe(0)
  })

  it('朝になると亡霊は消える', () => {
    const m = new MobManager()
    const world = flatWorld()
    m.spawn('wraith', 0, 1, 0)
    m.update(0.016, world, 0, 0, 0, 0)
    expect(m.total).toBe(1)
    m.update(0.016, world, 0, 0, 0, 1)
    expect(m.total, '昼になっても残っている').toBe(0)
  })

  it('近くの村人を探せる', () => {
    const m = new MobManager()
    m.spawn('deer', 1, 0, 0)
    expect(m.nearestVillager(0, 0, 5)).toBeNull()
    const v = m.spawn('villager', 2, 0, 0)
    expect(m.nearestVillager(0, 0, 5)).toBe(v)
    expect(m.nearestVillager(0, 0, 1)).toBeNull()
  })
})

describe('MOB の障害物回避', () => {
  /** x < 0 が地面、x > 0 は 40m 下という崖。 */
  const cliff = makeWorld((x) => (x < 0 ? 0 : -40), () => 0)
  /** x > 0 が 65°の斜面（歩ける限界より急）。 */
  const steepTan = Math.tan((65 * Math.PI) / 180)
  const steep = makeWorld(
    (x) => (x > 0 ? x * steepTan : 0),
    (x) => (x > 0 ? steepTan : 0),
  )

  it('崖の向こうのプレイヤーを追っても落ちない', () => {
    const m = new MobManager()
    const mob = m.spawn('wraith', -4, 0.2, 0)
    // プレイヤーは崖の先。見えているので追いかけようとする
    for (let i = 0; i < 600; i++) m.update(1 / 60, cliff, 6, 0, 0, 0)
    expect(mob.pos.y, `崖から落ちた (y=${mob.pos.y.toFixed(2)})`).toBeGreaterThan(-2)
    expect(mob.pos.x, `崖を踏み越えた (x=${mob.pos.x.toFixed(2)})`).toBeLessThan(0.5)
  })

  it('登れない坂をよじ登らない', () => {
    const m = new MobManager()
    const mob = m.spawn('wraith', -4, 0.2, 0)
    let maxY = 0
    for (let i = 0; i < 600; i++) {
      m.update(1 / 60, steep, 8, 8 * steepTan, 0, 0)
      maxY = Math.max(maxY, mob.pos.y)
    }
    expect(maxY, `急斜面に押し上げられた (y=${maxY.toFixed(2)})`).toBeLessThan(0.5)
    expect(mob.pos.x, `斜面に乗り上げた (x=${mob.pos.x.toFixed(2)})`).toBeLessThan(0.3)
  })

  it('急斜面にめり込んでも上へ押し出されない', () => {
    // ノックバックなどで斜面に押しつけられたとき、法線どおりに押すと登ってしまう
    const m = new MobManager()
    const mob = m.spawn('wraith', 0.6, 0.6 * steepTan - 0.35, 0)
    const y0 = mob.pos.y
    // プレイヤーは視界の外・消滅距離の内側に置いて、さまようだけにする
    // （亡霊は朝に消えるので夜のまま進める）
    m.update(1 / 60, steep, 60, 0, 0, 0)
    expect(mob.pos.y - y0, `斜面に持ち上げられた (+${(mob.pos.y - y0).toFixed(2)}m)`).toBeLessThan(0.02)
  })

  it('木を通り抜けない', () => {
    const m = new MobManager()
    const world = flatWorld()
    // (0,0) に半径 0.4 の幹。プレイヤーはその向こう
    const trunks = new Float32Array([0, 0, 0, 0.4, 4])
    m.obstacles = {
      trunksNear: () => trunks,
      boxesNear: (_x, _z, _r, out) => {
        out.length = 0
        return out
      },
    }
    const mob = m.spawn('wraith', -4, 0.2, 0)
    let closest = Infinity
    for (let i = 0; i < 600; i++) {
      m.update(1 / 60, world, 6, 0, 0, 0)
      closest = Math.min(closest, Math.hypot(mob.pos.x, mob.pos.z))
    }
    expect(closest, `幹にめり込んだ (${closest.toFixed(2)}m)`).toBeGreaterThan(
      0.4 + MOB_DEFS.wraith.radius - 0.05,
    )
  })

  it('建物の壁を通り抜けない', () => {
    const m = new MobManager()
    const world = flatWorld()
    const box = { minX: -1, maxX: 1, minZ: -6, maxZ: 6, minY: 0, maxY: 3 }
    m.obstacles = {
      trunksNear: () => new Float32Array(0),
      boxesNear: (_x, _z, _r, out) => {
        out.length = 0
        out.push(box)
        return out
      },
    }
    const mob = m.spawn('wraith', -5, 0.2, 0)
    for (let i = 0; i < 600; i++) {
      m.update(1 / 60, world, 6, 0, 0, 0)
      expect(mob.pos.x, `壁の中に入った (x=${mob.pos.x.toFixed(2)})`).toBeLessThan(
        box.minX - MOB_DEFS.wraith.radius + 0.05,
      )
    }
  })
})
