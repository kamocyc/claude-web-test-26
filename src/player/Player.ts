import * as THREE from 'three'
import type { World, FieldSample } from '../world/World'
import { SEA_LEVEL, WORLD_MIN_Y } from '../world/constants'
import type { Controls } from './Controls'

const RADIUS = 0.38
const HEIGHT = 1.78
const EYE = 1.62

const GRAVITY = 27
const JUMP_SPEED = 9.4
const WALK_SPEED = 5.2
const SPRINT_SPEED = 8.6
const FLY_SPEED = 19
const FLY_SPRINT = 46
const SWIM_SPEED = 4.2

const MAX_STEP = 1 / 90
const MAX_SUBSTEPS = 6

/** カプセル軸上のサンプル点（足元から頭まで）の高さ。 */
const AXIS = [RADIUS, HEIGHT * 0.38, HEIGHT * 0.68, HEIGHT - RADIUS]

/**
 * 密度場に対するカプセル衝突を持つ一人称プレイヤー。
 *
 * 地形が滑らかなので、ブロック地形のような「段差を登る」特別処理は不要で、
 * 勾配方向へ押し出すだけで坂も洞窟の天井も自然に扱える。
 */
export class Player {
  readonly position = new THREE.Vector3()
  readonly velocity = new THREE.Vector3()

  onGround = false
  inWater = false
  flying = false
  headUnderwater = false

  private accumulator = 0
  private readonly sample: FieldSample = { d: 0, gx: 0, gy: 0, gz: 0 }

  get eyeY(): number {
    return this.position.y + EYE
  }

  get radius(): number {
    return RADIUS
  }

  toggleFly(): void {
    this.flying = !this.flying
    if (this.flying) this.velocity.y = 0
  }

  update(dt: number, world: World, controls: Controls): void {
    this.accumulator += Math.min(dt, 0.25)
    let steps = 0
    while (this.accumulator >= MAX_STEP && steps < MAX_SUBSTEPS) {
      this.step(MAX_STEP, world, controls)
      this.accumulator -= MAX_STEP
      steps++
    }
    if (steps === MAX_SUBSTEPS) this.accumulator = 0
  }

  private step(dt: number, world: World, controls: Controls): void {
    const keys = controls.keys
    const sprint = keys.has('ShiftLeft') || keys.has('ShiftRight')

    // 入力方向（ヨーのみ反映）
    let fx = 0
    let fz = 0
    if (keys.has('KeyW')) fz -= 1
    if (keys.has('KeyS')) fz += 1
    if (keys.has('KeyA')) fx -= 1
    if (keys.has('KeyD')) fx += 1
    const mag = Math.hypot(fx, fz)
    if (mag > 0) {
      fx /= mag
      fz /= mag
    }
    const sin = Math.sin(controls.yaw)
    const cos = Math.cos(controls.yaw)
    const wishX = fx * cos - fz * sin
    const wishZ = -fx * sin - fz * cos

    this.inWater = this.position.y + HEIGHT * 0.45 < SEA_LEVEL
    this.headUnderwater = this.position.y + EYE < SEA_LEVEL

    if (this.flying) {
      const speed = sprint ? FLY_SPRINT : FLY_SPEED
      const accel = 14
      this.velocity.x += (wishX * speed - this.velocity.x) * Math.min(1, accel * dt)
      this.velocity.z += (wishZ * speed - this.velocity.z) * Math.min(1, accel * dt)
      let vy = 0
      if (keys.has('Space')) vy += speed
      if (keys.has('ControlLeft') || keys.has('KeyQ')) vy -= speed
      this.velocity.y += (vy - this.velocity.y) * Math.min(1, accel * dt)
      this.onGround = false
    } else if (this.inWater) {
      const speed = SWIM_SPEED
      const accel = 7
      this.velocity.x += (wishX * speed - this.velocity.x) * Math.min(1, accel * dt)
      this.velocity.z += (wishZ * speed - this.velocity.z) * Math.min(1, accel * dt)
      this.velocity.y -= GRAVITY * 0.16 * dt
      if (keys.has('Space')) this.velocity.y += 22 * dt
      // 水の抵抗
      this.velocity.multiplyScalar(1 - Math.min(1, 2.2 * dt))
      this.velocity.y = Math.max(this.velocity.y, -4.5)
    } else {
      const speed = sprint ? SPRINT_SPEED : WALK_SPEED
      const accel = this.onGround ? 18 : 4.5
      this.velocity.x += (wishX * speed - this.velocity.x) * Math.min(1, accel * dt)
      this.velocity.z += (wishZ * speed - this.velocity.z) * Math.min(1, accel * dt)
      this.velocity.y -= GRAVITY * dt
      if (this.onGround && keys.has('Space')) {
        this.velocity.y = JUMP_SPEED
        this.onGround = false
      }
      if (this.velocity.y < -68) this.velocity.y = -68
    }

    this.position.addScaledVector(this.velocity, dt)
    if (this.position.y < WORLD_MIN_Y) {
      this.position.y = WORLD_MIN_Y
      this.velocity.y = 0
    }

    this.resolveCollisions(world)
  }

  /**
   * カプセル軸上の数点をサンプルし、固体に食い込んでいる分だけ勾配方向へ押し出す。
   * 密度は表面付近でほぼ線形なので `密度 / |勾配|` を符号付き距離の近似として使える。
   */
  private resolveCollisions(world: World): void {
    this.onGround = false
    const s = this.sample

    for (let iter = 0; iter < 4; iter++) {
      let moved = 0
      for (let a = 0; a < AXIS.length; a++) {
        const px = this.position.x
        const py = this.position.y + AXIS[a]
        const pz = this.position.z
        world.sample(px, py, pz, s)
        const g = Math.hypot(s.gx, s.gy, s.gz)
        if (g < 1e-5) continue

        const signed = s.d / g // 正なら固体内部
        const penetration = signed + RADIUS
        if (penetration <= 0) continue

        const nx = -s.gx / g
        const ny = -s.gy / g
        const nz = -s.gz / g
        const push = Math.min(penetration, 0.6)
        this.position.x += nx * push
        this.position.y += ny * push
        this.position.z += nz * push
        moved += push

        // 面にめり込む方向の速度成分を消す
        const vn = this.velocity.x * nx + this.velocity.y * ny + this.velocity.z * nz
        if (vn < 0) {
          this.velocity.x -= nx * vn
          this.velocity.y -= ny * vn
          this.velocity.z -= nz * vn
        }
        if (ny > 0.45) this.onGround = true
      }
      if (moved < 1e-4) break
    }
  }

  /** 指定の x,z 付近で海面より上の地表を探してプレイヤーを置く。 */
  spawnAt(world: World, x: number, z: number): void {
    let best: [number, number, number] | null = null
    // 螺旋状に探して、水没していない足場を見つける
    for (let ring = 0; ring < 24 && !best; ring++) {
      const step = ring === 0 ? 1 : 8
      for (let a = 0; a < step; a++) {
        const ang = (a / step) * Math.PI * 2
        const sx = x + Math.cos(ang) * ring * 24
        const sz = z + Math.sin(ang) * ring * 24
        const sy = surfaceY(world, sx, sz)
        if (sy === null) continue
        if (sy > SEA_LEVEL + 2.5) {
          best = [sx, sy, sz]
          break
        }
      }
    }
    const [px, py, pz] = best ?? [x, Math.max(surfaceY(world, x, z) ?? SEA_LEVEL, SEA_LEVEL), z]
    this.position.set(px, py + 1.2, pz)
    this.velocity.set(0, 0, 0)
  }
}

export const PLAYER_EYE = EYE

/** 上から降りてきて最初に固体になる高さ。見つからなければ null。 */
function surfaceY(world: World, x: number, z: number): number | null {
  let prev = world.densityAt(x, 190, z)
  for (let y = 190; y > WORLD_MIN_Y + 2; y -= 0.5) {
    const d = world.densityAt(x, y, z)
    if (d > 0 && prev <= 0) return y
    prev = d
  }
  return null
}
