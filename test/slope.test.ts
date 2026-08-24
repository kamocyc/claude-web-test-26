import { describe, expect, it } from 'vitest'
import { Player } from '../src/player/Player'
import type { World } from '../src/world/World'
import type { Controls } from '../src/player/Controls'

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
