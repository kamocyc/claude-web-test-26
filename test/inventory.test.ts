import { describe, expect, it } from 'vitest'
import { Inventory } from '../src/items/Inventory'
import { ITEMS, RECIPES, TRADES, item } from '../src/items/items'

const recipe = (out: string) => {
  const r = RECIPES.find((x) => x.out === out)
  if (!r) throw new Error(`no recipe: ${out}`)
  return r
}

describe('持ち物', () => {
  it('初めて手に入れたものはホットバーの空きに入る', () => {
    const inv = new Inventory()
    expect(inv.hotbar).toContain('dirt')
    expect(inv.hotbar).not.toContain('wood')
    inv.add('wood', 3)
    expect(inv.hotbar, '手に入れたのにホットバーに出てこない').toContain('wood')
  })

  it('地形の素材は小数で貯まり、表示は切り捨てになる', () => {
    const inv = new Inventory()
    inv.add('dirt', 2.4)
    inv.add('dirt', 0.4)
    expect(inv.count('dirt')).toBeCloseTo(2.8, 6)
    expect(inv.whole('dirt')).toBe(2)
  })

  it('道具は 1 個までしか持てない', () => {
    const inv = new Inventory()
    inv.add('pickaxe', 5)
    expect(inv.whole('pickaxe')).toBe(1)
  })

  it('手に持っているものが攻撃力になる', () => {
    const inv = new Inventory()
    expect(inv.attack(), '素手の攻撃力').toBe(1)
    inv.add('bone_sword', 1)
    inv.assign(0, 'bone_sword')
    inv.selected = 0
    expect(inv.attack()).toBe(item('bone_sword').attack)
  })

  it('防具は持っているだけで効く（いちばん良いものが選ばれる）', () => {
    const inv = new Inventory()
    expect(inv.armor()).toBe(0)
    inv.add('hide_armor', 1)
    expect(inv.armor()).toBe(0.3)
    inv.add('bone_armor', 1)
    expect(inv.armor(), '良いほうが選ばれない').toBe(0.55)
  })
})

describe('クラフト', () => {
  it('材料が足りなければ作れない', () => {
    const inv = new Inventory()
    const r = recipe('pickaxe')
    expect(inv.canCraft(r)).toBe(false)
    expect(inv.craft(r)).toBe(false)
    expect(inv.whole('pickaxe')).toBe(0)
  })

  it('材料が揃えば作れて、材料は消える', () => {
    const inv = new Inventory()
    const r = recipe('pickaxe')
    for (const [id, n] of r.cost) inv.add(id, n)
    expect(inv.canCraft(r)).toBe(true)
    expect(inv.craft(r)).toBe(true)
    expect(inv.whole('pickaxe')).toBe(1)
    for (const [id] of r.cost) expect(inv.whole(id), `${id} が減っていない`).toBe(0)
  })

  it('ちょうど 1 足りないと作れない', () => {
    const inv = new Inventory()
    const r = recipe('brick')
    for (const [id, n] of r.cost) inv.add(id, n)
    inv.take(r.cost[0][0], 1)
    expect(inv.canCraft(r)).toBe(false)
  })

  it('道具は 2 個目を作れない', () => {
    const inv = new Inventory()
    const r = recipe('axe')
    for (const [id, n] of r.cost) inv.add(id, n * 2)
    expect(inv.craft(r)).toBe(true)
    expect(inv.canCraft(r), '2 個目が作れてしまう').toBe(false)
  })

  it('すべてのレシピの材料が、世界から手に入るものだけでできている', () => {
    // 掘る・伐る・倒すで手に入るもの
    const sources = new Set(['grass', 'dirt', 'rock', 'sand', 'wood', 'coal', 'hide', 'bone'])
    for (const r of RECIPES) sources.add(r.out)
    for (const r of RECIPES) {
      for (const [id] of r.cost) {
        expect(sources.has(id), `${r.out} の材料 ${id} がどこからも手に入らない`).toBe(true)
      }
    }
  })

  it('レシピと交換の相手が実在するアイテムを指している', () => {
    const ids = new Set(ITEMS.map((i) => i.id))
    for (const r of RECIPES) {
      expect(ids.has(r.out)).toBe(true)
      for (const [id] of r.cost) expect(ids.has(id)).toBe(true)
    }
    for (const t of TRADES) {
      expect(ids.has(t.give[0])).toBe(true)
      expect(ids.has(t.get[0])).toBe(true)
    }
  })
})

describe('交換', () => {
  it('渡すものが足りていれば交換できる', () => {
    const inv = new Inventory()
    const t = TRADES[0]
    expect(inv.trade(t.give, t.get), '持っていないのに交換できた').toBe(false)
    inv.add(t.give[0], t.give[1])
    expect(inv.trade(t.give, t.get)).toBe(true)
    expect(inv.whole(t.give[0])).toBe(0)
    expect(inv.whole(t.get[0])).toBe(t.get[1])
  })
})

describe('保存', () => {
  it('保存して読み直すと元に戻る', () => {
    const inv = new Inventory()
    inv.add('dirt', 120.5)
    inv.add('bone_sword', 1)
    inv.assign(2, 'bone_sword')
    inv.selected = 2
    const saved = JSON.parse(JSON.stringify(inv.toJSON()))

    const other = new Inventory()
    other.load(saved)
    expect(other.count('dirt')).toBeCloseTo(120.5, 6)
    expect(other.whole('bone_sword')).toBe(1)
    expect(other.hotbar[2]).toBe('bone_sword')
    expect(other.selected).toBe(2)
  })

  it('壊れた保存データを読んでも落ちない', () => {
    const inv = new Inventory()
    for (const bad of [null, 42, 'x', { counts: 'no' }, { counts: [['nope', 5], ['dirt', 'x']] }]) {
      expect(() => inv.load(bad)).not.toThrow()
    }
    expect(inv.whole('nope')).toBe(0)
    expect(inv.whole('dirt')).toBe(0)
  })

  it('無制限モードでは払えるが、溜めた量は減らない', () => {
    const inv = new Inventory()
    inv.add('rock', 10)
    inv.unlimited = true

    // 手持ちが無いものでも払える
    expect(inv.count('plank')).toBeGreaterThan(1e6)
    expect(inv.take('plank', 500)).toBe(true)
    expect(inv.takeUpTo('plank', 500)).toBe(500)
    // 溜めてある量には手をつけない
    expect(inv.stored('plank')).toBe(0)
    expect(inv.take('rock', 4)).toBe(true)
    expect(inv.stored('rock')).toBe(10)

    // 戻せば元の量から続けられる
    inv.unlimited = false
    expect(inv.count('rock')).toBe(10)
    expect(inv.count('plank')).toBe(0)
    expect(inv.take('plank', 1)).toBe(false)
  })

  it('無制限モードでは持ち物にすべて並び、レシピも作れる', () => {
    const inv = new Inventory()
    expect(inv.owned()).toHaveLength(0)
    inv.unlimited = true
    expect(inv.owned().length).toBeGreaterThan(10)
    const plank = RECIPES.find((r) => r.out === 'plank')!
    expect(inv.canCraft(plank)).toBe(true)
    expect(inv.craft(plank)).toBe(true)
    // 作ったものは実際に溜まる（戻したときに使える）
    expect(inv.stored('plank')).toBe(plank.count)
    expect(inv.stored('wood')).toBe(0)
  })
})
