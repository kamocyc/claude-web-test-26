import { describe, expect, it } from 'vitest'
import { Player } from '../src/player/Player'
import type { World } from '../src/world/World'
import type { Controls } from '../src/player/Controls'
import { BuildGrid } from '../src/build/BuildGrid'
import { BUILD_CELL, PANEL_T, normalizeYaw } from '../src/build/pieces'
import type { PieceKind } from '../src/build/pieces'
import { MAT_PLANK } from '../src/world/constants'
import type { Collider } from '../src/world/collision'

interface Sample {
  d: number
  gx: number
  gy: number
  gz: number
}

/**
 * 高さ関数 h(x) の地形（y < h(x) が固体）を持つ疑似ワールド。
 * 密度 = h(x) - y なので勾配は (h'(x), -1, 0)。World.sample と同じ形。
 */
function heightWorld(h: (x: number) => number, dh: (x: number) => number): World {
  return {
    sample(x: number, y: number, _z: number, out: Sample) {
      out.d = h(x) - y
      out.gx = dh(x)
      out.gy = -1
      out.gz = 0
      return out
    },
    densityAt: (x: number, y: number) => h(x) - y,
  } as unknown as World
}

/** 傾き angle 度の一様な斜面（+x が上り）。 */
function ramp(angleDeg: number): World {
  const t = Math.tan((angleDeg * Math.PI) / 180)
  return heightWorld((x) => x * t, () => t)
}

/** ヨー -π/2 で「前」が +x になる。 */
function controls(keys: string[]): Controls {
  return { keys: new Set(keys), yaw: -Math.PI / 2, pitch: 0 } as unknown as Controls
}

function run(player: Player, world: World, c: Controls, seconds: number): void {
  for (let i = 0; i < Math.round(seconds * 60); i++) player.update(1 / 60, world, c)
}

describe('斜面', () => {
  it('歩ける坂（35°）は登れる', () => {
    const p = new Player()
    p.position.set(0, 0.05, 0)
    const world = ramp(35)
    run(p, world, controls(['KeyW']), 4)
    expect(p.position.x, `登れていない (x=${p.position.x.toFixed(2)})`).toBeGreaterThan(4)
    expect(p.position.y, '高さが上がっていない').toBeGreaterThan(2)
  })

  it('急な坂（60°）は登れない', () => {
    const p = new Player()
    p.position.set(0, 0.05, 0)
    const world = ramp(60)
    const y0 = p.position.y
    run(p, world, controls(['KeyW']), 6)
    expect(p.position.y - y0, `よじ登ってしまった (+${(p.position.y - y0).toFixed(2)}m)`).toBeLessThan(0.4)
    expect(p.onGround, '急斜面で立ててしまっている').toBe(false)
  })

  it('限界のすぐ上（55°）でもよじ登れない', () => {
    const p = new Player()
    p.position.set(0, 0.05, 0)
    const world = ramp(55)
    const y0 = p.position.y
    run(p, world, controls(['KeyW']), 6)
    expect(p.position.y - y0, `じりじり登ってしまった (+${(p.position.y - y0).toFixed(2)}m)`).toBeLessThan(0.4)
  })

  it('平地から急斜面へ突っ込んでも押し上げられない', () => {
    // 法線どおりに押し出すと、壁へ歩くだけで体が持ち上がって斜面に乗ってしまう
    for (const deg of [55, 65, 75]) {
      const t = Math.tan((deg * Math.PI) / 180)
      const world = heightWorld(
        (x) => (x > 0 ? x * t : 0),
        (x) => (x > 0 ? t : 0),
      )
      const p = new Player()
      p.position.set(-3, 0.05, 0)
      let maxY = 0
      for (let i = 0; i < 600; i++) {
        p.update(1 / 60, world, controls(['KeyW']))
        maxY = Math.max(maxY, p.position.y)
      }
      expect(maxY, `${deg}°の斜面で ${maxY.toFixed(2)}m 持ち上がった`).toBeLessThan(0.25)
    }
  })

  it('急な坂の上に置くと滑り落ちる', () => {
    const p = new Player()
    // 斜面上の点（x=6 の地表）に置く
    const world = ramp(60)
    const t = Math.tan((60 * Math.PI) / 180)
    p.position.set(6, 6 * t + 0.1, 0)
    run(p, world, controls([]), 3)
    expect(p.position.x, `下（-x）へ滑っていない (x=${p.position.x.toFixed(2)})`).toBeLessThan(4)
    expect(p.sliding || p.position.y < 6 * t, '滑り落ちていない').toBe(true)
  })

  it('歩ける坂の上では滑らない', () => {
    const p = new Player()
    const world = ramp(35)
    const t = Math.tan((35 * Math.PI) / 180)
    p.position.set(6, 6 * t + 0.1, 0)
    run(p, world, controls([]), 3)
    expect(Math.abs(p.position.x - 6), '緩い坂でずり落ちている').toBeLessThan(0.3)
    expect(p.onGround).toBe(true)
  })

  it('膝下の段差は乗り越えられる', () => {
    // x=0 付近で 0.4m 立ち上がる段差（面の傾きは 69°で「登れない」判定になる）
    const rise = 0.4
    const w = 0.15
    const world = heightWorld(
      (x) => rise * Math.min(1, Math.max(0, x / w)),
      (x) => (x > 0 && x < w ? rise / w : 0),
    )
    const p = new Player()
    p.position.set(-2, 0.05, 0)
    run(p, world, controls(['KeyW']), 4)
    expect(p.position.x, `段差を越えられていない (x=${p.position.x.toFixed(2)})`).toBeGreaterThan(1)
    expect(p.position.y, '段の上に乗れていない').toBeGreaterThan(0.25)
  })

  it('背丈ほどの壁は登れない', () => {
    const rise = 2.2
    const w = 0.15
    const world = heightWorld(
      (x) => rise * Math.min(1, Math.max(0, x / w)),
      (x) => (x > 0 && x < w ? rise / w : 0),
    )
    const p = new Player()
    p.position.set(-2, 0.05, 0)
    run(p, world, controls(['KeyW']), 6)
    expect(p.position.x, `壁を越えてしまった (x=${p.position.x.toFixed(2)})`).toBeLessThan(0.1)
    expect(p.position.y, '壁をよじ登ってしまった').toBeLessThan(0.4)
  })
})

/** y < 0 が地面の、まったいらな疑似ワールド。 */
const flatGround = heightWorld(
  () => 0,
  () => 0,
)

/** ヨー `yaw` の向きへ全速で前進する入力。 */
function sprintAt(yaw: number): Controls {
  return { keys: new Set(['KeyW', 'ShiftLeft']), yaw, pitch: 0 } as unknown as Controls
}

/**
 * 自分で建てた部屋（床板と壁 4 面）を組む。
 * 床板の上面は地面より板厚だけ高い — 平地に部屋を建てると必ずこうなる。
 */
function builtRoom(cells: number): BuildGrid {
  const g = new BuildGrid()
  const C = BUILD_CELL
  const half = (cells * C) / 2
  const put = (kind: PieceKind, x: number, y: number, z: number, deg: number) =>
    g.place({ kind, x, y, z, yaw: normalizeYaw(deg / 5), mat: MAT_PLANK })
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      put('floor', -half + (i + 0.5) * C, 0, -half + (j + 0.5) * C, 0)
    }
  }
  for (let k = 0; k < cells; k++) {
    const c = -half + (k + 0.5) * C
    put('wall', half, C / 2, c, 0)
    put('wall', -half, C / 2, c, 0)
    put('wall', c, C / 2, half, 90)
    put('wall', c, C / 2, -half, 90)
  }
  return g
}

describe('部屋の中の当たり判定', () => {
  it('建てた部屋の中から壁をすり抜けない', () => {
    // 押し出しを「いちばん近い向き」だけで決めていた頃は、板の厚みの半分より
    // 深く入った瞬間に外向きのほうが近くなり、部屋の中から壁の外へ弾き出されていた。
    // 床板が水平に押してくるとそこまで一気に入り込むので、実際に頻繁に起きていた
    for (const cells of [2, 3]) {
      const g = builtRoom(cells)
      const half = (cells * BUILD_CELL) / 2
      const cols: Collider[] = []
      for (let a = 0; a < 16; a++) {
        const p = new Player()
        // 中心はマスの角なので、少しずらした所から全方位へ突進する
        p.position.set(0.7, 0.5, 0.7)
        for (let i = 0; i < 600; i++) {
          cols.length = 0
          g.collectColliders(p.position.x, p.position.z, 1.4, cols)
          p.boxes = cols
          p.update(1 / 60, flatGround, sprintAt((a / 16) * Math.PI * 2))
        }
        const esc = Math.max(Math.abs(p.position.x), Math.abs(p.position.z))
        expect(
          esc,
          `${cells}×${cells} の部屋から (${p.position.x.toFixed(2)}, ${p.position.z.toFixed(2)}) へ抜けた`,
        ).toBeLessThan(half)
      }
    }
  })

  it('床板 1 枚ぶんの段差は壁際でも足を取られない', () => {
    // 地面に張った床板は上面が板厚だけ高い。この小さな段差で足元がばたついたり、
    // 壁が近いせいで乗れずに水平へ押されたりしないこと
    const g = builtRoom(2)
    const cols: Collider[] = []
    const p = new Player()
    p.position.set(0.7, 0.5, 0.7)
    const heights: number[] = []
    for (let i = 0; i < 240; i++) {
      cols.length = 0
      g.collectColliders(p.position.x, p.position.z, 1.4, cols)
      p.boxes = cols
      p.update(1 / 60, flatGround, sprintAt(Math.PI))
      if (i > 60) heights.push(p.position.y)
    }
    expect(p.onGround, '床の上で接地していない').toBe(true)
    expect(p.position.y, '床の上に立てていない').toBeCloseTo(PANEL_T, 2)
    // 毎フレーム地面と床板を行き来していないこと
    const lo = Math.min(...heights)
    const hi = Math.max(...heights)
    expect(hi - lo, `足元が ${(hi - lo).toFixed(2)} m ばたついている`).toBeLessThan(0.05)
  })
})
