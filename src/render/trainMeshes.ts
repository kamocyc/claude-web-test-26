import * as THREE from 'three'
import { geometryFrom, orientedBox } from './trackMeshes'
import { buildMaterial } from './buildMeshes'
import { TRACK_INFO } from '../track/track'
import { CAR_H, CAR_LEN, CAR_W, PLATFORM_H, PLATFORM_LEN, PLATFORM_W } from '../train/trains'

/** 屋根・車輪・煙突。車体は軌道と同じく素材の色で描く。 */
export const trainTrimMaterial = new THREE.MeshStandardMaterial({
  color: 0x2b3038,
  roughness: 0.6,
  metalness: 0.2,
})

/** 駅名の看板と、選択中の印。 */
export const signMaterial = new THREE.MeshStandardMaterial({
  color: 0xffd479,
  roughness: 0.5,
  metalness: 0,
})

/**
 * 駅 1 つのジオメトリ。線路の脇にホームと上屋を建て、線路側に看板を出す。
 * `yaw` は線路の向き（ホームはそれと平行に伸びる）。
 */
export function buildStationGeometry(
  x: number,
  y: number,
  z: number,
  yaw: number,
  side: 1 | -1 = 1,
): { body: THREE.BufferGeometry; sign: THREE.BufferGeometry } {
  const body: number[] = []
  const sign: number[] = []
  const half = TRACK_INFO.rail.width / 2
  // 線路の脇へ寄せる（ヨー θ の右は (cosθ, -sinθ)）
  const off = (half + PLATFORM_W / 2) * side
  const px = x + Math.cos(yaw) * off
  const pz = z - Math.sin(yaw) * off

  // ホーム
  orientedBox(body, px, y, pz, yaw, PLATFORM_W / 2, PLATFORM_LEN / 2, -1.2, PLATFORM_H - 0.35)
  // 上屋の柱（ホームの四隅）。前方は (-sinθ, -cosθ)
  const rx = Math.cos(yaw)
  const rz = -Math.sin(yaw)
  const fx = -Math.sin(yaw)
  const fz = -Math.cos(yaw)
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const ox = (PLATFORM_W / 2 - 0.35) * sx
      const oz = (PLATFORM_LEN / 2 - 1.5) * sz
      orientedBox(
        body,
        px + rx * ox + fx * oz,
        y,
        pz + rz * ox + fz * oz,
        yaw,
        0.12,
        0.12,
        PLATFORM_H - 0.35,
        PLATFORM_H + 2.3,
      )
    }
  }
  // 屋根
  orientedBox(
    body,
    px,
    y,
    pz,
    yaw,
    PLATFORM_W / 2 + 0.3,
    PLATFORM_LEN / 2 - 1.2,
    PLATFORM_H + 2.3,
    PLATFORM_H + 2.6,
  )
  // 看板（線路側を向く板）
  orientedBox(
    sign,
    x + Math.cos(yaw) * half * side,
    y,
    z - Math.sin(yaw) * half * side,
    yaw,
    0.08,
    1.1,
    PLATFORM_H + 1.1,
    PLATFORM_H + 1.7,
  )
  return { body: geometryFrom(body), sign: geometryFrom(sign) }
}

/**
 * 機関車 1 両。原点を車体の中心（レール天面の高さ）として作り、
 * 走らせるときは位置とヨーだけを毎フレーム差し替える。
 */
export function buildTrainMesh(mat: number): THREE.Group {
  const g = new THREE.Group()
  const body: number[] = []
  const trim: number[] = []
  const w = CAR_W / 2
  const l = CAR_LEN / 2

  // 台枠とボイラー
  orientedBox(body, 0, 0, 0, 0, w, l, 0.35, 0.6)
  orientedBox(body, 0, 0, 0, 0, w * 0.8, l * 0.62, 0.6, CAR_H * 0.72)
  // 運転台（後ろ寄り）
  orientedBox(body, 0, 0, l * 0.62, 0, w * 0.9, l * 0.36, 0.6, CAR_H)
  // 屋根と煙突
  orientedBox(trim, 0, 0, l * 0.62, 0, w * 0.98, l * 0.4, CAR_H, CAR_H + 0.14)
  orientedBox(trim, 0, 0, -l * 0.72, 0, 0.22, 0.22, CAR_H * 0.72, CAR_H * 0.72 + 0.5)
  // 車輪（左右 3 対）。ヨー 0 のとき右は +x、前方は -z
  for (const side of [-1, 1]) {
    for (const at of [-0.62, 0, 0.62]) {
      orientedBox(trim, side * w, 0, -at * l, 0, 0.12, 0.34, 0, 0.35)
    }
  }

  const bodyMesh = new THREE.Mesh(geometryFrom(body), buildMaterial(mat))
  const trimMesh = new THREE.Mesh(geometryFrom(trim), trainTrimMaterial)
  for (const m of [bodyMesh, trimMesh]) {
    m.castShadow = true
    m.receiveShadow = true
    m.frustumCulled = false
    g.add(m)
  }
  return g
}
