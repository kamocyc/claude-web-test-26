import { expect, test } from '@playwright/test'

type Page = import('@playwright/test').Page

const api = (page: Page) => page.evaluate(() => window.__smooth!)

async function start(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(() => window.__smooth?.ready === true, null, { timeout: 75_000 })
  await page.click('#play')
  await page.waitForTimeout(1200)
}

/** 建材を持たせて建築モードにする。 */
async function prepare(page: Page, piece = 'wall'): Promise<void> {
  await page.evaluate((p) => {
    const s = window.__smooth!
    s.give('plank', 600)
    s.equip('plank')
    s.setTool('build')
    s.setPiece(p)
  }, piece)
  await page.waitForTimeout(400)
}

/** 村の広場は平らなので、建てる場所として当てにできる。 */
async function goToFlatGround(page: Page): Promise<void> {
  expect(await page.evaluate(() => window.__smooth!.gotoVillage()), '村が見つからない').toBe(true)
  await page.waitForTimeout(2500)
}

/**
 * ボタンを押したまま、ゲーム側の条件が満たされるまで待って離す。
 *
 * ヘッドレスは SwiftShader なので数 fps しか出ず、固定時間の押しっぱなしでは
 * 1 フレームも回らないことがある。押している間の待ちを条件で切るとぶれない。
 */
async function holdUntil(
  page: Page,
  button: 0 | 2,
  predicate: string,
  timeout = 20_000,
): Promise<void> {
  await page.evaluate((b) => document.dispatchEvent(new MouseEvent('mousedown', { button: b })), button)
  try {
    await page.waitForFunction(`(${predicate})()`, null, { timeout })
  } finally {
    await page.evaluate(
      (b) => document.dispatchEvent(new MouseEvent('mouseup', { button: b })),
      button,
    )
    await page.waitForTimeout(600)
  }
}

test.describe('建築モード', () => {
  test('R キーでパーツが巡回し、HUD に出る', async ({ page }) => {
    await start(page)
    await prepare(page)
    expect(await page.textContent('#brush')).toContain('建築')
    expect(await page.textContent('#brush')).toContain('壁')

    await page.keyboard.press('KeyR')
    await page.waitForFunction(() => (document.getElementById('brush')?.textContent ?? '').includes('窓'), null, {
      timeout: 10_000,
    })
    await page.keyboard.press('KeyR')
    await page.waitForFunction(() => (document.getElementById('brush')?.textContent ?? '').includes('戸口'), null, {
      timeout: 10_000,
    })
  })

  test('右クリックで壁が建ち、材料が減る', async ({ page }) => {
    await start(page)
    await goToFlatGround(page)
    await prepare(page)
    // 少し下を向いて地面を狙う
    await page.evaluate(() => window.__smooth!.look(0, -0.55))
    await page.waitForTimeout(400)

    const before = await page.evaluate(() => window.__smooth!.itemCount('plank'))
    await holdUntil(page, 2, '() => (window.__smooth?.pieceCount() ?? 0) > 0')

    const after = await api(page)
    expect(after.pieces, '壁が建っていない').toBeGreaterThan(0)
    expect(
      await page.evaluate(() => window.__smooth!.itemCount('plank')),
      '材料が減っていない',
    ).toBeLessThan(before)
    expect(await page.evaluate(() => window.__smooth!.buildColliders())).toBeGreaterThan(0)
  })

  test('左クリックで解体すると材料が戻る', async ({ page }) => {
    await start(page)
    await goToFlatGround(page)
    // ブロックはセルを丸ごと埋めるので、置いた直後に同じ照準で狙える
    await prepare(page, 'block')
    await page.evaluate(() => window.__smooth!.look(0, -0.55))
    await page.waitForTimeout(400)

    await holdUntil(page, 2, '() => (window.__smooth?.pieceCount() ?? 0) > 0')
    const placed = await api(page)
    expect(placed.pieces, 'ブロックが置けていない').toBeGreaterThan(0)
    const stock = await page.evaluate(() => window.__smooth!.itemCount('plank'))

    const n = placed.pieces
    await holdUntil(page, 0, `() => (window.__smooth?.pieceCount() ?? 0) < ${n}`)
    expect((await api(page)).pieces, '解体できていない').toBeLessThan(placed.pieces)
    expect(
      await page.evaluate(() => window.__smooth!.itemCount('plank')),
      '材料が戻っていない',
    ).toBeGreaterThan(stock)
  })

  test('浮いた場所・足りない材料では置けない', async ({ page }) => {
    await start(page)
    await goToFlatGround(page)
    await prepare(page)

    const r = await page.evaluate(() => {
      const s = window.__smooth!
      const p = s.state()
      // 基準点はブロックの底面中心なので、足元の高さがそのまま地面の上になる
      return {
        floating: s.buildAt('block', p.x, p.y + 40, p.z),
        ground: s.buildAt('block', p.x, p.y, p.z),
        again: s.buildAt('block', p.x, p.y, p.z),
        onTop: s.buildAt('block', p.x, p.y + 3, p.z),
        loose: s.buildAt('block', p.x + 6, p.y, p.z, 'dirt'),
        broke: s.buildAt('block', p.x + 6, p.y, p.z, 'brick'),
        pieces: s.pieceCount(),
      }
    })
    expect(r.floating, '宙に浮いた場所に置けてしまう').toBe('unsupported')
    expect(r.ground, '地面の上に置けない').toBe('ok')
    expect(r.again, '同じ場所に二重に置けてしまう').toBe('overlap')
    expect(r.onTop, '置いたブロックの上に積めない').toBe('ok')
    expect(r.loose, '土で建てられてしまう').toBe('material')
    expect(r.broke, '持っていない材料で建てられてしまう').toBe('short')
    expect(r.pieces).toBe(2)
  })

  test('ホイールで 5° ずつ回り、HUD に角度が出る', async ({ page }) => {
    await start(page)
    await prepare(page)
    // ラベルの末尾には操作の案内（ホイール:5°）が常に出るので、回転量の表示だけを見る
    expect(await page.textContent('#brush'), '最初から回っている').not.toContain(' 5°')

    // ホイールは 1 フレームに 1 段だけ効く（ブラシの大きさと同じ扱い）ので、
    // フレームをまたぐように送って 5° ずつ増えることを見る
    const notch = () =>
      page.evaluate(() =>
        document.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, cancelable: true })),
      )
    for (const deg of ['5°', '10°']) {
      await notch()
      await page.waitForFunction(
        (d) => (document.getElementById('brush')?.textContent ?? '').includes(` ${d}`),
        deg,
        { timeout: 10_000 },
      )
    }
  })

  test('斜めに建てた壁の隣に置くと、向きが自動で揃う', async ({ page }) => {
    await start(page)
    await goToFlatGround(page)
    await prepare(page)

    const r = await page.evaluate(() => {
      const s = window.__smooth!
      const p = s.state()
      // 壁の基準点は面の中心なので、足元 + 1.5 m が地面に立つ高さになる
      const first = s.buildAt('wall', p.x + 3, p.y + 1.5, p.z, 'plank', 35)
      const a = s.pieceInfoAt(p.x + 3, p.y + 1.5, p.z)
      if (!a) return { first, a: null }
      // 1 枚目の端（ローカル z = +1.5）のすぐ外を狙って増築する
      const rad = (a.deg * Math.PI) / 180
      const ex = a.x + 1.6 * Math.sin(rad)
      const ez = a.z + 1.6 * Math.cos(rad)
      const second = s.buildAim('wall', ex, a.y, ez)
      const b = s.pieceInfoAt(a.x + 3 * Math.sin(rad), a.y, a.z + 3 * Math.cos(rad), 1)
      return { first, second, aDeg: a.deg, bDeg: b?.deg ?? null, pieces: s.pieceCount() }
    })

    expect(r.first, '斜めの壁が建たない').toBe('ok')
    expect(r.aDeg, '指定した角度になっていない').toBe(35)
    expect(r.second, '隣に増築できない').toBe('ok')
    expect(r.bDeg, '向きが継承されていない').toBe(35)
    expect(r.pieces).toBe(2)
  })

  test('建てたものは当たり判定を持ち、リロードしても残る', async ({ page }) => {
    await start(page)
    await goToFlatGround(page)
    await prepare(page)

    // 目の前（-z 方向）に 2 段積んで、乗り越えられない壁にする
    const built = await page.evaluate(() => {
      const s = window.__smooth!
      s.look(0, 0)
      const p = s.state()
      const lo = s.buildAt('block', p.x, p.y, p.z - 4)
      const hi = s.buildAt('block', p.x, p.y + 3, p.z - 4)
      return { lo, hi, x: p.x, z: p.z, pieces: s.pieceCount() }
    })
    expect([built.lo, built.hi]).toEqual(['ok', 'ok'])

    // 前（-z）へ歩いてもブロックを通り抜けない
    await page.keyboard.down('KeyW')
    // 数 fps しか出ないので、時間ではなく「ブロックに着いたか」で待つ
    await page.waitForFunction(
      (b) => {
        const p = window.__smooth!.state()
        return Math.hypot(p.x - b.x, p.z - (b.z - 4)) < 2.4
      },
      built,
      { timeout: 30_000 },
    )
    await page.waitForTimeout(1200)
    await page.keyboard.up('KeyW')
    const after = await page.evaluate(() => window.__smooth!.state())
    const gap = Math.hypot(after.x - built.x, after.z - (built.z - 4))
    expect(gap, `ブロックを通り抜けた (${gap.toFixed(2)}m)`).toBeGreaterThan(1)
    expect(after.boxes, '当たり判定がプレイヤーに渡っていない').toBeGreaterThan(0)

    // 保存を待ってリロード
    await page.waitForTimeout(2500)
    await page.reload()
    await page.waitForFunction(() => window.__smooth?.ready === true, null, { timeout: 75_000 })
    expect((await api(page)).pieces, 'リロードで建てたものが消えた').toBe(built.pieces)
  })
})
