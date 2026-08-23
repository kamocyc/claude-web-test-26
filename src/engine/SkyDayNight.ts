import * as THREE from 'three'

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * p;
  gl_Position.z = gl_Position.w; // 常に最奥に描く
}
`

const SKY_FRAG = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform float uNight;
varying vec3 vDir;

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;

  vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.42));
  col = mix(col, uGround, smoothstep(0.0, -0.22, h));

  float mu = max(dot(d, uSunDir), 0.0);
  col += uSunColor * pow(mu, 7.0) * 0.5;                       // 大気の輝き
  col += uSunColor * pow(mu, 3000.0) * 14.0;                   // 太陽本体
  col += vec3(0.62, 0.68, 0.85) * pow(max(dot(d, -uSunDir), 0.0), 6000.0) * 9.0 * uNight;

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

const NIGHT_ZENITH = new THREE.Color(0x05070f)
const NIGHT_HORIZON = new THREE.Color(0x0d1226)
const DAY_ZENITH = new THREE.Color(0x2f74cc)
const DAY_HORIZON = new THREE.Color(0xa8ccec)
const DUSK_HORIZON = new THREE.Color(0xe8834a)
const DUSK_ZENITH = new THREE.Color(0x3d4a86)

/**
 * 空・太陽・星・環境光をまとめて時刻に応じて更新する。
 * `timeOfDay` は [0,1) で 0.25 が日の出、0.5 が正午、0.75 が日没。
 */
export class SkyDayNight {
  timeOfDay = 0.32
  /** 1 周にかかる実時間（秒）。 */
  dayLength = 900

  readonly sun: THREE.DirectionalLight
  readonly hemi: THREE.HemisphereLight
  readonly sunDir = new THREE.Vector3(0, 1, 0)

  private readonly dome: THREE.Mesh
  private readonly stars: THREE.Points
  private readonly uniforms: Record<string, THREE.IUniform>
  private readonly zenith = new THREE.Color()
  private readonly horizon = new THREE.Color()
  private readonly ground = new THREE.Color()
  private readonly sunColor = new THREE.Color()

  constructor(scene: THREE.Scene, radius: number) {
    this.uniforms = {
      uZenith: { value: new THREE.Color(0x2f74cc) },
      uHorizon: { value: new THREE.Color(0xa8ccec) },
      uGround: { value: new THREE.Color(0x4a5560) },
      uSunColor: { value: new THREE.Color(0xfff2d8) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uNight: { value: 0 },
    }

    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    })
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 20), mat)
    this.dome.frustumCulled = false
    this.dome.renderOrder = -1000
    scene.add(this.dome)

    this.stars = createStars(radius * 0.94)
    scene.add(this.stars)

    this.sun = new THREE.DirectionalLight(0xffffff, 2.4)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    this.sun.shadow.camera.near = 1
    this.sun.shadow.camera.far = 460
    const s = 96
    this.sun.shadow.camera.left = -s
    this.sun.shadow.camera.right = s
    this.sun.shadow.camera.top = s
    this.sun.shadow.camera.bottom = -s
    this.sun.shadow.bias = -0.0006
    this.sun.shadow.normalBias = 0.35
    scene.add(this.sun)
    scene.add(this.sun.target)

    this.hemi = new THREE.HemisphereLight(0xa8ccec, 0x4a4436, 0.6)
    scene.add(this.hemi)
  }

  /** 昼＝1, 夜＝0 */
  get daylight(): number {
    return smooth(-0.09, 0.22, this.sunDir.y)
  }

  update(dt: number, cameraPos: THREE.Vector3, fog: THREE.FogExp2): void {
    this.timeOfDay = (this.timeOfDay + dt / this.dayLength) % 1

    const theta = (this.timeOfDay - 0.25) * Math.PI * 2
    this.sunDir.set(Math.cos(theta) * 0.36, Math.sin(theta), Math.cos(theta) * 0.93).normalize()

    const day = this.daylight
    const night = 1 - smooth(-0.16, 0.06, this.sunDir.y)
    // 太陽が地平線付近にあるときの夕焼け度
    const dusk = Math.exp(-Math.pow(this.sunDir.y / 0.22, 2)) * (1 - night * 0.65)

    this.zenith.copy(NIGHT_ZENITH).lerp(DAY_ZENITH, day).lerp(DUSK_ZENITH, dusk * 0.75)
    this.horizon.copy(NIGHT_HORIZON).lerp(DAY_HORIZON, day).lerp(DUSK_HORIZON, dusk * 0.85)
    this.ground.copy(this.horizon).multiplyScalar(0.45)
    this.sunColor
      .setHex(0xfff2d8)
      .lerp(new THREE.Color(0xff8a3d), dusk)
      .multiplyScalar(0.35 + day * 0.65)

    ;(this.uniforms.uZenith.value as THREE.Color).copy(this.zenith)
    ;(this.uniforms.uHorizon.value as THREE.Color).copy(this.horizon)
    ;(this.uniforms.uGround.value as THREE.Color).copy(this.ground)
    ;(this.uniforms.uSunColor.value as THREE.Color).copy(this.sunColor)
    ;(this.uniforms.uSunDir.value as THREE.Vector3).copy(this.sunDir)
    this.uniforms.uNight.value = night

    this.dome.position.copy(cameraPos)
    this.stars.position.copy(cameraPos)
    this.stars.rotation.y = this.timeOfDay * Math.PI * 2
    const starMat = this.stars.material as THREE.PointsMaterial
    starMat.opacity = night

    // 光源はカメラに追従させ、影の解像度を手前に集中させる
    const above = this.sunDir.y > 0
    const dir = above ? this.sunDir : this.sunDir.clone().negate()
    this.sun.position.copy(cameraPos).addScaledVector(dir, 220)
    this.sun.target.position.copy(cameraPos)
    this.sun.target.updateMatrixWorld()
    this.sun.color.copy(above ? this.sunColor : new THREE.Color(0x9fb6e0))
    this.sun.intensity = above ? 0.35 + day * 2.5 : night * 0.16
    this.sun.castShadow = above ? day > 0.02 : false

    this.hemi.color.copy(this.horizon)
    this.hemi.groundColor.copy(this.ground).multiplyScalar(1.15)
    this.hemi.intensity = 0.26 + day * 1.05

    fog.color.copy(this.horizon)
  }
}

function createStars(radius: number): THREE.Points {
  const count = 1400
  const pos = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    // 上半球寄りに一様分布させる
    const u = Math.random() * 2 - 1
    const phi = Math.random() * Math.PI * 2
    const r = Math.sqrt(1 - u * u)
    pos[i * 3] = Math.cos(phi) * r * radius
    pos[i * 3 + 1] = Math.abs(u) * radius
    pos[i * 3 + 2] = Math.sin(phi) * r * radius
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  const mat = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 1.7,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: false,
  })
  const points = new THREE.Points(geo, mat)
  points.frustumCulled = false
  points.renderOrder = -999
  return points
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}
