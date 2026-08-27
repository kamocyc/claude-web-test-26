import type { Inventory } from '../items/Inventory'
import { HOTBAR_SIZE } from '../items/Inventory'
import { ITEMS, RECIPES, TRADES, type ItemDef, type Recipe, item } from '../items/items'

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

/** DOM だけで完結する軽量 HUD。 */
export class Hud {
  private readonly stats = el<HTMLDivElement>('stats')
  private readonly hotbar = el<HTMLDivElement>('hotbar')
  private readonly brush = el<HTMLDivElement>('brush')
  private readonly grade = el<HTMLDivElement>('grade')
  private readonly toast = el<HTMLDivElement>('toast')
  private readonly overlay = el<HTMLDivElement>('overlay')
  private readonly loading = el<HTMLDivElement>('loading')
  private readonly playButton = el<HTMLButtonElement>('play')
  private readonly resetButton = el<HTMLButtonElement>('reset')
  private readonly seedInput = el<HTMLInputElement>('seed')
  private readonly applySeedButton = el<HTMLButtonElement>('apply-seed')
  private readonly healthFill = el<HTMLDivElement>('health-fill')
  private readonly healthText = el<HTMLDivElement>('health-text')
  private readonly hurt = el<HTMLDivElement>('hurt')
  private readonly panel = el<HTMLDivElement>('panel')
  private readonly invGrid = el<HTMLDivElement>('inv-grid')
  private readonly craftList = el<HTMLDivElement>('craft-list')
  private readonly trade = el<HTMLDivElement>('trade')
  private readonly tradeList = el<HTMLDivElement>('trade-list')

  private readonly slots: HTMLDivElement[] = []
  private toastTimer: ReturnType<typeof setTimeout> | null = null
  private inv: Inventory | null = null

  onPlay: (() => void) | null = null
  onReset: (() => void) | null = null
  onApplySeed: ((seed: string) => void) | null = null
  onSelectSlot: ((index: number) => void) | null = null
  onCraft: ((r: Recipe) => void) | null = null
  onTrade: ((index: number) => void) | null = null
  onPanelClose: (() => void) | null = null
  onTradeClose: (() => void) | null = null

  constructor() {
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const slot = document.createElement('div')
      slot.className = 'slot'
      slot.innerHTML =
        `<span class="key">${i + 1}</span>` +
        `<span class="swatch"></span>` +
        `<span class="label"></span>` +
        `<span class="count"></span>`
      slot.addEventListener('click', () => this.onSelectSlot?.(i))
      this.hotbar.appendChild(slot)
      this.slots.push(slot)
    }
    this.playButton.addEventListener('click', () => this.onPlay?.())
    this.resetButton.addEventListener('click', () => this.onReset?.())
    this.applySeedButton.addEventListener('click', () => this.onApplySeed?.(this.seedInput.value))
    this.seedInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.onApplySeed?.(this.seedInput.value)
    })
    el<HTMLButtonElement>('panel-close').addEventListener('click', () => this.onPanelClose?.())
    el<HTMLButtonElement>('trade-close').addEventListener('click', () => this.onTradeClose?.())
  }

  /** 持ち物の実体を渡す。以降の描画はここから読む。 */
  bind(inv: Inventory): void {
    this.inv = inv
    inv.onChange = () => this.refresh()
    this.refresh()
  }

  // ---------------------------------------------------------------- ホットバー

  refresh(): void {
    const inv = this.inv
    if (!inv) return
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]
      const id = inv.hotbar[i]
      const def = id ? item(id) : null
      const n = id ? inv.whole(id) : 0
      slot.classList.toggle('active', i === inv.selected)
      slot.classList.toggle('empty', !def || n <= 0)
      const swatch = slot.querySelector('.swatch') as HTMLSpanElement
      const label = slot.querySelector('.label') as HTMLSpanElement
      const count = slot.querySelector('.count') as HTMLSpanElement
      swatch.style.background = def ? def.color : 'transparent'
      swatch.style.opacity = def ? '1' : '0'
      label.textContent = def ? def.name : ''
      count.textContent = def && !def.unique ? (inv.unlimited ? '∞' : String(n)) : ''
    }
    if (this.panelOpen) this.renderPanel()
    if (this.tradeOpen) this.renderTrade()
  }

  // ---------------------------------------------------------------- 体力

  setHealth(hp: number, max: number): void {
    const pct = Math.max(0, Math.min(1, hp / max))
    this.healthFill.style.width = `${(pct * 100).toFixed(1)}%`
    this.healthFill.style.background = pct > 0.5 ? '#5fbf6a' : pct > 0.25 ? '#e0b23c' : '#d8503e'
    this.healthText.textContent = `${Math.ceil(Math.max(0, hp))} / ${max}`
  }

  flashHurt(): void {
    this.hurt.classList.remove('show')
    // 連続で殴られてもアニメーションが再生されるように、一度リフローを挟む
    void this.hurt.offsetWidth
    this.hurt.classList.add('show')
  }

  // ---------------------------------------------------------------- 持ち物画面

  get panelOpen(): boolean {
    return !this.panel.classList.contains('hidden')
  }

  setPanel(open: boolean): void {
    this.panel.classList.toggle('hidden', !open)
    if (open) this.renderPanel()
  }

  private renderPanel(): void {
    const inv = this.inv
    if (!inv) return

    this.invGrid.innerHTML = ''
    const owned = inv.owned()
    if (owned.length === 0) {
      const p = document.createElement('p')
      p.className = 'hint'
      p.textContent = 'まだ何も持っていません。地面を掘るか、木を伐ってみてください。'
      this.invGrid.appendChild(p)
    }
    for (const def of owned) {
      this.invGrid.appendChild(this.itemCell(def, inv.unlimited ? Infinity : inv.whole(def.id), () => {
        inv.assign(inv.selected, def.id)
        this.refresh()
      }))
    }

    this.craftList.innerHTML = ''
    for (const r of RECIPES) {
      const def = item(r.out)
      const ok = inv.canCraft(r)
      const row = document.createElement('button')
      row.className = `recipe${ok ? '' : ' locked'}`
      row.disabled = !ok
      const cost = r.cost
        .map(([id, n]) => `${item(id).name} ${n}`)
        .join('・')
      row.innerHTML =
        `<span class="swatch" style="background:${def.color}"></span>` +
        `<span class="rname">${def.name}${r.count > 1 ? ` ×${r.count}` : ''}</span>` +
        `<span class="rcost">${cost}</span>`
      row.title = def.note ?? ''
      row.addEventListener('click', () => this.onCraft?.(r))
      this.craftList.appendChild(row)
    }
  }

  private itemCell(def: ItemDef, n: number, onClick: () => void): HTMLElement {
    const cell = document.createElement('button')
    cell.className = 'cell'
    cell.innerHTML =
      `<span class="swatch" style="background:${def.color}"></span>` +
      `<span class="label">${def.name}</span>` +
      `<span class="count">${def.unique ? '' : Number.isFinite(n) ? n : '∞'}</span>`
    cell.title = def.note ?? ''
    cell.addEventListener('click', onClick)
    return cell
  }

  // ---------------------------------------------------------------- 交易

  get tradeOpen(): boolean {
    return !this.trade.classList.contains('hidden')
  }

  setTrade(open: boolean): void {
    this.trade.classList.toggle('hidden', !open)
    if (open) this.renderTrade()
  }

  private renderTrade(): void {
    const inv = this.inv
    if (!inv) return
    this.tradeList.innerHTML = ''
    TRADES.forEach((t, i) => {
      const ok = inv.whole(t.give[0]) >= t.give[1]
      const row = document.createElement('button')
      row.className = `recipe${ok ? '' : ' locked'}`
      row.disabled = !ok
      row.innerHTML =
        `<span class="swatch" style="background:${item(t.give[0]).color}"></span>` +
        `<span class="rname">${item(t.give[0]).name} ${t.give[1]}</span>` +
        `<span class="arrow">→</span>` +
        `<span class="swatch" style="background:${item(t.get[0]).color}"></span>` +
        `<span class="rname">${item(t.get[0]).name} ${t.get[1]}</span>`
      row.addEventListener('click', () => this.onTrade?.(i))
      this.tradeList.appendChild(row)
    })
  }

  // ---------------------------------------------------------------- その他

  setBrush(label: string): void {
    this.brush.textContent = label
  }

  /** 照準の勾配。空文字で消える。 */
  setGrade(label: string): void {
    this.grade.textContent = label
  }

  showToast(text: string, ms = 1800): void {
    this.toast.textContent = text
    this.toast.classList.add('show')
    if (this.toastTimer) clearTimeout(this.toastTimer)
    this.toastTimer = setTimeout(() => this.toast.classList.remove('show'), ms)
  }

  setStats(text: string): void {
    this.stats.textContent = text
  }

  setStatsVisible(visible: boolean): void {
    this.stats.style.display = visible ? '' : 'none'
  }

  setOverlay(visible: boolean): void {
    this.overlay.classList.toggle('hidden', !visible)
  }

  setLoading(text: string): void {
    this.loading.textContent = text
  }

  setSeed(seed: number): void {
    this.seedInput.value = String(seed)
  }

  setPlayEnabled(enabled: boolean): void {
    this.playButton.disabled = !enabled
    this.playButton.style.opacity = enabled ? '1' : '0.5'
  }
}

export { ITEMS }
