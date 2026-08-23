/** ゲーム側が `window.__smooth` に生やすデバッグ／テスト用フックの型。 */
export interface SmoothState {
  x: number
  y: number
  z: number
  onGround: boolean
  groundNormalY: number
  flying: boolean
  inWater: boolean
  trunks: number
  boxes: number
}

export interface SmoothDebug {
  frames: number
  ready: boolean
  edits: number
  loaded: number
  desired: number
  trees: number
  villages: number
  villageBoxes: number
  chopped: number
  seed: number
  tool: string
  timeOfDay: number
  timeFrozen: boolean
  inventory: number[]
  look(yaw: number, pitch: number): void
  state(): SmoothState
  teleport(x: number, z: number): void
  gotoVillage(): boolean
  nearestTree(): { x: number; y: number; z: number } | null
  giveMaterial(index: number, amount: number): void
  setTool(name: string): void
  setTime(hours: number | null): void
  setBrushRadius(r: number): void
  density(x: number, y: number, z: number): number
}

declare global {
  interface Window {
    __smooth?: SmoothDebug
  }
}
