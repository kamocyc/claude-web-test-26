import * as THREE from 'three'
import { mulberry32 } from '../world/noise'

/**
 * タイリングするノイズテクスチャを CPU で生成する。
 * 外部アセットを一切使わずに三面投影のディテールを作るための素材。
 * RGBA の 4 チャンネルにそれぞれ異なる周波数のノイズを詰めるので、
 * 1 回のサンプルで 4 種類のノイズが取れる。
 */
export function createNoiseTexture(size = 256, seed = 1337): THREE.DataTexture {
  const rand = mulberry32(seed)
  const data = new Uint8Array(size * size * 4)

  const channels = [
    { base: 4, octaves: 4 },
    { base: 8, octaves: 4 },
    { base: 16, octaves: 4 },
    { base: 32, octaves: 3 },
  ]

  for (let c = 0; c < 4; c++) {
    const { base, octaves } = channels[c]
    const grids: Float32Array[] = []
    const sizes: number[] = []
    for (let o = 0; o < octaves; o++) {
      const cells = base << o
      if (cells > size) break
      const g = new Float32Array(cells * cells)
      for (let i = 0; i < g.length; i++) g[i] = rand()
      grids.push(g)
      sizes.push(cells)
    }

    let min = Infinity
    let max = -Infinity
    const tmp = new Float32Array(size * size)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let sum = 0
        let amp = 1
        let norm = 0
        for (let o = 0; o < grids.length; o++) {
          sum += amp * sampleTiling(grids[o], sizes[o], x / size, y / size)
          norm += amp
          amp *= 0.5
        }
        const v = sum / norm
        tmp[x + y * size] = v
        if (v < min) min = v
        if (v > max) max = v
      }
    }

    const span = max - min || 1
    for (let i = 0; i < tmp.length; i++) {
      data[i * 4 + c] = Math.round(((tmp[i] - min) / span) * 255)
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.generateMipmaps = true
  tex.needsUpdate = true
  return tex
}

/** 周期境界で補間する値ノイズ。 */
function sampleTiling(g: Float32Array, cells: number, u: number, v: number): number {
  const x = u * cells
  const y = v * cells
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = smoother(x - x0)
  const fy = smoother(y - y0)
  const i0 = ((x0 % cells) + cells) % cells
  const j0 = ((y0 % cells) + cells) % cells
  const i1 = (i0 + 1) % cells
  const j1 = (j0 + 1) % cells
  const a = g[i0 + j0 * cells]
  const b = g[i1 + j0 * cells]
  const c = g[i0 + j1 * cells]
  const d = g[i1 + j1 * cells]
  const top = a + (b - a) * fx
  const bot = c + (d - c) * fx
  return top + (bot - top) * fy
}

function smoother(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10)
}
