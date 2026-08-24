import { describe, expect, it, vi } from 'vitest'
import { MobManager } from '../src/mobs/MobManager'
import { MOB_DEFS } from '../src/mobs/mobs'
import type { World } from '../src/world/World'

/**
 * 地面 y = 0 の平らな世界。密度は `-y` なので勾配は (0,-1,0)、
 * つまり World.sample が返すものと同じ形になる。
 */
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
