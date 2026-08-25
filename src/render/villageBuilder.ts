import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { boxGeometry, quad, tri } from './geoUtil'
import { buildingBoxes } from '../world/village'
import type { Box, Building, Village } from '../world/village'

/** 建物はすべて頂点カラー付きの 1 マテリアルにまとめて 1 ドローコールにする。 */
export const villageMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.88,
  metalness: 0,
})

interface Palette {
  wall: number
  roof: number
  beam: number
}

const PALETTES: Palette[] = [
  { wall: 0xd9d0bd, roof: 0x9c4a35, beam: 0x5a4029 },
  { wall: 0x9a7a52, roof: 0x5d4733, beam: 0x453324 },
  { wall: 0x9d988e, roof: 0x4c5a63, beam: 0x50483d },
  { wall: 0xc6ac81, roof: 0x7d5b3b, beam: 0x4f3b28 },
]

const STONE = 0x8f8b83
const WOOD = 0x6b5236
const DARK = 0x2a2119

/** 村ひとつぶんの建物をまとめた 1 メッシュを作る。 */
export function buildVillageMesh(v: Village): THREE.Mesh {
  const parts: THREE.BufferGeometry[] = []
  for (const b of v.buildings) addBuilding(parts, b, v.platformY)
  const geo = mergeGeometries(parts, false)
  for (const p of parts) p.dispose()
  geo.computeBoundingSphere()
  const mesh = new THREE.Mesh(geo, villageMaterial)
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.matrixAutoUpdate = false
  mesh.name = `village-${v.key}`
  return mesh
}

/** 村の当たり判定（壁）。描画と同じ `buildingBoxes` を使うので必ず一致する。 */
export function villageColliders(v: Village): Box[] {
  const out: Box[] = []
  for (const b of v.buildings) {
    for (const box of buildingBoxes(b, v.platformY - 0.2)) out.push(box)
  }
  return out
}

function addBuilding(parts: THREE.BufferGeometry[], b: Building, groundY: number): void {
  const baseY = groundY - 0.2
  const pal = PALETTES[b.palette % PALETTES.length]

  if (b.kind === 'well') {
    for (const box of buildingBoxes(b, baseY)) parts.push(boxGeo(box, STONE))
    // 屋根と柱
    const top = baseY + b.wallH
    parts.push(pillar(b.x - 1.0, top, b.z, 0.16, 1.6, WOOD))
    parts.push(pillar(b.x + 1.0, top, b.z, 0.16, 1.6, WOOD))
    parts.push(roofGeo(b.x, b.z, b.w + 0.9, b.d + 0.9, top + 1.6, b.roofH, true, 0.2, pal.roof))
    return
  }

  const boxes = buildingBoxes(b, baseY)
  for (const box of boxes) parts.push(boxGeo(box, pal.wall))

  const top = baseY + b.wallH

  // 隅の柱（ハーフティンバー風）
  const hw = b.w / 2
  const hd = b.d / 2
  for (const [sx, sz] of CORNERS) {
    parts.push(pillar(b.x + sx * (hw - 0.14), baseY, b.z + sz * (hd - 0.14), 0.16, b.wallH, pal.beam))
  }

  if (b.kind === 'tower') {
    // 見張り台：手すりつきの床
    parts.push(
      boxGeo(
        { minX: b.x - hw - 0.6, minY: top, minZ: b.z - hd - 0.6, maxX: b.x + hw + 0.6, maxY: top + 0.25, maxZ: b.z + hd + 0.6 },
        WOOD,
      ),
    )
    for (const [sx, sz] of CORNERS) {
      parts.push(pillar(b.x + sx * (hw + 0.45), top + 0.25, b.z + sz * (hd + 0.45), 0.12, 0.9, pal.beam))
    }
    parts.push(roofGeo(b.x, b.z, b.w + 1.6, b.d + 1.6, top + 1.15, b.roofH, true, 0.25, pal.roof))
    return
  }

  parts.push(roofGeo(b.x, b.z, b.w, b.d, top, b.roofH, b.ridgeAlongX, 0.42, pal.roof))

  // ドア（見た目だけ。当たり判定は開口になっている）
  addDoor(parts, b, baseY)
  // 窓
  addWindows(parts, b, baseY)
}

const CORNERS: Array<[number, number]> = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
]

/**
 * 入口。当たり判定は開口になっているので、扉板ではなく枠だけを描いて
 * 「通り抜けられる出入口」だと見て分かるようにする。
 */
function addDoor(parts: THREE.BufferGeometry[], b: Building, baseY: number): void {
  const hw = b.w / 2
  const hd = b.d / 2
  const t = 0.1
  const w = 0.82 // 開口の半分幅（当たり判定の DOOR_W/2 = 0.75 より少し外側）
  const post = 0.14
  const h = 2.2
  const alongX = b.doorSide >= 2
  const face = b.doorSide === 0 ? b.x + hw : b.doorSide === 1 ? b.x - hw : b.doorSide === 2 ? b.z + hd : b.z - hd

  const frame = (lo: number, hi: number, y0: number, y1: number) => {
    if (alongX) {
      parts.push(boxGeo({ minX: lo, minY: y0, minZ: face - t, maxX: hi, maxY: y1, maxZ: face + t }, WOOD))
    } else {
      parts.push(boxGeo({ minX: face - t, minY: y0, minZ: lo, maxX: face + t, maxY: y1, maxZ: hi }, WOOD))
    }
  }
  const c = alongX ? b.x : b.z
  frame(c - w - post, c - w, baseY, baseY + h)
  frame(c + w, c + w + post, baseY, baseY + h)
  frame(c - w - post, c + w + post, baseY + h, baseY + h + 0.16)
}

function addWindows(parts: THREE.BufferGeometry[], b: Building, baseY: number): void {
  const hw = b.w / 2
  const hd = b.d / 2
  const y0 = baseY + b.wallH * 0.42
  const y1 = y0 + 0.85
  const t = 0.07
  const half = 0.42
  const offsets = b.w > 7 ? [-0.28, 0.28] : [0]
  for (const o of offsets) {
    const px = b.x + o * b.w
    const pz = b.z + o * b.d
    if (b.doorSide !== 3) {
      parts.push(boxGeo({ minX: px - half, minY: y0, minZ: b.z - hd - t, maxX: px + half, maxY: y1, maxZ: b.z - hd + t }, DARK))
    }
    if (b.doorSide !== 2) {
      parts.push(boxGeo({ minX: px - half, minY: y0, minZ: b.z + hd - t, maxX: px + half, maxY: y1, maxZ: b.z + hd + t }, DARK))
    }
    if (b.doorSide !== 1) {
      parts.push(boxGeo({ minX: b.x - hw - t, minY: y0, minZ: pz - half, maxX: b.x - hw + t, maxY: y1, maxZ: pz + half }, DARK))
    }
    if (b.doorSide !== 0) {
      parts.push(boxGeo({ minX: b.x + hw - t, minY: y0, minZ: pz - half, maxX: b.x + hw + t, maxY: y1, maxZ: pz + half }, DARK))
    }
  }
}

function pillar(
  x: number,
  y: number,
  z: number,
  r: number,
  h: number,
  color: number,
): THREE.BufferGeometry {
  return boxGeo({ minX: x - r, minY: y, minZ: z - r, maxX: x + r, maxY: y + h, maxZ: z + r }, color)
}

function boxGeo(b: Box, color: number): THREE.BufferGeometry {
  return finish(boxGeometry(b), color)
}

/**
 * 切妻屋根。棟が x 方向か z 方向かを選べる。
 * 2 枚の斜面 + 両端の妻壁を明示的に張った非インデックスジオメトリ。
 */
function roofGeo(
  cx: number,
  cz: number,
  w: number,
  d: number,
  baseY: number,
  height: number,
  ridgeAlongX: boolean,
  overhang: number,
  color: number,
): THREE.BufferGeometry {
  const x0 = cx - w / 2 - overhang
  const x1 = cx + w / 2 + overhang
  const z0 = cz - d / 2 - overhang
  const z1 = cz + d / 2 + overhang
  const yt = baseY + height
  const v: number[] = []

  if (ridgeAlongX) {
    // 棟は x 方向 → 斜面は z 方向に傾く
    quad(v, x0, baseY, z0, x1, baseY, z0, x1, yt, cz, x0, yt, cz)
    quad(v, x1, baseY, z1, x0, baseY, z1, x0, yt, cz, x1, yt, cz)
    tri(v, x0, baseY, z0, x0, yt, cz, x0, baseY, z1)
    tri(v, x1, baseY, z1, x1, yt, cz, x1, baseY, z0)
  } else {
    quad(v, x1, baseY, z0, x1, baseY, z1, cx, yt, z1, cx, yt, z0)
    quad(v, x0, baseY, z1, x0, baseY, z0, cx, yt, z0, cx, yt, z1)
    tri(v, x1, baseY, z0, cx, yt, z0, x0, baseY, z0)
    tri(v, x0, baseY, z1, cx, yt, z1, x1, baseY, z1)
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(v), 3))
  geo.computeVertexNormals()
  return finish(geo, color)
}

function finish(geo: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  const out = geo.index ? geo.toNonIndexed() : geo
  if (out !== geo) geo.dispose()
  out.deleteAttribute('uv')
  out.deleteAttribute('normal')
  out.computeVertexNormals()
  const c = new THREE.Color(color)
  const n = out.attributes.position.count
  const arr = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const v = 0.9 + ((i * 2654435761) % 64) / 420
    arr[i * 3] = c.r * v
    arr[i * 3 + 1] = c.g * v
    arr[i * 3 + 2] = c.b * v
  }
  out.setAttribute('color', new THREE.BufferAttribute(arr, 3))
  return out
}
