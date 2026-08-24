import { describe, expect, it } from 'vitest'
import { createTreePrototypes } from '../src/render/treeMeshes'
import { Player } from '../src/player/Player'
import type { World } from '../src/world/World'
import type { Controls } from '../src/player/Controls'

/** 地表が一定の高さにある疑似ワールド。 */
function ground(h: number): World {
  return {
    sample(_x: number, y: number, _z: number, out: { d: number; gx: number; gy: number; gz: number }) {
      out.d = h - y
      out.gx = 0
      out.gy = -1
      out.gz = 0
      return out
    },
    densityAt: (_x: number, y: number) => h - y,
  } as unknown as World
}

function controls(keys: string[]): Controls {
  return { keys: new Set(keys), yaw: -Math.PI / 2, pitch: 0 } as unknown as Controls
}

describe('木の当たり判定', () => {
  const protos = createTreePrototypes()

  it('幹と枝葉で木の高さを隙間なく覆う', () => {
    for (const p of protos) {
      expect(p.crownRadius, '枝葉の当たり判定が無い').toBeGreaterThan(0)
      // 幹の上端と枝葉の下端が離れていると、そこだけ通り抜けられる
      expect(p.crownBase, `幹(〜${p.trunkHeight}m)と枝葉(${p.crownBase}m〜)の間に隙間がある`).toBeLessThanOrEqual(
        p.trunkHeight,
      )
      // 見えている木のてっぺん近くまで判定が届いていること
      expect(Math.max(p.trunkHeight, p.crownTop), '木のてっぺん付近に判定が無い').toBeGreaterThan(
        p.hitHeight * 0.9,
      )
      expect(p.crownRadius).toBeLessThan(p.hitRadius)
    }
  })

  it('幹より上を通り抜けられない', () => {
    const proto = protos[0]
    // collectTrunks が出すのと同じ「縦円柱」2 本（幹と枝葉）
    const trunks = new Float32Array([
      0, 0, 0, proto.trunkRadius, proto.trunkHeight,
      0, proto.crownBase, 0, proto.crownRadius, proto.crownTop - proto.crownBase,
    ])
    // 幹の上端より高い足場に立って、木へ向かって歩く
    const feet = proto.trunkHeight + 0.5
    const p = new Player()
    p.position.set(-4, feet, 0)
    p.trunks = trunks
    const world = ground(feet)
    for (let i = 0; i < 300; i++) p.update(1 / 60, world, controls(['KeyW']))
    // 見えている葉のかたまりは半径 1.5m ほど。手前で止まっていること
    // （通り抜けると x が正になるので、符号ごと見る）
    expect(p.position.x, `枝葉をすり抜けた (x=${p.position.x.toFixed(2)})`).toBeLessThan(-1.5)
  })

  it('根元では幹に止められる', () => {
    const proto = protos[0]
    const trunks = new Float32Array([
      0, 0, 0, proto.trunkRadius, proto.trunkHeight,
      0, proto.crownBase, 0, proto.crownRadius, proto.crownTop - proto.crownBase,
    ])
    const p = new Player()
    p.position.set(-4, 0, 0)
    p.trunks = trunks
    const world = ground(0)
    for (let i = 0; i < 300; i++) p.update(1 / 60, world, controls(['KeyW']))
    expect(p.position.x, `幹をすり抜けた (x=${p.position.x.toFixed(2)})`).toBeLessThan(
      -(proto.trunkRadius + 0.3),
    )
    // 枝葉は頭の上なので、根元では木の際まで寄れる
    expect(p.position.x, '根元なのに枝葉に阻まれている').toBeGreaterThan(-proto.crownRadius)
  })
})
