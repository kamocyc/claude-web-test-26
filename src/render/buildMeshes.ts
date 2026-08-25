import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { boxGeometry, quadFacing } from './geoUtil'
import { MATERIAL_INFO, MAT_GLASS } from '../world/constants'
import { BUILD_CELL, PANEL_T, WINDOW_HALF, localBoxes } from '../build/pieces'
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
  const geo = kind === 'window' ? windowGeometry() : kind === 'roof' ? roofGeometry() : fromBoxes(kind)
  geo.computeBoundingSphere()
  geoCache.set(kind, geo)
  return geo
}

/** パーツに使うマテリアル。窓だけ枠とガラスの 2 つを返す。 */
export function pieceMaterials(kind: PieceKind, mat: number): THREE.Material | THREE.Material[] {
  return kind === 'window' ? [buildMaterial(mat), paneMaterial] : buildMaterial(mat)
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

function fromBoxes(kind: PieceKind): THREE.BufferGeometry {
  const parts = localBoxes(kind).map((b) => boxGeometry(b))
  const geo = parts.length === 1 ? parts[0] : mergeGeometries(parts, false)
  if (parts.length > 1) for (const p of parts) p.dispose()
  return geo
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
