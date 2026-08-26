import { describe, expect, it } from 'vitest'
import type { Box3, BufferGeometry } from 'three'
import { buildTrackGeometry } from '../src/render/trackMeshes'
import { DECK_T, GRADE_TOL } from '../src/track/track'
import type { Segment } from '../src/track/track'
import { MAT_ROCK } from '../src/world/constants'

function seg(kind: 'rail' | 'road' = 'rail'): Segment {
  return { kind, x: 0, y: 10, z: 0, yaw: 0, curve: 0, length: 12, rise: 0, mat: MAT_ROCK }
}

function bounds(geo: BufferGeometry): Box3 {
  geo.computeBoundingBox()
  // 頂点があれば必ず入る
  return geo.boundingBox as Box3
}

describe('軌道のジオメトリ', () => {
  it('地面が低いところには橋脚が伸びる', () => {
    const flat = buildTrackGeometry(seg(), () => 10 - DECK_T)
    const raised = buildTrackGeometry(seg(), () => 2)
    // 地面が路盤のすぐ下にあれば橋脚は要らない
    expect(bounds(flat.body).min.y).toBeGreaterThan(10 - DECK_T - 0.1)
    // 8 m 下に地面があれば、そこまで柱が下りる
    expect(bounds(raised.body).min.y).toBeLessThan(2)
    expect(bounds(raised.body).min.y).toBeGreaterThan(2 - 1.5)
  })

  it('切り盛りで埋まるくらいの差なら橋脚は立てない', () => {
    const deck = 10 - DECK_T
    // 敷くと盛られて埋まる差 → 橋脚なし（ゴーストと置いたあとの見た目が一致する）
    const shallow = buildTrackGeometry(seg(), () => deck - GRADE_TOL + 0.3)
    expect(bounds(shallow.body).min.y).toBeGreaterThan(deck - 0.1)
    // 盛らずに渡す深さ → 橋脚あり
    const deep = buildTrackGeometry(seg(), () => deck - GRADE_TOL - 0.3)
    expect(bounds(deep.body).min.y).toBeLessThan(deck - GRADE_TOL)
  })

  it('見た目の天面が歩ける面（中心線の高さ）と一致する', () => {
    const g = buildTrackGeometry(seg(), () => 10 - DECK_T)
    // レールと枕木は路盤の上に少しだけ出る
    expect(bounds(g.body).max.y).toBeLessThan(10.1)
    expect(bounds(g.accent!).max.y).toBeLessThan(10.2)
    expect(bounds(g.accent!).max.y).toBeGreaterThan(10)
  })

  it('線路にはレール、道路には中央線がつく', () => {
    expect(buildTrackGeometry(seg('rail'), () => 9).accent).not.toBeNull()
    expect(buildTrackGeometry(seg('road'), () => 9).accent).not.toBeNull()
  })

  it('幅は種類ごとの敷き幅に収まる', () => {
    const rail = bounds(buildTrackGeometry(seg('rail'), () => 9.65).body)
    const road = bounds(buildTrackGeometry(seg('road'), () => 9.65).body)
    // 底面を少し広げているぶんだけ外へ出る
    expect(rail.max.x - rail.min.x).toBeLessThan(3 + 1.2)
    expect(road.max.x - road.min.x).toBeGreaterThan(rail.max.x - rail.min.x)
  })
})
