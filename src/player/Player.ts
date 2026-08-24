import * as THREE from 'three'
import type { World, FieldSample } from '../world/World'
import { SEA_LEVEL, WALKABLE_NY, WORLD_MIN_Y } from '../world/constants'
import type { Controls } from './Controls'
import type { Box } from '../world/village'

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

const GROUND_ACCEL = 26
const AIR_ACCEL = 5
/** 入力が無いときの制動。これが無いと坂でずり落ちる。 */
const GROUND_FRICTION = 18
const STOP_SPEED = 0.35
/** 接地判定と地面への吸着に使う距離。 */
const GROUND_PROBE = 0.3
/** 急斜面に触れているあいだ、斜面を下る向きへ押される加速度。 */
const SLIDE_ACCEL = 15
/** 滑り落ちる速さの上限。自由落下ほどは速くならない。 */
const SLIDE_MAX_FALL = 13
/** よじ登れる段差の候補。これ以下の出っ張りは乗り越えられる。 */
const STEP_HEIGHTS = [0.22, 0.4, 0.58]

/** 箱の当たり判定で乗り上げられる段差の高さ（m）。階段の 1 段はこれより低い。 */
const BOX_STEP = 0.6

const MAX_STEP = 1 / 90
const MAX_SUBSTEPS = 6

/** カプセル軸上のサンプル点（足元から頭まで）の高さ。 */
const AXIS = [RADIUS, HEIGHT * 0.38, HEIGHT * 0.68, HEIGHT - RADIUS]

/**
 * 密度場に対するカプセル衝突を持つ一人称プレイヤー。
 *
 * 地形が滑らかなので、ブロック地形のような「段差を登る」特別処理は不要で、
 * 勾配方向へ押し出すだけで坂も洞窟の天井も自然に扱える。
 * ただし立てないほど急な面（`WALKABLE_NY` より上向きが弱い面）だけは
 * 押し出しを水平に倒し、代わりに低い段差の乗り上げを別途持つ。
 *
 * 接地判定は「押し出しが起きたか」ではなく足元への独立したプローブで行う。
 * こうすると接地中に重力を溜めずに済み、斜面で押し出しベクトルの水平成分に
 * よってじりじり滑り落ちる問題が起きない。
 */
export class Player {
  readonly position = new THREE.Vector3()
  readonly velocity = new THREE.Vector3()

  onGround = false
  groundNormalY = 1
  inWater = false
  flying = false
  headUnderwater = false
  /** 立てないほど急な面に触れていて、滑り落ちている最中か。 */
  sliding = false

  /** 木の幹（x, y, z, 半径, 高さ の 5 要素ずつ）。毎フレーム World から受け取る。 */
  trunks: Float32Array | null = null
  /** 建物の壁など、軸平行ボックスの衝突体。 */
  boxes: Box[] = []

  private accumulator = 0
  /** 滑っている向き（斜面を下る水平方向）。 */
  private slideX = 0
  private slideZ = 0
  private readonly sample: FieldSample = { d: 0, gx: 0, gy: 0, gz: 0 }
  /** 立っている箱の天面の高さ。地形に立っているときは -Infinity。 */
  private boxGroundY = -Infinity

  get eyeY(): number {
    return this.position.y + EYE
  }

  get radius(): number {
    return RADIUS
  }

  get height(): number {
    return HEIGHT
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

    // 入力方向。fz は「前が -1」（three のカメラは -Z を向く）
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

    // ヨー θ のとき前方 = (-sinθ, 0, -cosθ)、右 = (cosθ, 0, -sinθ)
    // wish = fx * 右 + (-fz) * 前方
    const sin = Math.sin(controls.yaw)
    const cos = Math.cos(controls.yaw)
    const wishX = fx * cos + fz * sin
    const wishZ = -fx * sin + fz * cos

    this.inWater = this.position.y + HEIGHT * 0.45 < SEA_LEVEL
    this.headUnderwater = this.position.y + EYE < SEA_LEVEL

    if (this.flying) {
      this.onGround = false
      const speed = sprint ? FLY_SPRINT : FLY_SPEED
      const a = Math.min(1, 14 * dt)
      this.velocity.x += (wishX * speed - this.velocity.x) * a
      this.velocity.z += (wishZ * speed - this.velocity.z) * a
      let vy = 0
      if (keys.has('Space')) vy += speed
      if (keys.has('ControlLeft') || keys.has('KeyQ')) vy -= speed
      this.velocity.y += (vy - this.velocity.y) * a
    } else if (this.inWater) {
      this.onGround = false
      const a = Math.min(1, 7 * dt)
      this.velocity.x += (wishX * SWIM_SPEED - this.velocity.x) * a
      this.velocity.z += (wishZ * SWIM_SPEED - this.velocity.z) * a
      this.velocity.y -= GRAVITY * 0.16 * dt
      if (keys.has('Space')) this.velocity.y += 22 * dt
      this.velocity.multiplyScalar(1 - Math.min(1, 2.2 * dt))
      this.velocity.y = Math.max(this.velocity.y, -4.5)
    } else {
      // 箱の天面は「地形に立てていないとき」だけ見る（地形が優先）
      this.boxGroundY = -Infinity
      const grounded = this.probeGround(world) || this.probeBoxGround()
      this.onGround = grounded

      const speed = sprint ? SPRINT_SPEED : WALK_SPEED
      const a = Math.min(1, (grounded ? GROUND_ACCEL : AIR_ACCEL) * dt)
      this.velocity.x += (wishX * speed - this.velocity.x) * a
      this.velocity.z += (wishZ * speed - this.velocity.z) * a

      // 立てない斜面に触れている間は、登れないだけでなく下へ流される
      if (this.sliding && !grounded) {
        const sl = Math.hypot(this.slideX, this.slideZ)
        if (sl > 1e-4) {
          this.velocity.x += (this.slideX / sl) * SLIDE_ACCEL * dt
          this.velocity.z += (this.slideZ / sl) * SLIDE_ACCEL * dt
        }
      }

      if (grounded) {
        // 接地中は重力を溜めない。溜めると押し出しの水平成分で斜面を滑る。
        if (this.velocity.y < 0) this.velocity.y = 0
        if (mag === 0) {
          const damp = Math.exp(-GROUND_FRICTION * dt)
          this.velocity.x *= damp
          this.velocity.z *= damp
          if (Math.hypot(this.velocity.x, this.velocity.z) < STOP_SPEED) {
            this.velocity.x = 0
            this.velocity.z = 0
          }
        }
        if (keys.has('Space')) {
          this.velocity.y = JUMP_SPEED
          this.onGround = false
        }
      } else {
        this.velocity.y -= GRAVITY * dt
        if (this.velocity.y < -68) this.velocity.y = -68
        // 斜面ずりは自由落下ではなく「滑り」なので速さを抑える
        if (this.sliding && this.velocity.y < -SLIDE_MAX_FALL) this.velocity.y = -SLIDE_MAX_FALL
      }

      // 急斜面と判定された壁でも、腰より低い出っ張りなら乗り越えられる
      if (this.sliding && mag > 0) this.tryStepUp(world, wishX, wishZ)
    }

    this.position.addScaledVector(this.velocity, dt)
    if (this.position.y < WORLD_MIN_Y) {
      this.position.y = WORLD_MIN_Y
      this.velocity.y = 0
    }

    this.resolveTerrain(world)
    this.resolveTrunks()
    this.resolveBoxes()

    // 下り坂で浮かないように地面へ吸着させる（純粋な鉛直補正なので滑らない）
    if (this.onGround && this.velocity.y <= 0 && !this.flying && !this.inWater) {
      this.snapToGround(world)
    }
  }

  /**
   * 足元にプローブを下ろして接地を判定する。
   * 押し出しの有無とは独立なので、接地状態が押し出しの副作用でちらつかない。
   */
  private probeGround(world: World): boolean {
    const s = this.sample
    world.sample(this.position.x, this.position.y + RADIUS - GROUND_PROBE, this.position.z, s)
    const g = Math.hypot(s.gx, s.gy, s.gz)
    if (g < 1e-5) return false
    if (s.d / g + RADIUS < 0) return false
    this.groundNormalY = -s.gy / g
    return this.groundNormalY > WALKABLE_NY
  }

  /**
   * 建てた床・階段・屋根（軸平行ボックス）の上に立っているか。
   *
   * `probeGround` は密度場しか見ないので、これが無いと自分で張った床の上が
   * 「空中」扱いになり、ジャンプできず摩擦も効かない。押し出し自体は
   * {@link resolveBoxes} が既にやっているので、ここでは接地の判定だけを足す。
   */
  private probeBoxGround(): boolean {
    if (this.boxes.length === 0) return false
    const feet = this.position.y
    for (const b of this.boxes) {
      if (feet < b.maxY - 0.06 || feet > b.maxY + GROUND_PROBE) continue
      if (this.position.x <= b.minX - RADIUS || this.position.x >= b.maxX + RADIUS) continue
      if (this.position.z <= b.minZ - RADIUS || this.position.z >= b.maxZ + RADIUS) continue
      if (b.maxY > this.boxGroundY) this.boxGroundY = b.maxY
    }
    if (this.boxGroundY === -Infinity) return false
    this.groundNormalY = 1
    return true
  }

  /** 接地しているのに浮いている分だけ真下に降ろす。 */
  private snapToGround(world: World): void {
    // 建てた床・階段の上では、その天面へ降ろす。これが無いと最大 GROUND_PROBE ぶん浮く
    if (this.boxGroundY > -Infinity) {
      const gap = this.position.y - this.boxGroundY
      if (gap > 0 && gap < GROUND_PROBE) this.position.y = this.boxGroundY
      return
    }
    const s = this.sample
    world.sample(this.position.x, this.position.y + RADIUS, this.position.z, s)
    const g = Math.hypot(s.gx, s.gy, s.gz)
    if (g < 1e-5) return
    const gap = -(s.d / g) - RADIUS
    if (gap > 0 && gap < GROUND_PROBE) this.position.y -= gap
  }

  /**
   * カプセル軸上の数点をサンプルし、固体に食い込んでいる分だけ勾配方向へ押し出す。
   * 密度は表面付近でほぼ線形なので `密度 / |勾配|` を符号付き距離の近似として使える。
   */
  private resolveTerrain(world: World): void {
    const s = this.sample
    this.sliding = false
    this.slideX = 0
    this.slideZ = 0

    for (let iter = 0; iter < 4; iter++) {
      let moved = 0
      for (let a = 0; a < AXIS.length; a++) {
        world.sample(this.position.x, this.position.y + AXIS[a], this.position.z, s)
        const g = Math.hypot(s.gx, s.gy, s.gz)
        if (g < 1e-5) continue

        let penetration = s.d / g + RADIUS
        if (penetration <= 0) continue

        let nx = -s.gx / g
        let ny = -s.gy / g
        let nz = -s.gz / g

        // 立てないほど急な上向き面は、押し出しに鉛直成分を持たせない。
        // 法線どおりに押すと壁へ歩くだけで体が持ち上がり、
        // どんな崖でもじりじりよじ登れてしまう。
        const nh = Math.hypot(nx, nz)
        if (ny > 0 && ny <= WALKABLE_NY && nh > 1e-3 && s.d <= 0) {
          this.sliding = true
          this.slideX += nx / nh
          this.slideZ += nz / nh
          // 平面なら水平移動だけで抜けきる量に直す
          penetration /= nh
          nx /= nh
          nz /= nh
          ny = 0
        }

        const push = Math.min(penetration, 0.6)
        this.position.x += nx * push
        this.position.y += ny * push
        this.position.z += nz * push
        moved += push

        const vn = this.velocity.x * nx + this.velocity.y * ny + this.velocity.z * nz
        if (vn < 0) {
          this.velocity.x -= nx * vn
          this.velocity.y -= ny * vn
          this.velocity.z -= nz * vn
        }
        if (ny > WALKABLE_NY) this.onGround = true
      }
      if (moved < 1e-4) break
    }
  }

  /**
   * 進行方向の低い出っ張りに乗り上げる。
   *
   * 急斜面を登れなくすると、岩の縁のような膝下の段差まで越えられなくなる。
   * そこで「少し前・少し上にカプセルがまるごと入るか」を低い方から順に試し、
   * 入る高さが見つかったらそこへ移す。60°より急な斜面では 0.44 m 先が
   * 0.76 m 以上せり上がるのでどの候補にも入らず、崖をよじ登る抜け道にはならない。
   */
  private tryStepUp(world: World, wishX: number, wishZ: number): void {
    const near = RADIUS + 0.06
    const far = RADIUS + 0.3
    const nx = this.position.x + wishX * near
    const nz = this.position.z + wishZ * near
    const fx = this.position.x + wishX * far
    const fz = this.position.z + wishZ * far
    for (const lift of STEP_HEIGHTS) {
      const feet = this.position.y + lift
      // 手前だけ見ると段の縁に爪先立ちしてしまうので、少し先も空いていることを確かめる
      if (!this.capsuleFree(world, nx, feet, nz)) continue
      if (!this.capsuleFree(world, fx, feet, fz)) continue
      this.position.set(nx, feet, nz)
      if (this.velocity.y < 0) this.velocity.y = 0
      this.sliding = false
      return
    }
  }

  /** 足元 feet に立ったカプセルが地形に触れずに収まるか。 */
  private capsuleFree(world: World, x: number, feet: number, z: number): boolean {
    const s = this.sample
    for (let a = 0; a < AXIS.length; a++) {
      world.sample(x, feet + AXIS[a], z, s)
      const g = Math.hypot(s.gx, s.gy, s.gz)
      if (g < 1e-5) continue
      if (s.d / g + RADIUS > 0) return false
    }
    return true
  }

  /** 木の幹（垂直な円柱）から水平に押し出す。 */
  private resolveTrunks(): void {
    const t = this.trunks
    if (!t) return
    const feet = this.position.y
    const head = this.position.y + HEIGHT
    for (let i = 0; i < t.length; i += 5) {
      const ty = t[i + 1]
      if (head < ty || feet > ty + t[i + 4]) continue
      const dx = this.position.x - t[i]
      const dz = this.position.z - t[i + 2]
      const r = t[i + 3] + RADIUS
      const d2 = dx * dx + dz * dz
      if (d2 >= r * r || d2 < 1e-8) continue
      const d = Math.sqrt(d2)
      const push = r - d
      const nx = dx / d
      const nz = dz / d
      this.position.x += nx * push
      this.position.z += nz * push
      const vn = this.velocity.x * nx + this.velocity.z * nz
      if (vn < 0) {
        this.velocity.x -= nx * vn
        this.velocity.z -= nz * vn
      }
    }
  }

  /**
   * 建物の壁や建てたパーツ（軸平行ボックス）から最小移動量で押し出す。
   *
   * 膝下の段差は上が空いていれば乗り上げる。建てた階段の 1 段（0.5 m）がこれに当たるので、
   * 置いた階段はそのまま歩いて登れる。
   * 壁のように背の高い箱は乗り上げの対象にならず、水平に押し戻される。
   */
  private resolveBoxes(): void {
    if (this.boxes.length === 0) return
    for (const b of this.boxes) {
      // カプセルを AABB に、ボックスを半径分だけ膨らませて判定する。
      // 押し出すたびに位置が動くので、箱ごとに読み直す
      const px = this.position.x
      const pz = this.position.z
      const minX = b.minX - RADIUS
      const maxX = b.maxX + RADIUS
      const minZ = b.minZ - RADIUS
      const maxZ = b.maxZ + RADIUS
      if (px <= minX || px >= maxX || pz <= minZ || pz >= maxZ) continue
      const feet = this.position.y
      const head = this.position.y + HEIGHT
      if (head <= b.minY || feet >= b.maxY) continue

      // 段差に乗る（屋根や台の上、階段の 1 段）
      const oy = b.maxY - feet
      if (oy > 0 && oy <= BOX_STEP && this.velocity.y <= 0 && this.boxFreeAbove(px, b.maxY, pz)) {
        this.position.y = b.maxY
        if (this.velocity.y < 0) this.velocity.y = 0
        this.onGround = true
        this.groundNormalY = 1
        continue
      }

      const ox1 = px - minX
      const ox2 = maxX - px
      const oz1 = pz - minZ
      const oz2 = maxZ - pz
      const best = Math.min(ox1, ox2, oz1, oz2)
      if (best === ox1) {
        this.position.x = minX
        if (this.velocity.x > 0) this.velocity.x = 0
      } else if (best === ox2) {
        this.position.x = maxX
        if (this.velocity.x < 0) this.velocity.x = 0
      } else if (best === oz1) {
        this.position.z = minZ
        if (this.velocity.z > 0) this.velocity.z = 0
      } else {
        this.position.z = maxZ
        if (this.velocity.z < 0) this.velocity.z = 0
      }
    }
  }

  /** 足元 `feet` に立ったとき、他の箱に頭や体がぶつからないか。 */
  private boxFreeAbove(x: number, feet: number, z: number): boolean {
    for (const b of this.boxes) {
      if (b.maxY <= feet + 1e-3) continue
      if (x <= b.minX - RADIUS || x >= b.maxX + RADIUS) continue
      if (z <= b.minZ - RADIUS || z >= b.maxZ + RADIUS) continue
      if (feet + HEIGHT > b.minY && feet < b.maxY) return false
    }
    return true
  }

  /** 指定の x,z 付近で海面より上の地表を探してプレイヤーを置く。 */
  spawnAt(world: World, x: number, z: number): void {
    let best: [number, number, number] | null = null
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
  let prev = world.densityAt(x, 210, z)
  for (let y = 210; y > WORLD_MIN_Y + 2; y -= 0.5) {
    const d = world.densityAt(x, y, z)
    if (d > 0 && prev <= 0) return y
    prev = d
  }
  return null
}
