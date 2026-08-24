import * as THREE from 'three'
import { SEA_LEVEL } from '../world/constants'
import type { FieldSample, World } from '../world/World'
import type { ItemId } from '../items/items'
import { MOB_DEFS, type MobDef, type MobKind, type MobModel, buildMobModel } from './mobs'

const GRAVITY = 26
const DESPAWN = 100
const SPAWN_MIN = 22
const SPAWN_MAX = 46
/** 押し出しに使う球の当たり判定の反復回数。 */
const RESOLVE_ITER = 3

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
 */
export class MobManager {
  readonly group = new THREE.Group()
  readonly mobs: Mob[] = []

  /** 敵がプレイヤーを殴ったときに呼ばれる。 */
  onAttack: ((damage: number, mob: Mob) => void) | null = null
  /** MOB を倒したときに呼ばれる。 */
  onDrop: ((id: ItemId, count: number, mob: Mob) => void) | null = null

  private readonly sample: FieldSample = { d: 0, gx: 0, gy: 0, gz: 0 }
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
        const nx = -s.gx / g
        const ny = -s.gy / g
        const nz = -s.gz / g
        const push = Math.min(pen, 0.5)
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
        if (ny > 0.5) m.onGround = true
      }
      if (moved < 1e-4) break
    }
    // 奈落に落ちたら消す
    if (m.pos.y < SEA_LEVEL - 90) m.hp = 0
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
