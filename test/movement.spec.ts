import { expect, test } from '@playwright/test'
import type { SmoothState } from './smooth-global'

type Page = import('@playwright/test').Page

async function start(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(() => window.__smooth?.ready === true, null, { timeout: 75_000 })
  await page.click('#play')
  await page.waitForTimeout(1200)
  expect(await page.evaluate(() => !!document.pointerLockElement)).toBe(true)
}

const state = (page: Page): Promise<SmoothState> => page.evaluate(() => window.__smooth!.state())

/**
 * キーを押して移動量を返す。
 * ヘッドレスは SwiftShader で数 fps しか出ず、物理は 1 フレームあたりの
 * サブステップ数で頭打ちになるため、実時間より進みが遅い。
 * そのため距離ではなく「向き」を検証する。
 */
async function walk(page: Page, key: string, ms: number): Promise<{ dx: number; dz: number }> {
  const before = await state(page)
  await page.keyboard.down(key)
  await page.waitForTimeout(ms)
  await page.keyboard.up(key)
  const after = await state(page)
  return { dx: after.x - before.x, dz: after.z - before.z }
}

test.describe('移動', () => {
  test('WASD がカメラの向きどおりに動く', async ({ page }) => {
    await start(page)
    // 村の広場は平坦なので移動のテストに向く
    expect(await page.evaluate(() => window.__smooth!.gotoVillage())).toBe(true)
    // ヨー 0 = -Z 方向を向く
    await page.evaluate(() => window.__smooth!.look(0, 0))
    await page.waitForTimeout(2000)

    const w = await walk(page, 'KeyW', 2200)
    expect(w.dz, `W は前（-Z）へ進むはず: ${JSON.stringify(w)}`).toBeLessThan(-0.4)
    expect(Math.abs(w.dx), 'W で横に流れている').toBeLessThan(Math.abs(w.dz) * 0.5)

    const s = await walk(page, 'KeyS', 2200)
    expect(s.dz, `S は後ろ（+Z）へ下がるはず: ${JSON.stringify(s)}`).toBeGreaterThan(0.4)

    const d = await walk(page, 'KeyD', 2200)
    expect(d.dx, `D は右（+X）へ進むはず: ${JSON.stringify(d)}`).toBeGreaterThan(0.4)
    expect(Math.abs(d.dz), 'D で前後に流れている').toBeLessThan(Math.abs(d.dx) * 0.5)

    const a = await walk(page, 'KeyA', 2200)
    expect(a.dx, `A は左（-X）へ進むはず: ${JSON.stringify(a)}`).toBeLessThan(-0.4)
  })

  test('入力を離すと止まり、斜面でも滑り落ちない', async ({ page }) => {
    await start(page)

    // いくつか着地させてみて、いちばん急な（=滑りやすい）足場を選ぶ
    const spot = await page.evaluate(async () => {
      const api = window.__smooth!
      let best: { x: number; z: number; n: number } | null = null
      for (let i = 1; i <= 10; i++) {
        const x = Math.cos(i * 2.2) * i * 34 + 20
        const z = Math.sin(i * 2.2) * i * 34 - 60
        api.teleport(x, z)
        // 低 fps でも確実に着地するまで待つ
        for (let t = 0; t < 40 && !api.state().onGround; t++) {
          await new Promise((r) => setTimeout(r, 60))
        }
        const s = api.state()
        if (s.inWater || !s.onGround) continue
        if (!best || s.groundNormalY < best.n) best = { x, z, n: s.groundNormalY }
      }
      return best
    })
    expect(spot, '着地できる足場が見つからなかった').not.toBeNull()

    await page.evaluate((s) => window.__smooth!.teleport(s!.x, s!.z), spot)
    await page.waitForFunction(() => window.__smooth!.state().onGround, null, { timeout: 30_000 })
    await page.waitForTimeout(1200)

    const before = await state(page)
    expect(before.onGround, '着地していない').toBe(true)
    await page.waitForTimeout(3500)
    const after = await state(page)

    const drift = Math.hypot(after.x - before.x, after.z - before.z)
    expect(
      drift,
      `斜面(法線y=${before.groundNormalY.toFixed(3)})で ${drift.toFixed(3)}m 滑った`,
    ).toBeLessThan(0.2)
  })

  test('村が生成され、壁の当たり判定を持つ', async ({ page }) => {
    await start(page)
    expect(await page.evaluate(() => window.__smooth!.gotoVillage())).toBe(true)
    await page.waitForTimeout(2500)

    const s = await page.evaluate(() => window.__smooth!)
    expect(s.villages, '村が読み込まれていない').toBeGreaterThan(0)
    expect(s.villageBoxes, '村に壁の当たり判定が無い').toBeGreaterThan(20)

    // 木も生えていること
    expect(s.trees, '木が 1 本も生えていない').toBeGreaterThan(0)

    // 広場を歩き回っても壁にめり込んで固まらないこと
    const before = await state(page)
    await page.evaluate(() => window.__smooth!.look(0, 0))
    await page.keyboard.down('KeyW')
    await page.waitForTimeout(4000)
    await page.keyboard.up('KeyW')
    const after = await state(page)
    expect(Number.isFinite(after.x) && Number.isFinite(after.z)).toBe(true)
    expect(Math.hypot(after.x - before.x, after.z - before.z), '全く動けていない').toBeGreaterThan(0.4)
  })
})

test.describe('地形と木の当たり判定', () => {
  test('急な坂は登れず、滑り落ちる', async ({ page }) => {
    await start(page)
    // 傾斜 55°以上の斜面を探して、いちばん上りのきつい向きを向く
    const spot = await page.evaluate(async () => {
      const api = window.__smooth!
      const surface = (x: number, z: number, from: number): number | null => {
        let prev = api.density(x, from, z)
        for (let y = from; y > from - 40; y -= 0.25) {
          const d = api.density(x, y, z)
          if (d > 0 && prev <= 0) return y
          prev = d
        }
        return null
      }
      for (let i = 1; i <= 14; i++) {
        const x = Math.cos(i * 2.4) * i * 41 + 5
        const z = Math.sin(i * 2.4) * i * 41 + 5
        api.teleport(x, z)
        for (let t = 0; t < 40 && !api.state().onGround; t++) {
          await new Promise((r) => setTimeout(r, 60))
        }
        const s = api.state()
        if (s.inWater) continue
        const h0 = surface(s.x, s.z, s.y + 6)
        if (h0 === null) continue
        let bestAng = 0
        let bestH = -Infinity
        for (let a = 0; a < 16; a++) {
          const ang = (a / 16) * Math.PI * 2
          const h = surface(s.x + Math.cos(ang) * 2.5, s.z + Math.sin(ang) * 2.5, s.y + 22)
          if (h !== null && h > bestH) {
            bestH = h
            bestAng = ang
          }
        }
        const slope = (Math.atan2(bestH - h0, 2.5) * 180) / Math.PI
        if (slope < 55) continue
        api.look(Math.atan2(-Math.cos(bestAng), -Math.sin(bestAng)), 0)
        return { y: s.y, slope }
      }
      return null
    })
    expect(spot, '55°以上の斜面が見つからなかった').not.toBeNull()

    await page.keyboard.down('KeyW')
    await page.waitForTimeout(7000)
    await page.keyboard.up('KeyW')
    const after = await state(page)
    const dy = after.y - spot!.y
    expect(dy, `${spot!.slope.toFixed(0)}°の坂を ${dy.toFixed(2)}m よじ登った`).toBeLessThan(0.6)
  })

  test('木の当たり判定が幹と枝葉に分かれている', async ({ page }) => {
    await start(page)
    const cyl = await page.evaluate(async () => {
      const api = window.__smooth!
      const origin = api.state()
      for (let i = 0; i < 20; i++) {
        const c = api.treeColliders()
        if (c.length >= 10) return c
        api.teleport(origin.x + Math.cos(i * 1.3) * i * 30, origin.z + Math.sin(i * 1.3) * i * 30)
        await new Promise((r) => setTimeout(r, 400))
      }
      return api.treeColliders()
    })
    expect(cyl.length, '木の当たり判定が集まっていない').toBeGreaterThanOrEqual(10)
    expect(cyl.length % 5, '5 要素で 1 本になっていない').toBe(0)

    // 同じ軸に幹と枝葉の 2 本が並び、木のてっぺん近くまで判定が届いていること
    const axes = new Map<string, { base: number; top: number; n: number }>()
    for (let i = 0; i < cyl.length; i += 5) {
      const key = `${cyl[i].toFixed(2)},${cyl[i + 2].toFixed(2)}`
      const a = axes.get(key) ?? { base: Infinity, top: -Infinity, n: 0 }
      a.base = Math.min(a.base, cyl[i + 1])
      a.top = Math.max(a.top, cyl[i + 1] + cyl[i + 4])
      a.n++
      axes.set(key, a)
    }
    const pairs = [...axes.values()].filter((a) => a.n >= 2)
    expect(pairs.length, '幹だけで枝葉の判定が無い').toBeGreaterThan(0)
    const tallest = Math.max(...pairs.map((a) => a.top - a.base))
    expect(tallest, `判定が ${tallest.toFixed(1)}m しか無く、梢まで届いていない`).toBeGreaterThan(4)
  })

  test('木に正面から歩いても通り抜けない', async ({ page }) => {
    await start(page)
    const tree = await page.evaluate(async () => {
      const api = window.__smooth!
      const origin = api.state()
      for (let i = 1; i < 24; i++) {
        api.teleport(origin.x + Math.cos(i * 1.7) * i * 33, origin.z + Math.sin(i * 1.7) * i * 33)
        for (let t = 0; t < 30 && !api.state().onGround; t++) {
          await new Promise((r) => setTimeout(r, 60))
        }
        const t0 = api.nearestTree()
        const s = api.state()
        if (!t0 || s.inWater) continue
        const d = Math.hypot(t0.x - s.x, t0.z - s.z)
        if (d < 1.5 || d > 8 || Math.abs(t0.y - s.y) > 3) continue
        api.look(Math.atan2(-(t0.x - s.x), -(t0.z - s.z)), 0)
        return t0
      }
      return null
    })
    expect(tree, '手ごろな木が見つからなかった').not.toBeNull()

    await page.keyboard.down('KeyW')
    await page.waitForTimeout(8000)
    await page.keyboard.up('KeyW')
    const s = await state(page)
    const d = Math.hypot(tree!.x - s.x, tree!.z - s.z)
    expect(d, `幹をすり抜けた (中心から ${d.toFixed(2)}m)`).toBeGreaterThan(tree!.r + 0.3)
  })
})
