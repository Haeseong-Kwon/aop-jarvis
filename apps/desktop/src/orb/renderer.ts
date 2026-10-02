import type { AgentId, RuntimeState } from '@aop/core'
import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import type { AudioLevels } from '../audio/levels'
import { markPolylines, O_INNER_RATIO } from './mark'
import { BOOT_DONE, bootFrame, lerpVisual, QUALITY, targetFps, VISUALS, type Quality, type Visual } from './params'
import * as S from './shaders'

export type AgentVisualStatus = 'queued' | 'running' | 'waiting' | 'failed' | 'completed'
export interface AgentVisual {
  id: AgentId
  status: AgentVisualStatus
}

export interface OrbInputs {
  state: RuntimeState
  /** Seconds since boot start, or null when not booting. */
  bootT: number | null
  mic: AudioLevels
  out: AudioLevels
  agents: AgentVisual[]
  quality: Quality
}

// Orb-unit radii (1 = the O's outer radius).
const R = { inner: O_INNER_RATIO, mid: 1.32, outer: 1.62, tick0: 1.76, tick1: 1.83, glyph: 1.98, orbit: 2.25 }
export const EXTENT = { x: 2.9, y: 2.55 }
const TICKS = 144

/** Fixed slots so an agent always appears in the same place. Radians, y up. */
export const AGENT_SLOTS: Record<AgentId, number> = {
  research: (150 * Math.PI) / 180,
  code: (30 * Math.PI) / 180,
  communicator: (90 * Math.PI) / 180,
  operator: (210 * Math.PI) / 180,
  analyst: (330 * Math.PI) / 180,
  reviewer: (270 * Math.PI) / 180,
}
export const ORBIT_RADIUS = R.orbit

function lineMaterial(color = new THREE.Color(0.75, 0.88, 1)): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: S.lineVert,
    fragmentShader: S.lineFrag,
    uniforms: { uColor: { value: color }, uAlpha: { value: 1 }, uProgress: { value: 1 } },
    transparent: true,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  })
}

/** Segments from polylines, with aDist = normalized arc length (for draw-on) and per-vertex alpha. */
function segments(paths: [number, number][][], alpha: (pathIndex: number, t: number) => number = () => 1): THREE.BufferGeometry {
  const pos: number[] = []
  const dist: number[] = []
  const alp: number[] = []
  paths.forEach((path, pi) => {
    let total = 0
    for (let i = 1; i < path.length; i++) total += Math.hypot(path[i]![0] - path[i - 1]![0], path[i]![1] - path[i - 1]![1])
    let acc = 0
    for (let i = 1; i < path.length; i++) {
      const [x0, y0] = path[i - 1]!
      const [x1, y1] = path[i]!
      const seg = Math.hypot(x1 - x0, y1 - y0)
      pos.push(x0, y0, 0, x1, y1, 0)
      dist.push(acc / total, (acc + seg) / total)
      alp.push(alpha(pi, acc / total), alpha(pi, (acc + seg) / total))
      acc += seg
    }
  })
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('aDist', new THREE.Float32BufferAttribute(dist, 1))
  g.setAttribute('aAlpha', new THREE.Float32BufferAttribute(alp, 1))
  return g
}

const arcPath = (r: number, a0: number, a1: number, steps = 64): [number, number][] =>
  Array.from({ length: steps + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / steps
    return [Math.cos(a) * r, Math.sin(a) * r]
  })

/** A ring made of arcs: `gaps` evenly spaced breaks of `gapFrac` of the circle each. */
function brokenRing(r: number, gaps: number, gapFrac: number, offset = 0): [number, number][][] {
  const seg = (Math.PI * 2) / gaps
  return Array.from({ length: gaps }, (_, i) => arcPath(r, offset + i * seg + seg * gapFrac * 0.5, offset + (i + 1) * seg - seg * gapFrac * 0.5, 48))
}

export class OrbRenderer {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10)
  private composer: EffectComposer | null = null
  private bloom: UnrealBloomPass | null = null
  private orb = new THREE.Group()
  private inner = new THREE.Group()
  private mid = new THREE.Group()
  private outer = new THREE.Group()
  private glyphs = new THREE.Group()
  private bgMat: THREE.ShaderMaterial
  private coreMat: THREE.ShaderMaterial
  private mats: Record<'mark' | 'inner' | 'mid' | 'outer' | 'ticks' | 'glyph' | 'links', THREE.ShaderMaterial>
  private tickGeo: THREE.BufferGeometry
  private particles: THREE.Points | null = null
  private particleMat: THREE.ShaderMaterial
  private nodes: THREE.Points
  private links: THREE.LineSegments
  private visual: Visual = { ...VISUALS.DORMANT }
  private scanAngle = 0
  private time = 0
  private last = 0
  private lastRender = 0
  private raf = 0
  private width = 1
  private height = 1
  private scale = 1
  private quality: Quality | null = null
  private agentIntensity = new Map<AgentId, number>()
  private resizeObserver: ResizeObserver

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly getInputs: () => OrbInputs,
    private readonly onFrame?: (scale: number) => void,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' })
    this.renderer.setClearColor(0x020305, 1)

    const fsGeo = new THREE.PlaneGeometry(2, 2)
    const fsUniforms = () => ({ uRes: { value: new THREE.Vector2() }, uScale: { value: 1 }, uTime: { value: 0 }, uTint: { value: new THREE.Color() }, uIntensity: { value: 1 } })
    this.bgMat = new THREE.ShaderMaterial({ vertexShader: S.fullscreenVert, fragmentShader: S.backgroundFrag, uniforms: fsUniforms(), depthTest: false, depthWrite: false })
    this.coreMat = new THREE.ShaderMaterial({
      vertexShader: S.fullscreenVert,
      fragmentShader: S.coreFrag,
      uniforms: {
        ...fsUniforms(),
        uCore: { value: 0 },
        uPulse: { value: 0 },
        uPoint: { value: 0 },
        uRing: { value: 0 },
        uScan: { value: 0 },
        uScanAngle: { value: 0 },
        uFlare: { value: 0 },
        uDistort: { value: 0 },
        uInner: { value: R.inner },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    const bg = new THREE.Mesh(fsGeo, this.bgMat)
    bg.frustumCulled = false
    bg.renderOrder = -2
    const core = new THREE.Mesh(fsGeo, this.coreMat)
    core.frustumCulled = false
    core.renderOrder = -1
    this.scene.add(bg, core, this.orb)

    this.mats = { mark: lineMaterial(), inner: lineMaterial(), mid: lineMaterial(), outer: lineMaterial(), ticks: lineMaterial(), glyph: lineMaterial(), links: lineMaterial() }

    // A and P structural frames, faded toward their outer ends so they read as optics, not lettering.
    const { a, p } = markPolylines()
    this.orb.add(new THREE.LineSegments(segments([a, p], (_pi, t) => 0.35 + 0.65 * Math.sin(Math.PI * Math.min(1, t * 1.1))), this.mats.mark))

    this.inner.add(new THREE.LineSegments(segments([...brokenRing(R.inner * 0.86, 3, 0.18), ...brokenRing(R.inner * 0.74, 12, 0.55, 0.2)]), this.mats.inner))
    this.mid.add(new THREE.LineSegments(segments([arcPath(R.mid, 0, Math.PI * 2, 256), ...brokenRing(R.mid + 0.05, 4, 0.62, Math.PI / 4)], (pi) => (pi === 0 ? 0.55 : 1)), this.mats.mid))
    // The outer ring breaks where the A and P frames pass through it.
    this.outer.add(new THREE.LineSegments(segments([arcPath(R.outer, 0.32, Math.PI - 0.32, 128), arcPath(R.outer, Math.PI + 0.32, Math.PI * 2 - 0.32, 128)]), this.mats.outer))
    this.tickGeo = segments(Array.from({ length: TICKS }, () => [[0, 0], [0, 0]] as [number, number][]), (pi) => (pi % 12 === 0 ? 1 : 0.45))
    this.outer.add(new THREE.LineSegments(this.tickGeo, this.mats.ticks))
    const glyphPaths: [number, number][][] = []
    for (let i = 0; i < 18; i++) {
      const a0 = (i / 18) * Math.PI * 2
      glyphPaths.push(arcPath(R.glyph, a0, a0 + 0.06 + (i % 3) * 0.04, 6))
      if (i % 4 === 0) glyphPaths.push([[Math.cos(a0) * (R.glyph - 0.03), Math.sin(a0) * (R.glyph - 0.03)], [Math.cos(a0) * (R.glyph + 0.05), Math.sin(a0) * (R.glyph + 0.05)]])
    }
    this.glyphs.add(new THREE.LineSegments(segments(glyphPaths, () => 0.6), this.mats.glyph))
    this.orb.add(this.inner, this.mid, this.outer, this.glyphs)

    this.particleMat = new THREE.ShaderMaterial({
      vertexShader: S.particleVert,
      fragmentShader: S.particleFrag,
      uniforms: { uTime: { value: 0 }, uSpeed: { value: 0.4 }, uPull: { value: 0 }, uSize: { value: 2.2 }, uPixelRatio: { value: 1 }, uScale: { value: 1 }, uColor: { value: new THREE.Color(0.8, 0.9, 1) }, uAlpha: { value: 0.4 } },
      transparent: true,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    })

    const slots = Object.keys(AGENT_SLOTS) as AgentId[]
    const nodeGeo = new THREE.BufferGeometry()
    nodeGeo.setAttribute('position', new THREE.Float32BufferAttribute(slots.flatMap((id) => [Math.cos(AGENT_SLOTS[id]) * R.orbit, Math.sin(AGENT_SLOTS[id]) * R.orbit, 0]), 3))
    nodeGeo.setAttribute('aIntensity', new THREE.Float32BufferAttribute(new Float32Array(slots.length), 1))
    nodeGeo.setAttribute('aPulse', new THREE.Float32BufferAttribute(new Float32Array(slots.length), 1))
    this.nodes = new THREE.Points(
      nodeGeo,
      new THREE.ShaderMaterial({
        vertexShader: S.nodeVert,
        fragmentShader: S.nodeFrag,
        uniforms: { uTime: { value: 0 }, uPixelRatio: { value: 1 }, uSize: { value: 26 }, uColor: { value: new THREE.Color(0.8, 0.92, 1) } },
        transparent: true,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      }),
    )
    this.links = new THREE.LineSegments(
      segments(slots.map((id) => [[Math.cos(AGENT_SLOTS[id]) * 1.04, Math.sin(AGENT_SLOTS[id]) * 1.04], [Math.cos(AGENT_SLOTS[id]) * (R.orbit - 0.09), Math.sin(AGENT_SLOTS[id]) * (R.orbit - 0.09)]])),
      this.mats.links,
    )
    this.orb.add(this.links, this.nodes)

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(canvas)
    this.resize()
    this.raf = requestAnimationFrame(this.loop)
    document.addEventListener('visibilitychange', this.onVisibility)
  }

  private onVisibility = (): void => {
    cancelAnimationFrame(this.raf)
    if (!document.hidden) {
      this.last = performance.now()
      this.raf = requestAnimationFrame(this.loop)
    }
  }

  private applyQuality(q: Quality): void {
    if (this.quality === q) return
    this.quality = q
    const preset = QUALITY[q]
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, preset.pixelRatio))
    if (this.particles) {
      this.orb.remove(this.particles)
      this.particles.geometry.dispose()
    }
    const n = preset.particles
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3))
    const seed = new Float32Array(n)
    const radius = new Float32Array(n)
    const angle = new Float32Array(n)
    const speed = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      seed[i] = Math.random()
      // Mostly in the optical band between the rings, a few drifting outside.
      radius[i] = Math.random() < 0.8 ? 1.05 + Math.pow(Math.random(), 1.6) * 0.95 : 2.0 + Math.random() * 0.8
      angle[i] = Math.random() * Math.PI * 2
      speed[i] = (0.02 + Math.random() * 0.08) * (Math.random() < 0.5 ? -1 : 1)
    }
    g.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 1))
    g.setAttribute('aRadius', new THREE.Float32BufferAttribute(radius, 1))
    g.setAttribute('aAngle', new THREE.Float32BufferAttribute(angle, 1))
    g.setAttribute('aSpeed', new THREE.Float32BufferAttribute(speed, 1))
    this.particles = new THREE.Points(g, this.particleMat)
    this.particles.frustumCulled = false
    this.scene.add(this.particles)

    this.composer?.dispose()
    this.composer = null
    this.bloom = null
    if (preset.bloom) {
      this.composer = new EffectComposer(this.renderer)
      this.composer.addPass(new RenderPass(this.scene, this.camera))
      this.bloom = new UnrealBloomPass(new THREE.Vector2(this.width, this.height), preset.bloomStrength, 0.32, 0.42)
      // No OutputPass: shader colors are authored for display; sRGB re-encoding would lift the near-black.
      this.composer.addPass(this.bloom)
    }
    this.resize()
  }

  private resize(): void {
    const w = this.canvas.clientWidth || 1
    const h = this.canvas.clientHeight || 1
    this.width = w
    this.height = h
    this.renderer.setSize(w, h, false)
    this.composer?.setSize(w, h)
    this.camera.left = -w / 2
    this.camera.right = w / 2
    this.camera.top = h / 2
    this.camera.bottom = -h / 2
    this.camera.updateProjectionMatrix()
    this.scale = Math.min(w / (2 * EXTENT.x), h / (2 * EXTENT.y))
    this.orb.scale.setScalar(this.scale)
  }

  private loop = (now: number): void => {
    this.raf = requestAnimationFrame(this.loop)
    const inputs = this.getInputs()
    this.applyQuality(inputs.quality)
    const preset = QUALITY[inputs.quality]
    const audioActive = inputs.mic.rms > 0.01 || inputs.out.rms > 0.005
    const fps = targetFps(inputs.state, audioActive || inputs.bootT !== null || inputs.agents.length > 0, preset)
    if (now - this.lastRender < 1000 / fps - 1) return
    const dt = Math.min(0.1, (now - (this.last || now)) / 1000)
    this.last = now
    this.lastRender = now
    this.update(inputs, dt)
    if (this.composer) this.composer.render()
    else this.renderer.render(this.scene, this.camera)
    this.onFrame?.(this.scale)
  }

  private update(inputs: OrbInputs, dt: number): void {
    this.time += dt
    // Inertia: ease toward the state's targets (~250ms time constant).
    this.visual = lerpVisual(this.visual, VISUALS[inputs.state], 1 - Math.exp(-dt / 0.25))
    const v = this.visual
    const boot = inputs.bootT !== null ? bootFrame(inputs.bootT) : inputs.state === 'DORMANT' ? { ...BOOT_DONE, mark: 0.35, point: 0.6 } : BOOT_DONE
    const dpr = this.renderer.getPixelRatio()
    const tint = new THREE.Color(v.tint[0], v.tint[1], v.tint[2])

    // Voice → visuals. User speech drives the outer ticks; JARVIS speech drives the core.
    const micLevel = Math.min(1, inputs.mic.rms * 9) * v.micGain
    const outLevel = Math.min(1, inputs.out.rms * 4.5)

    for (const m of [this.bgMat, this.coreMat]) {
      m.uniforms.uRes!.value.set(this.width * dpr, this.height * dpr)
      m.uniforms.uScale!.value = this.scale * dpr
      m.uniforms.uTime!.value = this.time
      ;(m.uniforms.uTint!.value as THREE.Color).copy(tint)
      m.uniforms.uIntensity!.value = v.intensity
    }
    this.scanAngle -= dt * (0.8 + v.scan * 2.2)
    const cu = this.coreMat.uniforms
    cu.uCore!.value = v.core * boot.core + micLevel * 0.15
    cu.uPulse!.value = outLevel
    cu.uPoint!.value = boot.point
    cu.uRing!.value = v.ring * boot.inner
    cu.uScan!.value = v.scan
    cu.uScanAngle!.value = this.scanAngle
    cu.uFlare!.value = boot.flare
    cu.uDistort!.value = v.distort + outLevel * 0.35

    this.inner.rotation.z += dt * v.innerSpeed
    this.mid.rotation.z += dt * v.midSpeed
    this.outer.rotation.z += dt * v.outerSpeed
    this.glyphs.rotation.z -= dt * v.outerSpeed * 0.6

    const lineColor = tint.clone().lerp(new THREE.Color(1, 1, 1), 0.25)
    const setLine = (m: THREE.ShaderMaterial, alpha: number, progress = 1) => {
      ;(m.uniforms.uColor!.value as THREE.Color).copy(lineColor)
      m.uniforms.uAlpha!.value = alpha * v.intensity
      m.uniforms.uProgress!.value = progress
    }
    setLine(this.mats.mark, 0.16 + v.ring * 0.14, boot.mark)
    setLine(this.mats.inner, 0.5 * v.ring, boot.inner)
    setLine(this.mats.mid, 0.38 * v.ring, boot.outer)
    setLine(this.mats.outer, 0.3 * v.ring, boot.outer)
    setLine(this.mats.ticks, (0.32 + micLevel * 0.5) * v.ring, boot.outer)
    setLine(this.mats.glyph, 0.22 * v.ring, boot.outer)
    this.updateTicks(inputs.mic.bands, micLevel)

    const pu = this.particleMat.uniforms
    pu.uTime!.value = this.time
    pu.uSpeed!.value = v.particleSpeed
    pu.uPull!.value = v.pull * (0.3 + micLevel)
    pu.uAlpha!.value = v.particleAlpha * boot.particles * v.intensity
    pu.uPixelRatio!.value = dpr
    pu.uScale!.value = this.scale
    ;(pu.uColor!.value as THREE.Color).copy(lineColor)

    this.updateAgents(inputs.agents, dt, dpr, lineColor)
  }

  private updateTicks(bands: Float32Array, level: number): void {
    const pos = this.tickGeo.getAttribute('position') as THREE.BufferAttribute
    for (let i = 0; i < TICKS; i++) {
      const a = (i / TICKS) * Math.PI * 2
      // Map ticks symmetrically onto the 8 voice bands so speech blooms evenly around the ring.
      const band = bands[Math.floor((Math.abs(Math.sin(a * 0.5)) * 7.99)) % bands.length] ?? 0
      const len = (i % 12 === 0 ? 0.09 : 0.04) + band * level * 0.22
      const r0 = R.tick0
      pos.setXYZ(i * 2, Math.cos(a) * r0, Math.sin(a) * r0, 0)
      pos.setXYZ(i * 2 + 1, Math.cos(a) * (r0 + len), Math.sin(a) * (r0 + len), 0)
    }
    pos.needsUpdate = true
  }

  private updateAgents(agents: AgentVisual[], dt: number, dpr: number, color: THREE.Color): void {
    const slots = Object.keys(AGENT_SLOTS) as AgentId[]
    const intensity = this.nodes.geometry.getAttribute('aIntensity') as THREE.BufferAttribute
    const pulse = this.nodes.geometry.getAttribute('aPulse') as THREE.BufferAttribute
    const linkAlpha = this.links.geometry.getAttribute('aAlpha') as THREE.BufferAttribute
    const k = 1 - Math.exp(-dt / 0.2)
    slots.forEach((id, i) => {
      const a = agents.find((x) => x.id === id)
      const target = !a ? 0 : a.status === 'queued' ? 0.3 : a.status === 'completed' ? 0.45 : a.status === 'failed' ? 0.5 : 1
      const current = (this.agentIntensity.get(id) ?? 0) + (target - (this.agentIntensity.get(id) ?? 0)) * k
      this.agentIntensity.set(id, current)
      intensity.setX(i, current)
      pulse.setX(i, a?.status === 'running' ? 1 : a?.status === 'waiting' ? 0.4 : 0)
      const link = a?.status === 'running' || a?.status === 'waiting' ? current : current * 0.25
      linkAlpha.setX(i * 2, link * 0.8)
      linkAlpha.setX(i * 2 + 1, link * 0.15)
    })
    intensity.needsUpdate = true
    pulse.needsUpdate = true
    linkAlpha.needsUpdate = true
    const nu = (this.nodes.material as THREE.ShaderMaterial).uniforms
    nu.uTime!.value = this.time
    nu.uPixelRatio!.value = dpr
    ;(nu.uColor!.value as THREE.Color).copy(color)
    this.mats.links.uniforms.uAlpha!.value = 0.6
    ;(this.mats.links.uniforms.uColor!.value as THREE.Color).copy(color)
  }

  dispose(): void {
    cancelAnimationFrame(this.raf)
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.resizeObserver.disconnect()
    this.composer?.dispose()
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments || o instanceof THREE.Points) {
        o.geometry.dispose()
        ;(o.material as THREE.Material).dispose()
      }
    })
    this.renderer.dispose()
  }
}
