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
    const cands: { dx: number; dz: number; reach: number }[] = []
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2
      const dx = Math.cos(a)
      const dz = Math.sin(a)
      let reach = 0
      for (let d = 2; d <= 52; d += 2) {
        const x = p.x + dx * d
        const z = p.z + dz * d
        if (s.density(x, p.y + 0.35, z) > 0) break
        if (s.density(x, p.y - 2.5, z) <= 0) break
        reach = d
      }
      cands.push({ dx, dz, reach })
      if (reach > best.reach) best = { dx, dz, reach }
    }
    // 村の広場は家に囲まれているので、通りの良い向きから順に試す
    // （家にぶつかると手前で止まるか敷けないので、その向きは捨てて次を試す）
    cands.sort((a, b) => b.reach - a.reach)
    const wipe = (): void => {
      for (const t of s.trackList()) {
        s.removeTrackAt((t.x + t.endX) / 2, (t.y + t.endY) / 2, (t.z + t.endZ) / 2, 6)
      }
      s.clearRailhead()
    }
    let res: string[] = []
    for (const c of cands) {
      if (c.reach < 40) break
      s.look(Math.atan2(-c.dx, -c.dz), -0.25)
      s.clearRailhead()
      res = []
      for (let i = 0; i < 3; i++) {
        const d = 6 + i * 14
        res.push(s.trackAim(p.x + c.dx * d, p.y, p.z + c.dz * d))
      }
      if (res.every((r) => r === 'ok')) break
      wipe()
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

/** 線路・駅・列車を用意して、走り出すまで待つ。 */
async function runTrain(page: Page): Promise<void> {
  await layLine(page)
  await buildStations(page)
  await page.evaluate(() => {
    const s = window.__smooth!
    s.selectStation(0)
    s.selectStation(1)
    s.depart()
  })
  await page.waitForFunction(() => (window.__smooth!.trainInfo(0)?.speed ?? 0) > 4, null, {
    timeout: 120_000,
  })
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


test.describe('列車の当たり判定', () => {
  test('屋根の上に立てて、走っている列車といっしょに運ばれる', async ({ page }) => {
    await start(page)
    await runTrain(page)

    const on = await page.evaluate(async () => {
      const s = window.__smooth!
      const t = s.trainInfo(0)!
      // 運転台の屋根の真ん中へ降りる（ヨー θ の後ろは (sinθ, cosθ)）
      const cab = s.trainColliders()[1]
      const back = (cab.minZ + cab.maxZ) / 2
      s.placeAt(t.x + Math.sin(t.yaw) * back, cab.maxY + 0.05, t.z + Math.cos(t.yaw) * back)
      await new Promise((r) => setTimeout(r, 1200))
      return { roofY: cab.maxY, standing: s.standingOnTrain(), p: s.state() }
    })
    // 車体をすり抜けず、屋根の天面に立っている
    expect(on.standing).not.toBeNull()
    expect(on.standing!).toBeCloseTo(on.roofY, 1)
    expect(on.p.onGround).toBe(true)

    // 列車が進んだぶんだけ、屋根の上のプレイヤーも動く
    const carried = await page.evaluate(async () => {
      const s = window.__smooth!
      const from = s.state()
      const t0 = s.trainInfo(0)!
      await new Promise((r) => setTimeout(r, 4000))
      const p = s.state()
      const t1 = s.trainInfo(0)!
      return {
        moved: Math.hypot(p.x - from.x, p.z - from.z),
        trainMoved: Math.hypot(t1.x - t0.x, t1.z - t0.z),
        standing: s.standingOnTrain(),
        hits: s.trainHits,
        health: s.health,
      }
    })
    expect(carried.trainMoved, '列車が動いていない').toBeGreaterThan(1)
    expect(carried.moved).toBeCloseTo(carried.trainMoved, 1)
    expect(carried.standing).not.toBeNull()
    // 屋根の上にいるあいだは轢かれない
    expect(carried.hits).toBe(0)
    expect(carried.health).toBe(20)
  })

  test('線路の上にいると、はねられてダメージを受け飛ばされる', async ({ page }) => {
    await start(page)
    await runTrain(page)

    const before = await page.evaluate(() => {
      const s = window.__smooth!
      const t = s.trainInfo(0)!
      // 進行方向 6 m 先の線路の上に立つ（ヨー θ の前方は (-sinθ, -cosθ)）
      s.teleport(t.x - Math.sin(t.yaw) * 6, t.z - Math.cos(t.yaw) * 6)
      return { health: s.health, hits: s.trainHits, p: s.state() }
    })
    expect(before.hits).toBe(0)
    expect(before.health).toBe(20)

    await page.waitForFunction(() => window.__smooth!.trainHits > 0, null, { timeout: 180_000 })
    const hit = await page.evaluate(() => {
      const s = window.__smooth!
      return { health: s.health, hits: s.trainHits, p: s.state() }
    })
    expect(hit.hits).toBe(1)
    expect(hit.health, 'ダメージを受けていない').toBeLessThan(before.health)
    // 打ち上げられて足が地面から離れる
    expect(hit.p.onGround).toBe(false)
    expect(hit.p.y).toBeGreaterThan(before.p.y + 0.2)

    // そのまま線路の外へ飛ばされる
    await page.waitForTimeout(3000)
    const flew = await page.evaluate(
      (b) => {
        const p = window.__smooth!.state()
        return Math.hypot(p.x - b.x, p.z - b.z)
      },
      before.p,
    )
    expect(flew).toBeGreaterThan(0.8)
  })

  test('線路の上の MOB もはねられる', async ({ page }) => {
    await start(page)
    await runTrain(page)

    const spawned = await page.evaluate(() => {
      const s = window.__smooth!
      const t = s.trainInfo(0)!
      const fx = -Math.sin(t.yaw)
      const fz = -Math.cos(t.yaw)
      const rx = Math.cos(t.yaw)
      const rz = -Math.sin(t.yaw)
      // 車体のすぐ前（4 m 先）に横並びで置く。逃げる間もなく轢かれる
      let n = 0
      for (const side of [-0.6, 0, 0.6]) {
        const x = t.x + fx * 4 + rx * side
        const z = t.z + fz * 4 + rz * side
        if (s.spawnMobAt('deer', x, t.y, z)) n++
      }
      // 近くにいると鹿が逃げてしまうので、プレイヤーは遠くへ避難する
      s.placeAt(t.x - fx * 60, t.y + 1, t.z - fz * 60)
      return { n, hide: s.itemCount('hide') }
    })
    expect(spawned.n).toBe(3)

    // 轢かれた鹿は倒れて毛皮を落とす
    await page.waitForFunction((h) => window.__smooth!.itemCount('hide') > h, spawned.hide, {
      timeout: 180_000,
    })
    const after = await page.evaluate(() => {
      const s = window.__smooth!
      return { hide: s.itemCount('hide'), health: s.health }
    })
    expect(after.hide).toBeGreaterThan(spawned.hide)
    // プレイヤーは離れているので無傷
    expect(after.health).toBe(20)
  })
})
