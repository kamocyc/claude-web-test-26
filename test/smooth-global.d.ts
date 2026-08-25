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
  health: number
  mobs: number
  torches: number
  /** 置いた建築パーツの数。 */
  pieces: number
  inventory: number[]
  look(yaw: number, pitch: number): void
  state(): SmoothState
  teleport(x: number, z: number): void
  gotoVillage(): boolean
  nearestTree(): { x: number; y: number; z: number; r: number; h: number } | null
  treeColliders(): number[]
  dig(x: number, y: number, z: number, r?: number): void
  giveMaterial(index: number, amount: number): void
  give(id: string, amount: number): void
  itemCount(id: string): number
  equip(id: string): void
  craft(out: string): boolean
  craftable(): string[]
  setPanel(open: boolean): void
  setTrade(open: boolean): void
  spawnMob(kind: 'wraith' | 'deer' | 'villager', dx?: number, dz?: number): boolean
  mobCount(kind?: 'wraith' | 'deer' | 'villager'): number
  hitNearestMob(): boolean
  hurt(amount: number): void
  torchCount(): number
  setPiece(name: string): boolean
  /** 建築の向きのオフセット（度、5° に丸められる）。 */
  setBuildYaw(deg: number): void
  /** 基準点と向きを直接指定して建てる。 */
  buildAt(
    kind: string,
    x: number,
    y: number,
    z: number,
    itemId?: string,
    deg?: number,
  ): string
  /** 照準の点を渡して、本番と同じ吸着経路で建てる。 */
  buildAim(
    kind: string,
    x: number,
    y: number,
    z: number,
    itemId?: string,
    offsetDeg?: number,
  ): string
  pieceInfoAt(
    x: number,
    y: number,
    z: number,
    range?: number,
  ): { kind: string; x: number; y: number; z: number; deg: number; mat: number } | null
  removePieceAt(x: number, y: number, z: number, range?: number): boolean
  pieceCount(): number
  buildColliders(): number
  craftedVertices(): number
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
