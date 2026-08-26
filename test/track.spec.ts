import { expect, test } from '@playwright/test'

type Page = import('@playwright/test').Page

async function start(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(() => window.__smooth?.ready === true, null, { timeout: 75_000 })
  await page.click('#play')
  await page.waitForTimeout(1200)
}

/** 材料を持たせて軌道モードにする。 */
async function prepare(page: Page, kind = 'rail', length = 8): Promise<void> {
  await page.evaluate(
    ({ kind, length }) => {
      const s = window.__smooth!
      s.give('rock', 4000)
      s.equip('rock')
      s.setTool('track')
      s.setTrackKind(kind)
      s.setTrackLength(length)
      s.clearRailhead()
      s.look(0, -0.35)
    },
    { kind, length },
  )
  await page.waitForTimeout(400)
}

/** 村の広場は平らなので、敷く場所として当てにできる。 */
async function goToFlatGround(page: Page): Promise<void> {
  expect(await page.evaluate(() => window.__smooth!.gotoVillage()), '村が見つからない').toBe(true)
  await page.waitForTimeout(2500)
}

/**
 * 平らで開けた向きを探して、そちらを向く。
 *
 * 村の広場でも一方向は丘に突き当たる。切り盛りで直せるのは小さな段差までなので、
 * 丘へ向けて敷けば途中で切り詰められて当然。ここで測りたいのはそこではないため、
 * **足元に地面があって頭上が塞がっていない**向きを選んでから敷く。
 */
async function faceOpenGround(page: Page): Promise<{ dx: number; dz: number; reach: number }> {
  const dir = await page.evaluate(() => {
    const s = window.__smooth!
    const p = s.state()
    let best = { dx: 0, dz: -1, reach: -1 }
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2
      const dx = Math.cos(a)
      const dz = Math.sin(a)
      let reach = 0
      for (let d = 2; d <= 34; d += 2) {
        const x = p.x + dx * d
        const z = p.z + dz * d
        if (s.density(x, p.y + 0.35, z) > 0) break // 軌道面より上に地面が出ている
        if (s.density(x, p.y - 2.5, z) <= 0) break // 足元が抜けている
        reach = d
      }
      if (reach > best.reach) best = { dx, dz, reach }
    }
    // 前方 = (-sin(yaw), -cos(yaw))
    s.look(Math.atan2(-best.dx, -best.dz), -0.3)
    return best
  })
  expect(dir.reach, '村の周りに平らな向きが見つからない').toBeGreaterThanOrEqual(28)
  return dir
}

/**
 * ボタンを押したまま、ゲーム側の条件が満たされるまで待って離す。
 * ヘッドレスは SwiftShader で数 fps しか出ないので、固定時間の押しっぱなしでは
 * 1 フレームも回らないことがある。
 */
async function holdUntil(
  page: Page,
  button: 0 | 2,
  predicate: string,
  timeout = 20_000,
): Promise<void> {
  await page.evaluate(
    (b) => document.dispatchEvent(new MouseEvent('mousedown', { button: b })),
    button,
  )
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

test.describe('軌道モード', () => {
  test('B で軌道モードに入り、R で線路と道路が入れ替わる', async ({ page }) => {
    await start(page)
    await prepare(page)
    expect(await page.textContent('#brush')).toContain('軌道')
    expect(await page.textContent('#brush')).toContain('線路')

    await page.keyboard.press('KeyR')
    await page.waitForTimeout(400)
    expect(await page.textContent('#brush')).toContain('道路')

    await page.keyboard.press('KeyR')
    await page.waitForTimeout(400)
    expect(await page.textContent('#brush')).toContain('線路')
  })

  test('狙った先へ線路が伸び、続けて敷くと端点で繋がる', async ({ page }) => {
    await start(page)
    await goToFlatGround(page)
    await prepare(page)

    const dir = await faceOpenGround(page)

    const laid = await page.evaluate(
      ({ dx, dz }) => {
        const s = window.__smooth!
        const p = s.state()
        const results: string[] = []
        // 8 m 先から始めて、6 m ずつ先を狙い足していく
        for (let i = 0; i < 3; i++) {
          const d = 8 + i * 6
          results.push(s.trackAim(p.x + dx * d, p.y, p.z + dz * d))
        }
        return { results, segs: s.trackList(), count: s.trackCount() }
      },
      dir,
    )

    expect(laid.results).toEqual(['ok', 'ok', 'ok'])
    expect(laid.count).toBe(3)
    // 2 本目・3 本目は前の区間の終点から始まる（継ぎ目に隙間も段差も無い）
    for (let i = 1; i < laid.segs.length; i++) {
      const prev = laid.segs[i - 1]
      const cur = laid.segs[i]
      expect(Math.hypot(cur.x - prev.endX, cur.y - prev.endY, cur.z - prev.endZ)).toBeLessThan(0.01)
    }
  })

  test('敷いた線路の上に立てる', async ({ page }) => {
    await start(page)
    await goToFlatGround(page)
    await prepare(page, 'rail', 10)

    const dir = await faceOpenGround(page)

    const onTrack = await page.evaluate(async ({ dx, dz }) => {
      const s = window.__smooth!
      const p = s.state()
      const aimX = p.x + dx * 8
      const aimZ = p.z + dz * 8
      if (s.trackAim(aimX, p.y, aimZ) !== 'ok') return { placed: false, onGround: false, dy: NaN }
      const seg = s.trackAt(aimX, p.y, aimZ, 14)!
      // 区間の真ん中へ降りる
      const midX = (seg.x + seg.endX) / 2
      const midZ = (seg.z + seg.endZ) / 2
      const midY = (seg.y + seg.endY) / 2
      s.teleport(midX, midZ)
      await new Promise((r) => setTimeout(r, 2500))
      const st = s.state()
      return { placed: true, onGround: st.onGround, dy: st.y - midY }
    }, dir)

    expect(onTrack.placed).toBe(true)
    expect(onTrack.onGround).toBe(true)
    // 路盤の天面に立っている（地面へ落ちていない）
    expect(Math.abs(onTrack.dy)).toBeLessThan(0.35)
  })

  test('右クリックで敷き、左クリックで撤去できる（実際の操作）', async ({ page }) => {
    await start(page)
    await goToFlatGround(page)
    await prepare(page, 'rail', 10)
    await faceOpenGround(page)

    await holdUntil(page, 2, '() => window.__smooth.trackCount() >= 1')
    expect(await page.evaluate(() => window.__smooth!.trackCount())).toBeGreaterThanOrEqual(1)
    // 敷いた先が次のレールヘッドになる
    expect(await page.evaluate(() => window.__smooth!.railhead())).not.toBeNull()

    // 敷いた軌道のそばへ寄り、その面へ照準を落として撤去する
    const before = await page.evaluate(() => window.__smooth!.trackCount())
    await page.evaluate(() => {
      const s = window.__smooth!
      const seg = s.trackList()[0]
      // 区間の始点の少し手前（進行方向の逆側）に立つ
      const ux = (seg.endX - seg.x) / seg.length
      const uz = (seg.endZ - seg.z) / seg.length
      s.teleport(seg.x - ux * 3.5, seg.z - uz * 3.5)
    })
    await page.waitForTimeout(1500)
    await page.evaluate(() => {
      const s = window.__smooth!
      const seg = s.trackList()[0]
      const p = s.state()
      const ux = (seg.endX - seg.x) / seg.length
      const uz = (seg.endZ - seg.z) / seg.length
      // 区間の 2 m 先を狙う（目の高さから見下ろす角度をそのまま渡す）
      const tx = seg.x + ux * 2
      const tz = seg.z + uz * 2
      const dx = tx - p.x
      const dz = tz - p.z
      const dy = seg.y - (p.y + 1.62)
      s.look(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)))
    })
    await page.waitForTimeout(800)
    await holdUntil(page, 0, `() => window.__smooth.trackCount() < ${before}`)
    expect(await page.evaluate(() => window.__smooth!.trackCount())).toBeLessThan(before)
  })

  test('撤去すると材料が全額戻る', async ({ page }) => {
    await start(page)
    await goToFlatGround(page)
    await prepare(page)

    const dir = await faceOpenGround(page)

    const result = await page.evaluate(({ dx, dz }) => {
      const s = window.__smooth!
      const p = s.state()
      const x = p.x + dx * 8
      const z = p.z + dz * 8
      const before = s.itemCount('rock')
      const placed = s.trackAim(x, p.y, z)
      const spent = before - s.itemCount('rock')
      const removed = s.removeTrackAt(x, p.y, z, 14)
      return { placed, spent, removed, after: s.itemCount('rock'), before, count: s.trackCount() }
    }, dir)

    expect(result.placed).toBe('ok')
    expect(result.spent).toBeGreaterThan(0)
    expect(result.removed).toBe(true)
    expect(result.count).toBe(0)
    expect(result.after).toBe(result.before)
  })
  test('小さな段差は、敷くと地形のほうが路盤に合う（切り盛り）', async ({ page }) => {
    await start(page)
    await goToFlatGround(page)
    await prepare(page, 'rail', 10)

    const dir = await faceOpenGround(page)

    const r = await page.evaluate(({ dx, dz }) => {
      const s = window.__smooth!
      const p = s.state()
      // 8 m 先から、見ている向きへ 10 m の線を敷く
      const ax = p.x + dx * 8
      const az = p.z + dz * 8
      // 線の途中に 1.2 m のくぼみと 1.4 m の出っ張りを作る
      const hollow = { x: ax + dx * 3, z: az + dz * 3 }
      const mound = { x: ax + dx * 7, z: az + dz * 7 }
      s.dig(hollow.x, s.surfaceAt(hollow.x, hollow.z) + 0.8, hollow.z, 2)
      s.fill(mound.x, s.surfaceAt(mound.x, mound.z) + 0.2, mound.z, 1.2)
      const before = {
        hollow: s.surfaceAt(hollow.x, hollow.z),
        mound: s.surfaceAt(mound.x, mound.z),
      }

      const placed = s.trackAim(ax, p.y, az)
      const seg = s.trackList()[0]
      const after = {
        hollow: s.surfaceAt(hollow.x, hollow.z),
        mound: s.surfaceAt(mound.x, mound.z),
      }
      return { placed, seg, before, after, hollow, mound }
    }, dir)

    expect(r.placed).toBe('ok')
    // 掘ったところは下がり、盛ったところは上がっている（測る対象がちゃんとできている）
    expect(r.before.hollow).toBeLessThan(r.before.mound - 1.5)

    // 区間は直線なので、注目点の路盤の底面は始点と終点の線形補間で出せる
    const seg = r.seg
    const deckBottom = (x: number, z: number): number => {
      const t = Math.hypot(x - seg.x, z - seg.z) / seg.length
      return seg.y + (seg.endY - seg.y) * t - 0.35
    }

    // くぼみは築堤で埋まり、出っ張りは切土で削られて、どちらも路盤の底面に合う
    expect(Math.abs(r.after.hollow - deckBottom(r.hollow.x, r.hollow.z))).toBeLessThan(0.3)
    expect(Math.abs(r.after.mound - deckBottom(r.mound.x, r.mound.z))).toBeLessThan(0.3)
    // 実際に地形が動いている
    expect(r.after.hollow - r.before.hollow).toBeGreaterThan(0.6)
    expect(r.before.mound - r.after.mound).toBeGreaterThan(0.6)
  })
})
