import {
  MAT_BRICK,
  MAT_DIRT,
  MAT_GLASS,
  MAT_GRASS,
  MAT_PLANK,
  MAT_ROCK,
  MAT_SAND,
} from '../world/constants'

export type ItemId = string

export type ItemKind = 'block' | 'resource' | 'tool' | 'weapon' | 'armor' | 'light'

export interface ItemDef {
  readonly id: ItemId
  readonly name: string
  readonly color: string
  readonly kind: ItemKind
  /** block: 設置に使う地形素材 ID。 */
  readonly material?: number
  /**
   * 建築パーツ（壁・床・階段…）の材料にできるか。
   * 土と砂は安息角で崩れる素材なので、形を保つ建材にはしない。
   */
  readonly build?: boolean
  /** 掘削間隔の倍率。1 未満で速い。 */
  readonly dig?: number
  /** ブラシ半径に足す量（m）。 */
  readonly radius?: number
  /** 伐採間隔の倍率。1 未満で速い。 */
  readonly chop?: number
  /** 攻撃力。 */
  readonly attack?: number
  /** 被ダメージの軽減率 0..1。 */
  readonly armor?: number
  /** 1 個しか持てない（道具・防具）。 */
  readonly unique?: boolean
  readonly note?: string
}

/**
 * アイテムの一覧。
 *
 * 地形の素材（草・土・岩・砂）と建材（板・レンガ・ガラス）は「体積」で数える。
 * 掘ると固体 → 空になった格子点の数だけ増え、盛るとその逆に減る。
 * 資源・道具・防具は個数で数える。
 */
export const ITEMS: readonly ItemDef[] = [
  { id: 'grass', name: '草', color: '#6f9c46', kind: 'block', material: MAT_GRASS },
  { id: 'dirt', name: '土', color: '#7d5a3c', kind: 'block', material: MAT_DIRT },
  { id: 'rock', name: '岩', color: '#8a8f96', kind: 'block', material: MAT_ROCK, build: true },
  { id: 'sand', name: '砂', color: '#d8c48a', kind: 'block', material: MAT_SAND },
  { id: 'plank', name: '板', color: '#b8874a', kind: 'block', material: MAT_PLANK, build: true },
  { id: 'brick', name: 'レンガ', color: '#a8503c', kind: 'block', material: MAT_BRICK, build: true },
  { id: 'glass', name: 'ガラス', color: '#9fd6e8', kind: 'block', material: MAT_GLASS, build: true },

  { id: 'wood', name: '木材', color: '#8a5c34', kind: 'resource', note: '木を伐ると採れる' },
  { id: 'coal', name: '石炭', color: '#2e3238', kind: 'resource', note: '岩を掘るとたまに出る' },
  { id: 'hide', name: '皮', color: '#c19a6b', kind: 'resource', note: '鹿から採れる' },
  { id: 'bone', name: '骨', color: '#e4dcc4', kind: 'resource', note: '亡霊が落とす' },

  {
    id: 'torch',
    name: '松明',
    color: '#ffb454',
    kind: 'light',
    note: '地面に置くと周りを照らす',
  },

  {
    id: 'pickaxe',
    name: 'つるはし',
    color: '#9aa7b4',
    kind: 'tool',
    dig: 0.55,
    radius: 0.5,
    unique: true,
    note: '掘るのが速い',
  },
  {
    id: 'shovel',
    name: 'シャベル',
    color: '#c2b280',
    kind: 'tool',
    dig: 0.7,
    radius: 1.5,
    unique: true,
    note: '一度に大きく掘れる',
  },
  {
    id: 'axe',
    name: '斧',
    color: '#b07a4a',
    kind: 'tool',
    dig: 0.9,
    chop: 0.3,
    attack: 2,
    unique: true,
    note: '伐採が速い',
  },

  {
    id: 'stone_sword',
    name: '石の剣',
    color: '#b9bec6',
    kind: 'weapon',
    attack: 4,
    unique: true,
  },
  {
    id: 'bone_sword',
    name: '骨の剣',
    color: '#efe8d2',
    kind: 'weapon',
    attack: 8,
    unique: true,
  },

  {
    id: 'hide_armor',
    name: '革の胴着',
    color: '#a97c50',
    kind: 'armor',
    armor: 0.3,
    unique: true,
    note: '持っていると自動で身につく',
  },
  {
    id: 'bone_armor',
    name: '骨の鎧',
    color: '#d9d2ba',
    kind: 'armor',
    armor: 0.55,
    unique: true,
    note: '持っていると自動で身につく',
  },
]

const BY_ID = new Map<ItemId, ItemDef>(ITEMS.map((i) => [i.id, i]))

export function item(id: ItemId): ItemDef {
  const d = BY_ID.get(id)
  if (!d) throw new Error(`unknown item: ${id}`)
  return d
}

export function tryItem(id: ItemId): ItemDef | null {
  return BY_ID.get(id) ?? null
}

/** 素材 ID → 設置に使うアイテム。 */
export const ITEM_BY_MATERIAL = new Map<number, ItemDef>(
  ITEMS.filter((i) => i.material !== undefined).map((i) => [i.material as number, i]),
)

export type Cost = readonly [ItemId, number]

export interface Recipe {
  readonly out: ItemId
  /** 1 回作るとこれだけ手に入る。 */
  readonly count: number
  readonly cost: readonly Cost[]
}

/**
 * レシピ。マスに並べる方式ではなく、**材料が揃っていれば作れる**。
 * 地形の素材は掘ると数十〜数百たまるので、それに合わせた分量にしてある。
 */
export const RECIPES: readonly Recipe[] = [
  { out: 'plank', count: 60, cost: [['wood', 4]] },
  { out: 'brick', count: 60, cost: [['dirt', 60], ['rock', 30]] },
  { out: 'glass', count: 60, cost: [['sand', 80], ['coal', 1]] },
  { out: 'torch', count: 4, cost: [['wood', 1], ['coal', 1]] },
  { out: 'pickaxe', count: 1, cost: [['wood', 3], ['rock', 40]] },
  { out: 'shovel', count: 1, cost: [['wood', 3], ['rock', 20]] },
  { out: 'axe', count: 1, cost: [['wood', 5], ['rock', 30]] },
  { out: 'stone_sword', count: 1, cost: [['wood', 2], ['rock', 50]] },
  { out: 'bone_sword', count: 1, cost: [['wood', 2], ['bone', 6]] },
  { out: 'hide_armor', count: 1, cost: [['hide', 5]] },
  { out: 'bone_armor', count: 1, cost: [['hide', 3], ['bone', 8]] },
]

/** 村人の交換品。左を渡すと右がもらえる。 */
export const TRADES: readonly { readonly give: Cost; readonly get: Cost }[] = [
  { give: ['rock', 120], get: ['wood', 6] },
  { give: ['sand', 120], get: ['coal', 4] },
  { give: ['dirt', 150], get: ['hide', 3] },
  { give: ['bone', 4], get: ['coal', 6] },
  { give: ['wood', 12], get: ['rock', 200] },
]
