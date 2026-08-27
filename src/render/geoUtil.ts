import * as THREE from 'three'
import type { Box } from '../world/collision'

/**
 * A→B→C→D を面の**内側から見て反時計回り**に並べた四角形を、
 * 外向きの面として出力する（巻き順を反転して 2 つの三角形にする）。
 */
export function quad(
  out: number[],
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  dx: number, dy: number, dz: number,
): void {
  out.push(ax, ay, az, cx, cy, cz, bx, by, bz)
  out.push(ax, ay, az, dx, dy, dz, cx, cy, cz)
}

export function tri(
  out: number[],
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): void {
  out.push(ax, ay, az, cx, cy, cz, bx, by, bz)
}

/**
 * 外向きの向き `hint` を指定して四角形を張る。並べ方が裏返っていたら自動で反転するので、
 * 斜めの面でも巻き順を間違えようがない。
 */
export function quadFacing(
  out: number[],
  hx: number, hy: number, hz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  dx: number, dy: number, dz: number,
): void {
  // (b-a) × (c-a) が hint と同じ側を向いていれば a→b→c→d が外向き
  const ux = bx - ax
  const uy = by - ay
  const uz = bz - az
  const vx = cx - ax
  const vy = cy - ay
  const vz = cz - az
  const nx = uy * vz - uz * vy
  const ny = uz * vx - ux * vz
  const nz = ux * vy - uy * vx
  if (nx * hx + ny * hy + nz * hz >= 0) {
    out.push(ax, ay, az, bx, by, bz, cx, cy, cz)
    out.push(ax, ay, az, cx, cy, cz, dx, dy, dz)
  } else {
    quad(out, ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz)
  }
}

/** 外向きの向き `hint` を指定して三角形を張る（{@link quadFacing} の三角形版）。 */
export function triFacing(
  out: number[],
  hx: number, hy: number, hz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): void {
  const ux = bx - ax
  const uy = by - ay
  const uz = bz - az
  const vx = cx - ax
  const vy = cy - ay
  const vz = cz - az
  const nx = uy * vz - uz * vy
  const ny = uz * vx - ux * vz
  const nz = ux * vy - uy * vx
  if (nx * hx + ny * hy + nz * hz >= 0) out.push(ax, ay, az, bx, by, bz, cx, cy, cz)
  else tri(out, ax, ay, az, bx, by, bz, cx, cy, cz)
}

/** 軸平行ボックスのジオメトリ（位置・法線・UV つき）。 */
export function boxGeometry(b: Box): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ)
  geo.translate((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2)
  return geo
}
