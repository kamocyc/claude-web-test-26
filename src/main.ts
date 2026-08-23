import * as THREE from 'three'
import { Renderer } from './engine/Renderer'
import { SkyDayNight } from './engine/SkyDayNight'
import { Water } from './engine/Water'
import { createTerrainMaterial } from './render/TerrainMaterial'
import { createNoiseTexture } from './render/proceduralTextures'
import { World } from './world/World'
import { WorldStore } from './world/storage'
import { CHUNK_SIZE, MATERIAL_INFO, SEA_LEVEL } from './world/constants'
import { Player, PLAYER_EYE } from './player/Player'
import { Controls } from './player/Controls'
import { createRayHit, raycastTerrain } from './player/terrainRaycast'
import { Hud } from './ui/hud'

const VIEW_DISTANCE = 7
const REACH = 9
const MIN_BRUSH = 1
const MAX_BRUSH = 6
const EDIT_INTERVAL = 0.09

async function boot(): Promise<void> {
  const hud = new Hud()
  hud.setPlayEnabled(false)
  hud.setLoading('ワールドを準備しています…')

  const store = new WorldStore()
  const hasDb = await store.open()
  const meta = hasDb ? await store.loadMeta() : null
  const seed = meta?.seed ?? Math.floor(Math.random() * 1_000_000_000)

  const engine = new Renderer(VIEW_DISTANCE)
  const scene = engine.scene
  const camera = engine.camera

  const world = new World({ seed, viewDistance: VIEW_DISTANCE, store })
  world.setMaterial(createTerrainMaterial(createNoiseTexture()))
  scene.add(world.group)
  store.setEditSource((key) => world.getEdits(key))
  if (hasDb) world.setEdits(await store.loadAllEdits())

  const sky = new SkyDayNight(scene, camera.far * 0.5)
  if (meta) sky.timeOfDay = meta.timeOfDay

  const water = new Water()
  scene.add(water.mesh)

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
    player.spawnAt(world, 0.5, 0.5)
    hud.setLoading('')
    hud.setPlayEnabled(true)
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
    }
  }

  // デバッグ／自動テスト用の状態（HUD と同じ値）
  const stats = { frames: 0, ready: false, edits: 0, loaded: 0, desired: 0 }
  ;(window as unknown as Record<string, unknown>).__smooth = stats

  const hit = createRayHit()
  const lookDir = new THREE.Vector3()
  const eye = new THREE.Vector3()
  const clock = new THREE.Clock()
  let frames = 0
  let fps = 0
  let fpsAccum = 0
  let fpsFrames = 0
  let saveTimer = 0
  let ready = false

  const surfaceFogDensity = engine.fog.density

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
    sky.update(dt, camera.position, engine.fog)
    water.update(dt, camera.position)

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
      if (target) {
        ghost.visible = true
        ghost.position.copy(target.point)
        ghost.scale.setScalar(brushRadius)
      } else {
        ghost.visible = false
      }

      editCooldown -= dt
      if (target && editCooldown <= 0 && (controls.digging || controls.placing)) {
        const dig = controls.digging
        // 掘るときは表面のわずかに内側、置くときはわずかに外側を中心にする
        const off = dig ? -0.25 : 0.35
        const cx = target.point.x + target.normal.x * off
        const cy = target.point.y + target.normal.y * off
        const cz = target.point.z + target.normal.z * off
        const changed = world.applyBrush(
          cx,
          cy,
          cz,
          brushRadius,
          dig ? 'dig' : 'place',
          MATERIAL_INFO[slot].id,
        )
        if (changed) editCooldown = EDIT_INTERVAL
      }
    } else {
      ghost.visible = false
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
          `Time  ${String(h).padStart(2, '0')}:00`,
          `Seed  ${seed}`,
        ].join('\n'),
      )
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
  }

  tick()
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}

void boot()
