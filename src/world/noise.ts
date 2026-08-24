/**
 * 依存なしのシード付きノイズ実装。
 * メインスレッドと Worker で同じシードから同一の値を返す必要があるため、
 * 浮動小数点演算のみで決定論的に構築する。
 */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const F2 = 0.3660254037844386 // (sqrt(3)-1)/2
const G2 = 0.21132486540518713 // (3-sqrt(3))/6

/** 2D の 8 方向勾配 */
const GRAD2 = new Float32Array([
  1, 1, -1, 1, 1, -1, -1, -1,
  1, 0, -1, 0, 0, 1, 0, -1,
])

export class Noise {
  private readonly perm = new Uint8Array(512)

  constructor(seed: number) {
    const rand = mulberry32(seed)
    const p = new Uint8Array(256)
    for (let i = 0; i < 256; i++) p[i] = i
    // Fisher-Yates
    for (let i = 255; i > 0; i--) {
      const j = (rand() * (i + 1)) | 0
      const t = p[i]
      p[i] = p[j]
      p[j] = t
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255]
  }

  /** 古典 Perlin 3D。おおよそ [-1, 1]。 */
  perlin3(x: number, y: number, z: number): number {
    const perm = this.perm
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    const zi = Math.floor(z)
    const X = xi & 255
    const Y = yi & 255
    const Z = zi & 255
    const xf = x - xi
    const yf = y - yi
    const zf = z - zi

    const u = fade(xf)
    const v = fade(yf)
    const w = fade(zf)

    const A = (perm[X] + Y) & 255
    const AA = (perm[A] + Z) & 255
    const AB = (perm[(A + 1) & 255] + Z) & 255
    const B = (perm[(X + 1) & 255] + Y) & 255
    const BA = (perm[B] + Z) & 255
    const BB = (perm[(B + 1) & 255] + Z) & 255

    const x1 = lerp(grad3(perm[AA], xf, yf, zf), grad3(perm[BA], xf - 1, yf, zf), u)
    const x2 = lerp(grad3(perm[AB], xf, yf - 1, zf), grad3(perm[BB], xf - 1, yf - 1, zf), u)
    const y1 = lerp(x1, x2, v)

    const x3 = lerp(
      grad3(perm[(AA + 1) & 255], xf, yf, zf - 1),
      grad3(perm[(BA + 1) & 255], xf - 1, yf, zf - 1),
      u,
    )
    const x4 = lerp(
      grad3(perm[(AB + 1) & 255], xf, yf - 1, zf - 1),
      grad3(perm[(BB + 1) & 255], xf - 1, yf - 1, zf - 1),
      u,
    )
    const y2 = lerp(x3, x4, v)

    return lerp(y1, y2, w) * 1.1547
  }

  /** Simplex 2D。おおよそ [-1, 1]。地形の高さ場に使うので 2D は品質重視。 */
  simplex2(xin: number, yin: number): number {
    const perm = this.perm
    const s = (xin + yin) * F2
    const i = Math.floor(xin + s)
    const j = Math.floor(yin + s)
    const t = (i + j) * G2
    const x0 = xin - (i - t)
    const y0 = yin - (j - t)

    let i1: number
    let j1: number
    if (x0 > y0) {
      i1 = 1
      j1 = 0
    } else {
      i1 = 0
      j1 = 1
    }

    const x1 = x0 - i1 + G2
    const y1 = y0 - j1 + G2
    const x2 = x0 - 1 + 2 * G2
    const y2 = y0 - 1 + 2 * G2

    const ii = i & 255
    const jj = j & 255

    let n = 0
    let t0 = 0.5 - x0 * x0 - y0 * y0
    if (t0 > 0) {
      t0 *= t0
      const g = (perm[(ii + perm[jj]) & 255] & 7) * 2
      n += t0 * t0 * (GRAD2[g] * x0 + GRAD2[g + 1] * y0)
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1
    if (t1 > 0) {
      t1 *= t1
      const g = (perm[(ii + i1 + perm[(jj + j1) & 255]) & 255] & 7) * 2
      n += t1 * t1 * (GRAD2[g] * x1 + GRAD2[g + 1] * y1)
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2
    if (t2 > 0) {
      t2 *= t2
      const g = (perm[(ii + 1 + perm[(jj + 1) & 255]) & 255] & 7) * 2
      n += t2 * t2 * (GRAD2[g] * x2 + GRAD2[g + 1] * y2)
    }
    return 49.5 * n
  }

  fbm2(x: number, y: number, octaves: number, lacunarity = 2.02, gain = 0.5): number {
    let amp = 1
    let freq = 1
    let sum = 0
    let norm = 0
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.simplex2(x * freq, y * freq)
      norm += amp
      amp *= gain
      freq *= lacunarity
    }
    return sum / norm
  }

  fbm3(x: number, y: number, z: number, octaves: number, lacunarity = 2.03, gain = 0.5): number {
    let amp = 1
    let freq = 1
    let sum = 0
    let norm = 0
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.perlin3(x * freq, y * freq, z * freq)
      norm += amp
      amp *= gain
      freq *= lacunarity
    }
    return sum / norm
  }

  /** 尾根状ノイズ。[0, 1] で 1 が尾根。 */
  ridged2(x: number, y: number, octaves: number, lacunarity = 2.04, gain = 0.5): number {
    let amp = 1
    let freq = 1
    let sum = 0
    let norm = 0
    for (let o = 0; o < octaves; o++) {
      const n = 1 - Math.abs(this.simplex2(x * freq, y * freq))
      sum += amp * n * n
      norm += amp
      amp *= gain
      freq *= lacunarity
    }
    return sum / norm
  }

  /** 3D 尾根状ノイズ。洞窟のトンネル生成に使う。[0, 1]。 */
  ridged3(x: number, y: number, z: number, octaves: number, lacunarity = 2.05, gain = 0.5): number {
    let amp = 1
    let freq = 1
    let sum = 0
    let norm = 0
    for (let o = 0; o < octaves; o++) {
      sum += amp * (1 - Math.abs(this.perlin3(x * freq, y * freq, z * freq)))
      norm += amp
      amp *= gain
      freq *= lacunarity
    }
    return sum / norm
  }
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function grad3(hash: number, x: number, y: number, z: number): number {
  const h = hash & 15
  const u = h < 8 ? x : y
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v)
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}
