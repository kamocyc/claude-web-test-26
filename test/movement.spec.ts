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
