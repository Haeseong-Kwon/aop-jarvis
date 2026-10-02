import type { RuntimeState } from '@aop/core'
import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import type { AudioLevels } from '../audio/levels'
import { BOOT_DONE, bootFrame, DEFAULT_TAU, EASE_TAU, lerpVisual, QUALITY, targetFps, VISUALS, type Quality, type Visual } from './params'
import { AOPOrbScene, DEFAULT_DEBUG, type AgentVisual, type DebugFlags, type Telemetry } from './scene'
import * as S from './shaders'

export { AGENT_SLOTS, ORBIT_RADIUS, type AgentVisual, type AgentVisualStatus, type DebugFlags, DEFAULT_DEBUG } from './scene'

export type OrbMode = 'cinematic' | 'standard' | 'developer' | 'ambient'

export interface OrbInputs {
  state: RuntimeState
  /** Seconds since boot start, or null when not booting. */
  bootT: number | null
  mic: AudioLevels
  out: AudioLevels
  agents: AgentVisual[]
  quality: Quality
  telemetry?: Telemetry | null
  mode?: OrbMode
  debug?: DebugFlags
}

export interface OrbStats {
  fps: number
  frameMs: number
  cpuMs: number
  drawCalls: number
  triangles: number
  programs: number
  geometries: number
  textures: number
  particles: number
  pixelRatio: number
  quality: Quality
  transmission: boolean
  bloom: boolean
  degraded: number
}

/** The z = 0 plane is fitted to this extent (orb units) — DOM overlays use the same fit. */
export const EXTENT = { x: 2.9, y: 2.55 }
const BASE_FOV = 30
const TARGET = new THREE.Vector3(0, 0, -0.15)

export class OrbRenderer {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.1, 60)
  private orb: AOPOrbScene
  private bg: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>
  private composer!: EffectComposer
  private bloomComposer: EffectComposer | null = null
  private bloomPass: UnrealBloomPass | null = null
  private compositePass!: ShaderPass
  private visual: Visual = { ...VISUALS.DORMANT }
  private prevState: RuntimeState | null = null
  private time = 0
  private scanAngle = 0
  private ignite = 0
  private outEnv = { level: 0, low: 0, mid: 0, high: 0 }
  private outQuietMs = 1000
  private last = 0
  private lastRender = 0
  private raf = 0
  private width = 1
  private height = 1
  private baseDist = 10
  private quality: Quality | null = null
  private debug: DebugFlags = { ...DEFAULT_DEBUG }
  private explode = 0
  private resizeObserver: ResizeObserver
  private occluded = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>()
  private hidden: THREE.Object3D[] = []
  // Adaptive quality + stats.
  private dynamicRatio = 1
  private degraded = 0
  private frameEma = 16
  private cpuEma = 4
  private slowFor = 0
  private fastFor = 0
  private fpsCount = 0
  private fpsAt = 0
  private fps = 0
  private lastStats: OrbStats | null = null
  private snapNext = false

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly getInputs: () => OrbInputs,
    private readonly onFrame?: (stats: OrbStats) => void,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance', stencil: false })
    this.renderer.setClearColor(0x010203, 1)
    this.renderer.toneMapping = THREE.NoToneMapping // tone mapping happens once, in the composite pass
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace
    this.renderer.info.autoReset = false

    this.bg = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({ vertexShader: S.background.vertex, fragmentShader: S.background.fragment, uniforms: { uTint: { value: new THREE.Color(0.7, 0.86, 1) }, uLift: { value: 1 }, uAspect: { value: 1 } }, depthWrite: false, depthTest: false }),
    )
    this.bg.frustumCulled = false
    this.bg.renderOrder = -100
    this.scene.add(this.bg)

    const initial = this.getInputs()
    this.orb = new AOPOrbScene(QUALITY[initial.quality])
    this.scene.add(this.orb.root)
    this.scene.add(this.camera)

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(canvas)
    this.applyQuality(initial.quality)
    this.raf = requestAnimationFrame(this.loop)
    document.addEventListener('visibilitychange', this.onVisibility)
  }

  /** Jump straight to the current state's visuals (capture harness / tests — the product always eases). */
  snap(): void {
    this.snapNext = true
  }

  stats(): OrbStats | null {
    return this.lastStats
  }

  private onVisibility = (): void => {
    cancelAnimationFrame(this.raf)
    if (!document.hidden) {
      this.last = performance.now()
      this.raf = requestAnimationFrame(this.loop)
    }
  }

  private preset() {
    return QUALITY[this.quality ?? 'HIGH']
  }

  private applyQuality(q: Quality): void {
    if (this.quality === q) return
    this.quality = q
    const preset = QUALITY[q]
    this.dynamicRatio = Math.min(window.devicePixelRatio || 1, preset.pixelRatio)
    this.degraded = 0
    this.orb.setQuality(preset, this.debug.glass)
    this.renderer.transmissionResolutionScale = preset.transmissionScale
    this.buildPost()
  }

  private buildPost(): void {
    const preset = this.preset()
    this.composer?.dispose()
    this.bloomComposer?.dispose()
    this.renderer.setPixelRatio(this.dynamicRatio)
    const w = this.width
    const h = this.height
    const rt = new THREE.WebGLRenderTarget(w * this.dynamicRatio, h * this.dynamicRatio, { type: THREE.HalfFloatType, samples: preset.msaa })
    this.composer = new EffectComposer(this.renderer, rt)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.compositePass = new ShaderPass(
      new THREE.ShaderMaterial({
        vertexShader: S.composite.vertex,
        fragmentShader: S.composite.fragment,
        uniforms: {
          tDiffuse: { value: null },
          tBloom: { value: null },
          uBloom: { value: 0.9 },
          uStreak: { value: 0.09 },
          uExposure: { value: 1.05 },
          uVignette: { value: 0.5 },
          uGrain: { value: 0.005 },
          uCA: { value: 0.002 },
          uTime: { value: 0 },
          uTexel: { value: new THREE.Vector2(1 / w, 1 / h) },
          uAspect: { value: w / h },
          uHasBloom: { value: 0 },
        },
      }),
    )
    this.composer.addPass(this.compositePass)
    this.bloomComposer = null
    this.bloomPass = null
    if (preset.bloom) {
      const brt = new THREE.WebGLRenderTarget(w * this.dynamicRatio * preset.bloomScale, h * this.dynamicRatio * preset.bloomScale, { type: THREE.HalfFloatType })
      this.bloomComposer = new EffectComposer(this.renderer, brt)
      this.bloomComposer.renderToScreen = false
      this.bloomComposer.setPixelRatio(this.dynamicRatio * preset.bloomScale)
      this.bloomComposer.addPass(new RenderPass(this.scene, this.camera))
      this.bloomPass = new UnrealBloomPass(new THREE.Vector2(w * preset.bloomScale, h * preset.bloomScale), preset.bloomStrength, 0.22, 1.25)
      this.bloomComposer.addPass(this.bloomPass)
      this.bloomComposer.setSize(w, h)
    }
    this.composer.setSize(w, h)
  }

  private resize(): void {
    const w = this.canvas.clientWidth || 1
    const h = this.canvas.clientHeight || 1
    this.width = w
    this.height = h
    this.renderer.setSize(w, h, false)
    this.composer?.setSize(w, h)
    this.bloomComposer?.setSize(w, h)
    this.bloomPass?.setSize(w * this.preset().bloomScale, h * this.preset().bloomScale)
    // Fit the z = 0 plane to EXTENT exactly, so DOM overlays (agent labels) can use the same math.
    const halfH = w / h > EXTENT.x / EXTENT.y ? EXTENT.y : (EXTENT.x * h) / w
    this.baseDist = halfH / Math.tan(THREE.MathUtils.degToRad(BASE_FOV / 2))
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    if (this.compositePass) {
      this.compositePass.uniforms.uTexel!.value.set(1 / w, 1 / h)
      this.compositePass.uniforms.uAspect!.value = w / h
    }
    this.bg.material.uniforms.uAspect!.value = w / h
  }

  private loop = (now: number): void => {
    this.raf = requestAnimationFrame(this.loop)
    const inputs = this.getInputs()
    this.applyQuality(inputs.quality)
    if (inputs.debug) this.setDebug(inputs.debug)
    const preset = this.preset()
    const ambient = inputs.mode === 'ambient'
    const audioActive = inputs.mic.rms > 0.01 || inputs.out.rms > 0.005 || this.ignite > 0.02
    let fps = targetFps(inputs.state, audioActive || inputs.bootT !== null || inputs.agents.length > 0, preset)
    if (ambient) fps = Math.min(fps, 24)
    if (now - this.lastRender < 1000 / fps - 1) return
    const interval = now - (this.lastRender || now)
    const dt = Math.min(0.1, (now - (this.last || now)) / 1000)
    this.last = now
    this.lastRender = now

    const t0 = performance.now()
    this.renderer.info.reset()
    this.update(inputs, this.debug.freeze ? 0 : dt, dt)
    this.render()
    const cpuMs = performance.now() - t0
    this.measure(now, interval, cpuMs, fps)
  }

  private update(inputs: OrbInputs, dt: number, realDt: number): void {
    this.time += dt
    const state = inputs.state
    // Daily wake: a short ignition impulse, not the boot sequence.
    if (this.prevState !== null && state !== this.prevState) {
      if (state === 'LISTENING' && (this.prevState === 'DORMANT' || this.prevState === 'ONLINE' || this.prevState === 'SLEEP')) this.ignite = Math.max(this.ignite, 1)
    }
    this.prevState = state
    const tau = EASE_TAU[state] ?? DEFAULT_TAU
    this.visual = this.snapNext ? { ...VISUALS[state] } : lerpVisual(this.visual, VISUALS[state], 1 - Math.exp(-realDt / tau))
    this.snapNext = false
    const v = this.visual
    const boot = inputs.bootT !== null ? bootFrame(inputs.bootT) : BOOT_DONE

    // Output audio → features with speech-like attack/release (fast up, smooth decay). Speech onset ignites.
    const b = inputs.out.bands
    const avg = (i0: number, i1: number) => {
      let s = 0
      for (let i = i0; i <= i1; i++) s += b[i] ?? 0
      return s / (i1 - i0 + 1)
    }
    const outLevel = Math.min(1, inputs.out.rms * 5)
    const env = this.outEnv
    const follow = (cur: number, target: number) => cur + (target - cur) * (target > cur ? 1 - Math.exp(-realDt / 0.03) : 1 - Math.exp(-realDt / 0.18))
    env.level = follow(env.level, outLevel)
    env.low = follow(env.low, Math.min(1, avg(0, 2) * outLevel * 3))
    env.mid = follow(env.mid, Math.min(1, avg(3, 5) * outLevel * 3.5))
    env.high = follow(env.high, Math.min(1, avg(6, 7) * outLevel * 5))
    if (outLevel < 0.03) this.outQuietMs += realDt * 1000
    else {
      if (this.outQuietMs > 220) this.ignite = Math.max(this.ignite, 0.55)
      this.outQuietMs = 0
    }
    this.ignite *= Math.exp(-realDt / 0.22)

    const micLevel = Math.min(1, inputs.mic.rms * 9) * v.micGain
    this.scanAngle -= dt * (0.4 + v.scan * 1.6)

    // Camera rig: sub-degree orbital drift + breathing; wake push, thinking focus, execution depth.
    const yaw = THREE.MathUtils.degToRad(0.7) * Math.sin((this.time * Math.PI * 2) / 23) + THREE.MathUtils.degToRad(32) * this.explode
    const pitch = THREE.MathUtils.degToRad(0.45) * Math.sin((this.time * Math.PI * 2) / 31 + 1) + THREE.MathUtils.degToRad(8) * this.explode
    const dist = this.baseDist * v.camDist * (1 - this.ignite * 0.012) * (1 + 0.0025 * Math.sin((this.time * Math.PI * 2) / 9)) * (1 + this.explode * 0.15)
    this.camera.position.set(TARGET.x + Math.sin(yaw) * Math.cos(pitch) * dist, TARGET.y + Math.sin(pitch) * dist, TARGET.z + Math.cos(yaw) * Math.cos(pitch) * dist)
    this.camera.lookAt(TARGET)
    const fov = BASE_FOV * v.camFov
    if (Math.abs(this.camera.fov - fov) > 1e-4) {
      this.camera.fov = fov
      this.camera.updateProjectionMatrix()
    }
    this.explode += ((this.debug.layers ? 1 : 0) - this.explode) * (1 - Math.exp(-realDt / 0.4))
    this.orb.explode(this.explode, v.depth)

    ;(this.bg.material.uniforms.uTint!.value as THREE.Color).setRGB(v.tint[0], v.tint[1], v.tint[2])
    this.bg.material.uniforms.uLift!.value = v.nucleus * boot.core

    this.orb.update({
      time: this.time,
      dt,
      v,
      boot,
      out: { ...env, bands: inputs.out.bands },
      mic: { level: micLevel, bands: inputs.mic.bands },
      ignite: this.ignite,
      scanAngle: this.scanAngle,
      agents: inputs.agents,
      telemetry: inputs.telemetry ?? null,
      stateLabel: state.replace('_', ' '),
      pixelRatio: this.dynamicRatio,
      viewHeight: this.height,
    })

    const cu = this.compositePass.uniforms
    cu.uTime!.value = this.time
    cu.uStreak!.value = this.preset().streak ? 0.03 + boot.flare * 0.25 + this.ignite * 0.05 : 0
  }

  /** Selective bloom: only objects tagged 'bloom' emit; opaque structure occludes as black; the rest is hidden. */
  private render(): void {
    const useBloom = !!this.bloomComposer && this.debug.bloom
    if (useBloom) {
      this.bg.visible = false
      this.orb.root.traverseVisible((o) => {
        const t = o.userData.orb as string | undefined
        if (t === 'bloom') return
        if (t === 'hide' || o instanceof THREE.Points || o instanceof THREE.Light || o instanceof THREE.Box3Helper) {
          if (o.visible && !(o instanceof THREE.Light)) this.hidden.push(o)
          return
        }
        if (o instanceof THREE.Mesh) {
          this.occluded.set(o, o.material)
          o.material = this.orb.mats.occluder
        }
      })
      for (const o of this.hidden) o.visible = false
      this.renderer.setClearColor(0x000000, 1)
      this.bloomComposer!.render()
      for (const o of this.hidden) o.visible = true
      this.hidden.length = 0
      for (const [m, mat] of this.occluded) m.material = mat
      this.occluded.clear()
      this.bg.visible = true
      this.renderer.setClearColor(0x010203, 1)
      this.compositePass.uniforms.tBloom!.value = this.bloomComposer!.readBuffer.texture
    }
    this.compositePass.uniforms.uHasBloom!.value = useBloom ? 1 : 0
    this.composer.render()
  }

  /** Frame stats + adaptive degradation: lower the internal pixel ratio first, then drop transmission. */
  private measure(now: number, interval: number, cpuMs: number, targetFps: number): void {
    this.frameEma += (interval - this.frameEma) * 0.08
    this.cpuEma += (cpuMs - this.cpuEma) * 0.08
    this.fpsCount++
    if (now - this.fpsAt >= 1000) {
      this.fps = (this.fpsCount * 1000) / (now - this.fpsAt || 1000)
      this.fpsCount = 0
      this.fpsAt = now
    }
    const budget = 1000 / targetFps
    const preset = this.preset()
    if (interval > 0 && interval < 500) {
      if (this.frameEma > budget * 1.35) {
        this.slowFor += interval
        this.fastFor = 0
      } else if (this.frameEma < budget * 1.08) {
        this.fastFor += interval
        this.slowFor = 0
      }
    }
    if (this.slowFor > 2500) {
      this.slowFor = 0
      if (this.dynamicRatio > preset.minPixelRatio + 0.01) {
        this.dynamicRatio = Math.max(preset.minPixelRatio, this.dynamicRatio - 0.25)
        this.degraded++
        this.buildPost()
      } else if (this.degraded < 99 && preset.transmission) {
        this.orb.setGlass(false)
        this.degraded = 99
      }
    } else if (this.fastFor > 8000 && this.degraded > 0 && this.degraded < 99) {
      this.fastFor = 0
      const cap = Math.min(window.devicePixelRatio || 1, preset.pixelRatio)
      if (this.dynamicRatio < cap) {
        this.dynamicRatio = Math.min(cap, this.dynamicRatio + 0.25)
        this.degraded--
        this.buildPost()
      }
    }
    const info = this.renderer.info
    this.lastStats = {
      fps: this.fps,
      frameMs: this.frameEma,
      cpuMs: this.cpuEma,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs?.length ?? 0,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      particles: this.orb.particleCount(),
      pixelRatio: this.dynamicRatio,
      quality: this.quality ?? 'HIGH',
      transmission: preset.transmission && this.debug.glass && this.degraded < 99,
      bloom: !!this.bloomComposer && this.debug.bloom,
      degraded: this.degraded,
    }
    this.onFrame?.(this.lastStats)
  }

  private setDebug(d: DebugFlags): void {
    const prev = this.debug
    if (prev.layers === d.layers && prev.bounds === d.bounds && prev.ringIds === d.ringIds && prev.bloom === d.bloom && prev.particles === d.particles && prev.glass === d.glass && prev.freeze === d.freeze) return
    this.debug = { ...d }
    this.orb.setDebug(d)
    if (prev.glass !== d.glass) this.orb.setGlass(this.preset().transmission && d.glass && this.degraded < 99)
  }

  dispose(): void {
    cancelAnimationFrame(this.raf)
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.resizeObserver.disconnect()
    this.composer?.dispose()
    this.bloomComposer?.dispose()
    this.orb.dispose()
    this.bg.geometry.dispose()
    this.bg.material.dispose()
    this.renderer.dispose()
  }
}
