import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { TREE_BROADLEAF, TREE_CACTUS, TREE_CONIFER } from '../world/vegetation'

export interface TreePrototype {
  geometry: THREE.BufferGeometry
  /** プレイヤーが押し出される幹の円柱。 */
  trunkRadius: number
  trunkHeight: number
  /** 伐採の照準判定に使う、木全体を覆う円柱。 */
  hitRadius: number
  hitHeight: number
}

/** 木は葉が多いので、頂点カラー付きの 1 マテリアルに統一して描画コストを抑える。 */
export const treeMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.92,
  metalness: 0,
  flatShading: true,
})

/** 3 種類の木のプロトタイプ形状。InstancedMesh の元として一度だけ作る。 */
export function createTreePrototypes(): TreePrototype[] {
  const out: TreePrototype[] = []
  out[TREE_BROADLEAF] = broadleaf()
  out[TREE_CONIFER] = conifer()
  out[TREE_CACTUS] = cactus()
  return out
}

function broadleaf(): TreePrototype {
  const parts = [
    tint(new THREE.CylinderGeometry(0.17, 0.28, 3.6, 7), 0x5b4430, at(0, 1.8, 0)),
    tint(new THREE.IcosahedronGeometry(1.75, 0), 0x3f6b26, at(0, 4.5, 0)),
    tint(new THREE.IcosahedronGeometry(1.25, 0), 0x3d6a2a, at(0.95, 3.85, 0.5)),
    tint(new THREE.IcosahedronGeometry(1.15, 0), 0x477a2b, at(-0.85, 4.05, -0.6)),
  ]
  return { geometry: merge(parts), trunkRadius: 0.34, trunkHeight: 3.4, hitRadius: 1.5, hitHeight: 6.2 }
}

function conifer(): TreePrototype {
  const parts = [
    tint(new THREE.CylinderGeometry(0.15, 0.24, 4.6, 6), 0x4a3826, at(0, 2.3, 0)),
    tint(new THREE.ConeGeometry(1.75, 2.4, 8), 0x2c5127, at(0, 3.0, 0)),
    tint(new THREE.ConeGeometry(1.4, 2.2, 8), 0x336030, at(0, 4.3, 0)),
    tint(new THREE.ConeGeometry(0.95, 2.0, 8), 0x3b6d35, at(0, 5.5, 0)),
  ]
  return { geometry: merge(parts), trunkRadius: 0.3, trunkHeight: 4.6, hitRadius: 1.4, hitHeight: 6.6 }
}

function cactus(): TreePrototype {
  const parts = [
    tint(new THREE.CylinderGeometry(0.36, 0.42, 2.8, 8), 0x4e7a3f, at(0, 1.4, 0)),
    tint(new THREE.CylinderGeometry(0.2, 0.2, 1.1, 6), 0x548244, at(0.55, 1.6, 0, 0, 0, Math.PI / 2.6)),
    tint(new THREE.CylinderGeometry(0.2, 0.2, 0.9, 6), 0x548244, at(-0.5, 2.0, 0, 0, 0, -Math.PI / 2.6)),
    tint(new THREE.CylinderGeometry(0.2, 0.2, 0.8, 6), 0x548244, at(0.85, 2.15, 0)),
  ]
  return { geometry: merge(parts), trunkRadius: 0.45, trunkHeight: 2.8, hitRadius: 0.8, hitHeight: 2.9 }
}

function at(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.Matrix4 {
  return new THREE.Matrix4()
    .makeRotationFromEuler(new THREE.Euler(rx, ry, rz))
    .setPosition(x, y, z)
}

function tint(
  src: THREE.BufferGeometry,
  color: number,
  matrix: THREE.Matrix4,
): THREE.BufferGeometry {
  // インデックスの有無が混在すると mergeGeometries が失敗するので揃える
  const geo = src.toNonIndexed()
  src.dispose()
  geo.applyMatrix4(matrix)
  geo.deleteAttribute('uv')
  const c = new THREE.Color(color)
  const n = geo.attributes.position.count
  const arr = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    // 面ごとに少し明度を散らして単調さを消す
    const v = 0.86 + ((i * 2654435761) % 100) / 360
    arr[i * 3] = c.r * v
    arr[i * 3 + 1] = c.g * v
    arr[i * 3 + 2] = c.b * v
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3))
  return geo
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts, false)
  for (const p of parts) p.dispose()
  merged.computeBoundingSphere()
  return merged
}
