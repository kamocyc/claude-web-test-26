import * as THREE from 'three'
import { TrackGraph, createTrackHit } from './TrackGraph'
import type {
  GroundFn,
  PlanRequest,
  SolidFn,
  Terrain,
  TrackCheck,
  TrackEnd,
  TrackHit,
  TrackPlan,
} from './TrackGraph'
import { TRACK_INFO, segmentCost } from './track'
import type { Segment, TrackKind } from './track'
import { buildTrackGeometry, laneMaterial, mergeTrackGeometries, railMaterial } from '../render/trackMeshes'
import { buildMaterial, ghostMaterial, snapMarkerMaterial } from '../render/buildMeshes'
import type { Collider } from '../world/collision'

interface TrackGroup {
  kind: TrackKind
  mat: number
  segs: Segment[]
  body: THREE.Mesh | null
  accent: THREE.Mesh | null
  dirty: boolean
}

/**
 * 敷いた軌道の描画と保持。
 *
 * 判定は {@link TrackGraph}（three 非依存）に任せ、ここは
 * 「種類 × 素材」ごとのメッシュと、敷設予定のゴーストだけを持つ。
 * 区間ごとに形が違うのでインスタンシングは使えず、
 * {@link BuildManager} の「変更のあったグループだけ作り直す」やり方だけを踏襲する。
 */
export class TrackManager {
  readonly group = new THREE.Group()
  readonly graph = new TrackGraph()

  private readonly groups = new Map<string, TrackGroup>()
  private readonly ghost = new THREE.Mesh()
  /** どの端点から伸びているかを見せる印。これが無いと接続先が読めない。 */
  private readonly marker: THREE.Mesh
  private readonly hit = createTrackHit()
  private ghostKey = ''

  constructor(scene: THREE.Scene) {
    this.group.name = 'track'
    scene.add(this.group)
    this.ghost.visible = false
    this.ghost.frustumCulled = false
    scene.add(this.ghost)
    this.marker = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), snapMarkerMaterial)
    this.marker.visible = false
    scene.add(this.marker)
  }

  get count(): number {
    return this.graph.count
  }

  get colliderCount(): number {
    return this.graph.colliderCount
  }

  // ------------------------------------------------------------------ 敷く／撤去

  plan(req: PlanRequest): TrackPlan {
    return this.graph.plan(req)
  }

  /** 見積もりをそのまま敷く。重なり判定から外す相手も見積もりと揃える。 */
  placePlan(plan: TrackPlan): boolean {
    return this.place(plan.seg, [plan.from?.seg ?? null, plan.joinTo?.seg ?? null])
  }

  place(seg: Segment, ignore: readonly (Segment | null)[] = []): boolean {
    if (!this.graph.place(seg, ignore)) return false
    const g = this.groupOf(seg.kind, seg.mat)
    g.segs.push(seg)
    g.dirty = true
    return true
  }

  remove(seg: Segment): Segment | null {
    const gone = this.graph.remove(seg)
    if (!gone) return null
    const g = this.groupOf(gone.kind, gone.mat)
    const i = g.segs.indexOf(gone)
    if (i >= 0) g.segs.splice(i, 1)
    g.dirty = true
    return gone
  }

  clear(): void {
    this.graph.clear()
    for (const g of this.groups.values()) {
      g.segs.length = 0
      g.dirty = true
    }
  }

  has(seg: Segment): boolean {
    return this.graph.has(seg)
  }

  cost(seg: Segment): number {
    return segmentCost(seg)
  }

  // ------------------------------------------------------------------ 参照

  collectColliders(
    x: number,
    z: number,
    r: number,
    out: Collider[],
    y0?: number,
    y1?: number,
  ): Collider[] {
    return this.graph.collectColliders(x, z, r, out, y0, y1)
  }

  raycast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDist: number,
  ): TrackHit | null {
    return this.graph.raycast(ox, oy, oz, dx, dy, dz, maxDist, this.hit)
  }

  nearestEnd(
    x: number,
    y: number,
    z: number,
    range: number,
    kind: TrackKind | null = null,
  ): TrackEnd | null {
    return this.graph.nearestEnd(x, y, z, range, kind)
  }

  nearest(x: number, y: number, z: number, range: number): Segment | null {
    return this.graph.nearest(x, y, z, range)
  }

  // ------------------------------------------------------------------ 表示

  /** 変更のあった「種類 × 素材」だけ作り直す。何も変わっていなければ何もしない。 */
  rebuild(ground: GroundFn): void {
    for (const g of this.groups.values()) {
      if (!g.dirty) continue
      g.dirty = false
      const bodies: THREE.BufferGeometry[] = []
      const accents: THREE.BufferGeometry[] = []
      for (const s of g.segs) {
        const geo = buildTrackGeometry(s, ground)
        bodies.push(geo.body)
        if (geo.accent) accents.push(geo.accent)
      }
      g.body = this.swap(g.body, mergeTrackGeometries(bodies), buildMaterial(g.mat))
      g.accent = this.swap(
        g.accent,
        mergeTrackGeometries(accents),
        g.kind === 'rail' ? railMaterial : laneMaterial,
      )
    }
  }

  /** 敷設予定の半透明表示と、伸びる元の端点の印。`plan` が null なら隠す。 */
  setGhost(plan: TrackPlan | null, ok: boolean, ground: GroundFn): void {
    if (!plan) {
      this.ghost.visible = false
      this.marker.visible = false
      this.ghostKey = ''
      return
    }
    const s = plan.seg
    const key = [s.kind, s.x, s.y, s.z, s.yaw, s.curve, s.length, s.rise].join(',')
    if (key !== this.ghostKey) {
      this.ghostKey = key
      const geo = buildTrackGeometry(s, ground)
      const merged = mergeTrackGeometries(geo.accent ? [geo.body, geo.accent] : [geo.body])
      this.ghost.geometry.dispose()
      this.ghost.geometry = merged ?? new THREE.BufferGeometry()
    }
    this.ghost.material = ghostMaterial(ok)
    this.ghost.visible = true
    const from = plan.from
    this.marker.visible = from !== null
    if (from) this.marker.position.set(from.x, from.y + 0.3, from.z)
  }

  // -------------------------------------------------------------------- 保存

  serialize(): number[] {
    return this.graph.serialize()
  }

  load(data: unknown): void {
    this.graph.load(data)
    for (const g of this.groups.values()) {
      g.segs.length = 0
      g.dirty = true
    }
    for (const s of this.graph.segments()) {
      const g = this.groupOf(s.kind, s.mat)
      g.segs.push(s)
      g.dirty = true
    }
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

  private groupOf(kind: TrackKind, mat: number): TrackGroup {
    const key = `${kind}|${mat}`
    let g = this.groups.get(key)
    if (!g) {
      g = { kind, mat, segs: [], body: null, accent: null, dirty: true }
      this.groups.set(key, g)
    }
    return g
  }
}

export { TRACK_INFO }
export type {
  Segment,
  TrackKind,
  TrackCheck,
  TrackEnd,
  TrackHit,
  TrackPlan,
  GroundFn,
  SolidFn,
  Terrain,
}
