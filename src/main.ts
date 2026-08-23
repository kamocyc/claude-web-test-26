import * as THREE from 'three'
import { Renderer } from './engine/Renderer'
import { SkyDayNight } from './engine/SkyDayNight'
import { Water } from './engine/Water'
import { createTerrainMaterial } from './render/TerrainMaterial'
import { createNoiseTexture } from './render/proceduralTextures'
import { createTreePrototypes, treeMaterial } from './render/treeMeshes'
import { VillageManager } from './world/VillageManager'
import type { Box } from './world/village'
import { World, createTreeHit } from './world/World'
import { boxBrush, snapBoxCenter, sphereBrush } from './world/edits'
import { WorldStore } from './world/storage'
import {
  CHUNK_SIZE,
  MATERIAL_INFO,
  SAMPLE_SEED,
  SEA_LEVEL,
  VILLAGE_CELL,
} from './world/constants'
import { Player, PLAYER_EYE } from './player/Player'
import { Controls } from './player/Controls'
import { createRayHit, raycastTerrain } from './player/terrainRaycast'
import { Hud } from './ui/hud'

const VIEW_DISTANCE = 7
const REACH = 9
const MIN_BRUSH = 1
const MAX_BRUSH = 6
const EDIT_INTERVAL = 0.09
const CHOP_INTERVAL = 0.25

/** B キーで切り替わるブラシ。 */
const TOOLS = [
  { id: 'sphere', name: '球' },
  { id: 'box', name: '直方体' },
  { id: 'smooth', name: 'ならし' },
] as const

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
  world.setMaterial(createTerrainMaterial(createNoiseTexture()))
  world.setTreeAssets(createTreePrototypes(), treeMaterial)
  scene.add(world.group)

  const villages = new VillageManager(world.field)
  scene.add(villages.group)
  store.setEditSource((key) => world.getEdits(key))
  if (hasDb) world.setEdits(await store.loadAllEdits())
  if (meta?.chopped) world.setChopped(meta.chopped)

  // 素材の手持ち量。掘ると増え、盛ると減る。
  const inventory = new Float32Array(MATERIAL_INFO.length)
  if (meta?.inventory) {
    for (let i = 0; i < inventory.length; i++) inventory[i] = meta.inventory[i] ?? 0
  }
  hud.setInventory(inventory)

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
    const m = MATERIAL_INFO[slot]
    const grain = t.id !== 'smooth' && m.repose > 0 ? `　${m.name}は崩れて積もる` : ''
    if (t.id === 'box') {
      const n = boxEdge(brushRadius)
      return `${t.name} ${n}×${n}×${n} m${grain}`
    }
    return `${t.name} 半径 ${brushRadius.toFixed(1)} m${grain}`
  }

  let brushRadius = 2.5
  let tool = 0
  let slot = 0
  let statsVisible = true
  let started = false
  let editCooldown = 0
  hud.setBrush(brushLabel())

  controls.onSlot = (i) => {
    if (i >= MATERIAL_INFO.length) return
    slot = i
    hud.setSlot(i)
  }
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
  }
  controls.onWarpVillage = () => {
    hud.showToast(stats.gotoVillage() ? '最寄りの村へワープしました' : '近くに村が見つかりません')
  }
  controls.onToggleStats = () => {
    statsVisible = !statsVisible
    hud.setStatsVisible(statsVisible)
  }
  controls.onLockChange = (locked) => {
    if (!locked && started) hud.setOverlay(true)
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
    inventory.fill(0)
    hud.setInventory(inventory)
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
      inventory: [...inventory],
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
    /** 一番近い木の根元の位置（デバッグ／テスト用）。 */
    nearestTree(): { x: number; y: number; z: number } | null {
      const t = world.collectTrunks(
        player.position.x,
        player.position.y,
        player.position.z,
        14,
      )
      let best: { x: number; y: number; z: number } | null = null
      let bestD = Infinity
      for (let i = 0; i < t.length; i += 5) {
        const d = Math.hypot(t[i] - player.position.x, t[i + 2] - player.position.z)
        if (d < bestD) {
          bestD = d
          best = { x: t[i], y: t[i + 1], z: t[i + 2] }
        }
      }
      return best
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
    /** 手持ち量を直接与える（テスト用）。 */
    giveMaterial(index: number, amount: number) {
      if (index < 0 || index >= inventory.length) return
      inventory[index] = amount
      hud.setInventory(inventory)
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

  /**
   * 掘った体積を素材ごとの手持ちに足す。
   * プレイヤーが設置した素材があればそれを、無ければ地形本来の素材の比率で分ける。
   */
  function creditDig(x: number, y: number, z: number, ny: number, amount: number): void {
    if (amount <= 0) return
    const placed = world.cornerMaterial(Math.round(x), Math.round(y), Math.round(z))
    if (placed < inventory.length) {
      inventory[placed] += amount
      return
    }
    world.field.surfaceSample(x, y, z, ny, matScratch, 0)
    for (let i = 0; i < inventory.length; i++) inventory[i] += amount * matScratch[i]
  }

  function tick(): void {
    requestAnimationFrame(tick)
    const dt = Math.min(clock.getDelta(), 0.1)
    frames++

    if (started && controls.locked) {
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

    // 水中は視界を濁らせる
    const underwater = camera.position.y < SEA_LEVEL
    engine.fog.density = underwater ? 0.055 : surfaceFogDensity
    if (underwater) engine.fog.color.setHex(0x1c4f6b)

    // --- ブラシ ---
    if (started && controls.locked) {
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
      // 木のほうが手前なら、左クリックは伐採になる
      const onTree = tree !== null && tree.distance < (target ? target.distance : Infinity)

      const kind = TOOLS[tool].id
      const smoothing = kind === 'smooth'
      // ならしは体積の帰属が曖昧なので手持ちを増減させない。左右どちらのボタンでもならす。
      const dig = smoothing || controls.digging
      const acting = controls.digging || controls.placing

      // 手持ちが足りないぶんブラシを小さくする（盛れる量 = 掘った量）
      const stock = inventory[slot]
      const repose = MATERIAL_INFO[slot].repose
      const cap = repose > 0 ? Math.min(brushRadius, MAX_PILE_RADIUS) : brushRadius
      const edge = Math.min(boxEdge(brushRadius), Math.floor(cap * 2))
      const half = dig ? boxEdge(brushRadius) / 2 : Math.min(edge, Math.floor(Math.cbrt(stock))) / 2
      const radius = dig ? brushRadius : Math.min(cap, Math.cbrt((stock * 3) / (4 * Math.PI)))

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
      const showBox = kind === 'box' && target !== null && !onTree && half > 0 && !inside
      const showSphere = kind !== 'box' && target !== null && !onTree && !inside
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
      hud.setBrush(brushLabel(onTree ? '木（左クリックで伐採）' : null))

      editCooldown -= dt
      if (editCooldown <= 0 && controls.digging && onTree && tree) {
        if (world.chopTree(tree)) {
          hud.showToast('木を切り倒した')
          markMetaDirty()
          editCooldown = CHOP_INTERVAL
        }
      } else if (target && editCooldown <= 0 && acting) {
        if (!dig && stock < 1) {
          hud.showToast(`${MATERIAL_INFO[slot].name}が足りません（掘って集める）`)
          editCooldown = 0.5
        } else {
          const shape = kind === 'box' ? boxBrush(half, half, half) : sphereBrush(radius)
          // 粒状かどうかは素材 ID から決まるので、盛る側の呼び分けは要らない
          const bounds = smoothing
            ? world.applySmooth(cx, cy, cz, brushRadius, 1)
            : world.applyBrush(cx, cy, cz, shape, dig ? 'dig' : 'place', MATERIAL_INFO[slot].id)
          if (bounds) {
            if (smoothing) {
              // 収支なし
            } else if (dig) {
              creditDig(cx, cy, cz, target.normal.y, bounds.cleared)
            } else {
              inventory[slot] = Math.max(0, inventory[slot] - bounds.solidified)
            }
            hud.setInventory(inventory)
            markMetaDirty()
            editCooldown = EDIT_INTERVAL
          }
        }
      }
    } else {
      ghost.visible = false
      boxGhost.visible = false
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
    for (let i = 0; i < inventory.length; i++) stats.inventory[i] = inventory[i]
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
