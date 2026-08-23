import * as THREE from 'three'
import { CHUNK_SIZE, VOXEL_SIZE } from '../world/constants'

export class Renderer {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  readonly fog: THREE.FogExp2

  constructor(viewDistanceChunks: number) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    document.body.appendChild(this.renderer.domElement)

    const far = viewDistanceChunks * CHUNK_SIZE * VOXEL_SIZE
    this.camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.1, far + 2200)
    this.fog = new THREE.FogExp2(0x9fc4e8, 1.8 / far)
    this.scene.fog = this.fog

    window.addEventListener('resize', () => this.resize())
  }

  resize(): void {
    const w = window.innerWidth
    const h = window.innerHeight
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(w, h)
  }

  render(): void {
    this.renderer.render(this.scene, this.camera)
  }
}
