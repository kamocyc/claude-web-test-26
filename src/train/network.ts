import { pointAt, sampleSegment, segmentEnd } from '../track/track'
import type { Segment } from '../track/track'
import { JOIN_EPS } from '../track/TrackGraph'

/**
 * 軌道上の 1 点。区間と、その区間の始点からの弧長で表す。
 * 駅も列車もこの座標系の上で動く。
 */
export interface TrackPoint {
  seg: Segment
  /** 区間の始点からの弧長（0 〜 seg.length）。 */
  s: number
}

/**
 * 経路の 1 区間ぶん。`from > to` なら区間を逆向きに走る。
 * 隣り合う脚は必ず端点を共有するので、繋げると 1 本の連続した線になる。
 */
export interface Leg {
  seg: Segment
  from: number
  to: number
}

/** 経路の長さ（m）。 */
export function pathLength(legs: readonly Leg[]): number {
  let n = 0
  for (const l of legs) n += Math.abs(l.to - l.from)
  return n
}

/**
 * 経路上を `dist` だけ進んだ地点と向き（`[x, y, z, yaw]`）。
 * 逆走している脚では向きを 180° 回して返すので、**列車は必ず進行方向を向く**。
 */
export function pathPoint(legs: readonly Leg[], dist: number, out: number[] = []): number[] {
  let left = Math.max(0, dist)
  for (let i = 0; i < legs.length; i++) {
    const l = legs[i]
    const span = Math.abs(l.to - l.from)
    const last = i === legs.length - 1
    if (left <= span || last) {
      const t = Math.min(left, span)
      const back = l.to < l.from
      pointAt(l.seg, back ? l.from - t : l.from + t, out)
      if (back) out[3] += Math.PI
      return out
    }
    left -= span
  }
  // 脚が 1 本も無いときは原点を返す（呼び出し側が経路なしを弾いている前提）
  out[0] = out[1] = out[2] = out[3] = 0
  return out
}

interface Edge {
  seg: Segment
  /** 反対側のノード。 */
  to: number
}

/**
 * 敷いた線路を「端点のノード」と「区間の辺」からなるグラフとして見る層。
 *
 * {@link TrackGraph} は敷設のための入れ物なので、経路探索の都合は持ち込まない。
 * こちらは**線路（`rail`）だけ**を集めて、駅から駅への道順を出すことに専念する。
 * 線路を敷いたり撤去したりしたら作り直す（`build`）。
 */
export class TrackNetwork {
  /** ノードの座標（3 要素ずつ）。 */
  private readonly nodes: number[] = []
  private readonly adj: Edge[][] = []
  /** 区間 → [始点のノード, 終点のノード]。 */
  private readonly ends = new Map<Segment, [number, number]>()

  get nodeCount(): number {
    return this.nodes.length / 3
  }

  get segmentCount(): number {
    return this.ends.size
  }

  /** 線路だけを集めてグラフを組み直す。 */
  build(segments: Iterable<Segment>): void {
    this.nodes.length = 0
    this.adj.length = 0
    this.ends.clear()
    const e: number[] = []
    for (const seg of segments) {
      if (seg.kind !== 'rail') continue
      segmentEnd(seg, e)
      const a = this.node(seg.x, seg.y, seg.z)
      const b = this.node(e[0], e[1], e[2])
      this.ends.set(seg, [a, b])
      if (a === b) continue
      this.adj[a].push({ seg, to: b })
      this.adj[b].push({ seg, to: a })
    }
  }

  has(seg: Segment): boolean {
    return this.ends.has(seg)
  }

  /** その位置にいちばん近い線路上の点。`maxDist` より遠ければ null。 */
  locate(x: number, y: number, z: number, maxDist = 4): TrackPoint | null {
    let best: TrackPoint | null = null
    let bd = maxDist
    const pts: number[] = []
    for (const seg of this.ends.keys()) {
      sampleSegment(seg, pts)
      const n = pts.length / 4 - 1
      const ds = seg.length / n
      for (let i = 0; i <= n; i++) {
        const d = Math.hypot(pts[i * 4] - x, pts[i * 4 + 1] - y, pts[i * 4 + 2] - z)
        if (d >= bd) continue
        bd = d
        best = { seg, s: ds * i }
      }
    }
    return best
  }

  /**
   * `a` から `b` への道順。繋がっていなければ null。
   *
   * 端点のノードを頂点、区間を辺とするグラフをダイクストラで解く。
   * 出発点と目的地は区間の途中にあるので、**それぞれの区間の両端を出入口として
   * 部分的な弧長を初期コストに乗せる**。同じ区間の上なら探索せずに直接繋ぐ。
   */
  path(a: TrackPoint, b: TrackPoint): Leg[] | null {
    if (!this.ends.has(a.seg) || !this.ends.has(b.seg)) return null
    if (a.seg === b.seg) {
      return Math.abs(b.s - a.s) < 1e-9 ? [] : [{ seg: a.seg, from: a.s, to: b.s }]
    }

    const [a0, a1] = this.ends.get(a.seg) as [number, number]
    const [b0, b1] = this.ends.get(b.seg) as [number, number]

    // 出発点から各ノードまでの距離と、そこへ入ってきた辺
    const n = this.nodeCount
    const dist = new Array<number>(n).fill(Infinity)
    const prevNode = new Array<number>(n).fill(-1)
    const prevSeg = new Array<Segment | null>(n).fill(null)
    const done = new Array<boolean>(n).fill(false)
    dist[a0] = Math.min(dist[a0], a.s)
    dist[a1] = Math.min(dist[a1], a.seg.length - a.s)

    for (;;) {
      let u = -1
      let bd = Infinity
      for (let i = 0; i < n; i++) {
        if (!done[i] && dist[i] < bd) {
          bd = dist[i]
          u = i
        }
      }
      if (u < 0) break
      done[u] = true
      for (const edge of this.adj[u]) {
        const nd = dist[u] + edge.seg.length
        if (nd >= dist[edge.to]) continue
        dist[edge.to] = nd
        prevNode[edge.to] = u
        prevSeg[edge.to] = edge.seg
      }
    }

    // 目的地の区間へは、その両端のどちらから入ってもよい
    const inB0 = dist[b0] + b.s
    const inB1 = dist[b1] + (b.seg.length - b.s)
    if (!Number.isFinite(Math.min(inB0, inB1))) return null
    const enter = inB0 <= inB1 ? b0 : b1

    // ノードの並びを逆にたどる
    const chain: { seg: Segment; node: number }[] = []
    let cur = enter
    while (prevSeg[cur]) {
      chain.push({ seg: prevSeg[cur] as Segment, node: cur })
      cur = prevNode[cur]
    }
    chain.reverse()
    const exit = cur // 出発点の区間から出たノード

    const legs: Leg[] = []
    const push = (seg: Segment, from: number, to: number): void => {
      if (Math.abs(to - from) > 1e-9) legs.push({ seg, from, to })
    }
    push(a.seg, a.s, exit === a0 ? 0 : a.seg.length)
    let at = exit
    for (const link of chain) {
      const [s0] = this.ends.get(link.seg) as [number, number]
      const forward = at === s0
      push(link.seg, forward ? 0 : link.seg.length, forward ? link.seg.length : 0)
      at = link.node
    }
    push(b.seg, at === b0 ? 0 : b.seg.length, b.s)
    return legs
  }

  /** 端点を丸めてノードにまとめる。既にあるノードの近くなら同じ番号を返す。 */
  private node(x: number, y: number, z: number): number {
    for (let i = 0; i < this.nodes.length; i += 3) {
      if (
        Math.hypot(this.nodes[i] - x, this.nodes[i + 1] - y, this.nodes[i + 2] - z) <= JOIN_EPS
      ) {
        return i / 3
      }
    }
    this.nodes.push(x, y, z)
    this.adj.push([])
    return this.nodes.length / 3 - 1
  }
}
