import { MATERIAL_INFO } from '../world/constants'

/** DOM だけで完結する軽量 HUD。 */
export class Hud {
  private readonly stats = document.getElementById('stats') as HTMLDivElement
  private readonly hotbar = document.getElementById('hotbar') as HTMLDivElement
  private readonly brush = document.getElementById('brush') as HTMLDivElement
  private readonly toast = document.getElementById('toast') as HTMLDivElement
  private readonly overlay = document.getElementById('overlay') as HTMLDivElement
  private readonly loading = document.getElementById('loading') as HTMLDivElement
  private readonly playButton = document.getElementById('play') as HTMLButtonElement
  private readonly resetButton = document.getElementById('reset') as HTMLButtonElement
  private readonly seedInput = document.getElementById('seed') as HTMLInputElement
  private readonly applySeedButton = document.getElementById('apply-seed') as HTMLButtonElement
  private readonly slots: HTMLDivElement[] = []
  private readonly counts: HTMLSpanElement[] = []
  private toastTimer: ReturnType<typeof setTimeout> | null = null

  onPlay: (() => void) | null = null
  onReset: (() => void) | null = null
  onApplySeed: ((seed: string) => void) | null = null

  constructor() {
    MATERIAL_INFO.forEach((m, i) => {
      const el = document.createElement('div')
      el.className = 'slot'
      el.innerHTML =
        `<span class="key">${i + 1}</span>` +
        `<span class="swatch" style="background:${m.color}"></span>` +
        `<span class="label">${m.name}</span>` +
        `<span class="count">0</span>`
      this.hotbar.appendChild(el)
      this.slots.push(el)
      this.counts.push(el.querySelector('.count') as HTMLSpanElement)
    })
    this.setSlot(0)
    this.playButton.addEventListener('click', () => this.onPlay?.())
    this.resetButton.addEventListener('click', () => this.onReset?.())
    this.applySeedButton.addEventListener('click', () => this.onApplySeed?.(this.seedInput.value))
    this.seedInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.onApplySeed?.(this.seedInput.value)
    })
  }

  setSlot(index: number): void {
    this.slots.forEach((el, i) => el.classList.toggle('active', i === index))
  }

  /** 素材ごとの手持ち量をホットバーに反映する。 */
  setInventory(amounts: ArrayLike<number>): void {
    for (let i = 0; i < this.counts.length; i++) {
      const n = Math.floor(amounts[i] ?? 0)
      this.counts[i].textContent = String(n)
      this.slots[i].classList.toggle('empty', n <= 0)
    }
  }

  setBrush(label: string): void {
    this.brush.textContent = label
  }

  /** 短いメッセージを一時表示する。 */
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
