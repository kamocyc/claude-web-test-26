import * as THREE from 'three'
import { Renderer } from './engine/Renderer'
import { SkyDayNight } from './engine/SkyDayNight'
import { Water } from './engine/Water'
import { createGlassMaterial, createTerrainMaterial } from './render/TerrainMaterial'
import { createNoiseTexture } from './render/proceduralTextures'
import { createTreePrototypes, treeMaterial } from './render/treeMeshes'
import { VillageManager } from './world/VillageManager'
import type { Box } from './world/village'
import { worldToLocal } from './world/collision'
import type { Collider } from './world/collision'
import { World, createTreeHit } from './world/World'
import { boxBrush, orientedBoxBrush, snapBoxCenter, sphereBrush } from './world/edits'
import type { BrushBounds } from './world/edits'
import { WorldStore } from './world/storage'
import {
  CHUNK_SIZE,
  MATERIAL_INFO,
  MAT_PLANK,
  MAT_ROCK,
  NATURAL_MATERIAL_COUNT,
  SAMPLE_SEED,
  SEA_LEVEL,
  VILLAGE_CELL,
} from './world/constants'
import { Player, PLAYER_EYE } from './player/Player'
import { Controls } from './player/Controls'
import { createRayHit, raycastTerrain } from './player/terrainRaycast'
import { Hud } from './ui/hud'
import { Inventory } from './items/Inventory'
import { ITEM_BY_MATERIAL, RECIPES, TRADES, item, tryItem } from './items/items'
import { MobManager } from './mobs/MobManager'
import { TorchManager } from './world/TorchManager'
import { BuildManager } from './build/BuildManager'
import type { PlaceCheck, SnapResult } from './build/BuildGrid'
import {
  BUILD_CELL,
  PIECE_COST,
  PIECE_KINDS,
  PIECE_NAME,
  YAW_STEP,
  normalizeYaw,
  yawDeg,
} from './build/pieces'
import type { PieceKind } from './build/pieces'
import { TrackManager } from './track/TrackManager'
import type { TrackEnd, TrackPlan } from './track/TrackManager'
import {
  DEFAULT_SEG_LEN,
  GRADE_TOL,
  MAX_SEG_LEN,
  MIN_SEG_LEN,
  TRACK_INFO,
  TRACK_KINDS,
  segmentCost,
  segmentEnd,
} from './track/track'
import type { Segment, TrackKind } from './track/track'
import { gradeOps, gradeVolume } from './track/grading'
import { MAX_PILLAR } from './track/TrackGraph'
import { TrainManager } from './train/TrainManager'
import { CAR_LEN, STATION_COST, TRAIN_COST } from './train/trains'
import type { Train } from './train/trains'
import { carColliders, trainImpact } from './train/impact'
import type { Impact } from './train/impact'

const VIEW_DISTANCE = 7
const REACH = 9
const MIN_BRUSH = 1
const MAX_BRUSH = 6
const EDIT_INTERVAL = 0.09
const CHOP_INTERVAL = 0.25
const ATTACK_INTERVAL = 0.42
const MAX_HEALTH = 20
/** ダメージを受けてから回復が始まるまでの秒数。 */
const REGEN_DELAY = 7
const REGEN_RATE = 1.1

/** B キーで切り替わるブラシ。 */
const TOOLS = [
  { id: 'sphere', name: '球' },
  { id: 'box', name: '直方体' },
  { id: 'smooth', name: 'ならし' },
  { id: 'build', name: '建築' },
  { id: 'track', name: '軌道' },
  { id: 'station', name: '駅・列車' },
] as const

/** 建築モードの操作間隔（秒）。 */
const BUILD_INTERVAL = 0.18
const DEMOLISH_INTERVAL = 0.25

/** 軌道モードの操作間隔（秒）。1 区間が長いので建築より少し重くする。 */
const TRACK_INTERVAL = 0.24

/** 敷けない理由の説明。 */
const TRACK_REASON: Record<string, string> = {
  overlap: 'そこには他の軌道と重なってしまいます',
  buried: '切土が深すぎます（先に掘って切通しを作ってください）',
  toohigh: '高すぎて橋脚が立てられません',
  kink: '繋ぐ相手との向きが違いすぎます（回り込んでください）',
  blocked: '建物にぶつかります（避けるか、先に壊してください）',
}

/** 狙った長さに届かなかったときの、短くなった理由。 */
const TRIM_REASON: Record<string, string> = {
  buried: '斜面にぶつかった',
  toohigh: '谷が深すぎた',
  blocked: '建物にぶつかった',
}

/** Shift + ホイールで動かす勾配の刻み（0.5 %）。 */
const GRADE_UI_STEP = 0.005

/** 駅・列車モードで、狙点の近くの駅／列車を拾う距離（m）。 */
const STATION_PICK = 6
const TRAIN_PICK = 5

/** 列車に乗り込める距離（m）と、降りたときに脇へよける距離（m）。 */
const RIDE_RANGE = 4.5
const RIDE_OFF = 2.6

/** 一度はねられてから、次にはねられるまでの間（秒）。轢かれ続けないための猶予。 */
const TRAIN_HIT_COOLDOWN = 1.2
/** はね飛ばされたときに地面から浮かせる高さ（m）。摩擦に食われないようにする。 */
const TRAIN_HIT_LIFT_OFF = 0.15

/** 狙点の近くでレールヘッドを拾う距離（m）。 */
const RAILHEAD_RANGE = 4
/** 握っているレールヘッドから離れすぎたら手放す距離（m）。 */
const RAILHEAD_DROP = 60

/** T キーで巡回するデバッグ用の時刻。`null` は自動で進む状態。 */
const TIME_PRESETS: Array<{ name: string; t: number } | null> = [
  null,
  { name: '朝', t: 7 / 24 },
  { name: '昼', t: 12 / 24 },
  { name: '夕', t: 18 / 24 },
  { name: '夜', t: 0 },
]

/**
 * 粒状の素材のブラシ半径の上限。
 * どのみち崩れて広がるので、これ以上大きくしても山の形は変わらず計算量だけ増える。
 */
const MAX_PILE_RADIUS = 3.5

const MIN_BOX_EDGE = 2
/** これ以上大きくすると 1 回の掘削が 10ms を超えてカクつく。 */
const MAX_BOX_EDGE = 8

/**
 * ホイールのブラシ半径を直方体の一辺（m）に写す。
 * 整数にしておくと半サイズが 0.5 の倍数になり、
 * 面を格子平面にぴったり乗せられる（= 稜が丸まらない）。
 */
export function boxEdge(radius: number): number {
  const t = Math.max(0, Math.min(1, (radius - MIN_BRUSH) / (MAX_BRUSH - MIN_BRUSH)))
  return Math.round(MIN_BOX_EDGE + t * (MAX_BOX_EDGE - MIN_BOX_EDGE))
}
const SEED_STORAGE_KEY = 'smooth-world:seed'

/**
 * シード文字列を数値に変換する。
 * 整数はそのまま、それ以外の文字列は FNV-1a でハッシュするので
 * `?seed=demo` のような指定もできる。`random` だけ特別扱い。
 */
export function parseSeed(raw: string | null | undefined): number | null {
  if (raw == null) return null
  const t = raw.trim()
  if (t === '') return null
  if (t.toLowerCase() === 'random') return Math.floor(Math.random() * 2147483647)
  if (/^-?\d+$/.test(t)) return Math.abs(Number(t)) % 2147483647
  let h = 2166136261
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) % 2147483647
}

/** URL → 前回のシード → サンプル用の固定シード、の順で決める。 */
function resolveSeed(): number {
  const fromUrl = parseSeed(new URLSearchParams(location.search).get('seed'))
  if (fromUrl !== null) return fromUrl
  try {
    const saved = parseSeed(localStorage.getItem(SEED_STORAGE_KEY))
    if (saved !== null) return saved
  } catch {
    // localStorage が使えない環境ではサンプルシードにフォールバックする
  }
  return SAMPLE_SEED
}

async function boot(): Promise<void> {
  const hud = new Hud()
  hud.setPlayEnabled(false)
  hud.setLoading('ワールドを準備しています…')

  const seed = resolveSeed()
  try {
    localStorage.setItem(SEED_STORAGE_KEY, String(seed))
  } catch {
    // 保存できなくても動作には影響しない
  }
  hud.setSeed(seed)

  const store = new WorldStore(seed)
  const hasDb = await store.open()
  const meta = hasDb ? await store.loadMeta() : null

  const engine = new Renderer(VIEW_DISTANCE)
  const scene = engine.scene
  const camera = engine.camera

  const world = new World({ seed, viewDistance: VIEW_DISTANCE, store })
  world.setMaterial(createTerrainMaterial(createNoiseTexture()), createGlassMaterial())
  world.setTreeAssets(createTreePrototypes(), treeMaterial)
  scene.add(world.group)

  const villages = new VillageManager(world.field)
  scene.add(villages.group)
  store.setEditSource((key) => world.getEdits(key))
  if (hasDb) world.setEdits(await store.loadAllEdits())
  if (meta?.chopped) world.setChopped(meta.chopped)

  // 持ち物。地形の素材は体積、資源・道具は個数で数える。
  const inventory = new Inventory()
  if (meta?.inventory) inventory.load(meta.inventory)
  hud.bind(inventory)

  const mobs = new MobManager()
  // MOB 用の木バッファ。プレイヤーの分を上書きしないよう別に持つ
  const mobTrunkBuf = new Float32Array(200 * 5)
  scene.add(mobs.group)
  const torches = new TorchManager(scene)
  if (meta?.torches) torches.load(meta.torches)

  // 建てた壁や床。地形の密度場とは別レイヤに持ち、当たり判定だけ村の建物と同じ土俵に合流する
  const build = new BuildManager(scene)
  // pieces2 が新形式。格子だった頃の pieces しか無いワールドは移して読む
  if (meta?.pieces2) build.load(meta.pieces2)
  else if (meta?.pieces) build.loadLegacy(meta.pieces, BUILD_CELL)

  // 敷いた線路と道路。建築パーツと同じく地形とは別レイヤに持ち、当たり判定だけ合流する
  const tracks = new TrackManager(scene)
  if (meta?.tracks) tracks.load(meta.tracks)

  // 駅と列車。線路の網（経路探索）はここが持ち、線路が変わるたびに組み直す
  const trains = new TrainManager(scene)
  trains.rebuildNetwork(tracks.graph.segments())
  if (meta?.stations || meta?.trainRoutes) trains.load(meta.stations, meta.trainRoutes)

  let health = typeof meta?.health === 'number' ? meta.health : MAX_HEALTH
  let sinceHurt = REGEN_DELAY
  hud.setHealth(health, MAX_HEALTH)

  const sky = new SkyDayNight(scene, camera.far * 0.5)
  if (meta) sky.timeOfDay = meta.timeOfDay

  const water = new Water()
  scene.add(water.mesh)

  const VIEW_RANGE = VIEW_DISTANCE * CHUNK_SIZE
  const boxScratch: Box[] = []

  const player = new Player()
  if (meta) {
    player.position.set(meta.px, meta.py, meta.pz)
    player.flying = meta.flying
  } else {
    player.spawnAt(world, 0.5, 0.5)
  }

  const controls = new Controls(engine.renderer.domElement)
  if (meta) {
    controls.yaw = meta.yaw
    controls.pitch = meta.pitch
  }

  // --- 照準のゴースト表示 ---
  const ghost = new THREE.Mesh(
    new THREE.SphereGeometry(1, 24, 16),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      wireframe: true,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      fog: false,
    }),
  )
  ghost.visible = false
  scene.add(ghost)

  // 直方体ブラシは実際に削れる範囲（格子に合わせて丸めたあとの箱）をそのまま出す
  const boxGhost = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
    new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      fog: false,
    }),
  )
  boxGhost.visible = false
  scene.add(boxGhost)

  /** HUD に出すブラシの説明。 */
  function brushLabel(note: string | null = null): string {
    if (note) return note
    const t = TOOLS[tool]
    const held = inventory.held()
    const grain =
      t.id !== 'smooth' && held?.material !== undefined && MATERIAL_INFO[held.material].repose > 0
        ? `　${held.name}は崩れて積もる`
        : ''
    const hand = held ? `　［${held.name}］` : '　［素手］'
    if (t.id === 'build') {
      const k = PIECE_KINDS[pieceIndex]
      const turn = buildYawOffset === 0 ? '' : ` ${yawDeg(buildYawOffset)}°`
      return `${t.name} ${PIECE_NAME[k]}（${PIECE_COST[k]}）${hand}${turn}　R:種類　ホイール:5°`
    }
    if (t.id === 'track') {
      const info = TRACK_INFO[TRACK_KINDS[trackIndex]]
      const cost = trackPlan ? `　材料 ${planCost(trackPlan.seg).label}` : ''
      const head = trackPlan?.from ? '' : '　新しい線'
      // 狙った長さに届かないときは、実際の長さと理由も出す
      const cut =
        trackPlan && trackPlan.trim !== 'none'
          ? ` → ${trackPlan.seg.length.toFixed(1)} m（${TRIM_REASON[trackPlan.trim]}）`
          : ''
      const grade =
        trackGrade === null ? '自動' : `${(trackGrade * 100 >= 0 ? '+' : '')}${(trackGrade * 100).toFixed(1)}%`
      return (
        `${t.name} ${info.name}${cost}${hand}${head}` +
        `　長さ ${segLen} m${cut}　勾配 ${grade}` +
        `　R:種類　ホイール:長さ　Shift:勾配　G:自動`
      )
    }
    if (t.id === 'station') {
      const picked =
        routeSel.length === 0
          ? '　駅に照準を合わせて右クリックで路線に追加'
          : `　路線: ${routeSel.map((i) => `駅${i + 1}`).join(' → ')}${
              routeSel.length >= 2 ? `　R:発車（${TRAIN_COST}）` : ''
            }`
      return `${t.name}（駅 ${STATION_COST}）${hand}${picked}`
    }
    if (t.id === 'box') {
      const n = boxEdge(brushRadius)
      return `${t.name} ${n}×${n}×${n} m${hand}${grain}`
    }
    return `${t.name} 半径 ${brushRadius.toFixed(1)} m${hand}${grain}`
  }

  let brushRadius = 2.5
  let tool = 0
  /** 建築モードで選んでいるパーツと、向きのオフセット（5° 刻みの 0..71）。 */
  let pieceIndex = 0
  let buildYawOffset = 0
  /** 軌道モードで選んでいる種類と、1 区間の長さ（m）。 */
  let trackIndex = 0
  let segLen = DEFAULT_SEG_LEN
  /**
   * 手で決めた勾配（1 = 45°）。`null` なら**終点の地面に合わせて自動**。
   * Shift + ホイールで動かし、`G` で自動へ戻す。
   */
  let trackGrade: number | null = null
  /** 同じ理由のトーストを何度も出さないための覚え書き。 */
  let lastTrim = 'none'
  /** いま伸ばしている端点（レールヘッド）。中クリックで手放して新しい線を始められる。 */
  let railhead: TrackEnd | null = null
  /**
   * 敷設の見積もり（近くの端点集めと重なり判定）も毎フレームは重いので、
   * 建築と同じく**照準が 5 cm 以上動くか、種類・長さ・素材が変わったときだけ**やり直す。
   * `brushLabel()` が材料の表示に読むので、ここで持つ。
   */
  let trackKey = ''
  /** 敷く前に見積もった材料（照準が動いたら作り直す）。 */
  let trackCostCache: { total: number; label: string } | null = null
  let trackPlan: TrackPlan | null = null
  /** 路線を組み立てている最中に選んだ駅（選んだ順）。 */
  let routeSel: number[] = []
  /** いま乗っている列車。 */
  let riding: Train | null = null
  /** 起動からの経過秒。はねられた間隔を測るのに使う。 */
  let elapsed = 0
  /** 次にはねられるまでの残り時間（プレイヤーぶん）。 */
  let trainHitCd = 0
  /** MOB がはねられた時刻。消えた MOB を掴んだままにしないよう WeakMap で持つ。 */
  const mobHitAt = new WeakMap<object, number>()
  /** 当たり判定と、はねられた結果の置き場（毎フレーム使い回す）。 */
  const carScratch: Collider[] = []
  const impactScratch: Impact = { nx: 0, nz: 0, push: 0, lift: 0, damage: 0 }
  const roofScratch = [0, 0]

  function invalidateTrack(): void {
    trackKey = ''
    trackCostCache = null
  }
  let statsVisible = true
  let started = false
  let editCooldown = 0
  hud.setBrush(brushLabel())

  controls.onSlot = (i) => {
    if (i >= inventory.hotbar.length) return
    inventory.selected = i
    hud.refresh()
    hud.setBrush(brushLabel())
  }
  hud.onSelectSlot = (i) => controls.onSlot?.(i)
  controls.onToggleFly = () => player.toggleFly()
  let timePreset = 0
  function applyTimePreset(): void {
    const p = TIME_PRESETS[timePreset]
    sky.paused = p !== null
    if (p) sky.timeOfDay = p.t
    markMetaDirty()
  }
  controls.onCycleTime = () => {
    timePreset = (timePreset + 1) % TIME_PRESETS.length
    applyTimePreset()
    const p = TIME_PRESETS[timePreset]
    hud.showToast(p ? `時刻: ${p.name}（固定）` : '時刻: 自動で進む')
  }
  controls.onCycleTool = () => {
    tool = (tool + 1) % TOOLS.length
    hud.showToast(`ブラシ: ${TOOLS[tool].name}`)
    hud.setBrush(brushLabel())
  }
  controls.onResetRotation = () => {
    if (TOOLS[tool].id === 'station') {
      if (routeSel.length === 0) return
      clearRouteSelection()
      hud.setBrush(brushLabel())
      hud.showToast('選んだ路線を取り消しました')
      return
    }
    if (TOOLS[tool].id === 'track') {
      if (!railhead) return
      railhead = null
      invalidateTrack()
      hud.showToast('接続を切りました（次はここから新しい線を始めます）')
      return
    }
    if (TOOLS[tool].id !== 'build' || buildYawOffset === 0) return
    buildYawOffset = 0
    invalidateBuild()
    hud.setBrush(brushLabel())
    hud.showToast('向きを既定に戻しました')
  }
  controls.onCyclePiece = () => {
    if (TOOLS[tool].id === 'station') {
      departRoute()
      hud.setBrush(brushLabel())
      return
    }
    if (TOOLS[tool].id === 'track') {
      trackIndex = (trackIndex + 1) % TRACK_KINDS.length
      // 種類が変わると繋げる相手も変わるので、握っていた端点は手放す
      railhead = null
      invalidateTrack()
      hud.showToast(`軌道: ${TRACK_INFO[TRACK_KINDS[trackIndex]].name}`)
      hud.setBrush(brushLabel())
      return
    }
    if (TOOLS[tool].id !== 'build') {
      hud.showToast('建築・軌道・駅のモードで使えます（B で切替）')
      return
    }
    pieceIndex = (pieceIndex + 1) % PIECE_KINDS.length
    hud.showToast(`パーツ: ${PIECE_NAME[PIECE_KINDS[pieceIndex]]}`)
    hud.setBrush(brushLabel())
  }
  controls.onWarpVillage = () => {
    hud.showToast(stats.gotoVillage() ? '最寄りの村へワープしました' : '近くに村が見つかりません')
  }
  controls.onToggleStats = () => {
    statsVisible = !statsVisible
    hud.setStatsVisible(statsVisible)
  }
  controls.onToggleUnlimited = () => setUnlimited(!inventory.unlimited)
  controls.onResetGrade = () => {
    if (TOOLS[tool].id !== 'track') return
    trackGrade = null
    invalidateTrack()
    hud.setBrush(brushLabel())
    hud.showToast('勾配を自動（地形なり）に戻した')
  }

  /**
   * デバッグ用の無制限モード。溜めた量はそのままに、支払いだけを素通しにする。
   * 何を建てても減らないので、線路や建築の形をいろいろ試すのに使う。
   */
  function setUnlimited(on: boolean): void {
    if (inventory.unlimited === on) return
    inventory.unlimited = on
    hud.refresh()
    hud.setBrush(brushLabel())
    invalidateTrack()
    hud.showToast(on ? 'デバッグ: 材料を無制限にした（F4 で戻す）' : '材料の制限を戻した')
  }
  controls.onLockChange = (locked) => {
    if (!locked && started && !hud.panelOpen && !hud.tradeOpen) hud.setOverlay(true)
  }

  hud.onPlay = () => {
    hud.setOverlay(false)
    controls.requestLock()
    started = true
  }
  hud.onReset = async () => {
    hud.setPlayEnabled(false)
    hud.setLoading('リセット中…')
    await store.clear()
    world.setEdits(new Map())
    world.setChopped([])
    inventory.clear()
    torches.clear()
    build.clear()
    tracks.clear()
    trains.clear()
    stats.trainHits = 0
    railhead = null
    riding = null
    routeSel = []
    mobs.clear()
    health = MAX_HEALTH
    hud.setHealth(health, MAX_HEALTH)
    player.spawnAt(world, 0.5, 0.5)
    hud.setLoading('')
    hud.setPlayEnabled(true)
  }

  hud.onApplySeed = (value) => {
    const next = parseSeed(value)
    if (next === null) {
      hud.showToast('シードを入力してください')
      return
    }
    void store.flush()
    void store.saveMeta(snapshot())
    const url = new URL(location.href)
    url.searchParams.set('seed', String(next))
    location.href = url.toString()
  }

  window.addEventListener('beforeunload', () => {
    void store.flush()
    void store.saveMeta(snapshot())
  })

  function snapshot() {
    return {
      seed,
      px: player.position.x,
      py: player.position.y,
      pz: player.position.z,
      yaw: controls.yaw,
      pitch: controls.pitch,
      timeOfDay: sky.timeOfDay,
      flying: player.flying,
      inventory: inventory.toJSON(),
      torches: [...torches.torches],
      pieces2: build.serialize(),
      tracks: tracks.serialize(),
      stations: trains.serialize().stations,
      trainRoutes: trains.serialize().trains,
      health,
      chopped: world.choppedList,
    }
  }

  /**
   * デバッグ／自動テスト用のフック。`window.__smooth` から触れる。
   */
  const stats = {
    frames: 0,
    ready: false,
    edits: 0,
    loaded: 0,
    desired: 0,
    trees: 0,
    villages: 0,
    villageBoxes: 0,
    chopped: 0,
    seed,
    /** 現在のブラシ。 */
    tool: TOOLS[0].id as string,
    /** 時刻 [0,1)。0.5 が正午。 */
    timeOfDay: 0,
    /** 時刻を固定しているか。 */
    timeFrozen: false,
    /** 体力。 */
    health: MAX_HEALTH,
    /** いま存在する MOB の数。 */
    mobs: 0,
    /** 置いた松明の数。 */
    torches: 0,
    /** 置いた建築パーツの数。 */
    pieces: 0,
    /** 敷いた軌道の区間数。 */
    tracks: 0,
    /** 建てた駅の数と、走っている列車の数。 */
    stations: 0,
    trains: 0,
    /** 列車に乗っているか。 */
    riding: false,
    /** 列車にはねられた回数。 */
    trainHits: 0,
    /** デバッグ用の無制限モードが入っているか。 */
    unlimited: false,
    /** 素材の手持ち量（grass, dirt, rock, sand）。 */
    inventory: [0, 0, 0, 0] as number[],
    /** 視線角を直接設定する。 */
    look(yaw: number, pitch: number) {
      controls.yaw = yaw
      controls.pitch = pitch
    },
    /** プレイヤーの現在の状態。 */
    state() {
      return {
        x: player.position.x,
        y: player.position.y,
        z: player.position.z,
        onGround: player.onGround,
        groundNormalY: player.groundNormalY,
        flying: player.flying,
        inWater: player.inWater,
        trunks: player.trunks ? player.trunks.length / 5 : 0,
        boxes: player.boxes.length,
      }
    },
    /** 指定座標の地表へ移動する。 */
    teleport(x: number, z: number) {
      player.spawnAt(world, x, z)
      // 落下待ちを挟まずすぐ接地するよう、地面のすぐ上に置く
      player.position.y -= 1.0
      world.update(x, player.position.y, z)
    },
    /**
     * 高さも指定して置く（テスト用）。地表を探さないので、
     * 列車の屋根の上のような**足場の上**へ直に降ろせる。
     */
    placeAt(x: number, y: number, z: number) {
      player.position.set(x, y, z)
      player.velocity.set(0, 0, 0)
      world.update(x, y, z)
    },
    /** 一番近い木の根元の位置と幹の当たり判定（デバッグ／テスト用）。 */
    nearestTree(): { x: number; y: number; z: number; r: number; h: number } | null {
      const t = world.collectTrunks(
        player.position.x,
        player.position.y,
        player.position.z,
        14,
      )
      let best: { x: number; y: number; z: number; r: number; h: number } | null = null
      let bestD = Infinity
      // 1 本の木は幹→枝葉の順に並ぶ。距離が同じなら先勝ちなので必ず幹が返る
      for (let i = 0; i < t.length; i += 5) {
        const d = Math.hypot(t[i] - player.position.x, t[i + 2] - player.position.z)
        if (d < bestD) {
          bestD = d
          best = { x: t[i], y: t[i + 1], z: t[i + 2], r: t[i + 3], h: t[i + 4] }
        }
      }
      return best
    },
    /** 指定座標を球ブラシで掘る（テスト用。照準を通さず直接叩く）。 */
    dig(x: number, y: number, z: number, r = 2.5) {
      world.applyBrush(x, y, z, sphereBrush(r), 'dig', MATERIAL_INFO[0].id)
    },
    /** 指定座標へ球ブラシで盛る（テスト用。照準を通さず直接叩く）。 */
    fill(x: number, y: number, z: number, r = 2.5, itemId = 'rock') {
      const def = tryItem(itemId)
      if (def?.material === undefined) return
      world.applyBrush(x, y, z, sphereBrush(r), 'place', def.material)
    },
    /** 近くの木の当たり判定（縦円柱。x, y, 半径, 高さ の順で 5 要素ずつ）。 */
    treeColliders(): number[] {
      return Array.from(
        world.collectTrunks(player.position.x, player.position.y, player.position.z, 10),
      )
    },
    /** 時刻を時（0〜24）で固定する。null で自動に戻す。 */
    setTime(hours: number | null) {
      if (hours === null) {
        timePreset = 0
      } else {
        timePreset = -1
        sky.timeOfDay = ((hours / 24) % 1 + 1) % 1
      }
      sky.paused = hours !== null
      markMetaDirty()
    },
    /** ブラシを切り替える（テスト用）。 */
    setTool(name: string) {
      const i = TOOLS.findIndex((t) => t.id === name)
      if (i >= 0) {
        tool = i
        hud.setBrush(brushLabel())
      }
    },
    /** ブラシの大きさを設定する（テスト用）。 */
    setBrushRadius(r: number) {
      brushRadius = clamp(r, MIN_BRUSH, MAX_BRUSH)
      hud.setBrush(brushLabel())
    },
    /** 密度場の値。> 0 が固体。 */
    density(x: number, y: number, z: number): number {
      return world.densityAt(x, y, z)
    },
    /** 素材の手持ち量を直接与える（テスト用、0=草 1=土 2=岩 3=砂）。 */
    giveMaterial(index: number, amount: number) {
      const def = ITEM_BY_MATERIAL.get(index)
      if (def) inventory.add(def.id, amount)
    },
    /** 任意のアイテムを与える（テスト用）。 */
    give(id: string, amount: number) {
      inventory.add(id, amount)
    },
    /** 持ち物の個数。 */
    itemCount(id: string): number {
      return inventory.whole(id)
    },
    /** 無制限モードでも変わらない、実際に溜めてある量（テスト用）。 */
    storedCount(id: string): number {
      return Math.floor(inventory.stored(id))
    },
    /** ホットバーの枠にアイテムを入れて選ぶ（テスト用）。 */
    equip(id: string) {
      inventory.assign(inventory.selected, id)
      hud.refresh()
    },
    /** レシピ ID を指定して作る。作れなければ false。 */
    craft(out: string): boolean {
      const r = RECIPES.find((x) => x.out === out)
      if (!r) return false
      const ok = inventory.craft(r)
      if (ok) markMetaDirty()
      return ok
    },
    /** 作れるレシピの一覧。 */
    craftable(): string[] {
      return RECIPES.filter((r) => inventory.canCraft(r)).map((r) => r.out)
    },
    /** 持ち物とクラフトの画面を開閉する。 */
    setPanel(open: boolean) {
      setPanel(open)
    },
    /** 交換画面を開閉する。 */
    setTrade(open: boolean) {
      setTradePanel(open)
    },
    /** MOB を目の前に湧かせる（テスト用）。 */
    spawnMob(kind: 'wraith' | 'deer' | 'villager', dx = 3, dz = 0) {
      const x = player.position.x + dx
      const z = player.position.z + dz
      return mobs.spawn(kind, x, world.field.height(x, z) + 0.5, z) !== null
    },
    /** MOB の数。 */
    mobCount(kind?: 'wraith' | 'deer' | 'villager'): number {
      return kind ? mobs.count(kind) : mobs.total
    },
    /** いちばん近い MOB を殴る（テスト用）。倒したら true。 */
    hitNearestMob(): boolean {
      let best = null as null | (typeof mobs.mobs)[number]
      let bd = 6
      for (const m of mobs.mobs) {
        const d = Math.hypot(m.pos.x - player.position.x, m.pos.z - player.position.z)
        if (d < bd) {
          bd = d
          best = m
        }
      }
      if (!best) return false
      return mobs.hurt(best, inventory.attack(), player.position.x, player.position.z)
    },
    /** ダメージを受ける（テスト用）。 */
    hurt(amount: number) {
      hurtPlayer(amount)
    },
    /** 松明の数。 */
    torchCount(): number {
      return torches.count
    },
    /** クラフトした建材が乗っている頂点の数（ワーカーまで届いているかの確認）。 */
    craftedVertices(): number {
      return world.countCraftedVertices()
    },
    /** 建築パーツを選ぶ（テスト用）。 */
    setPiece(name: string): boolean {
      const i = PIECE_KINDS.indexOf(name as PieceKind)
      if (i < 0) return false
      pieceIndex = i
      hud.setBrush(brushLabel())
      return true
    },
    /** 建築の向きのオフセットを度で与える（テスト用。5° に丸められる）。 */
    setBuildYaw(deg: number) {
      buildYawOffset = normalizeYaw(deg / 5)
      invalidateBuild()
      hud.setBrush(brushLabel())
    },
    /**
     * 基準点と向きを直接指定して建てる（照準も吸着も通さないテスト用）。
     * 材料も支持も重なりも本番と同じ規則で見るので、返り値がそのまま理由になる。
     * `deg` は Y 軸まわりの角度（5° に丸められる）。
     */
    buildAt(name: string, x: number, y: number, z: number, itemId = 'plank', deg = 0): string {
      const kind = pieceKind(name)
      if (!kind) return 'unknown'
      const def = tryItem(itemId)
      if (!def?.build || def.material === undefined) return 'material'
      const cost = PIECE_COST[kind]
      if (inventory.count(def.id) < cost) return 'short'
      const p = { kind, x, y, z, yaw: normalizeYaw(deg / 5), mat: def.material }
      const check = build.canPlace(p, isSolidAt)
      if (check !== 'ok') return check
      build.place(p)
      inventory.take(def.id, cost)
      invalidateBuild()
      markMetaDirty()
      return 'ok'
    },
    /**
     * 照準の当たった点を渡して、**本番とまったく同じ吸着経路で**建てる（テスト用）。
     * 既存パーツの接続点に噛めばその向きを継承する。
     */
    buildAim(
      name: string,
      x: number,
      y: number,
      z: number,
      itemId = 'plank',
      offsetDeg = 0,
    ): string {
      const kind = pieceKind(name)
      if (!kind) return 'unknown'
      const def = tryItem(itemId)
      if (!def?.build || def.material === undefined) return 'material'
      const cost = PIECE_COST[kind]
      if (inventory.count(def.id) < cost) return 'short'
      const snap = build.snap(kind, def.material, normalizeYaw(offsetDeg / 5), x, y, z, controls.yaw)
      const check = build.canPlace(snap.piece, isSolidAt)
      if (check !== 'ok') return check
      build.place(snap.piece)
      inventory.take(def.id, cost)
      invalidateBuild()
      markMetaDirty()
      return 'ok'
    },
    /** 指定座標にいちばん近いパーツの中身（テスト用）。 */
    pieceInfoAt(x: number, y: number, z: number, range = 4) {
      const p = build.nearest(x, y, z, range)
      if (!p) return null
      return { kind: p.kind as string, x: p.x, y: p.y, z: p.z, deg: yawDeg(p.yaw), mat: p.mat }
    },
    /** 指定座標にいちばん近いパーツを壊す（テスト用）。材料は戻る。 */
    removePieceAt(x: number, y: number, z: number, range = 3): boolean {
      const p = build.nearest(x, y, z, range)
      const gone = p ? build.remove(p) : null
      if (!gone) return false
      const def = ITEM_BY_MATERIAL.get(gone.mat)
      if (def) inventory.add(def.id, PIECE_COST[gone.kind])
      invalidateBuild()
      markMetaDirty()
      return true
    },
    /** 建てたパーツの数。 */
    pieceCount(): number {
      return build.count
    },
    /** 建てたパーツが持つ当たり判定の箱の数。 */
    buildColliders(): number {
      return build.colliderCount
    },
    /** 敷いた軌道の区間数。 */
    trackCount(): number {
      return tracks.count
    },
    /** 掘った跡・盛った跡まで含めた地表の高さ（テスト用）。 */
    surfaceAt(x: number, z: number): number {
      return surfaceY(x, z)
    },
    /** デバッグ用の無制限モードを切り替える（F4 と同じ）。 */
    setUnlimited(on: boolean): boolean {
      setUnlimited(on)
      return inventory.unlimited
    },
    /** 1 区間を敷くのに要る材料の見積もり（軌道 + 築堤）。 */
    trackCostAt(x: number, y: number, z: number): { rail: number; fill: number; cut: number } | null {
      const s2 = tracks.nearest(x, y, z, 14)
      if (!s2) return null
      const v = gradeVolume(s2, surfaceY)
      return { rail: segmentCost(s2), fill: v.fill, cut: v.cut }
    },
    /** 敷いた軌道が持つ当たり判定の箱の数。 */
    trackColliders(): number {
      return tracks.colliderCount
    },
    /** 軌道の種類を選ぶ（テスト用）。 */
    setTrackKind(name: string): boolean {
      const i = TRACK_KINDS.indexOf(name as TrackKind)
      if (i < 0) return false
      trackIndex = i
      railhead = null
      invalidateTrack()
      hud.setBrush(brushLabel())
      return true
    },
    /** 勾配を % で決める（null で自動＝地形なり）。 */
    setTrackGrade(percent: number | null) {
      trackGrade = percent === null ? null : percent / 100
      invalidateTrack()
      hud.setBrush(brushLabel())
    },
    /** いまの勾配（%）。自動なら null。 */
    trackGrade(): number | null {
      return trackGrade === null ? null : trackGrade * 100
    },
    /**
     * 敷かずに見積もりだけを返す（テスト用）。
     * 狙った長さ・実際の長さ・切り詰めた理由が分かる。
     */
    trackPreview(x: number, y: number, z: number) {
      const kind = TRACK_KINDS[trackIndex]
      const def = inventory.held()
      const plan = tracks.plan({
        kind,
        mat: def?.material ?? MAT_PLANK,
        maxLen: segLen,
        railhead: pickRailhead(kind, x, y, z),
        aimX: x,
        aimY: y,
        aimZ: z,
        camYaw: controls.yaw,
        grade: trackGrade,
        terrain: trackTerrain,
      })
      return {
        check: plan.check,
        trim: plan.trim,
        wanted: plan.wanted,
        length: plan.seg.length,
        grade: plan.seg.length > 0 ? plan.seg.rise / plan.seg.length : 0,
        curve: plan.seg.curve,
      }
    },
    /** 1 区間の長さを設定する（テスト用。上下限に丸められる）。 */
    setTrackLength(m: number) {
      segLen = clamp(Math.round(m), MIN_SEG_LEN, MAX_SEG_LEN)
      invalidateTrack()
      hud.setBrush(brushLabel())
    },
    /**
     * 照準の当たった点を渡して、**本番とまったく同じ経路で**敷く（テスト用）。
     * レールヘッドの決め方も材料も可否の判定も本番と同じなので、返り値がそのまま理由になる。
     */
    trackAim(x: number, y: number, z: number, itemId = 'rock'): string {
      const def = tryItem(itemId)
      if (!def?.build || def.material === undefined) return 'material'
      const kind = TRACK_KINDS[trackIndex]
      const plan = tracks.plan({
        kind,
        mat: def.material,
        maxLen: segLen,
        railhead: pickRailhead(kind, x, y, z),
        aimX: x,
        aimY: y,
        aimZ: z,
        camYaw: controls.yaw,
        grade: trackGrade,
        terrain: trackTerrain,
      })
      const cost = trackCost(plan.seg)
      if (inventory.count(def.id) < cost) return 'short'
      if (plan.check !== 'ok') return plan.check
      if (!tracks.placePlan(plan)) return 'overlap'
      reportTrim(plan)
      inventory.take(def.id, segmentCost(plan.seg))
      gradeTerrain(plan.seg)
      refreshNetwork()
      railhead = plan.joinTo ? null : endOf(plan.seg)
      invalidateTrack()
      markMetaDirty()
      return 'ok'
    },
    /** 敷いてある区間を敷いた順に並べたもの（テスト用）。 */
    trackList() {
      const out: {
        kind: string
        x: number
        y: number
        z: number
        endX: number
        endY: number
        endZ: number
        length: number
        curve: number
      }[] = []
      for (const t of tracks.graph.segments()) {
        const e = segmentEnd(t)
        out.push({
          kind: t.kind,
          x: t.x,
          y: t.y,
          z: t.z,
          endX: e[0],
          endY: e[1],
          endZ: e[2],
          length: t.length,
          curve: t.curve,
        })
      }
      return out
    },
    /** 指定座標にいちばん近い区間の中身（テスト用）。 */
    trackAt(x: number, y: number, z: number, range = 4) {
      const s = tracks.nearest(x, y, z, range)
      if (!s) return null
      const e = segmentEnd(s)
      return {
        kind: s.kind as string,
        x: s.x,
        y: s.y,
        z: s.z,
        yaw: s.yaw,
        curve: s.curve,
        length: s.length,
        rise: s.rise,
        mat: s.mat,
        endX: e[0],
        endY: e[1],
        endZ: e[2],
        endYaw: e[3],
      }
    },
    /** 指定座標にいちばん近い区間を撤去する（テスト用。材料は戻る）。 */
    removeTrackAt(x: number, y: number, z: number, range = 4): boolean {
      const s = tracks.nearest(x, y, z, range)
      const gone = s ? tracks.remove(s) : null
      if (!gone) return false
      const def = ITEM_BY_MATERIAL.get(gone.mat)
      if (def) inventory.add(def.id, segmentCost(gone))
      if (railhead && railhead.seg === gone) railhead = null
      refreshNetwork()
      invalidateTrack()
      markMetaDirty()
      return true
    },
    /** いま伸ばそうとしている端点（無ければ null）。 */
    railhead(): { x: number; y: number; z: number; yaw: number } | null {
      return railhead ? { x: railhead.x, y: railhead.y, z: railhead.z, yaw: railhead.yaw } : null
    },
    /** レールヘッドを手放して新しい線を始める（テスト用）。 */
    clearRailhead() {
      railhead = null
      invalidateTrack()
    },
    /** 建てた駅の数。 */
    stationCount(): number {
      return trains.stations.length
    },
    /** 駅の一覧（建てた順）。 */
    stationList() {
      return trains.stations.map((s) => ({ x: s.x, y: s.y, z: s.z, mat: s.mat }))
    },
    /** 線路の上に駅を建てる（テスト用。本番と同じ規則で見る）。 */
    placeStation(x: number, y: number, z: number, itemId = 'rock'): string {
      const def = tryItem(itemId)
      if (!def?.build || def.material === undefined) return 'material'
      if (inventory.count(def.id) < STATION_COST) return 'short'
      const check = trains.canPlaceStation(x, y, z)
      if (check !== 'ok') return check
      if (!trains.addStation(x, y, z, def.material)) return 'notrack'
      inventory.take(def.id, STATION_COST)
      markMetaDirty()
      return 'ok'
    },
    /** 指定座標にいちばん近い駅の番号（無ければ -1）。 */
    stationAt(x: number, y: number, z: number, range = 6): number {
      return trains.stationAt(x, y, z, range)
    },
    /** 駅を撤去する（材料は戻る）。 */
    removeStationAt(x: number, y: number, z: number, range = 6): boolean {
      const i = trains.stationAt(x, y, z, range)
      const gone = i >= 0 ? trains.removeStation(i) : null
      if (!gone) return false
      const def = ITEM_BY_MATERIAL.get(gone.mat)
      if (def) inventory.add(def.id, STATION_COST)
      routeSel = routeSel.filter((k) => k !== i).map((k) => (k > i ? k - 1 : k))
      trains.setSelection(routeSel)
      markMetaDirty()
      return true
    },
    /** 駅を路線に加える（照準で選ぶのと同じ）。 */
    selectStation(index: number): boolean {
      if (!trains.stations[index]) return false
      if (routeSel[routeSel.length - 1] === index) return false
      routeSel = [...routeSel, index]
      trains.setSelection(routeSel)
      hud.setBrush(brushLabel())
      return true
    },
    /** いま選んでいる路線。 */
    routeSelection(): number[] {
      return [...routeSel]
    },
    clearRoute() {
      clearRouteSelection()
      hud.setBrush(brushLabel())
    },
    /** 選んだ路線で列車を発車させる（テスト用。R キーと同じ規則）。 */
    depart(itemId = 'rock'): string {
      const def = tryItem(itemId)
      if (!def?.build || def.material === undefined) return 'material'
      if (routeSel.length < 2) return 'short-route'
      if (inventory.count(def.id) < TRAIN_COST) return 'short'
      if (!trains.addTrain(routeSel, def.material)) return 'badroute'
      inventory.take(def.id, TRAIN_COST)
      clearRouteSelection()
      hud.setBrush(brushLabel())
      markMetaDirty()
      return 'ok'
    },
    /** 走っている列車の数。 */
    trainCount(): number {
      return trains.trains.length
    },
    /** 列車の状態。 */
    trainInfo(index = 0) {
      const t = trains.trains[index]
      if (!t) return null
      return {
        x: t.pos[0],
        y: t.pos[1],
        z: t.pos[2],
        yaw: t.pos[3],
        speed: t.speed,
        running: t.running,
        stuck: t.stuck,
        hop: t.hop,
        dir: t.dir,
        dwell: t.dwell,
        total: t.total,
        traveled: t.traveled,
        route: [...t.route],
      }
    },
    /** 列車を引き上げる（材料は戻る）。 */
    removeTrainAt(x: number, y: number, z: number, range = 6): boolean {
      const t = trains.nearestTrain(x, y, z, range)
      if (!t) return false
      const def = ITEM_BY_MATERIAL.get(t.mat)
      if (def) inventory.add(def.id, TRAIN_COST)
      if (riding === t) riding = null
      trains.removeTrain(t)
      markMetaDirty()
      return true
    },
    /** いちばん近い列車に乗る（F キーと同じ）。 */
    rideTrain(): boolean {
      return mount()
    },
    /** 列車から降りる。 */
    leaveTrain() {
      dismount()
    },
    /**
     * いま乗っているか。`riding` は毎フレーム書き出す表示用なので、
     * 乗り降りした直後に読むならこちらを使う。
     */
    isRiding(): boolean {
      return riding !== null
    },
    /** 車体の当たり判定（走行中の位置で組み立てたもの）。 */
    trainColliders(index = 0) {
      const t = trains.trains[index]
      if (!t) return []
      return carColliders(t.pos, []).map((c) => ({
        ox: c.ox ?? 0,
        oz: c.oz ?? 0,
        minX: c.minX,
        maxX: c.maxX,
        minZ: c.minZ,
        maxZ: c.maxZ,
        minY: c.minY,
        maxY: c.maxY,
      }))
    },
    /** いま列車の上に立っているか（立っているなら、その天面の高さ）。 */
    standingOnTrain(): number | null {
      let best: number | null = null
      for (const t of trains.trains) {
        for (const c of carColliders(t.pos, carScratch)) {
          if (player.position.y < c.maxY - 0.1 || player.position.y > c.maxY + 0.35) continue
          worldToLocal(c, player.position.x, player.position.z, roofScratch)
          const r = player.radius
          if (roofScratch[0] <= c.minX - r || roofScratch[0] >= c.maxX + r) continue
          if (roofScratch[1] <= c.minZ - r || roofScratch[1] >= c.maxZ + r) continue
          if (best === null || c.maxY > best) best = c.maxY
        }
      }
      return best
    },
    /** いま居る MOB の一覧（はね飛ばされたかを見るのに使う）。 */
    mobList() {
      return mobs.mobs.map((m) => ({
        kind: m.def.kind as string,
        x: m.pos.x,
        y: m.pos.y,
        z: m.pos.z,
        vx: m.vel.x,
        vy: m.vel.y,
        vz: m.vel.z,
        hp: m.hp,
      }))
    },
    /** 指定の場所に MOB を湧かせる（テスト用）。 */
    spawnMobAt(kind: 'wraith' | 'deer' | 'villager', x: number, y: number, z: number) {
      return mobs.spawn(kind, x, y, z) !== null
    },
    /** 最寄りの村の広場へ移動する。見つからなければ false。 */
    gotoVillage(): boolean {
      const cx = Math.floor(player.position.x / VILLAGE_CELL)
      const cz = Math.floor(player.position.z / VILLAGE_CELL)
      for (let r = 0; r <= 6; r++) {
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
            const v = world.field.village(cx + dx, cz + dz)
            if (!v) continue
            stats.teleport(v.cx, v.cz - v.radius * 0.62)
            // 広場の方を向く
            controls.yaw = Math.atan2(
              -(v.cx - player.position.x),
              -(v.cz - player.position.z),
            )
            controls.pitch = -0.08
            return true
          }
        }
      }
      return false
    },
  }
  ;(window as unknown as Record<string, unknown>).__smooth = stats

  const hit = createRayHit()
  const treeHit = createTreeHit()
  const matScratch = new Float32Array(6)
  const lookDir = new THREE.Vector3()
  const eye = new THREE.Vector3()
  const clock = new THREE.Clock()
  let frames = 0
  let fps = 0
  let fpsAccum = 0
  let fpsFrames = 0
  let saveTimer = 0
  /** 0 より大きい間はカウントダウンし、0 になったらメタ情報を保存する。 */
  let metaDirty = 0
  let ready = false

  /** 手持ちや伐採が変わったら、少し待ってから保存する。 */
  function markMetaDirty(): void {
    metaDirty = 1.2
  }

  const surfaceFogDensity = engine.fog.density

  /** ダメージを受ける。防具のぶんだけ軽くなる。 */
  function hurtPlayer(damage: number): void {
    if (!started || health <= 0) return
    const taken = Math.max(0.5, damage * (1 - inventory.armor()))
    health -= taken
    sinceHurt = 0
    hud.flashHurt()
    hud.setHealth(health, MAX_HEALTH)
    markMetaDirty()
    if (health <= 0) respawn()
  }

  /** やられたら最寄りの村へ、無ければ最初の地点へ戻す。持ち物はそのまま。 */
  function respawn(): void {
    health = MAX_HEALTH
    sinceHurt = REGEN_DELAY
    const v = world.field.villageNear(player.position.x, player.position.z)
    const x = v ? v.cx : 0.5
    const z = v ? v.cz : 0.5
    player.spawnAt(world, x, z)
    mobs.clear()
    hud.setHealth(health, MAX_HEALTH)
    hud.showToast(v ? 'やられた… 最寄りの村で目を覚ました' : 'やられた… 最初の地点に戻った', 2600)
    markMetaDirty()
  }

  // MOB も木と建物にぶつかり、登れない坂や壁を避けて歩く
  mobs.obstacles = {
    trunksNear: (x, y, z, r) => world.collectTrunks(x, y, z, r, mobTrunkBuf),
    boxesNear: (x, y, z, r, out) => {
      // 村の建物（out を空にして詰める）に、建てたパーツを足す
      villages.collidersNear(x, z, r, out)
      build.collectColliders(x, z, r, out, y - 2, y + 4)
      tracks.collectColliders(x, z, r, out, y - 2, y + 4)
      return trains.collectColliders(x, z, r, out, y - 2, y + 4)
    },
  }

  mobs.onAttack = (damage) => hurtPlayer(damage)
  mobs.onDrop = (id, count) => {
    inventory.add(id, count)
    hud.showToast(`${item(id).name} ×${count} を手に入れた`)
    markMetaDirty()
  }

  hud.onCraft = (r) => {
    if (!inventory.craft(r)) return
    hud.showToast(`${item(r.out).name} を作った`)
    markMetaDirty()
  }
  hud.onTrade = (i) => {
    const t = TRADES[i]
    if (!t || !inventory.trade(t.give, t.get)) return
    hud.showToast(`${item(t.get[0]).name} ×${t.get[1]} と交換した`)
    markMetaDirty()
  }
  hud.onPanelClose = () => setPanel(false)
  hud.onTradeClose = () => setTradePanel(false)

  function setPanel(open: boolean): void {
    hud.setPanel(open)
    if (open) {
      hud.setTrade(false)
      document.exitPointerLock()
    } else if (started) {
      controls.requestLock()
    }
  }

  function setTradePanel(open: boolean): void {
    hud.setTrade(open)
    if (open) {
      hud.setPanel(false)
      document.exitPointerLock()
    } else if (started) {
      controls.requestLock()
    }
  }

  controls.onTogglePanel = () => setPanel(!hud.panelOpen)
  controls.onInteract = () => {
    if (hud.tradeOpen) {
      setTradePanel(false)
      return
    }
    // 列車が近ければ乗り降りが優先
    if (riding) {
      dismount()
      return
    }
    if (mount()) return
    const v = mobs.nearestVillager(player.position.x, player.position.z, 4.5)
    if (!v) {
      hud.showToast('近くに村人がいません')
      return
    }
    setTradePanel(true)
  }

  /**
   * 掘った体積を素材ごとの持ち物に足す。
   * プレイヤーが設置した素材があればそれを、無ければ地形本来の素材の比率で分ける。
   * 岩を掘るとまれに石炭も出る（松明とガラスの材料）。
   */
  function creditDig(x: number, y: number, z: number, ny: number, amount: number): void {
    if (amount <= 0) return
    const placed = world.cornerMaterial(Math.round(x), Math.round(y), Math.round(z))
    const placedItem = ITEM_BY_MATERIAL.get(placed)
    if (placedItem) {
      inventory.add(placedItem.id, amount)
      return
    }
    world.field.surfaceSample(x, y, z, ny, matScratch, 0)
    let rock = 0
    for (let i = 0; i < NATURAL_MATERIAL_COUNT; i++) {
      const def = ITEM_BY_MATERIAL.get(i)
      if (!def || matScratch[i] <= 0) continue
      inventory.add(def.id, amount * matScratch[i])
      if (i === MAT_ROCK) rock = matScratch[i]
    }
    coalProgress += amount * rock * 0.02
    if (coalProgress >= 1) {
      const n = Math.floor(coalProgress)
      coalProgress -= n
      inventory.add('coal', n)
    }
  }

  /** 石炭は端数を持ち越して、掘り続けるとたまに 1 個出るようにする。 */
  let coalProgress = 0

  const isSolidAt = (x: number, y: number, z: number): boolean => world.isSolid(x, y, z)

  /** 地表を探すときの刻みと、二分で詰める回数（4 cm まで詰まる）。 */
  const SURFACE_STEP = 0.4
  const SURFACE_REFINE = 3

  /**
   * 地表の高さ。**掘った跡も盛った跡も反映される**ので、
   * 切り盛りしたところに橋脚が立ったり、同じ場所を二度盛ったりしない。
   *
   * 素の地形の高さから上下に探して、固体と空の境目を二分で詰める。
   * たいていは 1〜2 歩で見つかるので、素の高さを引くのとほとんど変わらない。
   */
  const surfaceY = (x: number, z: number): number => {
    const h = world.field.height(x, z)
    const hi = h + GRADE_TOL + 1
    const lo = h - MAX_PILLAR - 1
    let solid: number
    let air: number
    if (world.isSolid(x, h, z)) {
      let y = h
      while (y < hi && world.isSolid(x, y + SURFACE_STEP, z)) y += SURFACE_STEP
      solid = y
      air = y + SURFACE_STEP
    } else {
      let y = h
      while (y > lo && !world.isSolid(x, y - SURFACE_STEP, z)) y -= SURFACE_STEP
      // 下に何も無い（水の中や空洞）ときは素の地形に任せる
      if (y <= lo) return h
      solid = y - SURFACE_STEP
      air = y
    }
    for (let i = 0; i < SURFACE_REFINE; i++) {
      const mid = (solid + air) / 2
      if (world.isSolid(x, mid, z)) solid = mid
      else air = mid
    }
    return solid
  }

  /**
   * 軌道の敷設可否を測る地形。被りの判定は密度場を直接見るので、
   * **自分で掘った切通しはそのまま「通れる」ようになる**。
   */
  const trackTerrain = {
    ground: surfaceY,
    solid: isSolidAt,
    obstacles: trackObstacles,
  }

  /**
   * 家や建てたパーツ。軌道がぶつかったら手前で止めるために使う
   * （`VillageManager.collidersNear` の約束どおり、`out` は空にしてから詰まる）。
   */
  function trackObstacles(x: number, z: number, r: number, out: Collider[]): Collider[] {
    villages.collidersNear(x, z, r, out)
    return build.collectColliders(x, z, r, out)
  }

  /** いま見えている区間の勾配（Shift + ホイールの出発点にする）。 */
  function gradeOfPlan(): number {
    const seg = trackPlan?.seg
    return seg && seg.length > 0 ? seg.rise / seg.length : 0
  }

  /**
   * 狙った長さに届かなかったときに、その理由を伝える。
   *
   * 押しっぱなしで敷き続けても喧しくならないよう、**理由が変わったときだけ**出す。
   */
  function reportTrim(plan: TrackPlan): void {
    if (plan.trim === 'none') {
      lastTrim = 'none'
      return
    }
    if (plan.trim === lastTrim) return
    lastTrim = plan.trim
    const why = TRIM_REASON[plan.trim] ?? 'ぶつかった'
    hud.showToast(`${why}ので ${plan.seg.length.toFixed(1)} m で止めました`)
  }

  /**
   * 敷いた区間に合わせて地形を切り盛りする。
   *
   * 差が {@link GRADE_TOL} 以下のところだけを直す。深い谷は橋脚に任せ、
   * 高すぎる山はそもそも敷けない（{@link TrackGraph.check} が弾く）。
   *
   * 土は掘削・設置とまったく同じ扱いで、**切土で出たぶんは手に入り、
   * 盛土で積んだぶんは手持ちから減る**。掘ったところの素材はブラシ 1 本ごとに
   * その場で見るので、草地を削れば草が、岩場を削れば岩が返る。
   */
  function gradeTerrain(seg: Segment): void {
    const ops = gradeOps(seg, surfaceY)
    if (ops.length === 0) return
    gradeBounds.length = 0
    world.applyBrushBatch(
      ops.map((o) => ({
        x: o.x,
        y: o.y,
        z: o.z,
        shape: orientedBoxBrush(o.hx, o.hy, o.hz, o.yaw),
        mode: o.mode,
        material: o.mat,
      })),
      gradeBounds,
    )
    let filled = 0
    for (let i = 0; i < ops.length && i < gradeBounds.length; i++) {
      const o = ops[i]
      const b = gradeBounds[i]
      if (o.mode === 'place') {
        filled += b.solidified
      } else if (b.cleared > 0) {
        // 削れたのは路盤のすぐ上。そこの素材を見て手持ちへ返す
        creditDig(o.x, o.y - o.hy + 0.5, o.z, 1, b.cleared)
      }
    }
    if (filled <= 0) return
    const def = ITEM_BY_MATERIAL.get(seg.mat)
    if (def) inventory.takeUpTo(def.id, filled)
  }

  const gradeBounds: BrushBounds[] = []

  /**
   * 1 区間を敷くのに要る材料。**軌道そのもの + 築堤で積む土**。
   *
   * 積む土の量は敷く前には見積もりでしか分からない（実際に何格子ぶん埋まるかは
   * ブラシを掛けてみないと数えられない）ので、ここでは体積から見積もって
   * 足りるかどうかの目安にし、請求はブラシが数えた実数で行う。
   * 撤去で戻るのは軌道のぶんだけ（積んだ土は地形になったので、掘れば返ってくる）。
   *
   * 地面を測るのは安くないので、**ゴーストと同じタイミングでだけ**計算して使い回す。
   */
  function planCost(seg: Segment): { total: number; label: string } {
    if (trackCostCache) return trackCostCache
    const rail = segmentCost(seg)
    const { fill, cut } = gradeVolume(seg, surfaceY)
    const bank = Math.ceil(fill)
    const dug = Math.floor(cut)
    const label = bank > 0 ? `${rail}（+築堤 ${bank}）` : dug > 0 ? `${rail}（切土 +${dug}）` : `${rail}`
    trackCostCache = { total: rail + bank, label }
    return trackCostCache
  }

  /** 照準を通さない経路（テスト用フック）でも同じ見積もりを使う。 */
  function trackCost(seg: Segment): number {
    trackCostCache = null
    const n = planCost(seg).total
    trackCostCache = null
    return n
  }

  function pieceKind(name: string): PieceKind | null {
    const i = PIECE_KINDS.indexOf(name as PieceKind)
    return i < 0 ? null : PIECE_KINDS[i]
  }

  /**
   * 吸着の計算（近傍の接続点集めと重なり判定）は毎フレーム回すには重いので、
   * **照準点が 5 cm 以上動くか、種類・向き・素材が変わったときだけ**やり直す。
   */
  let buildKey = ''
  let buildSnap: SnapResult | null = null
  let buildCheck: PlaceCheck = 'ok'

  function invalidateBuild(): void {
    buildKey = ''
  }

  /**
   * 建築モードの 1 フレーム。
   *
   * 照準の当たった点を既存パーツの接続点へ吸着させてゴーストを出し、
   * 右クリックで置き、左クリックで壊す（建築モード中は地形を掘らない）。
   */
  function updateBuildMode(): void {
    const kind = PIECE_KINDS[pieceIndex]
    const held = inventory.held()

    // 建築モードではホイールは大きさではなく向き。Shift で 45° ずつ回る
    if (controls.wheel !== 0) {
      const fast = controls.keys.has('ShiftLeft') || controls.keys.has('ShiftRight')
      const step = fast ? 9 : 1
      buildYawOffset = normalizeYaw(buildYawOffset + (controls.wheel > 0 ? step : -step))
      controls.wheel = 0
      invalidateBuild()
    }

    // 照準は「建てたパーツ」と「地形」の手前の方
    const pieceHit = build.raycast(eye.x, eye.y, eye.z, lookDir.x, lookDir.y, lookDir.z, REACH)
    const terrain = raycastTerrain(world, eye, lookDir, REACH, hit)
    const onPiece =
      pieceHit !== null && pieceHit.distance < (terrain ? terrain.distance : Infinity)

    let px: number
    let py: number
    let pz: number
    if (onPiece && pieceHit) {
      px = eye.x + lookDir.x * pieceHit.distance
      py = eye.y + lookDir.y * pieceHit.distance
      pz = eye.z + lookDir.z * pieceHit.distance
    } else if (terrain) {
      px = terrain.point.x
      py = terrain.point.y
      pz = terrain.point.z
    } else {
      // 何にも当たらなければ目の前。支えが無いので普通はそのままでは置けない
      px = eye.x + lookDir.x * 4
      py = eye.y + lookDir.y * 4
      pz = eye.z + lookDir.z * 4
    }

    const buildable = held?.build === true && held.material !== undefined
    const mat = buildable ? (held.material as number) : MAT_PLANK
    const cost = PIECE_COST[kind]
    const enough = buildable && held !== null && inventory.count(held.id) >= cost

    const key = [
      kind,
      buildYawOffset,
      mat,
      Math.round(px * 20),
      Math.round(py * 20),
      Math.round(pz * 20),
      Math.round(controls.yaw / YAW_STEP),
    ].join('|')
    if (key !== buildKey || !buildSnap) {
      buildKey = key
      buildSnap = build.snap(kind, mat, buildYawOffset, px, py, pz, controls.yaw)
      buildCheck = build.canPlace(buildSnap.piece, isSolidAt)
    }
    const candidate = buildSnap.piece
    build.setGhost(candidate, buildCheck === 'ok' && enough, buildSnap.point)
    hud.setBrush(brushLabel())

    if (editCooldown > 0) return

    // 左クリック = 解体。材料は全額戻る
    if (controls.digging) {
      const gone = onPiece && pieceHit ? build.remove(pieceHit.piece) : null
      if (gone) {
        const def = ITEM_BY_MATERIAL.get(gone.mat)
        if (def) inventory.add(def.id, PIECE_COST[gone.kind])
        hud.showToast(`${PIECE_NAME[gone.kind]}を回収した`)
        invalidateBuild()
        markMetaDirty()
      } else {
        hud.showToast('壊すパーツに照準を合わせてください')
      }
      editCooldown = DEMOLISH_INTERVAL
      return
    }

    if (!controls.placing) return

    if (!buildable || !held) {
      hud.showToast('この素材では建てられません（岩・板・レンガ・ガラス）')
      editCooldown = 0.5
      return
    }
    if (!enough) {
      hud.showToast(`${held.name}が足りません（${PIECE_NAME[kind]}に ${cost} 必要）`)
      editCooldown = 0.5
      return
    }
    if (buildCheck === 'overlap') {
      hud.showToast('そこには他のパーツと重なってしまいます')
      editCooldown = DEMOLISH_INTERVAL
      return
    }
    if (buildCheck === 'unsupported') {
      hud.showToast('地面か、すでにあるパーツに接していないと置けません')
      editCooldown = DEMOLISH_INTERVAL
      return
    }
    if (build.place(candidate)) {
      inventory.take(held.id, cost)
      invalidateBuild()
      markMetaDirty()
    }
    editCooldown = BUILD_INTERVAL
  }

  /**
   * 伸ばす元の端点を決める。
   *
   * ①狙点の近くにある自由端（他の線の先へ繋ぎに行ける） →
   * ②直前に置いた区間の終点（右クリックを続けるだけで線が伸びていく） →
   * ③無し（狙点から新しい線を始める）。
   */
  function pickRailhead(kind: TrackKind, px: number, py: number, pz: number): TrackEnd | null {
    const near = tracks.nearestEnd(px, py, pz, RAILHEAD_RANGE, kind)
    if (near) return near
    if (!railhead) return null
    // 撤去された区間や、遠く離れた端点は握り続けない
    if (!tracks.has(railhead.seg) || railhead.seg.kind !== kind) {
      railhead = null
      return null
    }
    const d = Math.hypot(railhead.x - player.position.x, railhead.z - player.position.z)
    if (d > RAILHEAD_DROP) {
      railhead = null
      return null
    }
    return railhead
  }

  /**
   * 軌道モードの 1 フレーム。
   *
   * 行きたい方を見ると、レールヘッドからそこへ向かう円弧がゴーストで伸びる。
   * 右クリックで敷き、左クリックで撤去する（軌道モード中は地形を掘らない）。
   */
  function updateTrackMode(): void {
    const kind = TRACK_KINDS[trackIndex]
    const held = inventory.held()

    // ホイールは 1 区間の長さ。Shift を押しながらだと勾配になる
    if (controls.wheel !== 0) {
      const dir = -Math.sign(controls.wheel)
      if (controls.keys.has('ShiftLeft') || controls.keys.has('ShiftRight')) {
        const max = TRACK_INFO[kind].maxGrade
        const base = trackGrade ?? gradeOfPlan()
        trackGrade = clamp(
          Math.round((base + dir * GRADE_UI_STEP) / GRADE_UI_STEP) * GRADE_UI_STEP,
          -max,
          max,
        )
      } else {
        segLen = clamp(segLen + dir, MIN_SEG_LEN, MAX_SEG_LEN)
      }
      controls.wheel = 0
      invalidateTrack()
    }

    // 照準は「敷いた軌道」と「地形」の手前の方
    const trackHit = tracks.raycast(eye.x, eye.y, eye.z, lookDir.x, lookDir.y, lookDir.z, REACH)
    const terrain = raycastTerrain(world, eye, lookDir, REACH, hit)
    const onTrack = trackHit !== null && trackHit.distance < (terrain ? terrain.distance : Infinity)

    let px: number
    let py: number
    let pz: number
    if (onTrack && trackHit) {
      px = eye.x + lookDir.x * trackHit.distance
      py = eye.y + lookDir.y * trackHit.distance
      pz = eye.z + lookDir.z * trackHit.distance
    } else if (terrain) {
      px = terrain.point.x
      py = terrain.point.y
      pz = terrain.point.z
    } else {
      px = eye.x + lookDir.x * REACH
      py = eye.y + lookDir.y * REACH
      pz = eye.z + lookDir.z * REACH
    }

    const buildable = held?.build === true && held.material !== undefined
    const mat = buildable ? (held.material as number) : MAT_PLANK

    const head = pickRailhead(kind, px, py, pz)
    const key = [
      kind,
      mat,
      segLen,
      trackGrade ?? 'auto',
      head ? `${head.x.toFixed(2)},${head.z.toFixed(2)},${head.atEnd}` : 'new',
      Math.round(px * 20),
      Math.round(py * 20),
      Math.round(pz * 20),
      Math.round(controls.yaw / YAW_STEP),
    ].join('|')
    if (key !== trackKey || !trackPlan) {
      trackKey = key
      trackCostCache = null
      trackPlan = tracks.plan({
        kind,
        mat,
        maxLen: segLen,
        railhead: head,
        aimX: px,
        aimY: py,
        aimZ: pz,
        grade: trackGrade,
        aimOnTrack: onTrack,
        camYaw: controls.yaw,
        terrain: trackTerrain,
      })
    }
    const plan = trackPlan
    const cost = planCost(plan.seg).total
    const enough = buildable && held !== null && inventory.count(held.id) >= cost
    tracks.setGhost(plan, plan.check === 'ok' && enough, surfaceY)
    hud.setBrush(brushLabel())

    if (editCooldown > 0) return

    // 左クリック = 撤去。材料は全額戻る
    if (controls.digging) {
      const gone = onTrack && trackHit ? tracks.remove(trackHit.seg) : null
      if (gone) {
        const def = ITEM_BY_MATERIAL.get(gone.mat)
        if (def) inventory.add(def.id, segmentCost(gone))
        if (railhead && railhead.seg === gone) railhead = null
        refreshNetwork()
        hud.showToast(`${TRACK_INFO[gone.kind].name}を撤去した`)
        invalidateTrack()
        markMetaDirty()
      } else {
        hud.showToast('撤去する軌道に照準を合わせてください')
      }
      editCooldown = DEMOLISH_INTERVAL
      return
    }

    if (!controls.placing) return

    if (!buildable || !held) {
      hud.showToast('この素材では敷けません（岩・板・レンガ・ガラス）')
      editCooldown = 0.5
      return
    }
    if (!enough) {
      hud.showToast(`${held.name}が足りません（この区間に ${cost} 必要）`)
      editCooldown = 0.5
      return
    }
    if (plan.check !== 'ok') {
      hud.showToast(TRACK_REASON[plan.check])
      editCooldown = DEMOLISH_INTERVAL
      return
    }
    if (tracks.placePlan(plan)) {
      reportTrim(plan)
      inventory.take(held.id, segmentCost(plan.seg))
      gradeTerrain(plan.seg)
      refreshNetwork()
      // 繋ぎ切ったら線は閉じ、そうでなければ終点が次のレールヘッドになる
      railhead = plan.joinTo ? null : endOf(plan.seg)
      invalidateTrack()
      markMetaDirty()
    }
    editCooldown = TRACK_INTERVAL
  }

  /** 線路が変わったら、経路探索の網を組み直す（駅が線路から外れたら捨てられる）。 */
  function refreshNetwork(): void {
    trains.rebuildNetwork(tracks.graph.segments())
    // 消えた駅を指していた選択は落とす
    routeSel = routeSel.filter((i) => trains.stations[i])
    trains.setSelection(routeSel)
  }

  /** 選んだ路線を捨てる。 */
  function clearRouteSelection(): void {
    if (routeSel.length === 0) return
    routeSel = []
    trains.setSelection(routeSel)
  }

  /** 選んだ駅を順に結んで 1 編成走らせる。 */
  function departRoute(): void {
    const held = inventory.held()
    if (routeSel.length < 2) {
      hud.showToast('駅を 2 つ以上、走らせたい順に選んでください')
      return
    }
    if (!held?.build || held.material === undefined) {
      hud.showToast('この素材では列車を作れません（岩・板・レンガ・ガラス）')
      return
    }
    if (inventory.count(held.id) < TRAIN_COST) {
      hud.showToast(`${held.name}が足りません（列車に ${TRAIN_COST} 必要）`)
      return
    }
    const train = trains.addTrain(routeSel, held.material)
    if (!train) {
      hud.showToast('その路線では走らせられません')
      return
    }
    inventory.take(held.id, TRAIN_COST)
    hud.showToast(`列車が発車しました（${routeSel.length} 駅）`)
    clearRouteSelection()
    markMetaDirty()
  }

  /**
   * 駅・列車モードの 1 フレーム。
   *
   * 右クリックで線路の上に駅を置き、**置いた駅に照準を合わせて右クリックすると
   * 路線に順番に加わる**。2 駅以上選んで `R` を押すと列車が発車する。
   * 左クリックは駅か列車の撤去、中クリックは選んだ路線の取り消し。
   */
  function updateStationMode(): void {
    const held = inventory.held()
    const trackHit = tracks.raycast(eye.x, eye.y, eye.z, lookDir.x, lookDir.y, lookDir.z, REACH)
    const terrain = raycastTerrain(world, eye, lookDir, REACH, hit)
    const onTrack = trackHit !== null && trackHit.distance < (terrain ? terrain.distance : Infinity)
    const dist = onTrack && trackHit ? trackHit.distance : terrain ? terrain.distance : REACH
    const px = eye.x + lookDir.x * dist
    const py = eye.y + lookDir.y * dist
    const pz = eye.z + lookDir.z * dist

    const station = trains.stationAt(px, py, pz, STATION_PICK)
    const train = trains.nearestTrain(px, py, pz, TRAIN_PICK)
    hud.setBrush(brushLabel())

    if (editCooldown > 0) return

    // 左クリック = 撤去。材料は全額戻る
    if (controls.digging) {
      if (station >= 0) {
        const gone = trains.removeStation(station)
        if (gone) {
          const def = ITEM_BY_MATERIAL.get(gone.mat)
          if (def) inventory.add(def.id, STATION_COST)
          routeSel = routeSel.filter((i) => i !== station).map((i) => (i > station ? i - 1 : i))
          trains.setSelection(routeSel)
          hud.showToast('駅を撤去した')
          markMetaDirty()
        }
      } else if (train) {
        const def = ITEM_BY_MATERIAL.get(train.mat)
        if (def) inventory.add(def.id, TRAIN_COST)
        if (riding === train) dismount()
        trains.removeTrain(train)
        hud.showToast('列車を引き上げた')
        markMetaDirty()
      } else {
        hud.showToast('撤去する駅か列車に照準を合わせてください')
      }
      editCooldown = DEMOLISH_INTERVAL
      return
    }

    if (!controls.placing) return

    // 既にある駅を狙っていれば、路線に加える
    if (station >= 0) {
      if (routeSel[routeSel.length - 1] === station) {
        hud.showToast('同じ駅は続けて選べません')
      } else {
        routeSel = [...routeSel, station]
        trains.setSelection(routeSel)
        hud.showToast(`駅${station + 1} を路線に追加（${routeSel.length} 駅目）`)
      }
      editCooldown = BUILD_INTERVAL
      return
    }

    // 何も無ければ線路の上に駅を建てる
    if (!held?.build || held.material === undefined) {
      hud.showToast('この素材では駅を建てられません（岩・板・レンガ・ガラス）')
      editCooldown = 0.5
      return
    }
    if (inventory.count(held.id) < STATION_COST) {
      hud.showToast(`${held.name}が足りません（駅に ${STATION_COST} 必要）`)
      editCooldown = 0.5
      return
    }
    const check = trains.canPlaceStation(px, py, pz)
    if (check === 'notrack') {
      hud.showToast('駅は線路の上にしか建てられません')
      editCooldown = DEMOLISH_INTERVAL
      return
    }
    if (check === 'tooclose') {
      hud.showToast('近くに駅がありすぎます')
      editCooldown = DEMOLISH_INTERVAL
      return
    }
    if (trains.addStation(px, py, pz, held.material)) {
      inventory.take(held.id, STATION_COST)
      hud.showToast(`駅${trains.stations.length} を建てた`)
      markMetaDirty()
    }
    editCooldown = TRACK_INTERVAL
  }

  /** 近くの列車に乗り込む。乗れたら true。 */
  function mount(): boolean {
    const t = trains.nearestTrain(
      player.position.x,
      player.position.y,
      player.position.z,
      RIDE_RANGE,
    )
    if (!t) return false
    riding = t
    player.velocity.set(0, 0, 0)
    hud.showToast('列車に乗った（F で降りる）')
    return true
  }

  /** 列車から降りて、線路の脇に立つ。 */
  function dismount(): void {
    const t = riding
    riding = null
    if (!t) return
    // ヨー θ の右は (cosθ, -sinθ)
    player.position.set(
      t.pos[0] + Math.cos(t.pos[3]) * RIDE_OFF,
      t.pos[1] + 0.6,
      t.pos[2] - Math.sin(t.pos[3]) * RIDE_OFF,
    )
    player.velocity.set(0, 0, 0)
    hud.showToast('列車から降りた')
  }

  /** 乗っているあいだは、列車の運転台にプレイヤーを載せて運ぶ。 */
  function carryRider(): void {
    const t = riding
    if (!t) return
    if (!trains.trains.includes(t)) {
      riding = null
      return
    }
    // 運転台は車体の後ろ寄り。前方は (-sinθ, -cosθ)
    const back = -CAR_LEN * 0.28
    player.position.set(
      t.pos[0] - Math.sin(t.pos[3]) * back,
      t.pos[1] + 0.6,
      t.pos[2] - Math.cos(t.pos[3]) * back,
    )
    player.velocity.set(0, 0, 0)
  }

  /**
   * 屋根の上に立っているあいだは、列車が動いたぶんだけ一緒に運ぶ（動く床）。
   *
   * 押し出しと接地は既存の箱の仕組みに任せてあるので、ここでやるのは
   * **足元の車体が動いた量を足す**ことだけ。判定は 1 フレーム前の車体（`prev`）で行う。
   * プレイヤーが立っていたのはそちらだから。
   */
  function carryOnRoof(): void {
    for (const t of trains.trains) {
      const dx = t.pos[0] - t.prev[0]
      const dy = t.pos[1] - t.prev[1]
      const dz = t.pos[2] - t.prev[2]
      if (dx === 0 && dy === 0 && dz === 0) continue
      for (const c of carColliders(t.prev, carScratch)) {
        const feet = player.position.y
        if (feet < c.maxY - 0.06 || feet > c.maxY + 0.35) continue
        worldToLocal(c, player.position.x, player.position.z, roofScratch)
        const r = player.radius
        if (roofScratch[0] <= c.minX - r || roofScratch[0] >= c.maxX + r) continue
        if (roofScratch[1] <= c.minZ - r || roofScratch[1] >= c.maxZ + r) continue
        player.position.x += dx
        player.position.y += dy
        player.position.z += dz
        return
      }
    }
  }

  /**
   * 走っている列車が、線路の上のプレイヤーや MOB をはねる。
   *
   * 押しのけ（{@link Player.resolveBoxes}）より**先に**見る。あとから見ると
   * 車体の横へ押し出されたあとになってしまい、当たったことに気づけない。
   */
  function applyTrainImpacts(dt: number): void {
    trainHitCd = Math.max(0, trainHitCd - dt)
    for (const t of trains.trains) {
      if (t === riding) continue

      if (!riding && trainHitCd <= 0 && health > 0) {
        const hit = trainImpact(
          t.pos,
          t.speed,
          player.position.x,
          player.position.y,
          player.position.z,
          player.radius,
          player.height,
          impactScratch,
        )
        if (hit) {
          trainHitCd = TRAIN_HIT_COOLDOWN
          stats.trainHits++
          hurtPlayer(hit.damage)
          // やられて復帰したときは、その場所へ飛ばさない
          if (health > 0) {
            player.position.y += TRAIN_HIT_LIFT_OFF
            player.velocity.set(hit.nx * hit.push, hit.lift, hit.nz * hit.push)
            player.onGround = false
            hud.showToast('列車にはねられた！')
          }
        }
      }

      for (const m of mobs.mobs) {
        if (elapsed - (mobHitAt.get(m) ?? -1e9) < TRAIN_HIT_COOLDOWN) continue
        const hit = trainImpact(
          t.pos,
          t.speed,
          m.pos.x,
          m.pos.y,
          m.pos.z,
          m.def.radius,
          m.def.height,
          impactScratch,
        )
        if (!hit) continue
        mobHitAt.set(m, elapsed)
        m.pos.y += TRAIN_HIT_LIFT_OFF
        mobs.knock(m, hit.damage, hit.nx, hit.nz, hit.push, hit.lift)
      }
    }
  }

  /** 区間の終点を、次に伸ばせる端点として取り出す。 */
  function endOf(seg: Segment): TrackEnd {
    const e = segmentEnd(seg)
    return { seg, atEnd: true, x: e[0], y: e[1], z: e[2], yaw: e[3] }
  }

  function tick(): void {
    requestAnimationFrame(tick)
    const dt = Math.min(clock.getDelta(), 0.1)
    frames++
    elapsed += dt

    // 列車はプレイヤーより先に動かす。当たり判定・乗り上げ・はねられを
    // すべて「いまの車体」で決められる
    if (started) {
      trains.update(dt)
      applyTrainImpacts(dt)
    }

    if (started && riding) {
      // 乗車中は自分では歩かない。視線だけ自由に回せる
      carryRider()
    } else if (started && controls.locked) {
      carryOnRoof()
      player.update(dt, world, controls)
    }

    eye.set(player.position.x, player.position.y + PLAYER_EYE, player.position.z)
    camera.position.copy(eye)
    camera.rotation.set(controls.pitch, controls.yaw, 0, 'YXZ')

    world.update(eye.x, eye.y, eye.z)
    villages.update(player.position.x, player.position.z, VIEW_RANGE)
    sky.update(dt, camera.position, engine.fog)
    water.update(dt, camera.position)

    // 木の幹と建物の壁の当たり判定は毎フレーム 1 回だけ集める
    player.trunks = world.collectTrunks(player.position.x, player.position.y, player.position.z, 4)
    player.boxes = villages.collidersNear(player.position.x, player.position.z, 1.2, boxScratch)
    build.collectColliders(
      player.position.x,
      player.position.z,
      1.2,
      player.boxes,
      player.position.y - 1.2,
      player.position.y + player.height + 0.5,
    )
    tracks.collectColliders(
      player.position.x,
      player.position.z,
      1.2,
      player.boxes,
      player.position.y - 1.2,
      player.position.y + player.height + 0.5,
    )
    trains.collectColliders(
      player.position.x,
      player.position.z,
      1.2,
      player.boxes,
      player.position.y - 1.2,
      player.position.y + player.height + 0.5,
    )
    build.rebuild()
    tracks.rebuild(surfaceY)

    // 水中は視界を濁らせる
    const underwater = camera.position.y < SEA_LEVEL
    engine.fog.density = underwater ? 0.055 : surfaceFogDensity
    if (underwater) engine.fog.color.setHex(0x1c4f6b)

    // --- MOB と松明 ---
    const daylight = sky.daylight
    if (started) {
      mobs.update(dt, world, player.position.x, player.position.y, player.position.z, daylight)
      torches.update(dt, camera.position.x, camera.position.y, camera.position.z)
      // 少し経つと体力が戻る
      sinceHurt += dt
      if (health > 0 && health < MAX_HEALTH && sinceHurt > REGEN_DELAY) {
        health = Math.min(MAX_HEALTH, health + REGEN_RATE * dt)
        hud.setHealth(health, MAX_HEALTH)
      }
    }

    // --- ブラシと戦闘 ---
    if (started && controls.locked && TOOLS[tool].id === 'build') {
      camera.getWorldDirection(lookDir)
      editCooldown -= dt
      updateBuildMode()
      tracks.setGhost(null, false, surfaceY)
      ghost.visible = false
      boxGhost.visible = false
    } else if (started && controls.locked && TOOLS[tool].id === 'station') {
      camera.getWorldDirection(lookDir)
      editCooldown -= dt
      updateStationMode()
      build.setGhost(null, false)
      tracks.setGhost(null, false, surfaceY)
      ghost.visible = false
      boxGhost.visible = false
    } else if (started && controls.locked && TOOLS[tool].id === 'track') {
      camera.getWorldDirection(lookDir)
      editCooldown -= dt
      updateTrackMode()
      build.setGhost(null, false)
      ghost.visible = false
      boxGhost.visible = false
    } else if (started && controls.locked) {
      build.setGhost(null, false)
      tracks.setGhost(null, false, surfaceY)
      if (controls.wheel !== 0) {
        brushRadius = clamp(brushRadius - Math.sign(controls.wheel) * 0.5, MIN_BRUSH, MAX_BRUSH)
        controls.wheel = 0
      }

      camera.getWorldDirection(lookDir)
      const target = raycastTerrain(world, eye, lookDir, REACH, hit)
      const tree = world.raycastTree(
        eye.x,
        eye.y,
        eye.z,
        lookDir.x,
        lookDir.y,
        lookDir.z,
        REACH,
        treeHit,
      )
      const mobHit = mobs.raycast(eye.x, eye.y, eye.z, lookDir.x, lookDir.y, lookDir.z, REACH)

      // 手前にあるものが左クリックの対象になる（MOB > 木 > 地形）
      const terrainDist = target ? target.distance : Infinity
      const treeDist = tree ? tree.distance : Infinity
      const onMob = mobHit !== null && mobHit.distance < Math.min(terrainDist, treeDist)
      const onTree = !onMob && tree !== null && treeDist < terrainDist

      const held = inventory.held()
      const kind = TOOLS[tool].id
      const smoothing = kind === 'smooth'
      // ならしは体積の帰属が曖昧なので手持ちを増減させない。左右どちらのボタンでもならす。
      const dig = smoothing || controls.digging
      const acting = controls.digging || controls.placing

      // 道具の効果
      const digMul = held?.dig ?? 1
      const chopMul = held?.chop ?? 1
      const digRadius = clamp(brushRadius + (held?.radius ?? 0), MIN_BRUSH, MAX_BRUSH + 2)

      // 手に持っているものが置けるかどうか
      const placeMat = held?.material
      const placingTorch = held?.kind === 'light'
      const stock = held ? inventory.count(held.id) : 0

      // 手持ちが足りないぶんブラシを小さくする（盛れる量 = 掘った量）
      const repose = placeMat !== undefined ? MATERIAL_INFO[placeMat].repose : 0
      const cap = repose > 0 ? Math.min(brushRadius, MAX_PILE_RADIUS) : brushRadius
      const edge = Math.min(boxEdge(brushRadius), Math.floor(cap * 2))
      const half = dig ? boxEdge(digRadius) / 2 : Math.min(edge, Math.floor(Math.cbrt(stock))) / 2
      const radius = dig ? digRadius : Math.min(cap, Math.cbrt((stock * 3) / (4 * Math.PI)))

      // 掘るときは表面のわずかに内側、置くときはわずかに外側を中心にする
      const off = dig ? -0.25 : 0.35
      let cx = 0
      let cy = 0
      let cz = 0
      if (target) {
        cx = target.point.x + target.normal.x * off
        cy = target.point.y + target.normal.y * off
        cz = target.point.z + target.normal.z * off
        if (kind === 'box') {
          // 面が格子平面に乗るように中心を丸める。ここを丸めないと稜が面取りされる。
          cx = snapBoxCenter(cx, half)
          cy = snapBoxCenter(cy, half)
          cz = snapBoxCenter(cz, half)
        }
      }

      // カメラがゴーストの内側に入ると、ワイヤーが視界を覆って邪魔になるだけなので隠す
      const toGhost = Math.max(
        Math.abs(eye.x - cx),
        Math.abs(eye.y - cy),
        Math.abs(eye.z - cz),
      )
      const inside =
        kind === 'box'
          ? toGhost < half + 0.3
          : Math.hypot(eye.x - cx, eye.y - cy, eye.z - cz) < radius + 0.3
      const busy = onTree || onMob || placingTorch
      const showBox = kind === 'box' && target !== null && !busy && half > 0 && !inside
      const showSphere = kind !== 'box' && target !== null && !busy && !inside
      boxGhost.visible = showBox
      ghost.visible = showSphere
      if (showBox) {
        boxGhost.position.set(cx, cy, cz)
        boxGhost.scale.setScalar(half * 2)
      }
      if (showSphere) {
        ghost.position.set(cx, cy, cz)
        ghost.scale.setScalar(Math.max(radius, 0.15))
      }
      const note = onMob && mobHit
        ? `${mobHit.mob.def.name}（左クリックで攻撃）`
        : onTree
          ? '木（左クリックで伐採）'
          : null
      hud.setBrush(brushLabel(note))

      editCooldown -= dt
      if (editCooldown <= 0 && controls.digging && onMob && mobHit) {
        const dead = mobs.hurt(
          mobHit.mob,
          inventory.attack(),
          player.position.x,
          player.position.z,
        )
        if (dead) hud.showToast(`${mobHit.mob.def.name} を倒した`)
        editCooldown = ATTACK_INTERVAL
      } else if (editCooldown <= 0 && controls.digging && onTree && tree) {
        if (world.chopTree(tree)) {
          inventory.add('wood', 3)
          hud.showToast('木を伐った（木材 ×3）')
          markMetaDirty()
          editCooldown = CHOP_INTERVAL * chopMul
        }
      } else if (editCooldown <= 0 && controls.placing && placingTorch && held) {
        if (target && stock >= 1) {
          torches.add(
            target.point.x + target.normal.x * 0.06,
            target.point.y + target.normal.y * 0.06,
            target.point.z + target.normal.z * 0.06,
            controls.yaw,
          )
          inventory.take(held.id, 1)
          markMetaDirty()
          editCooldown = 0.28
        } else if (target) {
          hud.showToast('松明が足りません')
          editCooldown = 0.5
        }
      } else if (target && editCooldown <= 0 && acting) {
        if (!dig && placeMat === undefined) {
          hud.showToast('持っているものは置けません（E で持ち物）')
          editCooldown = 0.5
        } else if (!dig && stock < 1) {
          hud.showToast(`${held?.name ?? '素材'}が足りません（掘って集める）`)
          editCooldown = 0.5
        } else {
          const material = dig ? MATERIAL_INFO[0].id : (placeMat as number)
          const shape = kind === 'box' ? boxBrush(half, half, half) : sphereBrush(radius)
          // 粒状かどうかは素材 ID から決まるので、盛る側の呼び分けは要らない
          const bounds = smoothing
            ? world.applySmooth(cx, cy, cz, brushRadius, 1)
            : world.applyBrush(cx, cy, cz, shape, dig ? 'dig' : 'place', material)
          if (bounds) {
            if (smoothing) {
              // 収支なし
            } else if (dig) {
              creditDig(cx, cy, cz, target.normal.y, bounds.cleared)
              // 掘ったところにあった松明は回収する
              const t = torches.removeNear(cx, cy, cz, radius + 0.6)
              if (t) inventory.add('torch', 1)
            } else if (held) {
              inventory.take(held.id, bounds.solidified)
            }
            markMetaDirty()
            editCooldown = EDIT_INTERVAL * (dig && !smoothing ? digMul : 1)
          }
        }
      }
    } else {
      ghost.visible = false
      boxGhost.visible = false
      build.setGhost(null, false)
      tracks.setGhost(null, false, surfaceY)
      hud.setBrush(brushLabel())
    }

    // --- HUD ---
    fpsAccum += dt
    fpsFrames++
    if (fpsAccum >= 0.5) {
      fps = fpsFrames / fpsAccum
      fpsAccum = 0
      fpsFrames = 0
    }

    if (!ready) {
      const total = Math.max(1, world.desiredCount)
      const pct = Math.min(100, Math.round((world.loadedChunks / total) * 100))
      hud.setLoading(`地形を生成中… ${pct}%`)
      if (world.isChunkReady(eye.x, eye.y, eye.z) && world.loadedChunks >= Math.min(60, total)) {
        ready = true
        hud.setLoading('')
        hud.setPlayEnabled(true)
      }
    }

    if (statsVisible) {
      const h = Math.round(sky.timeOfDay * 24)
      hud.setStats(
        [
          `FPS   ${fps.toFixed(0)}`,
          `XYZ   ${player.position.x.toFixed(1)} ${player.position.y.toFixed(1)} ${player.position.z.toFixed(1)}`,
          `Chunk ${Math.floor(player.position.x / CHUNK_SIZE)} ${Math.floor(player.position.y / CHUNK_SIZE)} ${Math.floor(player.position.z / CHUNK_SIZE)}`,
          `Mesh  ${world.loadedChunks}/${world.desiredCount}  queue ${world.pendingJobs}`,
          `Mode  ${player.flying ? '飛行' : player.inWater ? '水中' : player.onGround ? '接地' : '空中'}`,
          `Env   ${biomeName(world, player.position.x, player.position.z)}  村 ${villages.activeCount}`,
          `Tree  ${world.treeCount}  伐採 ${world.choppedCount}`,
          `HP    ${Math.ceil(health)}/${MAX_HEALTH}  MOB ${mobs.total}  松明 ${torches.count}`,
          `Build ${build.count} パーツ  軌道 ${tracks.count} 区間`,
          `Rail  駅 ${trains.stations.length}  列車 ${trains.trains.length}${riding ? '（乗車中）' : ''}`,
          `Hit   ${villages.colliderCount + build.colliderCount + tracks.colliderCount}`,
          `Time  ${String(h % 24).padStart(2, '0')}:00${sky.paused ? '  固定' : ''}`,
          `Seed  ${seed}`,
        ].join('\n'),
      )
    }

    if (metaDirty > 0) {
      metaDirty -= dt
      if (metaDirty <= 0) void store.saveMeta(snapshot())
    }

    saveTimer += dt
    if (saveTimer > 8 && started) {
      saveTimer = 0
      void store.saveMeta(snapshot())
    }

    engine.render()
    stats.frames = frames
    stats.ready = ready
    stats.edits = world.editedChunkCount
    stats.loaded = world.loadedChunks
    stats.desired = world.desiredCount
    stats.villages = villages.activeCount
    stats.villageBoxes = villages.colliderCount
    stats.chopped = world.choppedCount
    for (let i = 0; i < NATURAL_MATERIAL_COUNT; i++) {
      const def = ITEM_BY_MATERIAL.get(i)
      stats.inventory[i] = def ? inventory.whole(def.id) : 0
    }
    stats.health = health
    stats.mobs = mobs.total
    stats.torches = torches.count
    stats.pieces = build.count
    stats.tracks = tracks.count
    stats.stations = trains.stations.length
    stats.trains = trains.trains.length
    stats.riding = riding !== null
    stats.unlimited = inventory.unlimited
    stats.trees = world.treeCount
    stats.tool = TOOLS[tool].id
    stats.timeOfDay = sky.timeOfDay
    stats.timeFrozen = sky.paused
  }

  tick()
}

/** HUD 表示用のバイオーム名。 */
function biomeName(world: World, x: number, z: number): string {
  const b = world.field.biomeAt(x, z)
  if (b.mountain > 0.55) return '山岳'
  if (b.temp < 0.32) return b.humid > 0.5 ? '雪の森' : 'ツンドラ'
  if (b.temp > 0.56 && b.humid < 0.42) return '砂漠'
  if (b.humid > 0.58) return '森'
  return '草原'
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}

void boot()
