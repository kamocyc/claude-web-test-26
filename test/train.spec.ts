import { expect, test } from '@playwright/test'

type Page = import('@playwright/test').Page

async function start(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(() => window.__smooth?.ready === true, null, { timeout: 75_000 })
  await page.click('#play')
  await page.waitForTimeout(1200)
}

/** 村の広場は平らなので、敷く場所として当てにできる。 */
async function goToFlatGround(page: Page): Promise<void> {
  expect(await page.evaluate(() => window.__smooth!.gotoVillage()), '村が見つからない').toBe(true)
  await page.waitForTimeout(2500)
}

/**
 * 平らで開けた向きへ線路を 3 区間敷いて、駅・列車モードに入る。
 *
 * ヘッドレスは数 fps しか出ず、`dt` が 0.1 秒で頭打ちになるので、
 * **実時間ではなくゲーム側の状態で待つ**こと（`waitForFunction`）。
 */
async function layLine(page: Page): Promise<void> {
  await goToFlatGround(page)
  const laid = await page.evaluate(() => {
    const s = window.__smooth!
    s.give('rock', 40000)
    s.equip('rock')
    s.setTool('track')
    s.setTrackKind('rail')
    s.setTrackLength(14)
    s.clearRailhead()
    const p = s.state()
    let best = { dx: 0, dz: -1, reach: -1 }
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2
      const dx = Math.cos(a)
      const dz = Math.sin(a)
      let reach = 0
      for (let d = 2; d <= 40; d += 2) {
        const x = p.x + dx * d
        const z = p.z + dz * d
        if (s.density(x, p.y + 0.35, z) > 0) break
        if (s.density(x, p.y - 2.5, z) <= 0) break
        reach = d
      }
      if (reach > best.reach) best = { dx, dz, reach }
    }
    s.look(Math.atan2(-best.dx, -best.dz), -0.25)
    const res: string[] = []
    for (let i = 0; i < 3; i++) {
      const d = 6 + i * 14
      res.push(s.trackAim(p.x + best.dx * d, p.y, p.z + best.dz * d))
    }
    s.setTool('station')
    return { res, reach: best.reach, segs: s.trackList().length }
  })
  expect(laid.res, '線路が敷けなかった').toEqual(['ok', 'ok', 'ok'])
  expect(laid.segs).toBe(3)
}

/** 線路の両端に駅を建てる。 */
async function buildStations(page: Page): Promise<void> {
  const built = await page.evaluate(() => {
    const s = window.__smooth!
    const segs = s.trackList()
    const first = segs[0]
    const last = segs[segs.length - 1]
    return [
      s.placeStation(first.x, first.y, first.z),
      s.placeStation(last.endX, last.endY, last.endZ),
    ]
  })
  expect(built).toEqual(['ok', 'ok'])
}

test.describe('駅と列車', () => {
  test('駅は線路の上にしか建てられない', async ({ page }) => {
    await start(page)
    await layLine(page)
    expect(await page.textContent('#brush')).toContain('駅・列車')

    const r = await page.evaluate(() => {
      const s = window.__smooth!
      const seg = s.trackList()[0]
      const on = s.placeStation(seg.x, seg.y, seg.z)
      // 線路から 40 m 離れた所には建たない
      const off = s.placeStation(seg.x + 40, seg.y, seg.z + 40)
      // すぐ隣にも建たない
      const close = s.placeStation(seg.x, seg.y, seg.z)
      return { on, off, close, count: s.stationCount() }
    })
    expect(r.on).toBe('ok')
    expect(r.off).toBe('notrack')
    expect(r.close).toBe('tooclose')
    expect(r.count).toBe(1)
  })

  test('駅を順に選んで発車すると列車が走る', async ({ page }) => {
    await start(page)
    await layLine(page)
    await buildStations(page)

    const dep = await page.evaluate(() => {
      const s = window.__smooth!
      const before = s.itemCount('rock')
      const alone = s.depart() // 駅を選ばずに発車はできない
      s.selectStation(0)
      s.selectStation(1)
      const sel = s.routeSelection()
      const ok = s.depart()
      return { alone, sel, ok, spent: before - s.itemCount('rock'), trains: s.trainCount() }
    })
    expect(dep.alone).toBe('short-route')
    expect(dep.sel).toEqual([0, 1])
    expect(dep.ok).toBe('ok')
    expect(dep.trains).toBe(1)
    expect(dep.spent).toBeGreaterThan(0)
    // 選んだ路線は発車で消える
    expect(await page.evaluate(() => window.__smooth!.routeSelection())).toEqual([])

    // 走り出して、駅から駅へ辿り着く（fps が出ないので状態で待つ）
    await page.waitForFunction(() => (window.__smooth!.trainInfo(0)?.traveled ?? 0) > 5, null, {
      timeout: 120_000,
    })
    const moving = await page.evaluate(() => window.__smooth!.trainInfo(0)!)
    expect(moving.running).toBe(true)
    expect(moving.stuck).toBe(false)
    expect(moving.speed).toBeGreaterThan(0)

    await page.waitForFunction(() => window.__smooth!.trainInfo(0)?.hop === 1, null, {
      timeout: 180_000,
    })
    const arrived = await page.evaluate(() => {
      const s = window.__smooth!
      const t = s.trainInfo(0)!
      const to = s.stationList()[1]
      return { d: Math.hypot(t.x - to.x, t.z - to.z), speed: t.speed, dir: t.dir }
    })
    // 終点にぴたりと止まり、折り返す
    expect(arrived.d).toBeLessThan(1)
    expect(arrived.speed).toBe(0)
    expect(arrived.dir).toBe(-1)
  })

  test('列車に乗ると運ばれ、降りると線路の脇に立つ', async ({ page }) => {
    await start(page)
    await layLine(page)
    await buildStations(page)
    await page.evaluate(() => {
      const s = window.__smooth!
      s.selectStation(0)
      s.selectStation(1)
      s.depart()
    })
    await page.waitForFunction(() => (window.__smooth!.trainInfo(0)?.traveled ?? 0) > 3, null, {
      timeout: 120_000,
    })

    const rode = await page.evaluate(() => {
      const s = window.__smooth!
      const t = s.trainInfo(0)!
      s.teleport(t.x, t.z)
      return s.rideTrain()
    })
    expect(rode).toBe(true)

    // 列車が進んだぶんだけ、プレイヤーも一緒に動く
    const from = await page.evaluate(() => window.__smooth!.trainInfo(0)!.traveled)
    await page.waitForFunction(
      (d) => (window.__smooth!.trainInfo(0)?.traveled ?? 0) > d + 6,
      from,
      { timeout: 120_000 },
    )
    const carried = await page.evaluate(() => {
      const s = window.__smooth!
      const t = s.trainInfo(0)!
      const p = s.state()
      return { riding: s.isRiding(), gap: Math.hypot(p.x - t.x, p.z - t.z) }
    })
    expect(carried.riding).toBe(true)
    // 運転台にいる（車体の中）
    expect(carried.gap).toBeLessThan(3)

    const off = await page.evaluate(async () => {
      const s = window.__smooth!
      s.leaveTrain()
      const p = s.state()
      const t = s.trainInfo(0)!
      return { riding: s.isRiding(), gap: Math.hypot(p.x - t.x, p.z - t.z) }
    })
    expect(off.riding).toBe(false)
    expect(off.gap).toBeGreaterThan(1.5)
  })

  test('駅と列車を撤去すると材料が戻り、リロードしても残る', async ({ page }) => {
    await start(page)
    await layLine(page)
    await buildStations(page)
    await page.evaluate(() => {
      const s = window.__smooth!
      s.selectStation(0)
      s.selectStation(1)
      s.depart()
    })

    // リロードしても駅と列車が残る
    await page.waitForTimeout(2500)
    await page.reload()
    await page.waitForFunction(() => window.__smooth?.ready === true, null, { timeout: 75_000 })
    await page.click('#play')
    await page.waitForTimeout(1500)
    const after = await page.evaluate(() => {
      const s = window.__smooth!
      return { stations: s.stationCount(), trains: s.trainCount(), route: s.trainInfo(0)?.route }
    })
    expect(after.stations).toBe(2)
    expect(after.trains).toBe(1)
    expect(after.route).toEqual([0, 1])

    const removed = await page.evaluate(() => {
      const s = window.__smooth!
      s.equip('rock')
      const before = s.itemCount('rock')
      const t = s.trainInfo(0)!
      const gotTrain = s.removeTrainAt(t.x, t.y, t.z, 8)
      const st = s.stationList()[0]
      const gotStation = s.removeStationAt(st.x, st.y, st.z, 6)
      return {
        gotTrain,
        gotStation,
        gained: s.itemCount('rock') - before,
        stations: s.stationCount(),
        trains: s.trainCount(),
      }
    })
    expect(removed.gotTrain).toBe(true)
    expect(removed.gotStation).toBe(true)
    expect(removed.gained).toBeGreaterThan(0)
    expect(removed.stations).toBe(1)
    expect(removed.trains).toBe(0)
  })

  test('線路を撤去すると、その上の駅も消える', async ({ page }) => {
    await start(page)
    await layLine(page)
    await buildStations(page)
    const r = await page.evaluate(() => {
      const s = window.__smooth!
      const before = s.stationCount()
      const seg = s.trackList()[0]
      // 1 本目の線路（1 つ目の駅が乗っている）を撤去する
      s.removeTrackAt(seg.x, seg.y, seg.z, 6)
      return { before, after: s.stationCount() }
    })
    expect(r.before).toBe(2)
    expect(r.after).toBe(1)
  })
})
