/** 軸平行の直方体（ワールド座標）。当たり判定・空間索引・ジオメトリの共通の器。 */
export interface Box {
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
}

/**
 * 回転を持てる当たり判定。
 *
 * `minX/maxX` と `minZ/maxZ` は**ローカル座標**（回転の中心 `(ox, oz)` からの相対）、
 * `minY/maxY` は**ワールド座標**。回転は Y 軸まわりだけなので y は回らない。
 *
 * 回転のフィールドを持たない素の {@link Box}（村の建物の壁など）は、
 * `ox = oz = 0`・`cos = 1`・`sin = 0` として扱われ、**式が恒等になる**。
 * つまり軸平行の当たり判定はこれまでとまったく同じ数値で処理される。
 */
export interface Collider extends Box {
  ox?: number
  oz?: number
  cos?: number
  sin?: number
}

/**
 * ローカル → ワールド。three の Y 回転に合わせて
 * `x' = x cosθ + z sinθ`, `z' = -x sinθ + z cosθ`。
 */
export function localToWorld(c: Collider, lx: number, lz: number, out: number[]): number[] {
  const cos = c.cos ?? 1
  const sin = c.sin ?? 0
  out[0] = (c.ox ?? 0) + lx * cos + lz * sin
  out[1] = (c.oz ?? 0) - lx * sin + lz * cos
  return out
}

/** ワールド → ローカル（{@link localToWorld} の逆）。 */
export function worldToLocal(c: Collider, wx: number, wz: number, out: number[]): number[] {
  const cos = c.cos ?? 1
  const sin = c.sin ?? 0
  const dx = wx - (c.ox ?? 0)
  const dz = wz - (c.oz ?? 0)
  out[0] = dx * cos - dz * sin
  out[1] = dx * sin + dz * cos
  return out
}

/** ローカルの移動量をワールドの移動量へ（平行移動を含まない回転だけ）。 */
export function deltaToWorld(c: Collider, dx: number, dz: number, out: number[]): number[] {
  const cos = c.cos ?? 1
  const sin = c.sin ?? 0
  out[0] = dx * cos + dz * sin
  out[1] = -dx * sin + dz * cos
  return out
}

/** 回転を含めたワールドの外接箱。空間索引と粗い足切りに使う。 */
export function colliderBounds(c: Collider, out: Box): Box {
  out.minY = c.minY
  out.maxY = c.maxY
  const cos = c.cos ?? 1
  const sin = c.sin ?? 0
  if (sin === 0 && cos === 1) {
    out.minX = (c.ox ?? 0) + c.minX
    out.maxX = (c.ox ?? 0) + c.maxX
    out.minZ = (c.oz ?? 0) + c.minZ
    out.maxZ = (c.oz ?? 0) + c.maxZ
    return out
  }
  // 4 隅を回してから包む
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (let i = 0; i < 4; i++) {
    const lx = i & 1 ? c.maxX : c.minX
    const lz = i & 2 ? c.maxZ : c.minZ
    localToWorld(c, lx, lz, PAIR)
    if (PAIR[0] < minX) minX = PAIR[0]
    if (PAIR[0] > maxX) maxX = PAIR[0]
    if (PAIR[1] < minZ) minZ = PAIR[1]
    if (PAIR[1] > maxZ) maxZ = PAIR[1]
  }
  out.minX = minX
  out.maxX = maxX
  out.minZ = minZ
  out.maxZ = maxZ
  return out
}

/**
 * 2 つの当たり判定が重なっているか。
 *
 * y は区間の重なり、xz は**分離軸法**（矩形どうしなので候補の軸は互いの 2 辺ぶんの 4 本）。
 * 判定に使う大きさは `半分の辺 × scale + grow`。
 *
 * - **支持**（接していれば重なり扱い）: `scale = 1`, `grow = 0.35`
 * - **設置の重なり**: `scale < 1`, `grow = 0`。**中心寄りだけを見る**ので、
 *   直角に交わる 2 枚の壁が角で 0.15 m 食い込むような「組み上がった結果の交差」は許し、
 *   同じ場所への二重置きのような**本体どうしの重なり**だけを弾ける
 *   （一定量を引く縮め方だと、薄い板が全部すり抜けてしまって二重置きも通ってしまう）。
 */
export function obbOverlap(a: Collider, b: Collider, grow: number, scale = 1): boolean {
  const acy = (a.minY + a.maxY) / 2
  const bcy = (b.minY + b.maxY) / 2
  const ahy = ((a.maxY - a.minY) / 2) * scale + grow
  const bhy = ((b.maxY - b.minY) / 2) * scale + grow
  if (ahy <= 0 || bhy <= 0) return false
  if (Math.abs(bcy - acy) >= ahy + bhy) return false

  const acos = a.cos ?? 1
  const asin = a.sin ?? 0
  const bcos = b.cos ?? 1
  const bsin = b.sin ?? 0

  const ahx = ((a.maxX - a.minX) / 2) * scale + grow
  const ahz = ((a.maxZ - a.minZ) / 2) * scale + grow
  const bhx = ((b.maxX - b.minX) / 2) * scale + grow
  const bhz = ((b.maxZ - b.minZ) / 2) * scale + grow
  if (ahx <= 0 || ahz <= 0 || bhx <= 0 || bhz <= 0) return false

  localToWorld(a, (a.minX + a.maxX) / 2, (a.minZ + a.maxZ) / 2, PAIR)
  const acx = PAIR[0]
  const acz = PAIR[1]
  localToWorld(b, (b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2, PAIR)
  const dx = PAIR[0] - acx
  const dz = PAIR[1] - acz

  // 各矩形のローカル x 軸・z 軸のワールド向き
  AXES[0] = acos
  AXES[1] = -asin
  AXES[2] = asin
  AXES[3] = acos
  AXES[4] = bcos
  AXES[5] = -bsin
  AXES[6] = bsin
  AXES[7] = bcos

  for (let i = 0; i < 8; i += 2) {
    const nx = AXES[i]
    const nz = AXES[i + 1]
    const ra = ahx * Math.abs(nx * acos + nz * -asin) + ahz * Math.abs(nx * asin + nz * acos)
    const rb = bhx * Math.abs(nx * bcos + nz * -bsin) + bhz * Math.abs(nx * bsin + nz * bcos)
    if (Math.abs(dx * nx + dz * nz) >= ra + rb) return false
  }
  return true
}

/** 点が当たり判定の中にあるか。 */
export function colliderContains(c: Collider, x: number, y: number, z: number): boolean {
  if (y <= c.minY || y >= c.maxY) return false
  worldToLocal(c, x, z, PAIR)
  return PAIR[0] > c.minX && PAIR[0] < c.maxX && PAIR[1] > c.minZ && PAIR[1] < c.maxZ
}

/**
 * レイと当たり判定の交差。入射距離を返し、`normal` にその面のワールド外向き法線を入れる。
 * レイをローカルへ移してからスラブ法にかけるので、回転していても軸平行のときと同じ精度。
 * 中にいるときは 0 を返す。
 */
export function rayCollider(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  c: Collider,
  maxT: number,
  normal: number[],
): number | null {
  worldToLocal(c, ox, oz, PAIR)
  const lox = PAIR[0]
  const loz = PAIR[1]
  const cos = c.cos ?? 1
  const sin = c.sin ?? 0
  const ldx = dx * cos - dz * sin
  const ldz = dx * sin + dz * cos

  ORIGIN[0] = lox
  ORIGIN[1] = oy
  ORIGIN[2] = loz
  DIR[0] = ldx
  DIR[1] = dy
  DIR[2] = ldz
  LO[0] = c.minX
  LO[1] = c.minY
  LO[2] = c.minZ
  HI[0] = c.maxX
  HI[1] = c.maxY
  HI[2] = c.maxZ

  let tmin = 0
  let tmax = maxT
  let axis = -1
  let sign = 1
  for (let i = 0; i < 3; i++) {
    if (Math.abs(DIR[i]) < 1e-9) {
      if (ORIGIN[i] < LO[i] || ORIGIN[i] > HI[i]) return null
      continue
    }
    let t1 = (LO[i] - ORIGIN[i]) / DIR[i]
    let t2 = (HI[i] - ORIGIN[i]) / DIR[i]
    let s = -1
    if (t1 > t2) {
      const tmp = t1
      t1 = t2
      t2 = tmp
      s = 1
    }
    if (t1 > tmin) {
      tmin = t1
      axis = i
      sign = s
    }
    if (t2 < tmax) tmax = t2
    if (tmin > tmax) return null
  }

  normal[0] = 0
  normal[1] = 0
  normal[2] = 0
  if (axis === 1) {
    normal[1] = sign
  } else if (axis >= 0) {
    // ローカルの法線をワールドへ回す
    const nlx = axis === 0 ? sign : 0
    const nlz = axis === 2 ? sign : 0
    normal[0] = nlx * cos + nlz * sin
    normal[2] = -nlx * sin + nlz * cos
  }
  return tmin
}

const PAIR = [0, 0]
const AXES = [0, 0, 0, 0, 0, 0, 0, 0]
const ORIGIN = [0, 0, 0]
const DIR = [0, 0, 0]
const LO = [0, 0, 0]
const HI = [0, 0, 0]
