import { expect, test } from '@playwright/test'

type Page = import('@playwright/test').Page

const SAMPLE_SEED = 20260823

async function start(page: Page, query = ''): Promise<void> {
  await page.goto(`/${query}`)
  await page.waitForFunction(() => window.__smooth?.ready === true, null, { timeout: 75_000 })
  await page.click('#play')
  await page.waitForTimeout(1200)
}

const api = (page: Page) => page.evaluate(() => window.__smooth!)

/** 木のすぐ横まで寄って、その木を狙う。狙えなければ null。 */
async function approachTree(page: Page): Promise<{ x: number; y: number; z: number } | null> {
  return page.evaluate(async () => {
    const s = window.__smooth!
    const origin = s.state()
    let tree = s.nearestTree()
    for (let i = 1; i < 40 && !tree; i++) {
      s.teleport(origin.x + Math.cos(i * 1.3) * i * 30, origin.z + Math.sin(i * 1.3) * i * 30)
      await new Promise((r) => setTimeout(r, 220))
      tree = s.nearestTree()
    }
    if (!tree) return null
    s.teleport(tree.x + 3.2, tree.z + 3.2)
    await new Promise((r) => setTimeout(r, 900))
    tree = s.nearestTree() ?? tree
    const p = s.state()
    const dx = tree.x - p.x
    const dz = tree.z - p.z
    const dist = Math.hypot(dx, dz)
    s.look(Math.atan2(-dx, -dz), Math.atan2(tree.y + 2.4 - (p.y + 1.62), dist))
    await new Promise((r) => setTimeout(r, 600))
    return tree
  })
}

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

test.describe('シード', () => {
  test('指定しなければサンプル用の固定シードになる', async ({ page }) => {
    await start(page)
    expect((await api(page)).seed).toBe(SAMPLE_SEED)
    expect(await page.inputValue('#seed')).toBe(String(SAMPLE_SEED))
  })

  test('?seed= で固定でき、同じシードなら同じ地形になる', async ({ page }) => {
    await start(page, '?seed=4242')
    expect((await api(page)).seed).toBe(4242)
    const first = await page.evaluate(() => window.__smooth!.state())

    await start(page, '?seed=4242')
    const second = await page.evaluate(() => window.__smooth!.state())
    expect(second.x).toBeCloseTo(first.x, 3)
    expect(second.z).toBeCloseTo(first.z, 3)

    // 別シードなら別の地形
    await start(page, '?seed=999')
    expect((await api(page)).seed).toBe(999)
    const other = await page.evaluate(() => window.__smooth!.state())
    expect(Math.hypot(other.x - first.x, other.z - first.z)).toBeGreaterThan(1)
  })

  test('文字列のシードも受け付ける', async ({ page }) => {
    await start(page, '?seed=demo')
    const s = await api(page)
    expect(s.seed).toBeGreaterThan(0)
    expect(s.seed).not.toBe(SAMPLE_SEED)
  })
})

test('V キーで最寄りの村へワープする', async ({ page }) => {
  await start(page)
  const before = await page.evaluate(() => window.__smooth!.state())
  await page.keyboard.press('KeyV')
  await page.waitForTimeout(1500)
  const after = await page.evaluate(() => window.__smooth!.state())
  expect(await page.textContent('#toast')).toContain('村')
  expect(Math.hypot(after.x - before.x, after.z - before.z), 'ワープしていない').toBeGreaterThan(20)
  await page.waitForTimeout(2500)
  expect((await api(page)).villages, 'ワープ先に村が無い').toBeGreaterThan(0)
})

test.describe('伐採', () => {
  test('木を切ると消え、リロードしても戻らない', async ({ page }) => {
    await start(page)
    const tree = await approachTree(page)
    expect(tree, '近くに木が見つからなかった').not.toBeNull()

    await click(page, 0, 700)
    const after = await api(page)
    expect(after.chopped, '伐採が記録されていない').toBeGreaterThan(0)
    expect(await page.textContent('#toast')).toContain('切り倒した')

    // 切った木の位置に幹が残っていないこと
    const remaining = await page.evaluate(
      (t) => {
        const n = window.__smooth!.nearestTree()
        return n ? Math.hypot(n.x - t!.x, n.z - t!.z) : Infinity
      },
      tree,
    )
    expect(remaining, '切った木がまだ立っている').toBeGreaterThan(1)

    // 保存を待ってからリロード
    await page.waitForTimeout(2500)
    await page.reload()
    await page.waitForFunction(() => window.__smooth?.ready === true, null, { timeout: 75_000 })
    expect((await api(page)).chopped, 'リロードで伐採が失われた').toBeGreaterThan(0)
  })
})

test.describe('採掘量', () => {
  test('掘ると貯まり、貯めた分だけ盛れる', async ({ page }) => {
    await start(page)
    // 真下を向く
    await page.evaluate(() =>
      document.dispatchEvent(new MouseEvent('mousemove', { movementX: 0, movementY: 620 })),
    )
    await page.waitForTimeout(600)

    // 手持ち 0 では盛れない
    expect((await api(page)).inventory.every((n) => n === 0)).toBe(true)
    await click(page, 2, 900)
    expect((await api(page)).edits, '手持ち 0 なのに地形が変わった').toBe(0)
    expect(await page.textContent('#toast')).toContain('足りません')

    // 掘ると貯まる
    await click(page, 0, 2500)
    const dug = await api(page)
    const total = dug.inventory.reduce((a, b) => a + b, 0)
    expect(total, '掘っても手持ちが増えない').toBeGreaterThan(5)

    // いちばん多く採れた素材を選んで盛ると減る
    const best = dug.inventory.indexOf(Math.max(...dug.inventory))
    await page.keyboard.press(`Digit${best + 1}`)
    await page.waitForTimeout(300)
    await click(page, 2, 2500)
    const placed = await api(page)
    expect(placed.inventory[best], '盛っても手持ちが減らない').toBeLessThan(dug.inventory[best])
  })
})

/** 中心 c のまわりの密度を格子状に読む。 */
async function probe(page: Page, c: { x: number; y: number; z: number }): Promise<number[]> {
  return page.evaluate((p) => {
    const s = window.__smooth!
    const out: number[] = []
    for (let dy = -4; dy <= 1; dy++) {
      for (let dz = -3; dz <= 3; dz++) {
        for (let dx = -3; dx <= 3; dx++) out.push(s.density(p.x + dx, p.y + dy, p.z + dz))
      }
    }
    return out
  }, c)
}

function changed(a: number[], b: number[]): number {
  let n = 0
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-3) n++
  return n
}

/** 真下を向く。 */
async function lookDown(page: Page): Promise<void> {
  await page.evaluate(() =>
    document.dispatchEvent(new MouseEvent('mousemove', { movementX: 0, movementY: 620 })),
  )
  await page.waitForTimeout(600)
}

test.describe('ブラシの切り替え', () => {
  test('B キーで 球 → 直方体 → ならし と巡回する', async ({ page }) => {
    await start(page)
    expect((await api(page)).tool).toBe('sphere')
    for (const expected of ['box', 'smooth', 'sphere']) {
      await page.keyboard.press('KeyB')
      // 数 fps しか出ないので、次のフレームで stats が更新されるまで待つ
      await page.waitForFunction((t) => window.__smooth?.tool === t, expected, { timeout: 10_000 })
    }
  })

  test('直方体ブラシは大きさを一辺で表示し、地形を削る', async ({ page }) => {
    await start(page)
    await page.evaluate(() => window.__smooth!.setTool('box'))
    await page.waitForTimeout(200)
    expect(await page.textContent('#brush')).toMatch(/直方体 \d+×\d+×\d+ m/)

    await lookDown(page)
    const c = await page.evaluate(() => window.__smooth!.state())
    const before = await probe(page, c)
    await click(page, 0, 900)
    expect(changed(before, await probe(page, c)), '直方体で掘っても地形が変わらない').toBeGreaterThan(
      20,
    )
  })
})

test.describe('ならしブラシ', () => {
  test('地形は変わるが手持ちは増減しない', async ({ page }) => {
    await start(page)
    await lookDown(page)

    // まず掘って、ならす対象の凹凸と手持ちを作る
    await click(page, 0, 2000)
    const dug = await api(page)
    expect(dug.inventory.reduce((a, b) => a + b, 0)).toBeGreaterThan(5)

    await page.evaluate(() => window.__smooth!.setTool('smooth'))
    await lookDown(page)
    const c = await page.evaluate(() => window.__smooth!.state())
    const before = await probe(page, c)
    await click(page, 0, 1500)
    const after = await api(page)

    expect(changed(before, await probe(page, c)), 'ならしても地形が変わらない').toBeGreaterThan(20)
    expect(after.inventory, 'ならしで手持ちが増減した').toEqual(dug.inventory)
  })
})
