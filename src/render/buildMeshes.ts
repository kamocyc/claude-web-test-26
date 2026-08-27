import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { boxGeometry, quadFacing, triFacing } from './geoUtil'
import { MATERIAL_INFO, MAT_GLASS } from '../world/constants'
import type { Box } from '../world/collision'
import {
  BUILD_CELL,
  FENCE_H,
  PANEL_T,
  WINDOW_HALF,
  accentStart,
  localBoxes,
} from '../build/pieces'
import type { PieceKind } from '../build/pieces'

const geoCache = new Map<PieceKind, THREE.BufferGeometry>()
const matCache = new Map<number, THREE.Material>()

/** 窓のガラス面。素材が何であれガラスとして描く。 */
const paneMaterial = new THREE.MeshStandardMaterial({
  color: 0x9fd6e8,
  roughness: 0.08,
  metalness: 0,
  transparent: true,
  opacity: 0.34,
  depthWrite: false,
})

/** ベッドの布。 */
const linenMaterial = new THREE.MeshStandardMaterial({ color: 0xd8cfc0, roughness: 0.95 })

/** チェストの鉄帯。 */
const ironMaterial = new THREE.MeshStandardMaterial({
  color: 0x5b6068,
  roughness: 0.5,
  metalness: 0.55,
})

/**
 * 差し色のマテリアル。{@link accentStart} 以降の箱をこれで描く。
 * どの素材で建てても布は布、鉄は鉄に見せたいので、素材 ID には依らない。
 */
function accentMaterial(kind: PieceKind): THREE.Material | null {
  if (kind === 'window') return paneMaterial
  if (kind === 'bed') return linenMaterial
  if (kind === 'chest') return ironMaterial
  return null
}

/**
 * パーツ種類ごとのジオメトリ。基準点（{@link pieceAnchor}）を原点とする局所座標で作る。
 *
 * **壁・戸口・床・階段・ブロックは当たり判定の箱 {@link localBoxes} からそのまま作る**ので、
 * 見た目と当たり判定がずれることが原理的に起きない。
 * 窓は枠とガラス面に分かれ、屋根だけは滑らかな斜面を描く（判定は階段状の近似）。
 */
export function pieceGeometry(kind: PieceKind): THREE.BufferGeometry {
  const hit = geoCache.get(kind)
  if (hit) return hit
  const geo =
    kind === 'window'
      ? windowGeometry()
      : kind === 'roof'
        ? roofGeometry()
        : kind === 'gable'
          ? gableGeometry()
          : kind === 'fence'
            ? fenceGeometry()
            : fromBoxes(kind)
  geo.computeBoundingSphere()
  geoCache.set(kind, geo)
  return geo
}

/**
 * パーツに使うマテリアル。窓・ベッド・チェストのように差し色を持つパーツだけ
 * `[主素材, 差し色]` の 2 つを返す（ジオメトリのグループと同じ並び）。
 */
export function pieceMaterials(kind: PieceKind, mat: number): THREE.Material | THREE.Material[] {
  const accent = accentMaterial(kind)
  return accent ? [buildMaterial(mat), accent] : buildMaterial(mat)
}

/** 素材 ID ごとのマテリアル。色は地形と同じ {@link MATERIAL_INFO} から取る。 */
export function buildMaterial(mat: number): THREE.Material {
  const hit = matCache.get(mat)
  if (hit) return hit
  const info = MATERIAL_INFO[mat] ?? MATERIAL_INFO[0]
  const m =
    mat === MAT_GLASS
      ? new THREE.MeshStandardMaterial({
          color: info.color,
          roughness: 0.08,
          transparent: true,
          opacity: 0.42,
        })
      : new THREE.MeshStandardMaterial({ color: info.color, roughness: 0.86, metalness: 0 })
  matCache.set(mat, m)
  return m
}

/** ゴースト（設置予定の半透明表示）。置ける＝緑、置けない＝赤。 */
export function ghostMaterial(ok: boolean): THREE.Material {
  return ok ? GHOST_OK : GHOST_NG
}

/** 吸着した接続点の印。 */
export const snapMarkerMaterial = new THREE.MeshBasicMaterial({
  color: 0xffd479,
  transparent: true,
  opacity: 0.85,
  depthWrite: false,
  depthTest: false,
  fog: false,
})

const GHOST_OK = new THREE.MeshBasicMaterial({
  color: 0x7fe08a,
  transparent: true,
  opacity: 0.34,
  depthWrite: false,
  side: THREE.DoubleSide,
  fog: false,
})

const GHOST_NG = new THREE.MeshBasicMaterial({
  color: 0xe06a5a,
  transparent: true,
  opacity: 0.3,
  depthWrite: false,
  side: THREE.DoubleSide,
  fog: false,
})

/**
 * 当たり判定の箱からそのままジオメトリを作る。
 * {@link accentStart} 以降の箱は差し色のグループ 1 にまとめる。
 */
function fromBoxes(kind: PieceKind): THREE.BufferGeometry {
  const boxes = localBoxes(kind)
  const split = accentStart(kind)
  if (split >= boxes.length) return mergeBoxes(boxes)
  const main = mergeBoxes(boxes.slice(0, split))
  const accent = mergeBoxes(boxes.slice(split))
  const geo = mergeGeometries([main, accent], true)
  main.dispose()
  accent.dispose()
  return geo
}

function mergeBoxes(boxes: readonly Box[]): THREE.BufferGeometry {
  const parts = boxes.map((b) => boxGeometry(b))
  if (parts.length === 1) return parts[0]
  const geo = mergeGeometries(parts, false)
  for (const p of parts) p.dispose()
  return geo
}

/**
 * 屋根の妻を塞ぐ直角三角形の壁。厚みは {@link PANEL_T}、+z 側が棟で高さ 1 マス。
 * 当たり判定は階段状の近似だが、こちらは三角形そのものを張る。
 */
function gableGeometry(): THREE.BufferGeometry {
  const h = BUILD_CELL / 2
  const C = BUILD_CELL
  const t = PANEL_T / 2
  const v: number[] = []

  // 面（±x）の三角形
  triFacing(v, -1, 0, 0, -t, 0, -h, -t, 0, h, -t, C, h)
  triFacing(v, 1, 0, 0, t, 0, -h, t, 0, h, t, C, h)
  // 底辺・棟側の垂直面・斜面
  quadFacing(v, 0, -1, 0, -t, 0, -h, t, 0, -h, t, 0, h, -t, 0, h)
  quadFacing(v, 0, 0, 1, -t, 0, h, t, 0, h, t, C, h, -t, C, h)
  quadFacing(v, -1, 1, 0, -t, 0, -h, -t, C, h, t, C, h, t, 0, -h)

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(v), 3))
  geo.computeVertexNormals()
  return geo
}

/**
 * 手すり。**当たり判定は 1 枚の薄い板**（{@link localBoxes}）だが、
 * 見た目は柱と横桟にする。桟の隙間に体が挟まらないようにするための、意図した食い違い。
 */
function fenceGeometry(): THREE.BufferGeometry {
  const h = BUILD_CELL / 2
  const t = 0.07
  const boxes = [
    // 上の桟と中の桟
    { minX: -t, minY: FENCE_H - 0.16, minZ: -h, maxX: t, maxY: FENCE_H, maxZ: h },
    { minX: -t * 0.8, minY: 0.45, minZ: -h, maxX: t * 0.8, maxY: 0.58, maxZ: h },
  ]
  // 端の柱は少し内側に寄せる。隣り合う柵と同じ場所に重ならないように
  for (const cz of [-h + 0.09, 0, h - 0.09]) {
    boxes.push({ minX: -0.09, minY: 0, minZ: cz - 0.09, maxX: 0.09, maxY: FENCE_H, maxZ: cz + 0.09 })
  }
  return mergeBoxes(boxes)
}

/** 枠（グループ 0）とガラス面（グループ 1）。 */
function windowGeometry(): THREE.BufferGeometry {
  const h = BUILD_CELL / 2
  const t = PANEL_T / 2
  const w = WINDOW_HALF
  const frame = mergeGeometries(
    [
      { minX: -t, minY: -h, minZ: -h, maxX: t, maxY: -w, maxZ: h },
      { minX: -t, minY: w, minZ: -h, maxX: t, maxY: h, maxZ: h },
      { minX: -t, minY: -w, minZ: -h, maxX: t, maxY: w, maxZ: -w },
      { minX: -t, minY: -w, minZ: w, maxX: t, maxY: w, maxZ: h },
    ].map((b) => boxGeometry(b)),
    false,
  )
  const pane = boxGeometry({
    minX: -t * 0.35,
    minY: -w,
    minZ: -w,
    maxX: t * 0.35,
    maxY: w,
    maxZ: w,
  })
  const geo = mergeGeometries([frame, pane], true)
  frame.dispose()
  pane.dispose()
  return geo
}

/**
 * +x 側へ昇る薄い斜面。上面は `y = x + CELL/2`、下面はその {@link PANEL_T} 下。
 * 面の向きは {@link quadFacing} に任せるので、斜めでも巻き順を間違えない。
 */
function roofGeometry(): THREE.BufferGeometry {
  const h = BUILD_CELL / 2
  const C = BUILD_CELL
  const T = PANEL_T
  const v: number[] = []

  // 上面の 4 隅（低い辺 x=-h が y=0、高い辺 x=+h が y=C）と、その T 下の下面
  const A: Pt = [-h, 0, -h]
  const B: Pt = [h, C, -h]
  const D: Pt = [h, C, h]
  const E: Pt = [-h, 0, h]
  const A2: Pt = [-h, -T, -h]
  const B2: Pt = [h, C - T, -h]
  const D2: Pt = [h, C - T, h]
  const E2: Pt = [-h, -T, h]

  face(v, [-1, 1, 0], A, B, D, E) // 上面
  face(v, [1, -1, 0], A2, B2, D2, E2) // 下面
  face(v, [0, 0, -1], A, B, B2, A2) // 手前の妻
  face(v, [0, 0, 1], E, D, D2, E2) // 奥の妻
  face(v, [-1, 0, 0], A, E, E2, A2) // 低い側の小口
  face(v, [1, 0, 0], B, D, D2, B2) // 高い側の小口

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(v), 3))
  geo.computeVertexNormals()
  return geo
}

type Pt = [number, number, number]

function face(out: number[], hint: Pt, a: Pt, b: Pt, c: Pt, d: Pt): void {
  quadFacing(out, hint[0], hint[1], hint[2], a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2])
}
