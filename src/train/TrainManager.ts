import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { TrackNetwork } from './network'
import type { Leg, TrackPoint } from './network'
import { STATION_MIN_GAP, Train } from './trains'
import type { Resolve, Station } from './trains'
import { buildStationGeometry, buildTrainMesh, signMaterial } from '../render/trainMeshes'
import { buildMaterial } from '../render/buildMeshes'
import { pointAt } from '../track/track'
import type { Segment } from '../track/track'

/** 駅を置けない理由。 */
export type StationCheck = 'ok' | 'notrack' | 'tooclose'

interface StationGroup {
  mat: number
  mesh: THREE.Mesh | null
}

/**
 * 駅と列車の保持・描画。
 *
 * 経路探索は {@link TrackNetwork}、走らせ方は {@link Train}（どちらも three 非依存）に
 * 任せ、ここは**線路が変わったら網を組み直す**ことと、駅・車体・選択の印を描くことだけを持つ。
 */
export class TrainManager {
  readonly group = new THREE.Group()
  readonly network = new TrackNetwork()
  readonly stations: Station[] = []
  readonly trains: Train[] = []

  private readonly groups = new Map<number, StationGroup>()
  private signMesh: THREE.Mesh | null = null
  private readonly trainMeshes = new Map<Train, THREE.Group>()
  private selection: readonly number[] = []
  private dirty = true

  constructor(scene: THREE.Scene) {
    this.group.name = 'train'
    scene.add(this.group)
  }

  // ------------------------------------------------------------------ 線路の網

  /** 線路を敷いたり撤去したりしたら呼ぶ。駅が線路から外れていたら捨てる。 */
  rebuildNetwork(segments: Iterable<Segment>): void {
    this.network.build(segments)
    let dropped = false
    for (let i = this.stations.length - 1; i >= 0; i--) {
      const s = this.stations[i]
      if (this.network.locate(s.x, s.y, s.z, 2)) continue
      this.removeStation(i)
      dropped = true
    }
    if (dropped) this.dirty = true
  }

  /** 駅から駅への道順（{@link Train} に渡す）。 */
  readonly resolve: Resolve = (from, to): Leg[] | null => {
    const a = this.network.locate(from.x, from.y, from.z, 2)
    const b = this.network.locate(to.x, to.y, to.z, 2)
    if (!a || !b) return null
    return this.network.path(a, b)
  }

  // ------------------------------------------------------------------ 駅

  /** その位置に駅を置けるか。 */
  canPlaceStation(x: number, y: number, z: number): StationCheck {
    if (!this.network.locate(x, y, z, 3)) return 'notrack'
    for (const s of this.stations) {
      if (Math.hypot(s.x - x, s.y - y, s.z - z) < STATION_MIN_GAP) return 'tooclose'
    }
    return 'ok'
  }

  /**
   * 線路の上に駅を置く。狙った点を**線路の中心線へ寄せてから**据えるので、
   * ホームは必ず線路と平行に並ぶ。置けなければ null。
   */
  addStation(x: number, y: number, z: number, mat: number): Station | null {
    const at = this.network.locate(x, y, z, 3)
    if (!at) return null
    const p = pointAt(at.seg, at.s, POINT)
    if (this.canPlaceStation(p[0], p[1], p[2]) !== 'ok') return null
    const station: Station = { x: p[0], y: p[1], z: p[2], mat }
    this.stations.push(station)
    this.dirty = true
    return station
  }

  /** 駅を取り除く。その駅を使う路線も止める。 */
  removeStation(index: number): Station | null {
    const gone = this.stations[index]
    if (!gone) return null
    this.stations.splice(index, 1)
    for (let i = this.trains.length - 1; i >= 0; i--) {
      const t = this.trains[i]
      if (t.route.includes(index)) this.removeTrain(t)
      // 後ろの駅がずれるので、路線が指す番号も詰める
      else for (let k = 0; k < t.route.length; k++) if (t.route[k] > index) t.route[k]--
    }
    this.dirty = true
    return gone
  }

  /** その位置にいちばん近い駅の番号。無ければ -1。 */
  stationAt(x: number, y: number, z: number, range = 6): number {
    let best = -1
    let bd = range
    for (let i = 0; i < this.stations.length; i++) {
      const s = this.stations[i]
      const d = Math.hypot(s.x - x, s.y - y, s.z - z)
      if (d >= bd) continue
      bd = d
      best = i
    }
    return best
  }

  /** 駅のある向き（線路の向き）。線路から外れていれば 0。 */
  stationYaw(station: Station): number {
    const at = this.network.locate(station.x, station.y, station.z, 2)
    if (!at) return 0
    return pointAt(at.seg, at.s, POINT)[3]
  }

  // ------------------------------------------------------------------ 列車

  /** 路線（駅の番号の並び）を決めて 1 編成走らせる。 */
  addTrain(route: readonly number[], mat: number): Train | null {
    if (route.length < 2) return null
    if (route.some((i) => !this.stations[i])) return null
    const t = new Train([...route], mat)
    const first = this.stations[route[0]]
    t.pos[0] = first.x
    t.pos[1] = first.y
    t.pos[2] = first.z
    t.pos[3] = this.stationYaw(first)
    this.trains.push(t)
    const mesh = buildTrainMesh(mat)
    this.trainMeshes.set(t, mesh)
    this.group.add(mesh)
    return t
  }

  removeTrain(train: Train): boolean {
    const i = this.trains.indexOf(train)
    if (i < 0) return false
    this.trains.splice(i, 1)
    const mesh = this.trainMeshes.get(train)
    if (mesh) {
      this.group.remove(mesh)
      for (const c of mesh.children) {
        if (c instanceof THREE.Mesh) c.geometry.dispose()
      }
      this.trainMeshes.delete(train)
    }
    return true
  }

  /** その位置にいちばん近い列車。 */
  nearestTrain(x: number, y: number, z: number, range = 5): Train | null {
    let best: Train | null = null
    let bd = range
    for (const t of this.trains) {
      const d = Math.hypot(t.pos[0] - x, t.pos[1] - y, t.pos[2] - z)
      if (d >= bd) continue
      bd = d
      best = t
    }
    return best
  }

  clear(): void {
    this.stations.length = 0
    for (const t of [...this.trains]) this.removeTrain(t)
    this.selection = []
    this.dirty = true
  }

  // ------------------------------------------------------------------ 毎フレーム

  update(dt: number): void {
    for (const t of this.trains) {
      t.update(dt, this.stations, this.resolve)
      const mesh = this.trainMeshes.get(t)
      if (!mesh) continue
      mesh.position.set(t.pos[0], t.pos[1], t.pos[2])
      mesh.rotation.set(0, t.pos[3], 0)
    }
    if (this.dirty) {
      this.dirty = false
      this.rebuildMeshes()
    }
  }

  /** 路線を組み立てている最中の駅（順番に光る印がつく）。 */
  setSelection(ids: readonly number[]): void {
    this.selection = [...ids]
    this.dirty = true
  }

  // -------------------------------------------------------------------- 保存

  serialize(): { stations: number[]; trains: number[] } {
    const stations: number[] = []
    for (const s of this.stations) stations.push(s.x, s.y, s.z, s.mat)
    const trains: number[] = []
    for (const t of this.trains) {
      trains.push(t.mat, t.route.length, ...t.route)
    }
    return { stations, trains }
  }

  /** 壊れた要素は 1 件ずつ捨てる（`BuildGrid.load` と同じ寛容さ）。 */
  load(stations: unknown, trains: unknown): void {
    this.clear()
    if (Array.isArray(stations)) {
      for (let i = 0; i + 3 < stations.length; i += 4) {
        const v = stations.slice(i, i + 4) as number[]
        if (!v.every((n) => typeof n === 'number' && Number.isFinite(n))) continue
        this.stations.push({ x: v[0], y: v[1], z: v[2], mat: Math.round(v[3]) })
      }
    }
    if (Array.isArray(trains)) {
      let i = 0
      while (i + 1 < trains.length) {
        const mat = trains[i]
        const n = trains[i + 1]
        if (typeof n !== 'number' || !Number.isFinite(n) || n < 2 || i + 2 + n > trains.length) break
        const route = trains.slice(i + 2, i + 2 + n) as number[]
        i += 2 + n
        if (!route.every((k) => typeof k === 'number' && this.stations[k])) continue
        this.addTrain(route, Math.round(mat))
      }
    }
    this.dirty = true
  }

  // -------------------------------------------------------------------- 描画

  private rebuildMeshes(): void {
    const byMat = new Map<number, THREE.BufferGeometry[]>()
    const signs: THREE.BufferGeometry[] = []
    for (const s of this.stations) {
      const geo = buildStationGeometry(s.x, s.y, s.z, this.stationYaw(s))
      const list = byMat.get(s.mat) ?? []
      list.push(geo.body)
      byMat.set(s.mat, list)
      signs.push(geo.sign)
    }
    // 選んだ駅の上に浮かぶ印
    for (const id of this.selection) {
      const s = this.stations[id]
      if (!s) continue
      const box = new THREE.BoxGeometry(0.6, 0.6, 0.6)
      box.translate(s.x, s.y + 4.4, s.z)
      signs.push(box)
    }

    for (const [mat, list] of byMat) {
      const g = this.groupOf(mat)
      g.mesh = this.swap(g.mesh, merge(list), buildMaterial(mat))
    }
    // 駅が全部消えた素材の分も片付ける
    for (const [mat, g] of this.groups) {
      if (byMat.has(mat)) continue
      g.mesh = this.swap(g.mesh, null, buildMaterial(mat))
    }
    this.signMesh = this.swap(this.signMesh, merge(signs), signMaterial)
  }

  private swap(
    old: THREE.Mesh | null,
    geo: THREE.BufferGeometry | null,
    material: THREE.Material,
  ): THREE.Mesh | null {
    if (old) {
      this.group.remove(old)
      old.geometry.dispose()
    }
    if (!geo) return null
    const mesh = new THREE.Mesh(geo, material)
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.frustumCulled = false
    this.group.add(mesh)
    return mesh
  }

  private groupOf(mat: number): StationGroup {
    let g = this.groups.get(mat)
    if (!g) {
      g = { mat, mesh: null }
      this.groups.set(mat, g)
    }
    return g
  }
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (parts.length === 0) return null
  const geo = parts.length === 1 ? parts[0] : mergeGeometries(parts, false)
  if (parts.length > 1) for (const p of parts) p.dispose()
  geo?.computeBoundingSphere()
  return geo
}

const POINT = [0, 0, 0, 0]

export { Train }
export type { Station, TrackPoint, Leg }
