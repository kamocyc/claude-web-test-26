import { expect, test } from '@playwright/test'

declare global {
  interface Window {
    __smooth?: { frames: number; ready: boolean; edits: number; loaded: number; desired: number }
  }
}

test('起動して地形を描画し、掘削できる', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  page.on('pageerror', (err) => errors.push(String(err)))

  await page.goto('/')

  // 初期チャンクの生成完了を待つ
  await page.waitForFunction(() => window.__smooth?.ready === true, null, { timeout: 75_000 })

  // 視界内のチャンクがすべてメッシュ化されること
  await page.waitForFunction(
    () => {
      const s = window.__smooth!
      return s.desired > 0 && s.loaded === s.desired
    },
    null,
    { timeout: 75_000 },
  )
  const loaded = await page.evaluate(() => window.__smooth!)
  expect(loaded.desired).toBeGreaterThan(100)

  const canvasOk = await page.evaluate(() => {
    const c = document.querySelector('canvas') as HTMLCanvasElement | null
    return !!c && c.width > 0 && c.height > 0
  })
  expect(canvasOk).toBe(true)

  // プレイ開始（オーバーレイの backdrop-filter がソフトウェア描画では重いので先に閉じる）
  await page.click('#play')
  await page.waitForTimeout(1500)

  // 描画が止まっていないこと。
  // ヘッドレスは SwiftShader（CPU ラスタライザ）なので数 fps しか出ない。
  // ここでの目的はフレームレートの測定ではなくフリーズ検出。
  const first = await page.evaluate(() => window.__smooth!.frames)
  await page.waitForTimeout(6000)
  const second = await page.evaluate(() => window.__smooth!.frames)
  expect(second - first, '描画が停止している').toBeGreaterThan(5)

  // 真下を向いて掘る
  await page.evaluate(() =>
    document.dispatchEvent(new MouseEvent('mousemove', { movementX: 0, movementY: 620 })),
  )
  await page.waitForTimeout(500)
  await page.screenshot({ path: testInfo.outputPath('terrain.png') })

  await page.mouse.down({ button: 'left' })
  await page.waitForTimeout(2000)
  await page.mouse.up({ button: 'left' })
  await page.waitForTimeout(1500)

  const after = await page.evaluate(() => window.__smooth!)
  expect(after.edits, '掘削がワールドに反映されていない').toBeGreaterThan(0)

  await page.screenshot({ path: testInfo.outputPath('crater.png') })
  await testInfo.attach('terrain', {
    path: testInfo.outputPath('terrain.png'),
    contentType: 'image/png',
  })
  await testInfo.attach('crater', {
    path: testInfo.outputPath('crater.png'),
    contentType: 'image/png',
  })

  const fatal = errors.filter((e) => !/favicon|WebGL.*deprecated|SwiftShader/i.test(e))
  expect(fatal, fatal.join('\n')).toEqual([])
})
