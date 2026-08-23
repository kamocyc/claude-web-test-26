import { describe, expect, it } from 'vitest'
import { applyBrush, applyPileBrush, settleLoose, sphereBrush } from '../src/world/edits'
import { MAT_DIRT, MAT_NONE, MAT_ROCK, MAT_SAND } from '../src/world/constants'

const DIRT_STEP = Math.tan((38 * Math.PI) / 180)
const SAND_STEP = Math.tan((32 * Math.PI) / 180)
/** edits.ts の NATURAL_SKIN と揃えること。 */
const NATURAL_SKIN = 2.5

/**
 * @param natural 自然地形の素材。MAT_NONE なら自然地形は崩れない。
 */
function makeField(
  initial: (x: number, y: number, z: number) => number,
  natural: number = MAT_NONE,
) {
  const store = new Map<string, { d: number; mat: number }>()
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`
  const readD = (x: number, y: number, z: number) => store.get(key(x, y, z))?.d ?? initial(x, y, z)
  const readMat = (x: number, y: number, z: number) => store.get(key(x, y, z))?.mat ?? MAT_NONE
  const write = (x: number, y: number, z: number, d: number, mat: number) =>
    store.set(key(x, y, z), { d, mat })
  const readNatural = () => natural
  return {
    store,
    readD,
    readMat,
    write,
    readNatural,
    /** 粒状の素材を盛る（World.applyBrush の place と同じ経路）。 */
    pile: (x: number, y: number, z: number, r: number, mat = MAT_DIRT) =>
      applyPileBrush(x, y, z, sphereBrush(r), mat, readD, readMat, readNatural, write, -200, 200),
    /** 掘ってから崩す（World.applyBrush の dig と同じ経路）。 */
    dig: (x: number, y: number, z: number, r: number) => {
      applyBrush(x, y, z, sphereBrush(r), 'dig', 0, readD, readMat, write, -200, 200)
      return settleLoose(x, y, z, r, r, r, readD, readMat, readNatural, write, -200, 200)
    },
    settle: (x: number, y: number, z: number, r: number) =>
      settleLoose(x, y, z, r, r, r, readD, readMat, readNatural, write, -200, 200),
  }
}

/** 柱 (x,z) の地表の高さ。上から見て最初に固体になるところを線形補間する。 */
function surfaceHeight(
  readD: (x: number, y: number, z: number) => number,
  x: number,
  z: number,
  top = 60,
  bottom = -60,
): number {
  let prev = readD(x, top, z)
  for (let y = top - 1; y >= bottom; y--) {
    const cur = readD(x, y, z)
    if (cur > 0) return y + cur / (cur - prev)
    prev = cur
  }
  return bottom
}

function heights(
  readD: (x: number, y: number, z: number) => number,
  cx: number,
  cz: number,
  range: number,
): Map<string, number> {
  const m = new Map<string, number>()
  for (let z = cz - range; z <= cz + range; z++) {
    for (let x = cx - range; x <= cx + range; x++) m.set(`${x},${z}`, surfaceHeight(readD, x, z))
  }
  return m
}

/** 隣り合う柱の高さ差の最大値。 */
function worstSlope(h: Map<string, number>): number {
  let worst = 0
  for (const [k, v] of h) {
    const [x, z] = k.split(',').map(Number)
    for (const [dx, dz] of [
      [1, 0],
      [0, 1],
    ]) {
      const n = h.get(`${x + dx},${z + dz}`)
      if (n === undefined) continue
      worst = Math.max(worst, Math.abs(v - n))
    }
  }
  return worst
}

/** 地面 y = 0 の平らな場。 */
const flat = (_x: number, y: number) => -y

describe('土砂を盛る', () => {
  it('安息角より急な斜面を作らない', () => {
    const f = makeField(flat)
    f.pile(0, 0.4, 0, 2.5)

    const h = heights(f.readD, 0, 0, 9)
    expect(h.get('0,0')!, '中心が盛り上がっていない').toBeGreaterThan(0.5)
    expect(worstSlope(h)).toBeLessThan(DIRT_STEP * 1.1)
  })

  it('球ブラシのまま固まらず、安息角ちょうどの円錐になる', () => {
    const f = makeField(flat)
    f.pile(0, 0.4, 0, 2.5)
    const h = heights(f.readD, 0, 0, 9)
    expect(h.get('3,0')!, '球の外に広がっていない').toBeGreaterThan(0.3)

    let atRepose = 0
    for (let x = -5; x < 5; x++) {
      if (Math.abs(Math.abs(h.get(`${x},0`)! - h.get(`${x + 1},0`)!) - DIRT_STEP) < 0.02) atRepose++
    }
    expect(atRepose, '安息角ちょうどの斜面が現れない').toBeGreaterThanOrEqual(4)
  })

  it('20 m 上に置いても地面まで落ちる', () => {
    const f = makeField(flat)
    f.pile(0, 20, 0, 2)

    for (let y = 4; y <= 23; y++) {
      for (let z = -3; z <= 3; z++) {
        for (let x = -3; x <= 3; x++) {
          expect(f.readD(x, y, z), `(${x},${y},${z}) が空中に残っている`).toBeLessThanOrEqual(0)
        }
      }
    }
    expect(surfaceHeight(f.readD, 0, 0), '地面に積もっていない').toBeGreaterThan(0.4)
  })

  it('元の地形は削らない', () => {
    const field = (x: number, y: number, z: number) => x * 0.35 + Math.sin(z * 0.4) * 1.2 - y
    const f = makeField(field)
    const before = heights(f.readD, 0, 0, 9)
    f.pile(0, field(0, 0, 0) + 0.4, 0, 2.5)
    const after = heights(f.readD, 0, 0, 9)
    for (const [k, v] of before) {
      expect(after.get(k)!, `${k} の地面が下がった`).toBeGreaterThan(v - 1e-3)
    }
  })

  it('積み増すと高くなるが、傾斜は保たれる', () => {
    const f = makeField(flat)
    let last = 0
    for (let i = 0; i < 6; i++) {
      f.pile(0, surfaceHeight(f.readD, 0, 0) + 0.4, 0, 2.5)
      const h = surfaceHeight(f.readD, 0, 0)
      expect(h, `${i} 回目で高くならなかった`).toBeGreaterThan(last)
      last = h
    }
    expect(worstSlope(heights(f.readD, 0, 0, 12))).toBeLessThan(DIRT_STEP * 1.1)
  })

  it('置いた素材が記録される', () => {
    const f = makeField(flat)
    const b = f.pile(0, 0.4, 0, 2.5)
    expect(b.solidified, '固体になった格子点が無い').toBeGreaterThan(0)
    let dirt = 0
    for (const v of f.store.values()) if (v.d > 0 && v.mat === MAT_DIRT) dirt++
    expect(dirt).toBeGreaterThan(0)
  })

  it('落ち着いたあとは 1 件も書き込まない（冪等）', () => {
    const f = makeField(flat)
    f.pile(0, 0.4, 0, 2.5)
    expect(f.settle(0, 0.4, 0, 2.5).touched, '平衡状態なのに書き込んでいる').toBe(0)
  })
})

describe('積んだ山を掘る', () => {
  /** 中心に高さ 5〜6 m ほどの土の山を作る。 */
  function buildPile() {
    const f = makeField(flat)
    for (let i = 0; i < 8; i++) f.pile(0, surfaceHeight(f.readD, 0, 0) + 0.4, 0, 2.5)
    return f
  }

  it('麓を掘ると崩れてくる', () => {
    const f = buildPile()
    const peakBefore = surfaceHeight(f.readD, 0, 0)
    expect(peakBefore, '山ができていない').toBeGreaterThan(3)

    // +x 側の麓を掘る
    f.dig(5, 0.5, 0, 2.5)

    const peakAfter = surfaceHeight(f.readD, 0, 0)
    expect(peakAfter, `山が崩れてこない ${peakBefore} → ${peakAfter}`).toBeLessThan(peakBefore - 0.2)
    // 崩れたあとも安息角に収まっている
    expect(worstSlope(heights(f.readD, 0, 0, 12))).toBeLessThan(DIRT_STEP * 1.15)
  })

  it('掘った穴に土が流れ込む', () => {
    const f = buildPile()
    // 掘るだけで崩さない場と、掘って崩す場を比べる
    const bare = makeField(flat)
    for (let i = 0; i < 8; i++) bare.pile(0, surfaceHeight(bare.readD, 0, 0) + 0.4, 0, 2.5)
    applyBrush(5, 0.5, 0, sphereBrush(2.5), 'dig', 0, bare.readD, bare.readMat, bare.write, -200, 200)

    f.dig(5, 0.5, 0, 2.5)
    expect(
      surfaceHeight(f.readD, 5, 0),
      '掘った穴が埋まっていない',
    ).toBeGreaterThan(surfaceHeight(bare.readD, 5, 0) + 0.2)
  })

  it('岩は崩れないし落ちない', () => {
    const f = makeField(flat)
    // 空中に岩を置く
    applyBrush(0, 8, 0, sphereBrush(2), 'place', MAT_ROCK, f.readD, f.readMat, f.write, -200, 200)
    const b = f.settle(0, 8, 0, 2)
    expect(b.touched, '岩が動いた').toBe(0)
    expect(f.readD(0, 8, 0), '岩が落ちた').toBeGreaterThan(0)
  })
})

describe('自然地形を掘る', () => {
  it('砂地は掘った縁が安息角まで崩れる', () => {
    const f = makeField(flat, MAT_SAND)

    // 掘っただけの場（崩さない）と比べる
    const bare = makeField(flat, MAT_SAND)
    applyBrush(0, -1, 0, sphereBrush(2.5), 'dig', 0, bare.readD, bare.readMat, bare.write, -200, 200)
    expect(worstSlope(heights(bare.readD, 0, 0, 10)), '掘っただけなら急な縁が残る').toBeGreaterThan(
      SAND_STEP * 1.5,
    )

    const b = f.dig(0, -1, 0, 2.5)
    expect(b.touched, '自然の砂地が崩れていない').toBeGreaterThan(0)
    expect(worstSlope(heights(f.readD, 0, 0, 10)), '崩れていない').toBeLessThan(SAND_STEP * 1.15)
  })

  it('崖の足元を掘ると上が崩れるが、動くのは表土だけ', () => {
    // x < 0 が高さ 10 m の砂の崖、x > 0 は平地
    const cliff = (x: number, y: number) => (x < 0 ? 10 - y : -y)
    const f = makeField(cliff, MAT_SAND)
    f.dig(1, 0.5, 0, 2)

    // 崖っぷちの柱が崩れて下がる
    const edge = surfaceHeight(f.readD, -1, 0)
    expect(edge, '崖が崩れてこない').toBeLessThan(9.5)
    // ただし表土ぶんだけ。崖ぜんぶが安息角まで寝てしまわない
    expect(10 - edge, `崖が根こそぎ崩れている（${(10 - edge).toFixed(2)} m 下がった）`).toBeLessThan(
      NATURAL_SKIN + 1.8,
    )
    // 崩れた先は安息角に収まっている
    expect(surfaceHeight(f.readD, 1, 0), '足元に積もっていない').toBeGreaterThan(-1.5)
  })

  it('草地や岩場は崩れない', () => {
    const f = makeField(flat) // natural = MAT_NONE
    const before = heights(f.readD, 0, 0, 8)
    const b = f.dig(0, -1, 0, 2.5)
    expect(b.touched, '自然の草地が崩れた').toBe(0)
    const after = heights(f.readD, 0, 0, 8)
    // 掘った穴の外は 1 mm も動かない
    for (const [k, v] of before) {
      const [x, z] = k.split(',').map(Number)
      if (Math.hypot(x, z) < 4) continue
      expect(after.get(k)!, `${k} が動いた`).toBeCloseTo(v, 6)
    }
  })
})
