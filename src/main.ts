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

  let brushRadius = 2.5
  let slot = 0
  let statsVisible = true
  let started = false
  let editCooldown = 0
  hud.setBrush(brushRadius)

  controls.onSlot = (i) => {
    if (i >= MATERIAL_INFO.length) return
    slot = i
    hud.setSlot(i)
  }
  controls.onToggleFly = () => player.toggleFly()
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
        hud.setBrush(brushRadius)
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

      // 手持ちが足りないぶんブラシを小さくする（盛れる量 = 掘った量）
      const stock = inventory[slot]
      const placeRadius = Math.min(brushRadius, Math.cbrt((stock * 3) / (4 * Math.PI)))

      if (target && !onTree) {
        ghost.visible = true
        ghost.position.copy(target.point)
        ghost.scale.setScalar(controls.placing ? Math.max(placeRadius, 0.15) : brushRadius)
      } else {
        ghost.visible = false
      }
      hud.setBrush(brushRadius, onTree ? '木（左クリックで伐採）' : null)

      editCooldown -= dt
      if (editCooldown <= 0 && controls.digging && onTree && tree) {
        if (world.chopTree(tree)) {
          hud.showToast('木を切り倒した')
          markMetaDirty()
          editCooldown = CHOP_INTERVAL
        }
      } else if (target && editCooldown <= 0 && (controls.digging || controls.placing)) {
        const dig = controls.digging
        if (!dig && stock < 1) {
          hud.showToast(`${MATERIAL_INFO[slot].name}が足りません（掘って集める）`)
          editCooldown = 0.5
        } else {
          // 掘るときは表面のわずかに内側、置くときはわずかに外側を中心にする
          const off = dig ? -0.25 : 0.35
          const cx = target.point.x + target.normal.x * off
          const cy = target.point.y + target.normal.y * off
          const cz = target.point.z + target.normal.z * off
          const bounds = world.applyBrush(
            cx,
            cy,
            cz,
            dig ? brushRadius : placeRadius,
            dig ? 'dig' : 'place',
            MATERIAL_INFO[slot].id,
          )
          if (bounds) {
            if (dig) creditDig(cx, cy, cz, target.normal.y, bounds.cleared)
            else inventory[slot] = Math.max(0, inventory[slot] - bounds.solidified)
            hud.setInventory(inventory)
            markMetaDirty()
            editCooldown = EDIT_INTERVAL
          }
        }
      }
    } else {
      ghost.visible = false
      hud.setBrush(brushRadius)
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
          `Time  ${String(h).padStart(2, '0')}:00`,
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
