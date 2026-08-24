import * as THREE from 'three'
import type { World } from '../world/World'

export interface RayHit {
  point: THREE.Vector3
  normal: THREE.Vector3
  distance: number
}

const STEP = 0.28
const REFINE = 14

/**
 * 密度場に対するレイマーチ。ポリゴンではなく場そのものを撃つので、
 * メッシュ化が終わっていないチャンクでも正しい交点が得られる。
 */
export function raycastTerrain(
  world: World,
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  maxDistance: number,
  out: RayHit,
): RayHit | null {
  let prevT = 0
  let prevD = world.densityAt(origin.x, origin.y, origin.z)
  if (prevD > 0) {
    // 既に地中にいる場合は足元をそのまま返す
    out.point.copy(origin)
    fillNormal(world, out)
    out.distance = 0
    return out
  }

  for (let t = STEP; t <= maxDistance; t += STEP) {
    const x = origin.x + dir.x * t
    const y = origin.y + dir.y * t
    const z = origin.z + dir.z * t
    const d = world.densityAt(x, y, z)
    if (d > 0) {
      // 二分探索で交点を詰める
      let lo = prevT
      let hi = t
      for (let i = 0; i < REFINE; i++) {
        const mid = (lo + hi) * 0.5
        const md = world.densityAt(
          origin.x + dir.x * mid,
          origin.y + dir.y * mid,
          origin.z + dir.z * mid,
        )
        if (md > 0) {
          hi = mid
        } else {
          lo = mid
        }
      }
      out.distance = hi
      out.point.set(origin.x + dir.x * hi, origin.y + dir.y * hi, origin.z + dir.z * hi)
      fillNormal(world, out)
      return out
    }
    prevT = t
    prevD = d
  }
  return null
}

const SAMPLE = { d: 0, gx: 0, gy: 0, gz: 0 }

function fillNormal(world: World, hit: RayHit): void {
  world.sample(hit.point.x, hit.point.y, hit.point.z, SAMPLE)
  const len = Math.hypot(SAMPLE.gx, SAMPLE.gy, SAMPLE.gz) || 1
  hit.normal.set(-SAMPLE.gx / len, -SAMPLE.gy / len, -SAMPLE.gz / len)
}

export function createRayHit(): RayHit {
  return { point: new THREE.Vector3(), normal: new THREE.Vector3(), distance: 0 }
}
