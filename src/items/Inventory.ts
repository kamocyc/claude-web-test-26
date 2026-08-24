import { ITEMS, type Cost, type ItemDef, type ItemId, type Recipe, item, tryItem } from './items'

export const HOTBAR_SIZE = 9

/** 最初からホットバーに並んでいる素材。 */
// 1〜4 は素材 ID の順に合わせておく（HUD と保存データの読みやすさのため）
const DEFAULT_HOTBAR: (ItemId | null)[] = [
  'grass',
  'dirt',
  'rock',
  'sand',
  null,
  null,
  null,
  null,
  null,
]

/**
 * 持ち物。
 *
 * 地形の素材は体積（格子点の数）なので小数になる。表示と支払いは切り捨てで扱う。
 * 道具・防具は `unique` なので 1 個しか持てない。
 */
export class Inventory {
  private readonly counts = new Map<ItemId, number>()
  readonly hotbar: (ItemId | null)[] = [...DEFAULT_HOTBAR]
  selected = 0

  /** 変化したときに呼ばれる（HUD の更新用）。 */
  onChange: (() => void) | null = null

  count(id: ItemId): number {
    return this.counts.get(id) ?? 0
  }

  /** 表示・支払いに使う整数値。 */
  whole(id: ItemId): number {
    return Math.floor(this.count(id))
  }

  /** 何かしら持っているアイテムを、レジストリの順で返す。 */
  owned(): ItemDef[] {
    return ITEMS.filter((d) => this.whole(d.id) > 0)
  }

  add(id: ItemId, amount: number): void {
    if (amount <= 0) return
    const def = tryItem(id)
    if (!def) return
    const had = this.whole(id)
    const next = def.unique ? Math.min(1, this.count(id) + amount) : this.count(id) + amount
    this.counts.set(id, next)
    // 初めて手に入れたものはホットバーの空きに入れて、すぐ使えるようにする
    if (had === 0 && Math.floor(next) > 0) this.assignToFreeSlot(id)
    this.onChange?.()
  }

  /** 足りていれば減らして true。 */
  take(id: ItemId, amount: number): boolean {
    if (this.count(id) < amount) return false
    this.counts.set(id, this.count(id) - amount)
    this.onChange?.()
    return true
  }

  /** 足りているぶんだけ減らし、実際に減らせた量を返す。 */
  takeUpTo(id: ItemId, amount: number): number {
    const n = Math.min(this.count(id), amount)
    if (n <= 0) return 0
    this.counts.set(id, this.count(id) - n)
    this.onChange?.()
    return n
  }

  canPay(cost: readonly Cost[]): boolean {
    return cost.every(([id, n]) => this.whole(id) >= n)
  }

  private pay(cost: readonly Cost[]): boolean {
    if (!this.canPay(cost)) return false
    for (const [id, n] of cost) this.counts.set(id, this.count(id) - n)
    return true
  }

  canCraft(r: Recipe): boolean {
    // 道具・防具は 1 個持っていたらもう作れない
    if (item(r.out).unique && this.whole(r.out) > 0) return false
    return this.canPay(r.cost)
  }

  craft(r: Recipe): boolean {
    if (!this.canCraft(r)) return false
    this.pay(r.cost)
    this.add(r.out, r.count)
    this.onChange?.()
    return true
  }

  /** 交換。渡すものが足りていれば true。 */
  trade(give: Cost, get: Cost): boolean {
    if (!this.pay([give])) return false
    this.add(get[0], get[1])
    return true
  }

  // ---------------------------------------------------------------- ホットバー

  private assignToFreeSlot(id: ItemId): void {
    if (this.hotbar.includes(id)) return
    const free = this.hotbar.indexOf(null)
    if (free >= 0) this.hotbar[free] = id
  }

  /** ホットバーの枠にアイテムを割り当てる（インベントリ画面から使う）。 */
  assign(slot: number, id: ItemId | null): void {
    if (slot < 0 || slot >= HOTBAR_SIZE) return
    // 同じものが別の枠にあれば入れ替える
    if (id !== null) {
      const dup = this.hotbar.indexOf(id)
      if (dup >= 0) this.hotbar[dup] = this.hotbar[slot]
    }
    this.hotbar[slot] = id
    this.onChange?.()
  }

  /**
   * いま手に持っているもの。
   * 手持ちが 0 でも返す（「置けません」ではなく「足りません」と案内したいため）。
   */
  held(): ItemDef | null {
    const id = this.hotbar[this.selected]
    return id ? item(id) : null
  }

  /** 持っている中でいちばん良い防具の軽減率。 */
  armor(): number {
    let best = 0
    for (const d of ITEMS) {
      if (d.kind !== 'armor' || d.armor === undefined) continue
      if (this.whole(d.id) > 0) best = Math.max(best, d.armor)
    }
    return best
  }

  /** 手に持っている道具・武器の攻撃力（素手は 1）。 */
  attack(): number {
    return this.held()?.attack ?? 1
  }

  // ---------------------------------------------------------------- 保存

  toJSON(): { counts: [ItemId, number][]; hotbar: (ItemId | null)[]; selected: number } {
    return { counts: [...this.counts], hotbar: [...this.hotbar], selected: this.selected }
  }

  load(data: unknown): void {
    this.counts.clear()
    this.hotbar.splice(0, HOTBAR_SIZE, ...DEFAULT_HOTBAR)
    this.selected = 0
    if (!data || typeof data !== 'object') return
    const d = data as { counts?: unknown; hotbar?: unknown; selected?: unknown }
    if (Array.isArray(d.counts)) {
      for (const e of d.counts) {
        if (!Array.isArray(e) || e.length !== 2) continue
        const [id, n] = e as [unknown, unknown]
        if (typeof id !== 'string' || typeof n !== 'number' || !Number.isFinite(n)) continue
        if (!tryItem(id) || n <= 0) continue
        this.counts.set(id, n)
      }
    }
    if (Array.isArray(d.hotbar)) {
      for (let i = 0; i < HOTBAR_SIZE; i++) {
        const v = d.hotbar[i]
        this.hotbar[i] = typeof v === 'string' && tryItem(v) ? v : null
      }
    }
    if (typeof d.selected === 'number' && d.selected >= 0 && d.selected < HOTBAR_SIZE) {
      this.selected = d.selected
    }
    this.onChange?.()
  }

  clear(): void {
    this.counts.clear()
    this.hotbar.splice(0, HOTBAR_SIZE, ...DEFAULT_HOTBAR)
    this.selected = 0
    this.onChange?.()
  }
}
