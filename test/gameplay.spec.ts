import { expect, test } from '@playwright/test'

type Page = import('@playwright/test').Page

async function start(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(() => window.__smooth?.ready === true, null, { timeout: 75_000 })
  await page.click('#play')
  await page.waitForTimeout(1200)
}

const api = (page: Page) => page.evaluate(() => window.__smooth!)
/** 体力は毎フレーム末に stats へ写すので、数 fps だと反映を待つ必要がある。 */
const health = (page: Page) => page.evaluate(() => window.__smooth!.health)
const waitHealth = (page: Page, pred: (h: number) => boolean) =>
  page.waitForFunction(
    (src) => new Function('h', `return (${src})(h)`)(window.__smooth!.health),
    pred.toString(),
    { timeout: 15_000 },
  )

// window.__smooth をまるごと渡すと関数が落ちるので、呼ぶものは個別に評価する
const craftable = (page: Page) => page.evaluate(() => window.__smooth!.craftable())
const itemCount = (page: Page, id: string) =>
  page.evaluate((i) => window.__smooth!.itemCount(i), id)
const torchCount = (page: Page) => page.evaluate(() => window.__smooth!.torchCount())
const craftedVertices = (page: Page) => page.evaluate(() => window.__smooth!.craftedVertices())
const mobCount = (page: Page, kind: 'wraith' | 'deer' | 'villager') =>
  page.evaluate((k) => window.__smooth!.mobCount(k), kind)

async function click(page: Page, button: 0 | 2, ms: number): Promise<void> {
  await page.evaluate(
    async ([b, hold]) => {
      document.dispatchEvent(new MouseEvent('mousedown', { button: b }))
      await new Promise((r) => setTimeout(r, hold))
      document.dispatchEvent(new MouseEvent('mouseup', { button: b }))
      await new Promise((r) => setTimeout(r, 500))
    },
    [button, ms] as const,
  )
}

async function lookDown(page: Page): Promise<void> {
  await page.evaluate(() =>
    document.dispatchEvent(new MouseEvent('mousemove', { movementX: 0, movementY: 620 })),
  )
  await page.waitForTimeout(500)
}

test.describe('持ち物とクラフト', () => {
  test('E で画面が開き、材料が揃ったレシピだけ作れる', async ({ page }) => {
    await start(page)
    expect(await craftable(page), '最初から作れてしまう').toEqual([])

    await page.keyboard.press('KeyE')
    await page.waitForFunction(() => !document.getElementById('panel')!.classList.contains('hidden'))
    // ポインタロックを外して操作できるようにしている
    expect(await page.evaluate(() => document.pointerLockElement === null)).toBe(true)

    await page.evaluate(() => {
      const s = window.__smooth!
      s.give('wood', 3)
      s.giveMaterial(2, 40) // 岩
    })
    await page.waitForTimeout(300)
    expect(await craftable(page)).toContain('pickaxe')

    expect(await page.evaluate(() => window.__smooth!.craft('pickaxe'))).toBe(true)
    expect(await itemCount(page, 'pickaxe')).toBe(1)
    expect(await itemCount(page, 'wood'), '材料が減っていない').toBe(0)
    expect(await itemCount(page, 'rock')).toBe(0)
    // 2 個目は作れない
    expect(await page.evaluate(() => window.__smooth!.craft('pickaxe'))).toBe(false)

    await page.keyboard.press('KeyE')
    await page.waitForFunction(() => document.getElementById('panel')!.classList.contains('hidden'))
  })

  test('クラフトした建材を置くと、地形にその素材が乗る', async ({ page }) => {
    await start(page)
    expect(await craftedVertices(page), '最初から建材がある').toBe(0)

    await page.evaluate(() => {
      const s = window.__smooth!
      s.giveMaterial(1, 400) // 土
      s.giveMaterial(2, 400) // 岩
      s.craft('brick')
      s.equip('brick')
      s.setBrushRadius(3)
    })
    await lookDown(page)
    const before = await itemCount(page, 'brick')
    await click(page, 2, 900)
    await page.waitForTimeout(1500)

    expect(await itemCount(page, 'brick'), 'レンガが減っていない').toBeLessThan(before)
    expect(await craftedVertices(page), 'メッシュにレンガが出ていない').toBeGreaterThan(20)
  })

  test('置けないものを持っていると盛れない', async ({ page }) => {
    await start(page)
    await page.evaluate(() => {
      const s = window.__smooth!
      s.give('bone', 5)
      s.equip('bone')
    })
    await lookDown(page)
    await click(page, 2, 700)
    expect(await page.textContent('#toast')).toContain('置けません')
    expect((await api(page)).edits).toBe(0)
  })

  test('松明を置いて掘ると回収できる', async ({ page }) => {
    await start(page)
    await page.evaluate(() => {
      const s = window.__smooth!
      s.give('torch', 4)
      s.equip('torch')
    })
    await lookDown(page)
    await click(page, 2, 400)
    await page.waitForTimeout(600)
    expect(await torchCount(page), '松明が置けていない').toBe(1)
    expect(await itemCount(page, 'torch')).toBe(3)

    await page.evaluate(() => window.__smooth!.equip('dirt'))
    await click(page, 0, 700)
    await page.waitForTimeout(600)
    expect(await torchCount(page), '掘っても松明が残っている').toBe(0)
    expect(await itemCount(page, 'torch'), '松明が戻ってこない').toBe(4)
  })
})

test.describe('MOB と戦闘', () => {
  test('敵に殴られると体力が減り、0 になると復帰する', async ({ page }) => {
    await start(page)
    expect(await health(page)).toBe(20)

    await page.evaluate(() => window.__smooth!.hurt(6))
    await waitHealth(page, (h) => h < 20)
    expect(await page.textContent('#health-text')).toBe('14 / 20')

    await page.evaluate(() => window.__smooth!.hurt(100))
    await waitHealth(page, (h) => h === 20)
    expect(await page.textContent('#toast'), '倒れた合図が出ない').toContain('やられた')
  })

  test('防具を持っているとダメージが減る', async ({ page }) => {
    await start(page)
    await page.evaluate(() => window.__smooth!.hurt(10))
    await waitHealth(page, (h) => h < 20)
    const bare = 20 - (await health(page))

    // 倒れて満タンに戻してから、防具ありで比べる
    await page.evaluate(() => window.__smooth!.hurt(100))
    await waitHealth(page, (h) => h === 20)
    await page.evaluate(() => window.__smooth!.give('bone_armor', 1))
    await page.evaluate(() => window.__smooth!.hurt(10))
    await waitHealth(page, (h) => h < 20)
    const armored = 20 - (await health(page))
    expect(armored, `防具が効いていない ${bare} → ${armored}`).toBeLessThan(bare * 0.6)
  })

  test('MOB を倒すと素材を落とす', async ({ page }) => {
    await start(page)
    await page.evaluate(() => window.__smooth!.spawnMob('deer', 2, 0))
    await page.waitForTimeout(400)
    // 自然に湧いた鹿がいることもあるので、増えたことだけ見る
    expect(await mobCount(page, 'deer')).toBeGreaterThan(0)
    expect(await itemCount(page, 'hide')).toBe(0)

    // 素手だと 1 発では倒せない
    await page.evaluate(() => {
      const s = window.__smooth!
      s.give('bone_sword', 1)
      s.equip('bone_sword')
    })
    await page.waitForFunction(() => window.__smooth!.hitNearestMob() === true, null, {
      timeout: 10_000,
    })
    await page.waitForTimeout(800)
    expect(await itemCount(page, 'hide'), '皮が手に入らない').toBeGreaterThan(0)
  })

  test('村人と交換できる', async ({ page }) => {
    await start(page)
    await page.evaluate(() => window.__smooth!.gotoVillage())
    await page.waitForTimeout(2500)
    await page.evaluate(() => {
      window.__smooth!.spawnMob('villager', 2, 0)
      window.__smooth!.giveMaterial(2, 200) // 岩
    })
    await page.waitForTimeout(500)

    await page.keyboard.press('KeyF')
    await page.waitForFunction(() => !document.getElementById('trade')!.classList.contains('hidden'))

    const rows = page.locator('#trade-list .recipe:not(.locked)')
    expect(await rows.count(), '交換できる項目が出ない').toBeGreaterThan(0)
    await rows.first().click()
    await page.waitForTimeout(400)
    expect(await itemCount(page, 'wood'), '交換で木材が増えない').toBeGreaterThan(0)

    await page.keyboard.press('KeyF')
    await page.waitForFunction(() => document.getElementById('trade')!.classList.contains('hidden'))
  })
})
