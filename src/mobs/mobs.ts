import * as THREE from 'three'
import type { ItemId } from '../items/items'

export type MobKind = 'wraith' | 'deer' | 'villager'

export interface MobDef {
  readonly kind: MobKind
  readonly name: string
  readonly hp: number
  /** 歩く速さ (m/s)。 */
  readonly speed: number
  /** 逃げる／追いかけるときの速さ。 */
  readonly runSpeed: number
  /** 当たり判定の半径と背丈。 */
  readonly radius: number
  readonly height: number
  /** プレイヤーに気づく距離。 */
  readonly sight: number
  readonly hostile: boolean
  readonly flees: boolean
  readonly attack: number
  readonly attackInterval: number
  readonly drops: readonly (readonly [ItemId, number])[]
  /** 同時に存在できる数。 */
  readonly max: number
}

export const MOB_DEFS: Record<MobKind, MobDef> = {
  wraith: {
    kind: 'wraith',
    name: '亡霊',
    hp: 14,
    speed: 1.6,
    runSpeed: 3.6,
    radius: 0.42,
    height: 1.75,
    sight: 20,
    hostile: true,
    flees: false,
    attack: 4,
    attackInterval: 1.1,
    drops: [['bone', 2]],
    max: 10,
  },
  deer: {
    kind: 'deer',
    name: '鹿',
    hp: 6,
    speed: 1.1,
    runSpeed: 5.2,
    radius: 0.45,
    height: 1.5,
    sight: 13,
    hostile: false,
    flees: true,
    attack: 0,
    attackInterval: 0,
    drops: [['hide', 2]],
    max: 8,
  },
  villager: {
    kind: 'villager',
    name: '村人',
    hp: 20,
    speed: 0.9,
    runSpeed: 1.6,
    radius: 0.4,
    height: 1.72,
    sight: 10,
    hostile: false,
    flees: false,
    attack: 0,
    attackInterval: 0,
    drops: [],
    max: 8,
  },
}

function mat(color: number, opts: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, ...opts })
}

function box(w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0) {
  const g = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m)
  g.position.set(x, y, z)
  g.castShadow = true
  return g
}

/**
 * MOB の見た目。地形と同じく外部アセットを使わず、
 * 低ポリゴンの箱と球を組み立てて作る。
 * 原点は足元。`body` はアニメーション用に上下させる部分。
 */
export interface MobModel {
  readonly root: THREE.Group
  readonly body: THREE.Object3D
  readonly legs: THREE.Object3D[]
}

export function buildMobModel(kind: MobKind): MobModel {
  const root = new THREE.Group()
  const body = new THREE.Group()
  const legs: THREE.Object3D[] = []
  root.add(body)

  if (kind === 'wraith') {
    const cloth = mat(0x2a2740, { roughness: 0.95 })
    const glow = mat(0x000000, { emissive: 0x8fd7ff, emissiveIntensity: 2.4 })
    const torso = new THREE.Mesh(new THREE.ConeGeometry(0.46, 1.35, 7), cloth)
    torso.position.y = 0.68
    torso.castShadow = true
    body.add(torso)
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.27, 10, 8), cloth)
    head.position.y = 1.5
    head.castShadow = true
    body.add(head)
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.062, 6, 5), glow)
      eye.position.set(s * 0.11, 1.53, 0.23)
      body.add(eye)
    }
    // 腕は前に伸ばす
    for (const s of [-1, 1]) {
      const arm = box(0.13, 0.13, 0.62, cloth, s * 0.34, 1.02, 0.28)
      arm.rotation.x = -0.3
      body.add(arm)
    }
  } else if (kind === 'deer') {
    const fur = mat(0x8a6034)
    const dark = mat(0x4b3320)
    const torso = box(0.52, 0.5, 1.12, fur, 0, 0.98, 0)
    body.add(torso)
    const neck = box(0.26, 0.46, 0.26, fur, 0, 1.3, 0.52)
    neck.rotation.x = -0.35
    body.add(neck)
    const head = box(0.26, 0.24, 0.42, fur, 0, 1.55, 0.72)
    body.add(head)
    for (const s of [-1, 1]) {
      const antler = box(0.05, 0.34, 0.05, dark, s * 0.1, 1.78, 0.66)
      antler.rotation.z = s * 0.35
      body.add(antler)
      const tine = box(0.05, 0.2, 0.05, dark, s * 0.22, 1.9, 0.66)
      body.add(tine)
    }
    for (const [sx, sz] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as const) {
      const pivot = new THREE.Group()
      pivot.position.set(sx * 0.19, 0.74, sz * 0.4)
      const leg = box(0.12, 0.74, 0.12, dark, 0, -0.37, 0)
      pivot.add(leg)
      body.add(pivot)
      legs.push(pivot)
    }
  } else {
    const robe = mat(0x5c6f96)
    const skin = mat(0xd0a184)
    const belt = mat(0x3b4664)
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.38, 1.02, 9), robe)
    torso.position.y = 0.72
    torso.castShadow = true
    body.add(torso)
    body.add(box(0.68, 0.1, 0.68, belt, 0, 0.62, 0))
    body.add(box(0.16, 0.14, 0.16, skin, 0, 1.26, 0))
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 10, 8), skin)
    head.position.y = 1.38
    head.castShadow = true
    body.add(head)
    const nose = box(0.1, 0.16, 0.16, skin, 0, 1.34, 0.22)
    body.add(nose)
    for (const s of [-1, 1]) {
      const pivot = new THREE.Group()
      pivot.position.set(s * 0.31, 1.12, 0)
      const arm = box(0.13, 0.62, 0.13, robe, 0, -0.31, 0)
      pivot.add(arm)
      body.add(pivot)
      legs.push(pivot)
    }
  }

  return { root, body, legs }
}
