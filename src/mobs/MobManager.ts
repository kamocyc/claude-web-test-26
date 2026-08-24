import * as THREE from 'three'
import { SEA_LEVEL, WALKABLE_NY } from '../world/constants'
import type { FieldSample, World } from '../world/World'
import type { Box } from '../world/village'
import type { ItemId } from '../items/items'
import { MOB_DEFS, type MobDef, type MobKind, type MobModel, buildMobModel } from './mobs'

const GRAVITY = 26
const DESPAWN = 100
const SPAWN_MIN = 22
const SPAWN_MAX = 46
/** 押し出しに使う球の当たり判定の反復回数。 */
const RESOLVE_ITER = 3
/** 進路を調べる距離（体の半径に足す）。 */
const LOOKAHEAD = 1.3
/** MOB がまたげる段差。これより高い壁は登れない扱いにする。 */
const STEP_UP = 0.7
/** これより下へ落ちる縁は避ける。 */
const MAX_DROP = 3.2
/** 進路を選び直す間隔。毎フレーム測り直すのは無駄なので間引く。 */
const AVOID_INTERVAL = 0.2
/** 迂回で試す曲がり角（ラジアン）。手前から順に試す。 */
const TURNS = [0, 0.6, -0.6, 1.2, -1.2, 1.9, -1.9, 2.7, -2.7]
/** 障害物を集める半径。 */
const OBSTACLE_RANGE = 4

/** 進路上の障害物（木の幹と建物の壁）を教えてくれるもの。 */
export interface Obstacles {
  /** 縦円柱（x, y, z, 半径, 高さ）を 5 要素ずつ並べた配列。 */
  trunksNear(x: number, y: number, z: number, r: number): Float32Array
  /** 軸平行ボックスの当たり判定。y は「どの高さの帯を見ればよいか」の目安に使う。 */
  boxesNear(x: number, y: number, z: number, r: number, out: Box[]): Box[]
}

const NO_TRUNKS = new Float32Array(0)
const NO_BOXES: Box[] = []

export interface Mob {
  readonly def: MobDef
  readonly model: MobModel
  readonly pos: THREE.Vector3
  readonly vel: THREE.Vector3
  hp: number
  yaw: number
  /** さまよう向きを変えるまでの残り時間。 */
  wander: number
  wanderYaw: number
  attackCd: number
  hurtFlash: number
  onGround: boolean
  /** プレイヤーに倒されたか。奈落へ落ちただけならドロップしない。 */
  killed: boolean
  /** 歩行アニメーションの位相。 */
  phase: number
  /** 村人が属する村の中心（そこから離れない）。 */
  homeX: number
  homeZ: number
  homeR: number
  /** 迂回のために足している回転角と、その決め直しまでの残り時間。 */
  avoidTurn: number
  avoidCd: number
}

export interface MobHit {
  mob: Mob
  distance: number
}

/**
 * MOB の湧き・消滅・移動・戦闘。
 *
 * 地形は連続な密度場なので、経路探索は持たずに
 * 「行きたい向きへ加速して、めり込んだら勾配方向へ押し出す」だけで坂を歩ける。
 * プレイヤーと同じ仕組み（`密度 / |勾配|` を符号付き距離とみなす）を使う。
 *
 * 障害物も経路探索ではなく先読みで避ける。1 歩先に立てるかを扇状に試し、
 * 通れる向きへ振るだけで、崖・登れない坂・木・建物を回り込む。
 */
export class MobManager {
  readonly group = new THREE.Group()
  readonly mobs: Mob[] = []

  /** 敵がプレイヤーを殴ったときに呼ばれる。 */
  onAttack: ((damage: number, mob: Mob) => void) | null = null
  /** MOB を倒したときに呼ばれる。 */
  onDrop: ((id: ItemId, count: number, mob: Mob) => void) | null = null

  /** 木と建物の当たり判定の供給元。未設定なら地形だけを見る。 */
  obstacles: Obstacles | null = null

  private readonly sample: FieldSample = { d: 0, gx: 0, gy: 0, gz: 0 }
  private readonly boxScratch: Box[] = []
  private spawnTimer = 0

  constructor() {
    this.group.name = 'mobs'
  }

  count(kind: MobKind): number {
    let n = 0
    for (const m of this.mobs) if (m.def.kind === kind) n++
    return n
  }

  get total(): number {
    return this.mobs.length
  }

  clear(): void {
    for (const m of this.mobs) this.group.remove(m.model.root)
    this.mobs.length = 0
  }

  /**
   * @param daylight 1 が昼、0 が夜。亡霊は夜だけ湧く。
   */
  update(
    dt: number,
    world: World,
    px: number,
    py: number,
    pz: number,
    daylight: number,
  ): void {
    this.spawnTimer -= dt
    if (this.spawnTimer <= 0) {
      this.spawnTimer = 1.1
      this.trySpawn(world, px, pz, daylight)
    }

    for (let i = this.mobs.length - 1; i >= 0; i--) {
      const m = this.mobs[i]
      const far = Math.hypot(m.pos.x - px, m.pos.z - pz) > DESPAWN
      // 夜の敵は朝になったら消える
      const burns = m.def.kind === 'wraith' && daylight > 0.75
      if (m.hp <= 0 || far || burns) {
        if (m.killed) for (const [id, n] of m.def.drops) this.onDrop?.(id, n, m)
        this.group.remove(m.model.root)
        this.mobs.splice(i, 1)
        continue
      }
      this.step(m, dt, world, px, py, pz)
    }
  }

  private step(m: Mob, dt: number, world: World, px: number, py: number, pz: number): void {
    const def = m.def
    const dx = px - m.pos.x
    const dz = pz - m.pos.z
    const dist = Math.hypot(dx, dz)
    const sees = dist < def.sight

    let wishX = 0
    let wishZ = 0
    let speed = def.speed

    if (def.hostile && sees) {
      // 追いかける
      speed = def.runSpeed
      wishX = dx / (dist || 1)
      wishZ = dz / (dist || 1)
      m.attackCd -= dt
      if (dist < def.radius + 1.15 && Math.abs(py - m.pos.y) < 2.4) {
        wishX = 0
        wishZ = 0
        if (m.attackCd <= 0) {
          m.attackCd = def.attackInterval
          this.onAttack?.(def.attack, m)
        }
      }
    } else if (def.flees && sees) {
      // 逃げる
      speed = def.runSpeed
      wishX = -dx / (dist || 1)
      wishZ = -dz / (dist || 1)
    } else {
      // さまよう
      m.wander -= dt
      if (m.wander <= 0) {
        m.wander = 2 + Math.random() * 4
        m.wanderYaw = Math.random() * Math.PI * 2
      }
      wishX = Math.sin(m.wanderYaw)
      wishZ = Math.cos(m.wanderYaw)
      // 村人は広場から離れない
      if (m.homeR > 0) {
        const hx = m.pos.x - m.homeX
        const hz = m.pos.z - m.homeZ
        const hd = Math.hypot(hx, hz)
        if (hd > m.homeR) {
          wishX = -hx / hd
          wishZ = -hz / hd
        }
      }
    }

    // 木と建物はここで一度だけ集める（返る配列は使い回しなので持ち越さない）
    const obs = this.obstacles
    const trunks = obs
      ? obs.trunksNear(m.pos.x, m.pos.y, m.pos.z, OBSTACLE_RANGE)
      : NO_TRUNKS
    const boxes = obs
      ? obs.boxesNear(m.pos.x, m.pos.y, m.pos.z, OBSTACLE_RANGE, this.boxScratch)
      : NO_BOXES

    // 登れない坂・木・建物の手前で向きを振り直す
    if (wishX !== 0 || wishZ !== 0) {
      const turn = this.chooseTurn(m, dt, world, trunks, boxes, wishX, wishZ)
      if (turn !== 0) {
        const c = Math.cos(turn)
        const sn = Math.sin(turn)
        const nx = wishX * c - wishZ * sn
        wishZ = wishX * sn + wishZ * c
        wishX = nx
      }
    }

    const accel = m.onGround ? 12 : 3
    const a = Math.min(1, accel * dt)
    m.vel.x += (wishX * speed - m.vel.x) * a
    m.vel.z += (wishZ * speed - m.vel.z) * a
    if (m.onGround && m.vel.y < 0) m.vel.y = 0
    m.vel.y -= GRAVITY * dt

    m.pos.x += m.vel.x * dt
    m.pos.y += m.vel.y * dt
    m.pos.z += m.vel.z * dt

    this.resolve(m, world)
    this.resolveTrunks(m, trunks)
    this.resolveBoxes(m, boxes)

    // 崖や壁に当たって止まったら向きを変える
    const moving = Math.hypot(m.vel.x, m.vel.z)
    if (moving < 0.15 && !(def.hostile && sees)) m.wander = Math.min(m.wander, 0.2)

    if (moving > 0.05) m.yaw = Math.atan2(m.vel.x, m.vel.z)
    m.phase += moving * dt * 3.4
    m.hurtFlash = Math.max(0, m.hurtFlash - dt * 3)

    const model = m.model
    model.root.position.copy(m.pos)
    model.root.rotation.y = m.yaw
    // 歩くとわずかに上下し、脚が振れる
    model.body.position.y = Math.sin(m.phase * 2) * 0.045 * Math.min(1, moving)
    for (let i = 0; i < model.legs.length; i++) {
      const sign = i % 2 === 0 ? 1 : -1
      model.legs[i].rotation.x = Math.sin(m.phase + (i < 2 ? 0 : Math.PI)) * 0.6 * sign
    }
    model.root.visible = m.hurtFlash <= 0 || Math.sin(m.hurtFlash * 40) > 0
  }

  /** 球の当たり判定。めり込んだぶんだけ勾配の逆向きに押し出す。 */
  private resolve(m: Mob, world: World): void {
    const s = this.sample
    const r = m.def.radius
    m.onGround = false
    for (let iter = 0; iter < RESOLVE_ITER; iter++) {
      let moved = 0
      for (const h of [r, m.def.height * 0.55, m.def.height - r]) {
        world.sample(m.pos.x, m.pos.y + h, m.pos.z, s)
        const g = Math.hypot(s.gx, s.gy, s.gz)
        if (g < 1e-5) continue
        const pen = s.d / g + r
        if (pen <= 0) continue
        let nx = -s.gx / g
        let ny = -s.gy / g
        let nz = -s.gz / g
        // プレイヤーと同じく、立てないほど急な面では押し出しを水平だけにする。
        // そうしないと壁に体を押しつけるだけで崖をよじ登れてしまう。
        const nh = Math.hypot(nx, nz)
        let depth = pen
        if (ny > 0 && ny <= WALKABLE_NY && nh > 1e-3 && s.d <= 0) {
          depth /= nh
          nx /= nh
          nz /= nh
          ny = 0
        }
        const push = Math.min(depth, 0.5)
        m.pos.x += nx * push
        m.pos.y += ny * push
        m.pos.z += nz * push
        moved += push
        const vn = m.vel.x * nx + m.vel.y * ny + m.vel.z * nz
        if (vn < 0) {
          m.vel.x -= nx * vn
          m.vel.y -= ny * vn
          m.vel.z -= nz * vn
        }
        if (ny > WALKABLE_NY) m.onGround = true
      }
      if (moved < 1e-4) break
    }
    // 奈落に落ちたら消す
    if (m.pos.y < SEA_LEVEL - 90) m.hp = 0
  }

  /**
   * 進みたい向きが通れるか調べ、駄目なら左右へ振った向きを返す。
   *
   * 経路探索はしない。「1.3 m 先に立てるか」を扇状に何本か試すだけで、
   * 崖・壁・木を回り込み、行き止まりでは引き返す。
   * 毎フレーム測ると無駄なので `AVOID_INTERVAL` ごとに選び直し、
   * その間は同じ曲がり角を足し続ける（ふらつかずに壁沿いを歩く）。
   */
  private chooseTurn(
    m: Mob,
    dt: number,
    world: World,
    trunks: Float32Array,
    boxes: readonly Box[],
    wishX: number,
    wishZ: number,
  ): number {
    m.avoidCd -= dt
    if (m.avoidCd > 0) return m.avoidTurn
    m.avoidCd = AVOID_INTERVAL
    for (const turn of TURNS) {
      const c = Math.cos(turn)
      const sn = Math.sin(turn)
      if (this.canGo(m, world, trunks, boxes, wishX * c - wishZ * sn, wishX * sn + wishZ * c)) {
        m.avoidTurn = turn
        return turn
      }
    }
    // どこも塞がっていたら引き返す
    m.avoidTurn = Math.PI
    return Math.PI
  }

  /** その向きへ 1 歩進んだ先に立てるか。 */
  private canGo(
    m: Mob,
    world: World,
    trunks: Float32Array,
    boxes: readonly Box[],
    dx: number,
    dz: number,
  ): boolean {
    const r = m.def.radius
    const ax = m.pos.x + dx * (r + LOOKAHEAD)
    const az = m.pos.z + dz * (r + LOOKAHEAD)
    const s = this.sample

    // またげない高さの地形（段差 STEP_UP より上に体が残るか）
    world.sample(ax, m.pos.y + STEP_UP + r, az, s)
    let g = Math.hypot(s.gx, s.gy, s.gz)
    if (g > 1e-5 && s.d / g + r > 0) return false

    // 落ちすぎる縁。空中にいるときは判定しない（着地の邪魔になる）
    if (m.onGround) {
      world.sample(ax, m.pos.y - MAX_DROP, az, s)
      g = Math.hypot(s.gx, s.gy, s.gz)
      if (g > 1e-5 && s.d / g < 0) return false
    }

    const feet = m.pos.y
    const head = m.pos.y + m.def.height
    for (let i = 0; i < trunks.length; i += 5) {
      if (head < trunks[i + 1] || feet > trunks[i + 1] + trunks[i + 4]) continue
      const tx = ax - trunks[i]
      const tz = az - trunks[i + 2]
      const rr = trunks[i + 3] + r
      if (tx * tx + tz * tz < rr * rr) return false
    }
    for (const b of boxes) {
      if (head <= b.minY || feet >= b.maxY) continue
      if (ax > b.minX - r && ax < b.maxX + r && az > b.minZ - r && az < b.maxZ + r) return false
    }
    return true
  }

  /** 木の幹と枝葉（縦円柱）から水平に押し出す。 */
  private resolveTrunks(m: Mob, trunks: Float32Array): void {
    const r = m.def.radius
    const feet = m.pos.y
    const head = m.pos.y + m.def.height
    for (let i = 0; i < trunks.length; i += 5) {
      if (head < trunks[i + 1] || feet > trunks[i + 1] + trunks[i + 4]) continue
      const dx = m.pos.x - trunks[i]
      const dz = m.pos.z - trunks[i + 2]
      const rr = trunks[i + 3] + r
      const d2 = dx * dx + dz * dz
      if (d2 >= rr * rr || d2 < 1e-8) continue
      const d = Math.sqrt(d2)
      const nx = dx / d
      const nz = dz / d
      m.pos.x += nx * (rr - d)
      m.pos.z += nz * (rr - d)
      const vn = m.vel.x * nx + m.vel.z * nz
      if (vn < 0) {
        m.vel.x -= nx * vn
        m.vel.z -= nz * vn
      }
    }
  }

  /** 建物の壁から最小移動量で押し出す。屋根には乗らない。 */
  private resolveBoxes(m: Mob, boxes: readonly Box[]): void {
    const r = m.def.radius
    for (const b of boxes) {
      const minX = b.minX - r
      const maxX = b.maxX + r
      const minZ = b.minZ - r
      const maxZ = b.maxZ + r
      if (m.pos.x <= minX || m.pos.x >= maxX || m.pos.z <= minZ || m.pos.z >= maxZ) continue
      if (m.pos.y + m.def.height <= b.minY || m.pos.y >= b.maxY) continue
      const ox1 = m.pos.x - minX
      const ox2 = maxX - m.pos.x
      const oz1 = m.pos.z - minZ
      const oz2 = maxZ - m.pos.z
      const best = Math.min(ox1, ox2, oz1, oz2)
      if (best === ox1) {
        m.pos.x = minX
        if (m.vel.x > 0) m.vel.x = 0
      } else if (best === ox2) {
        m.pos.x = maxX
        if (m.vel.x < 0) m.vel.x = 0
      } else if (best === oz1) {
        m.pos.z = minZ
        if (m.vel.z > 0) m.vel.z = 0
      } else {
        m.pos.z = maxZ
        if (m.vel.z < 0) m.vel.z = 0
      }
    }
  }

  // ---------------------------------------------------------------- 湧き

  private trySpawn(world: World, px: number, pz: number, daylight: number): void {
    const night = daylight < 0.35
    const order: MobKind[] = night ? ['wraith', 'villager'] : ['deer', 'villager']
    for (const kind of order) {
      const def = MOB_DEFS[kind]
      if (this.count(kind) >= def.max) continue
      const spot = this.findSpot(world, px, pz, kind)
      if (!spot) continue
      this.spawn(kind, spot.x, spot.y, spot.z, spot.homeX, spot.homeZ, spot.homeR)
      return
    }
  }

  private findSpot(
    world: World,
    px: number,
    pz: number,
    kind: MobKind,
  ): { x: number; y: number; z: number; homeX: number; homeZ: number; homeR: number } | null {
    for (let attempt = 0; attempt < 8; attempt++) {
      let x: number
      let z: number
      let homeX = 0
      let homeZ = 0
      let homeR = 0

      if (kind === 'villager') {
        const v = world.field.villageNear(px, pz)
        if (!v) return null
        if (Math.hypot(v.cx - px, v.cz - pz) > 90) return null
        const ang = Math.random() * Math.PI * 2
        const rad = v.radius * (0.25 + Math.random() * 0.6)
        x = v.cx + Math.cos(ang) * rad
        z = v.cz + Math.sin(ang) * rad
        homeX = v.cx
        homeZ = v.cz
        homeR = v.radius * 0.95
      } else {
        const ang = Math.random() * Math.PI * 2
        const rad = SPAWN_MIN + Math.random() * (SPAWN_MAX - SPAWN_MIN)
        x = px + Math.cos(ang) * rad
        z = pz + Math.sin(ang) * rad
      }

      const h = world.field.height(x, z)
      if (h < SEA_LEVEL + 1.2) continue
      if (kind === 'deer') {
        // 砂漠には湧かない
        const b = world.field.biomeAt(x, z)
        if (b.temp > 0.62 && b.humid < 0.3) continue
      }
      const y = h + 0.4
      // 地表が編集で消えていないか確かめる
      if (world.densityAt(x, y + 1.0, z) > 0) continue
      return { x, y, z, homeX, homeZ, homeR }
    }
    return null
  }

  spawn(
    kind: MobKind,
    x: number,
    y: number,
    z: number,
    homeX = 0,
    homeZ = 0,
    homeR = 0,
  ): Mob {
    const def = MOB_DEFS[kind]
    const model = buildMobModel(kind)
    model.root.position.set(x, y, z)
    this.group.add(model.root)
    const mob: Mob = {
      def,
      model,
      pos: new THREE.Vector3(x, y, z),
      vel: new THREE.Vector3(),
      hp: def.hp,
      yaw: Math.random() * Math.PI * 2,
      wander: Math.random() * 3,
      wanderYaw: Math.random() * Math.PI * 2,
      attackCd: 0,
      hurtFlash: 0,
      onGround: false,
      killed: false,
      phase: 0,
      homeX,
      homeZ,
      homeR,
      avoidTurn: 0,
      avoidCd: 0,
    }
    this.mobs.push(mob)
    return mob
  }

  // ---------------------------------------------------------------- 戦闘

  /** 視線上でいちばん手前の MOB。 */
  raycast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDist: number,
  ): MobHit | null {
    let best: MobHit | null = null
    for (const m of this.mobs) {
      // 当たり判定は胴の中心に置いた球
      const cy = m.pos.y + m.def.height * 0.55
      const ex = m.pos.x - ox
      const ey = cy - oy
      const ez = m.pos.z - oz
      const along = ex * dx + ey * dy + ez * dz
      if (along < 0 || along > maxDist) continue
      const perp2 = ex * ex + ey * ey + ez * ez - along * along
      const rr = m.def.radius + 0.45
      if (perp2 > rr * rr) continue
      if (!best || along < best.distance) best = { mob: m, distance: along }
    }
    return best
  }

  /** ダメージを与える。倒したら true。 */
  hurt(mob: Mob, damage: number, fromX: number, fromZ: number): boolean {
    mob.hp -= damage
    mob.hurtFlash = 0.45
    const dx = mob.pos.x - fromX
    const dz = mob.pos.z - fromZ
    const d = Math.hypot(dx, dz) || 1
    mob.vel.x += (dx / d) * 4.2
    mob.vel.z += (dz / d) * 4.2
    mob.vel.y = Math.max(mob.vel.y, 3.2)
    // 攻撃されたら怯えて逃げるのをやめない（動物はそのまま逃げ続ける）
    mob.wander = 0
    if (mob.hp <= 0) mob.killed = true
    return mob.hp <= 0
  }

  /** いちばん近い村人。交易の相手を探すのに使う。 */
  nearestVillager(x: number, z: number, maxDist: number): Mob | null {
    let best: Mob | null = null
    let bd = maxDist
    for (const m of this.mobs) {
      if (m.def.kind !== 'villager') continue
      const d = Math.hypot(m.pos.x - x, m.pos.z - z)
      if (d < bd) {
        bd = d
        best = m
      }
    }
    return best
  }
}
