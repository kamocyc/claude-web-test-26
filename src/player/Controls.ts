const MOUSE_SENSITIVITY = 0.0022
const MAX_PITCH = Math.PI / 2 - 0.001

/**
 * ポインタロックによる一人称の入力。
 * ゲームロジックが読む状態（keys / 視線角 / マウスボタン）を保持するだけの薄い層。
 */
export class Controls {
  yaw = 0
  pitch = 0
  locked = false

  readonly keys = new Set<string>()
  digging = false
  placing = false

  /** ホイールの累積量。読み出した側が 0 に戻す。 */
  wheel = 0

  onSlot: ((index: number) => void) | null = null
  onToggleFly: (() => void) | null = null
  /** B キー: ブラシの切り替え */
  onCycleTool: (() => void) | null = null
  /** T キー: 時刻の切り替え（デバッグ） */
  onCycleTime: (() => void) | null = null
  onLockChange: ((locked: boolean) => void) | null = null
  onToggleStats: (() => void) | null = null
  /** デバッグ: 最寄りの村へワープ */
  onWarpVillage: (() => void) | null = null

  private lastSpace = 0

  constructor(private readonly element: HTMLElement) {
    document.addEventListener('pointerlockchange', this.handleLockChange)
    document.addEventListener('mousemove', this.handleMouseMove)
    document.addEventListener('mousedown', this.handleMouseDown)
    document.addEventListener('mouseup', this.handleMouseUp)
    document.addEventListener('keydown', this.handleKeyDown)
    document.addEventListener('keyup', this.handleKeyUp)
    document.addEventListener('wheel', this.handleWheel, { passive: false })
    document.addEventListener('contextmenu', (e) => e.preventDefault())
    window.addEventListener('blur', () => this.reset())
  }

  requestLock(): void {
    void this.element.requestPointerLock()
  }

  reset(): void {
    this.keys.clear()
    this.digging = false
    this.placing = false
  }

  private handleLockChange = (): void => {
    this.locked = document.pointerLockElement === this.element
    if (!this.locked) this.reset()
    this.onLockChange?.(this.locked)
  }

  private handleMouseMove = (e: MouseEvent): void => {
    if (!this.locked) return
    this.yaw -= e.movementX * MOUSE_SENSITIVITY
    this.pitch -= e.movementY * MOUSE_SENSITIVITY
    if (this.pitch > MAX_PITCH) this.pitch = MAX_PITCH
    if (this.pitch < -MAX_PITCH) this.pitch = -MAX_PITCH
  }

  private handleMouseDown = (e: MouseEvent): void => {
    if (!this.locked) return
    if (e.button === 0) this.digging = true
    if (e.button === 2) this.placing = true
  }

  private handleMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) this.digging = false
    if (e.button === 2) this.placing = false
  }

  private handleWheel = (e: WheelEvent): void => {
    if (!this.locked) return
    e.preventDefault()
    this.wheel += e.deltaY
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'F3') {
      e.preventDefault()
      this.onToggleStats?.()
      return
    }
    if (!this.locked) return
    if (e.repeat) return
    this.keys.add(e.code)

    if (e.code === 'Space') {
      const now = performance.now()
      if (now - this.lastSpace < 300) {
        this.onToggleFly?.()
        this.lastSpace = 0
      } else {
        this.lastSpace = now
      }
    }

    if (e.code === 'KeyB') {
      this.onCycleTool?.()
      return
    }

    if (e.code === 'KeyT') {
      this.onCycleTime?.()
      return
    }

    if (e.code === 'KeyV') {
      this.onWarpVillage?.()
      return
    }

    if (e.code.startsWith('Digit')) {
      const n = Number(e.code.slice(5))
      if (n >= 1 && n <= 9) this.onSlot?.(n - 1)
    }
  }

  private handleKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code)
  }
}
