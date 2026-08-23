import { MATERIAL_INFO } from '../world/constants'

/** DOM だけで完結する軽量 HUD。 */
export class Hud {
  private readonly stats = document.getElementById('stats') as HTMLDivElement
  private readonly hotbar = document.getElementById('hotbar') as HTMLDivElement
  private readonly brush = document.getElementById('brush') as HTMLDivElement
  private readonly overlay = document.getElementById('overlay') as HTMLDivElement
  private readonly loading = document.getElementById('loading') as HTMLDivElement
  private readonly playButton = document.getElementById('play') as HTMLButtonElement
  private readonly resetButton = document.getElementById('reset') as HTMLButtonElement
  private readonly slots: HTMLDivElement[] = []

  onPlay: (() => void) | null = null
  onReset: (() => void) | null = null

  constructor() {
    MATERIAL_INFO.forEach((m, i) => {
      const el = document.createElement('div')
      el.className = 'slot'
      el.innerHTML = `<span class="key">${i + 1}</span><span class="swatch" style="background:${m.color}"></span><span class="label">${m.name}</span>`
      this.hotbar.appendChild(el)
      this.slots.push(el)
    })
    this.setSlot(0)
    this.playButton.addEventListener('click', () => this.onPlay?.())
    this.resetButton.addEventListener('click', () => this.onReset?.())
  }

  setSlot(index: number): void {
    this.slots.forEach((el, i) => el.classList.toggle('active', i === index))
  }

  setBrush(radius: number): void {
    this.brush.textContent = `ブラシ半径 ${radius.toFixed(1)} m`
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

  setPlayEnabled(enabled: boolean): void {
    this.playButton.disabled = !enabled
    this.playButton.style.opacity = enabled ? '1' : '0.5'
  }
}
