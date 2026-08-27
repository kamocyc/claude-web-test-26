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
    expect(await page.textContent('#toast')).toContain('伐った')

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

/** 中心 c から +x 方向へ 0..6 m の地表の高さ。 */
async function profile(
  page: Page,
  c: { x: number; y: number; z: number },
  span = 14,
): Promise<number[]> {
  return page.evaluate(
    ([p, up]) => {
      const s = window.__smooth!
      const out: number[] = []
      for (let dx = 0; dx <= 6; dx++) {
        let h = -99
        for (let y = p.y + up; y > p.y - 12; y -= 0.2) {
          if (s.density(p.x + dx, y, p.z) > 0) {
            h = y
            break
          }
        }
        out.push(h)
      }
      return out
    },
    [c, span] as const,
  )
}

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
  test('B キーで 球 → 直方体 → ならし → 建築 → 軌道 → 駅 と巡回する', async ({ page }) => {
    await start(page)
    expect((await api(page)).tool).toBe('sphere')
    for (const expected of ['box', 'smooth', 'build', 'track', 'station', 'sphere']) {
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

/** (x, z) の地表の高さ。top から下へ密度を見て、固体になった最初の高さを返す。 */
async function groundY(page: Page, x: number, z: number, top: number): Promise<number> {
  return page.evaluate(
    ([px, pz, ptop]) => {
      const s = window.__smooth!
      for (let y = ptop; y > ptop - 24; y -= 0.05) if (s.density(px, y, pz) > 0) return y
      return ptop - 24
    },
    [x, z, top] as const,
  )
}

test.describe('掘る強さ', () => {
  test('弱いと 1 回では削り切らず、掘り続けると一気に掘ったのと同じ穴になる', async ({ page }) => {
    await start(page)
    const p = await page.evaluate(() => window.__smooth!.state())
    const x = p.x + 6
    const z = p.z + 6
    const top = p.y + 6
    const h0 = await groundY(page, x, z, top)
    const cy = h0 - 0.25

    // 強さ 0.3 m/回 で 1 回。球ぶん（半径 2.5 m）は抜けない
    await page.evaluate(([ax, ay, az]) => window.__smooth!.dig(ax, ay, az, 2.5, 0.3), [
      x,
      cy,
      z,
    ] as const)
    const h1 = await groundY(page, x, z, top)
    expect(h0 - h1, '1 回で削れていない').toBeGreaterThan(0.02)
    expect(h0 - h1, '弱くしたのに一気に削れている').toBeLessThan(1.4)

    // 掛け続けると球の形まで届く
    await page.evaluate(
      ([ax, ay, az]) => {
        for (let i = 0; i < 30; i++) window.__smooth!.dig(ax, ay, az, 2.5, 0.3)
      },
      [x, cy, z] as const,
    )
    const slow = await groundY(page, x, z, top)
    expect(h0 - slow, '掘り続けても穴が深くならない').toBeGreaterThan(1.5)

    // そこから「一気に」で掘っても、もう削るところが残っていない
    await page.evaluate(([ax, ay, az]) => window.__smooth!.dig(ax, ay, az, 2.5), [
      x,
      cy,
      z,
    ] as const)
    const all = await groundY(page, x, z, top)
    expect(Math.abs(all - slow), '徐々に掘った穴が一気に掘った穴と違う').toBeLessThan(0.3)
  })

  test('Shift + ホイールで強さが変わり、HUD に出る', async ({ page }) => {
    await start(page)
    await page.evaluate(() => window.__smooth!.setTool('sphere'))
    await page.waitForTimeout(200)
    expect(await page.textContent('#brush')).toMatch(/強さ \d+\.\d m\/回/)

    const before = await page.evaluate(() => window.__smooth!.digDepth())
    await page.keyboard.down('Shift')
    await page.mouse.wheel(0, -100)
    await page.waitForFunction((b) => window.__smooth!.digDepth() > b, before, { timeout: 10_000 })
    await page.keyboard.up('Shift')

    // Shift を離せばホイールはブラシの大きさに戻る（強さは動かない）
    const held = await page.evaluate(() => window.__smooth!.digDepth())
    await page.mouse.wheel(0, -100)
    await page.waitForTimeout(400)
    expect(await page.evaluate(() => window.__smooth!.digDepth())).toBe(held)
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

test.describe('昼夜', () => {
  test('T キーで 朝 → 昼 → 夕 → 夜 → 自動 と切り替わる', async ({ page }) => {
    await start(page)
    expect((await api(page)).timeFrozen).toBe(false)

    for (const hour of [7, 12, 18, 0]) {
      await page.keyboard.press('KeyT')
      await page.waitForFunction(
        (h) => window.__smooth?.timeFrozen === true && Math.abs(window.__smooth.timeOfDay - h / 24) < 1e-6,
        hour,
        { timeout: 10_000 },
      )
    }
    await page.keyboard.press('KeyT')
    await page.waitForFunction(() => window.__smooth?.timeFrozen === false, null, { timeout: 10_000 })
  })

  test('固定した時刻は進まない', async ({ page }) => {
    await start(page)
    await page.evaluate(() => window.__smooth!.setTime(0))
    await page.waitForTimeout(2500)
    expect((await api(page)).timeOfDay).toBe(0)
  })
})

test.describe('土砂', () => {
  test('盛った土はブラシの外まで崩れて広がる', async ({ page }) => {
    await start(page)
    await lookDown(page)
    // 土（スロット 2）をたっぷり与えて選ぶ
    await page.evaluate(() => window.__smooth!.giveMaterial(1, 5000))
    await page.keyboard.press('Digit2')
    await page.waitForTimeout(400)

    const c = await page.evaluate(() => window.__smooth!.state())
    const before = await profile(page, c)
    await click(page, 2, 900)
    const after = await profile(page, c)

    // ブラシ半径の上限は 3.5 m。その外側が持ち上がっていれば「崩れて広がった」
    expect(after[5], `4〜5m 先が持ち上がっていない before=${before[5]} after=${after[5]}`).toBeGreaterThan(
      before[5] + 0.15,
    )
    // 元の地形は削れない
    for (let i = 0; i < before.length; i++) {
      expect(after[i], `${i}m の地面が下がった`).toBeGreaterThan(before[i] - 0.25)
    }
  })
})

test.describe('崩落', () => {
  test('積んだ山を掘ると、ブラシの外まで崩れてくる', async ({ page }) => {
    await start(page)
    await lookDown(page)
    await page.evaluate(() => {
      window.__smooth!.giveMaterial(1, 20000)
      window.__smooth!.setBrushRadius(3.5)
    })
    await page.keyboard.press('Digit2') // 土
    await page.waitForTimeout(400)

    // 飛行して真下に土を積む
    await page.keyboard.press('Space')
    await page.keyboard.press('Space')
    await page.waitForTimeout(400)
    const c = await page.evaluate(() => window.__smooth!.state())
    for (let i = 0; i < 5; i++) await click(page, 2, 500)

    const before = await profile(page, c)
    expect(before[0], '山が積み上がっていない').toBeGreaterThan(c.y - 6)

    // 山の天辺を掘る。ブラシ半径は 2.5 m なので 4〜5 m 先には届かない
    await page.evaluate(() => window.__smooth!.setBrushRadius(2.5))
    await click(page, 0, 600)
    const after = await profile(page, c)

    expect(
      after[4],
      `ブラシの外が崩れてこない before=${before[4]} after=${after[4]}`,
    ).toBeLessThan(before[4] - 0.15)
  })
})

test.describe('木の足場', () => {
  test('木の下を掘ると木は消え、穴の底へ沈まない', async ({ page }) => {
    test.setTimeout(180_000)
    await start(page)

    // 周りのチャンクが出そろってから木を選ぶ（あとから近い木が現れると測り違える）
    const tree = await page.evaluate(async () => {
      const s = window.__smooth!
      const origin = s.state()
      for (let i = 1; i < 30; i++) {
        s.teleport(origin.x + Math.cos(i * 1.7) * i * 27, origin.z + Math.sin(i * 1.7) * i * 27)
        for (let t = 0; t < 30 && !s.state().onGround; t++) {
          await new Promise((r) => setTimeout(r, 60))
        }
        for (let t = 0; t < 120 && s.loaded < s.desired; t++) {
          await new Promise((r) => setTimeout(r, 250))
        }
        await new Promise((r) => setTimeout(r, 1200))
        const t0 = s.nearestTree()
        const p = s.state()
        if (!t0 || p.inWater) continue
        const dist = Math.hypot(t0.x - p.x, t0.z - p.z)
        if (dist < 4 || dist > 11) continue
        return t0
      }
      return null
    })
    expect(tree, '手ごろな木が見つからなかった').not.toBeNull()

    /** 指定座標にいちばん近い木の幹。 */
    const nearTree = (x: number, z: number) =>
      page.evaluate(([tx, tz]) => {
        const c = window.__smooth!.treeColliders()
        let best: { y: number; d: number } | null = null
        for (let i = 0; i < c.length; i += 5) {
          const d = Math.hypot(c[i] - tx, c[i + 2] - tz)
          if (!best || d < best.d) best = { y: c[i + 1], d }
        }
        return best
      }, [x, z])

    // 5m 離れた所を掘っても木は動かない
    await page.evaluate((t) => window.__smooth!.dig(t!.x + 5, t!.y, t!.z + 5, 2.5), tree)
    await page.waitForTimeout(2500)
    const beside = await nearTree(tree!.x, tree!.z)
    expect(beside!.d, '横を掘っただけで木が動いた').toBeLessThan(0.2)
    expect(Math.abs(beside!.y - tree!.y), '横を掘っただけで木の高さが変わった').toBeLessThan(0.2)

    // 真下を掘る。木は消えるのが正しく、穴の底に沈むのは間違い
    await page.evaluate((t) => window.__smooth!.dig(t!.x, t!.y - 1.6, t!.z, 3.2), tree)
    await page.waitForTimeout(3000)
    const after = await nearTree(tree!.x, tree!.z)
    if (after && after.d < 2) {
      expect(
        after.y,
        `木が穴の底へ沈んだ (${tree!.y.toFixed(1)}m → ${after.y.toFixed(1)}m)`,
      ).toBeGreaterThan(tree!.y - 0.5)
    }
  })
})
