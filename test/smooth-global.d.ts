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
  /** 敷いた軌道の区間数。 */
  tracks: number
  /** 建てた駅の数と、走っている列車の数。 */
  stations: number
  trains: number
  /** 列車に乗っているか。 */
  riding: boolean
  /** 列車にはねられた回数。 */
  trainHits: number
  /** デバッグ用の無制限モードが入っているか。 */
  unlimited: boolean
  inventory: number[]
  look(yaw: number, pitch: number): void
  state(): SmoothState
  teleport(x: number, z: number): void
  /** 高さも指定して置く（足場の上へ直に降ろせる）。 */
  placeAt(x: number, y: number, z: number): void
  gotoVillage(): boolean
  nearestTree(): { x: number; y: number; z: number; r: number; h: number } | null
  treeColliders(): number[]
  dig(x: number, y: number, z: number, r?: number, depth?: number): void
  fill(x: number, y: number, z: number, r?: number, itemId?: string): void
  giveMaterial(index: number, amount: number): void
  give(id: string, amount: number): void
  itemCount(id: string): number
  /** 無制限モードでも変わらない、実際に溜めてある量。 */
  storedCount(id: string): number
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
  surfaceAt(x: number, z: number): number
  /** デバッグ用の無制限モードを切り替える（F4 と同じ）。戻り値はいまの状態。 */
  setUnlimited(on: boolean): boolean
  /** 近くの区間を敷くのに要る材料（軌道のぶんと、切り盛りする土の量）。 */
  trackCostAt(
    x: number,
    y: number,
    z: number,
  ): { rail: number; fill: number; cut: number } | null
  trackCount(): number
  trackColliders(): number
  /** 軌道の種類（rail / road）を選ぶ。 */
  setTrackKind(name: string): boolean
  /** 勾配を % で決める（null で自動＝地形なり）。 */
  setTrackGrade(percent: number | null): void
  /** いまの勾配（%）。自動なら null。 */
  trackGrade(): number | null
  /** 敷かずに見積もりだけを返す。 */
  trackPreview(
    x: number,
    y: number,
    z: number,
  ): {
    check: string
    trim: string
    wanted: number
    length: number
    grade: number
    curve: number
  }
  /** 1 区間の長さ（m）。 */
  setTrackLength(m: number): void
  /** 照準の点を渡して、本番と同じ経路で敷く。 */
  trackAim(x: number, y: number, z: number, itemId?: string): string
  trackAt(
    x: number,
    y: number,
    z: number,
    range?: number,
  ): {
    kind: string
    x: number
    y: number
    z: number
    yaw: number
    curve: number
    length: number
    rise: number
    mat: number
    endX: number
    endY: number
    endZ: number
    endYaw: number
  } | null
  /** 敷いてある区間を敷いた順に並べたもの。 */
  trackList(): {
    kind: string
    x: number
    y: number
    z: number
    endX: number
    endY: number
    endZ: number
    length: number
    curve: number
  }[]
  removeTrackAt(x: number, y: number, z: number, range?: number): boolean
  stationCount(): number
  stationList(): { x: number; y: number; z: number; mat: number }[]
  /** 線路の上に駅を建てる。'ok' | 'notrack' | 'tooclose' | 'short' | 'material' */
  placeStation(x: number, y: number, z: number, itemId?: string): string
  stationAt(x: number, y: number, z: number, range?: number): number
  removeStationAt(x: number, y: number, z: number, range?: number): boolean
  /** 駅を路線に加える。 */
  selectStation(index: number): boolean
  routeSelection(): number[]
  clearRoute(): void
  /** 選んだ路線で列車を発車させる。'ok' | 'short-route' | 'short' | 'badroute' | 'material' */
  depart(itemId?: string): string
  trainCount(): number
  trainInfo(index?: number): {
    x: number
    y: number
    z: number
    yaw: number
    speed: number
    running: boolean
    stuck: boolean
    hop: number
    dir: number
    dwell: number
    total: number
    traveled: number
    route: number[]
  } | null
  removeTrainAt(x: number, y: number, z: number, range?: number): boolean
  rideTrain(): boolean
  leaveTrain(): void
  /** いま乗っているか（乗り降りした直後でも正しい）。 */
  isRiding(): boolean
  /** 車体の当たり判定（`[前半, 運転台]` の 2 つ）。 */
  trainColliders(index?: number): {
    ox: number
    oz: number
    minX: number
    maxX: number
    minZ: number
    maxZ: number
    minY: number
    maxY: number
  }[]
  /** いま列車の上に立っているか。立っていればその天面の高さ。 */
  standingOnTrain(): number | null
  /** いま居る MOB の一覧。 */
  mobList(): {
    kind: string
    x: number
    y: number
    z: number
    vx: number
    vy: number
    vz: number
    hp: number
  }[]
  /** 指定の場所に MOB を湧かせる。 */
  spawnMobAt(kind: 'wraith' | 'deer' | 'villager', x: number, y: number, z: number): boolean
  /** いま伸ばそうとしている端点。 */
  railhead(): { x: number; y: number; z: number; yaw: number } | null
  clearRailhead(): void
  craftedVertices(): number
  setTool(name: string): void
  setTime(hours: number | null): void
  setBrushRadius(r: number): void
  /** 1 回で削る深さ（m）。0 以下で「一気に」。 */
  setDigDepth(m: number): void
  /** いまの掘る強さ（m/回）。「一気に」なら Infinity。 */
  digDepth(): number
  /** いま照準が指している点の勾配。狙っていなければ null。 */
  gradeReading(): {
    rise: number
    run: number
    grade: number
    degrees: number
    level: boolean
    vertical: boolean
  } | null
  density(x: number, y: number, z: number): number
}

declare global {
  interface Window {
    __smooth?: SmoothDebug
  }
}
