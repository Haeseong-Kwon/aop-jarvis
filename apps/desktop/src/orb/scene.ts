// AOPOrbScene — the Orb as a holographic light construct (JARVIS-style): an arc-reactor core inside the O,
// a live voice waveform, seven counter-rotating ring families, radar sweep, shockwaves on speech, and the
// A/P structure drawn as light. The renderer owns camera, post chain and loop; this module owns the scene
// graph and per-frame art direction. Every motion is bound to real state or real audio.
import type { AgentId } from '@aop/core'
import * as THREE from 'three'
import { arcBand } from './geometry'
import { HudLabel } from './hudText'
import { markPolylines, O_INNER_RATIO } from './mark'
import type { BootFrame, QualityPreset, Visual } from './params'
import * as H from './holoShaders'
import * as S from './shaders'

export type AgentVisualStatus = 'queued' | 'running' | 'waiting' | 'failed' | 'completed'
export interface AgentVisual {
  id: AgentId
  status: AgentVisualStatus
}

/** Fixed slots so an agent always appears in the same place. Radians, y up. */
export const AGENT_SLOTS: Record<AgentId, number> = {
  research: (150 * Math.PI) / 180,
  code: (30 * Math.PI) / 180,
  communicator: (90 * Math.PI) / 180,
  operator: (210 * Math.PI) / 180,
  analyst: (330 * Math.PI) / 180,
  reviewer: (270 * Math.PI) / 180,
}
export const ORBIT_RADIUS = 2.25
const SLOT_IDS = Object.keys(AGENT_SLOTS) as AgentId[]

export interface Telemetry {
  cpu: number
  memUsed: number
  memTotal: number
}

export interface DebugFlags {
  layers: boolean
  bounds: boolean
  ringIds: boolean
  bloom: boolean
  particles: boolean
  glass: boolean
  freeze: boolean
}

export const DEFAULT_DEBUG: DebugFlags = { layers: false, bounds: false, ringIds: false, bloom: true, particles: true, glass: true, freeze: false }

export interface SceneFrame {
  time: number
  dt: number
  v: Visual
  boot: BootFrame
  /** JARVIS output: rms + low/mid/high envelopes (0..1) and the raw 8 analyser bands. */
  out: { level: number; low: number; mid: number; high: number; bands: Float32Array }
  /** User input: rms level (already gated by state) + 8 bands from the mic analyser. */
  mic: { level: number; bands: Float32Array }
  /** Speech-onset / wake ignition impulse (decays). */
  ignite: number
  scanAngle: number
  agents: AgentVisual[]
  telemetry: Telemetry | null
  stateLabel: string
  pixelRatio: number
  viewHeight: number
}

type Tag = 'bloom' | 'hide'
const tag = <T extends THREE.Object3D>(o: T, t: Tag): T => {
  o.userData.orb = t
  return o
}
const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const additive = (shader: { vertex: string; fragment: string }, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial =>
  new THREE.ShaderMaterial({ vertexShader: shader.vertex, fragmentShader: shader.fragment, uniforms, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide })

/** Annulus with aU (angle 0..1 over [a0, a1]) and aV (0 inner … 1 outer). */
function annulus(r: number, width: number, segments = 512, a0 = 0, a1 = Math.PI * 2): THREE.BufferGeometry {
  const pos: number[] = []
  const u: number[] = []
  const v: number[] = []
  const idx: number[] = []
  for (let i = 0; i <= segments; i++) {
    const t = i / segments
    const a = a0 + (a1 - a0) * t
    for (const [k, rr] of [
      [0, r - width / 2],
      [1, r + width / 2],
    ] as const) {
      pos.push(Math.cos(a) * rr, Math.sin(a) * rr, 0)
      u.push(t)
      v.push(k)
    }
    if (i < segments) {
      const b = i * 2
      idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('aU', new THREE.Float32BufferAttribute(u, 1))
  g.setAttribute('aV', new THREE.Float32BufferAttribute(v, 1))
  g.setIndex(idx)
  return g
}

type V2 = [number, number]
/** Ribbon along a polyline with aS (arc length 0..1) and aSide (−1 … +1). */
function polylineRibbon(points: V2[], width: number, closed: boolean): THREE.BufferGeometry {
  const pts = closed ? [...points, points[0]!] : points
  const lens = [0]
  for (let i = 1; i < pts.length; i++) lens.push(lens[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]))
  const total = lens[lens.length - 1]!
  const pos: number[] = []
  const s: number[] = []
  const side: number[] = []
  const idx: number[] = []
  pts.forEach((p, i) => {
    const prev = pts[Math.max(0, i - 1)]!
    const next = pts[Math.min(pts.length - 1, i + 1)]!
    let tx = next[0] - prev[0]
    let ty = next[1] - prev[1]
    const l = Math.hypot(tx, ty) || 1
    tx /= l
    ty /= l
    const nx = -ty * (width / 2)
    const ny = tx * (width / 2)
    pos.push(p[0] + nx, p[1] + ny, 0, p[0] - nx, p[1] - ny, 0)
    s.push(lens[i]! / total, lens[i]! / total)
    side.push(1, -1)
    if (i < pts.length - 1) {
      const b = i * 2
      idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2)
    }
  })
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('aS', new THREE.Float32BufferAttribute(s, 1))
  g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1))
  g.setIndex(idx)
  return g
}

interface RingSpec {
  name: string
  r: number
  width: number
  mode: 0 | 1 | 2 | 3
  count?: number
  duty?: number
  major?: number
  /** Base angular speed (rad/s); multiplied by the state's spin. */
  speed: number
  z: number
  /** Brightness relative to the ring family. */
  gain: number
  hl?: { speed: number; width: number; gain: number }
  core?: number
}

// Seven ring families, inside → out. Alternating directions and speeds create the layered JARVIS motion.
const RING_SPECS: RingSpec[] = [
  { name: 'EnergyRing', r: 1.085, width: 0.012, mode: 0, speed: 0, z: 0.04, gain: 1.4, hl: { speed: 0.55, width: 0.06, gain: 3 }, core: 1.2 },
  { name: 'DashRing', r: 1.18, width: 0.022, mode: 1, count: 96, duty: 0.55, speed: 0.32, z: 0.07, gain: 0.9 },
  { name: 'ArcRing', r: 1.3, width: 0.05, mode: 3, count: 3, duty: 0.78, speed: -0.13, z: 0.1, gain: 0.55, hl: { speed: -0.13, width: 0.08, gain: 1.6 } },
  { name: 'FringeRing', r: 1.36, width: 0.03, mode: 2, count: 240, duty: 0.3, major: 10, speed: -0.13, z: 0.1, gain: 0.8 },
  { name: 'TickRing', r: 1.5, width: 0.06, mode: 2, count: 180, duty: 0.22, major: 15, speed: 0.045, z: 0.14, gain: 0.9 },
  { name: 'SegmentRing', r: 1.64, width: 0.014, mode: 3, count: 8, duty: 0.86, speed: -0.075, z: 0.17, gain: 1, hl: { speed: 0.22, width: 0.05, gain: 2.4 } },
  { name: 'HairRing', r: 1.79, width: 0.005, mode: 0, speed: 0, z: 0.2, gain: 0.9, core: 0.6 },
  { name: 'BracketRing', r: 2.0, width: 0.016, mode: 3, count: 4, duty: 0.3, speed: 0.035, z: 0.24, gain: 1.1 },
]

const WAVE_POINTS = 240
const SHOCKS = 6

interface Shock {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>
  age: number
  strength: number
}

export class AOPOrbScene {
  readonly root = new THREE.Group()
  /** The renderer swaps non-bloom meshes to `occluder` during the bloom pass. */
  readonly mats: { occluder: THREE.MeshBasicMaterial }
  private coreGroup = new THREE.Group()
  private ringGroup = new THREE.Group()
  private frameGroup = new THREE.Group()
  private hud = new THREE.Group()
  private particleGroup = new THREE.Group()
  private agentGroup = new THREE.Group()
  private debugGroup = new THREE.Group()

  private coreMat: THREE.ShaderMaterial
  private oRingMat: THREE.ShaderMaterial
  private oRingOuterMat: THREE.ShaderMaterial
  private rings: { spec: RingSpec; mesh: THREE.Mesh; mat: THREE.ShaderMaterial; hl: number }[] = []
  private markers: THREE.Group
  private markerMat: THREE.MeshBasicMaterial
  private sweepMat: THREE.ShaderMaterial
  private wave: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>
  private waveGlow: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>
  private waveAmp = new Float32Array(WAVE_POINTS)
  private shocks: Shock[] = []
  private nextShock = 0
  private frameEdgeMat: THREE.ShaderMaterial
  private frameGlowMat: THREE.ShaderMaterial
  private frameFillMat: THREE.ShaderMaterial
  private framePulse = 0
  private flash = 0
  private prevOut = 0
  private shockCooldown = 0
  private bootFlareFired = false
  private cpuGauge: THREE.ShaderMaterial
  private memGauge: THREE.ShaderMaterial
  private labels: { deg: HudLabel[]; title: HudLabel; state: HudLabel; cpu: HudLabel; mem: HudLabel; agents: HudLabel }
  private labelClock = 0
  private sparks: { points: THREE.Points; mat: THREE.ShaderMaterial; far: boolean }[] = []
  private nodeGlows: THREE.ShaderMaterial[] = []
  private nodeRings: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[] = []
  private linkMat: THREE.ShaderMaterial
  private agentIntensity = new Map<AgentId, number>()

  constructor(preset: QualityPreset) {
    this.mats = { occluder: new THREE.MeshBasicMaterial({ color: 0x000000 }) }
    this.root.name = 'AOPOrbScene'
    this.root.add(this.coreGroup, this.frameGroup, this.ringGroup, this.hud, this.particleGroup, this.agentGroup, this.debugGroup)
    const ice = () => new THREE.Color(0.62, 0.86, 1)

    // ------------------------------------------------------------- Core: arc reactor inside the O
    this.coreMat = additive(H.core, {
      uSize: { value: 2.0 },
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uFlash: { value: 0 },
      uIgnite: { value: 0 },
      uPoint: { value: 0 },
      uSwirl: { value: 0.3 },
      uInner: { value: O_INNER_RATIO },
      uLow: { value: 0 },
      uColor: { value: ice() },
    })
    const coreMesh = tag(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.coreMat), 'bloom')
    coreMesh.name = 'ArcReactorCore'
    coreMesh.position.z = -0.05
    coreMesh.frustumCulled = false
    // The O itself: a luminous band between the inner and outer radius, with a bright outer rim.
    const ringUniforms = (mode: number, intensity: number) => ({
      uColor: { value: ice() },
      uIntensity: { value: intensity },
      uMode: { value: mode },
      uCount: { value: 1 },
      uDuty: { value: 1 },
      uMajor: { value: 1 },
      uReveal: { value: 1 },
      uHl: { value: 0 },
      uHlWidth: { value: 0.05 },
      uHlGain: { value: 0 },
      uFlicker: { value: 0 },
      uTime: { value: 0 },
      uCore: { value: 0 },
    })
    this.oRingMat = additive(H.ring, ringUniforms(0, 0))
    const oBand = tag(new THREE.Mesh(annulus((1 + O_INNER_RATIO) / 2, 1 - O_INNER_RATIO, 512), this.oRingMat), 'bloom')
    oBand.name = 'OBand'
    this.oRingOuterMat = additive(H.ring, ringUniforms(0, 0))
    const oRim = tag(new THREE.Mesh(annulus(1.0, 0.014, 512), this.oRingOuterMat), 'bloom')
    oRim.name = 'ORim'
    oRim.position.z = 0.01
    this.coreGroup.add(coreMesh, oBand, oRim)

    // Shockwaves (pool).
    for (let i = 0; i < SHOCKS; i++) {
      const mat = additive(H.shock, { uSize: { value: 6 }, uRadius: { value: 1 }, uAlpha: { value: 0 }, uWidth: { value: 0.012 }, uColor: { value: ice() } })
      const mesh = tag(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat), 'bloom')
      mesh.frustumCulled = false
      mesh.position.z = 0.02
      this.shocks.push({ mesh, age: 1, strength: 0 })
      this.coreGroup.add(mesh)
    }

    // ------------------------------------------------------------- Voice waveform ring
    const waveGeo = (width: number) => {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array((WAVE_POINTS + 1) * 2 * 3), 3))
      const s: number[] = []
      const side: number[] = []
      const idx: number[] = []
      for (let i = 0; i <= WAVE_POINTS; i++) {
        s.push(i / WAVE_POINTS, i / WAVE_POINTS)
        side.push(1, -1)
        if (i < WAVE_POINTS) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2)
      }
      g.setAttribute('aS', new THREE.Float32BufferAttribute(s, 1))
      g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1))
      g.setIndex(idx)
      g.userData.width = width
      return g
    }
    const ribbonMat = (intensity: number) => additive(H.ribbon, { uColor: { value: ice() }, uIntensity: { value: intensity }, uReveal: { value: 1 }, uPulse: { value: 0 }, uPulsePos: { value: 0 }, uTime: { value: 0 } })
    this.wave = tag(new THREE.Mesh(waveGeo(0.007), ribbonMat(0)), 'bloom')
    this.waveGlow = tag(new THREE.Mesh(waveGeo(0.05), ribbonMat(0)), 'bloom')
    this.wave.name = 'VoiceWaveform'
    this.wave.frustumCulled = false
    this.waveGlow.frustumCulled = false
    this.wave.position.z = 0.05
    this.waveGlow.position.z = 0.049
    this.coreGroup.add(this.waveGlow, this.wave)

    // ------------------------------------------------------------- Ring families
    for (const spec of RING_SPECS) {
      const mat = additive(H.ring, ringUniforms(spec.mode, 0))
      mat.uniforms.uCount!.value = spec.count ?? 1
      mat.uniforms.uDuty!.value = spec.duty ?? 1
      mat.uniforms.uMajor!.value = spec.major ?? 1
      mat.uniforms.uHlWidth!.value = spec.hl?.width ?? 0.05
      mat.uniforms.uCore!.value = spec.core ?? 0
      const mesh = tag(new THREE.Mesh(annulus(spec.r, spec.width, spec.mode === 0 ? 720 : 1024), mat), 'bloom')
      mesh.name = spec.name
      mesh.position.z = spec.z
      mesh.rotation.z = Math.random() * Math.PI * 2
      this.rings.push({ spec, mesh, mat, hl: Math.random() })
      this.ringGroup.add(mesh)
    }
    // Orbiting triangle markers on the segment ring.
    this.markers = new THREE.Group()
    this.markerMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending })
    const tri = new THREE.CircleGeometry(0.026, 3)
    for (let i = 0; i < 3; i++) {
      const m = tag(new THREE.Mesh(tri, this.markerMat), 'bloom')
      const a = (i / 3) * Math.PI * 2
      m.position.set(Math.cos(a) * 1.7, Math.sin(a) * 1.7, 0)
      m.rotation.z = a + Math.PI
      this.markers.add(m)
    }
    this.markers.position.z = 0.18
    this.ringGroup.add(this.markers)
    // Radar sweep.
    this.sweepMat = additive(H.sweep, { uSize: { value: 4 }, uAngle: { value: 0 }, uIntensity: { value: 0 }, uR0: { value: 1.12 }, uR1: { value: 1.76 }, uColor: { value: ice() } })
    const sweep = tag(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.sweepMat), 'bloom')
    sweep.name = 'RadarSweep'
    sweep.frustumCulled = false
    sweep.position.z = 0.12
    this.ringGroup.add(sweep)

    // ------------------------------------------------------------- A / P drawn as light
    const { a, p } = markPolylines()
    this.frameEdgeMat = ribbonMat(0)
    this.frameGlowMat = ribbonMat(0)
    this.frameFillMat = additive(H.holoFill, { uColor: { value: ice() }, uIntensity: { value: 0 }, uTime: { value: 0 }, uScanPos: { value: 0 } })
    const shape = (pts: V2[]) => new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)))
    for (const [pts, closed] of [
      [a, false],
      [p, true],
    ] as const) {
      const fill = tag(new THREE.Mesh(new THREE.ShapeGeometry(shape(pts)), this.frameFillMat), 'hide')
      const glow = tag(new THREE.Mesh(polylineRibbon(pts, 0.035, closed), this.frameGlowMat), 'bloom')
      const edge = tag(new THREE.Mesh(polylineRibbon(pts, 0.011, closed), this.frameEdgeMat), 'bloom')
      glow.position.z = 0.001
      edge.position.z = 0.002
      this.frameGroup.add(fill, glow, edge)
    }
    this.frameGroup.name = 'AOPFrames'
    this.frameGroup.position.z = -0.1

    // ------------------------------------------------------------- HUD: readouts bound to real telemetry
    this.hud.position.z = 0.3
    const gaugeMat = (start: number, length: number) =>
      new THREE.ShaderMaterial({
        vertexShader: S.gauge.vertex,
        fragmentShader: S.gauge.fragment,
        uniforms: { uColor: { value: ice() }, uAlpha: { value: 0 }, uFill: { value: 0 }, uStart: { value: start }, uLength: { value: length } },
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      })
    const cpuStart = (200 * Math.PI) / 180
    const memStart = (-70 * Math.PI) / 180
    const gLen = (50 * Math.PI) / 180
    this.cpuGauge = gaugeMat(cpuStart, gLen)
    this.memGauge = gaugeMat(memStart, gLen)
    this.hud.add(tag(new THREE.Mesh(arcBand(1.88, 0.02, cpuStart, cpuStart + gLen, 96), this.cpuGauge), 'bloom'), tag(new THREE.Mesh(arcBand(1.88, 0.02, memStart, memStart + gLen, 96), this.memGauge), 'bloom'))
    const deg: HudLabel[] = []
    for (let i = 0; i < 12; i++) {
      const ang = (i / 12) * Math.PI * 2
      const l = new HudLabel(String(i * 30).padStart(3, '0'), 0.048)
      l.mesh.position.set(Math.cos(ang) * 2.1, Math.sin(ang) * 2.1, 0)
      deg.push(l)
    }
    const title = new HudLabel('AOP · J.A.R.V.I.S', 0.06)
    title.mesh.position.set(0, 2.3, 0)
    const state = new HudLabel('STATE —', 0.06)
    state.mesh.position.set(0, 2.19, 0)
    const cpu = new HudLabel('CPU —', 0.058, 'right')
    cpu.mesh.position.set(Math.cos(cpuStart + gLen / 2) * 2.06 - 0.04, Math.sin(cpuStart + gLen / 2) * 2.06, 0)
    const mem = new HudLabel('MEM —', 0.058, 'left')
    mem.mesh.position.set(Math.cos(memStart + gLen / 2) * 2.06 + 0.04, Math.sin(memStart + gLen / 2) * 2.06, 0)
    const agents = new HudLabel('AGENTS 0/6', 0.052)
    agents.mesh.position.set(0, -2.3, 0)
    this.labels = { deg, title, state, cpu, mem, agents }
    this.hud.add(...[...deg, title, state, cpu, mem, agents].map((l) => l.mesh))

    // ------------------------------------------------------------- Particles
    this.buildSparks(preset)

    // ------------------------------------------------------------- Agent nodes
    const linkPos: number[] = []
    const linkS: number[] = []
    const linkSlot: number[] = []
    const linkIdx: number[] = []
    SLOT_IDS.forEach((id, i) => {
      const ang = AGENT_SLOTS[id]
      const x = Math.cos(ang) * ORBIT_RADIUS
      const y = Math.sin(ang) * ORBIT_RADIUS
      const gm = additive(S.glow, { uSize: { value: 0.32 }, uColor: { value: ice() }, uIntensity: { value: 0 }, uFalloff: { value: 18 }, uRing: { value: 0 } })
      const g = tag(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), gm), 'bloom')
      g.position.set(x, y, 0.03)
      g.frustumCulled = false
      this.nodeGlows.push(gm)
      const hex = tag(new THREE.Mesh(new THREE.RingGeometry(0.045, 0.054, 6), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending })), 'bloom')
      hex.position.set(x, y, 0.035)
      this.nodeRings.push(hex)
      this.agentGroup.add(g, hex)
      const r0 = 1.1
      const r1 = ORBIT_RADIUS - 0.07
      const nx = -Math.sin(ang) * 0.002
      const ny = Math.cos(ang) * 0.002
      const k = linkPos.length / 3
      for (const [r, sv] of [
        [r0, 0],
        [r1, 1],
      ] as const) {
        linkPos.push(Math.cos(ang) * r + nx, Math.sin(ang) * r + ny, 0, Math.cos(ang) * r - nx, Math.sin(ang) * r - ny, 0)
        linkS.push(sv, sv)
        linkSlot.push(i, i)
      }
      linkIdx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2)
    })
    const lg = new THREE.BufferGeometry()
    lg.setAttribute('position', new THREE.Float32BufferAttribute(linkPos, 3))
    lg.setAttribute('aS', new THREE.Float32BufferAttribute(linkS, 1))
    lg.setAttribute('aSlot', new THREE.Float32BufferAttribute(linkSlot, 1))
    lg.setIndex(linkIdx)
    this.linkMat = additive(S.link, { uColor: { value: ice() }, uTime: { value: 0 }, uIntensity: { value: new Array(6).fill(0) }, uRunning: { value: new Array(6).fill(0) } })
    this.agentGroup.add(tag(new THREE.Mesh(lg, this.linkMat), 'bloom'))
    this.agentGroup.position.z = 0.02
    this.debugGroup.visible = false
  }

  private buildSparks(preset: QualityPreset): void {
    for (const l of this.sparks) {
      this.particleGroup.remove(l.points)
      l.points.geometry.dispose()
      l.mat.dispose()
    }
    this.sparks = []
    const layer = (n: number, rMin: number, rMax: number, z0: number, z1: number, size: number, speed: number, far: boolean) => {
      if (n <= 0) return
      const attrs = { aSeed: new Float32Array(n), aRadius: new Float32Array(n), aAngle: new Float32Array(n), aSpeed: new Float32Array(n), aZ: new Float32Array(n) }
      for (let i = 0; i < n; i++) {
        attrs.aSeed[i] = (i + Math.random()) / n
        attrs.aRadius[i] = rMin + Math.pow(Math.random(), 1.4) * (rMax - rMin)
        attrs.aAngle[i] = Math.random() * Math.PI * 2
        attrs.aSpeed[i] = (0.3 + Math.random() * 0.7) * speed * (Math.random() < 0.65 ? 1 : -1)
        attrs.aZ[i] = z0 + Math.random() * (z1 - z0)
      }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3))
      for (const [k, arr] of Object.entries(attrs)) g.setAttribute(k, new THREE.Float32BufferAttribute(arr, 1))
      const mat = additive(H.sparks, {
        uTime: { value: 0 },
        uBurst: { value: 0 },
        uPull: { value: 0 },
        uSize: { value: size },
        uPixelRatio: { value: 1 },
        uViewH: { value: 800 },
        uDensity: { value: 0 },
        uColor: { value: new THREE.Color(0.7, 0.88, 1) },
        uAlpha: { value: 0 },
      })
      const points = tag(new THREE.Points(g, mat), 'hide')
      points.frustumCulled = false
      this.particleGroup.add(points)
      this.sparks.push({ points, mat, far })
    }
    const { far, mid, near } = preset.particles
    layer(mid * 3 + near * 20, 1.04, 2.4, -0.2, 0.3, 3.2, 0.12, false)
    layer(far * 3, 2.2, 5, -3, -1, 2.4, 0.02, true)
  }

  setQuality(preset: QualityPreset, _glass: boolean): void {
    this.buildSparks(preset)
  }

  /** The holographic Orb has no physical glass; kept for the renderer's adaptive-quality contract. */
  setGlass(_physical: boolean): void {}

  setDebug(d: DebugFlags): void {
    for (const l of this.sparks) l.points.visible = d.particles
  }

  /** Exploded depth view (developer toggle) and per-state depth expansion. */
  explode(amount: number, depth: number): void {
    const z = (g: THREE.Object3D, base: number, off: number) => {
      g.position.z = base * depth + off * amount
    }
    z(this.coreGroup, 0, -0.6)
    z(this.frameGroup, -0.1, -1.0)
    z(this.ringGroup, 0, 0.4)
    z(this.hud, 0.3, 1.0)
    z(this.agentGroup, 0.02, 0.6)
    this.ringGroup.scale.z = depth * (1 + amount * 3)
  }

  update(f: SceneFrame): void {
    const { v, boot, out, mic } = f
    const tint = new THREE.Color(v.tint[0], v.tint[1], v.tint[2])
    const white = new THREE.Color(1, 1, 1)
    const hudColor = tint.clone().lerp(white, 0.08)
    const energy = v.energy
    const userTalking = mic.level > out.level + 0.02

    // ---- Speech envelope: fast attack, short release → every syllable flashes the core.
    const target = Math.min(1, out.level * 1.3 + out.low * 0.4)
    this.flash += (target - this.flash) * (target > this.flash ? 1 - Math.exp(-f.dt / 0.018) : 1 - Math.exp(-f.dt / 0.11))
    this.shockCooldown -= f.dt
    if (out.level - this.prevOut > 0.1 && out.level > 0.18 && this.shockCooldown <= 0) {
      this.emitShock(0.7 + out.level * 0.6)
      this.shockCooldown = 0.22
    }
    this.prevOut = out.level
    if (boot.flare > 0.5 && !this.bootFlareFired) {
      this.emitShock(1.4)
      this.bootFlareFired = true
    }
    if (boot.flare === 0 && boot.core === 1) this.bootFlareFired = false

    // ---- Core
    const cu = this.coreMat.uniforms
    cu.uTime!.value = f.time
    cu.uIntensity!.value = v.nucleus * energy * boot.core
    cu.uFlash!.value = this.flash
    cu.uIgnite!.value = f.ignite + boot.flare * 1.5
    cu.uPoint!.value = boot.point
    cu.uSwirl!.value = 0.25 + v.scan * 0.9
    cu.uLow!.value = out.low
    ;(cu.uColor!.value as THREE.Color).copy(tint)
    const om = this.oRingMat.uniforms
    om.uTime!.value = f.time
    om.uIntensity!.value = 0.008 * energy * boot.core * v.ring
    ;(om.uColor!.value as THREE.Color).copy(tint)
    const orim = this.oRingOuterMat.uniforms
    orim.uIntensity!.value = (0.55 + this.flash * 1.0 + f.ignite * 0.8) * energy * boot.core * v.ring
    orim.uCore!.value = 1.5
    orim.uReveal!.value = clamp01(boot.core * 1.2)
    ;(orim.uColor!.value as THREE.Color).copy(tint).lerp(white, 0.3)

    // ---- Shockwaves
    for (const s of this.shocks) {
      s.age = Math.min(1, s.age + f.dt / 1.1)
      const e = 1 - s.age
      const u = s.mesh.material.uniforms
      u.uRadius!.value = 1.02 + Math.pow(s.age, 0.7) * 1.25
      u.uAlpha!.value = e * e * s.strength * energy * 0.5
      u.uWidth!.value = 0.005 + s.age * 0.004
      ;(u.uColor!.value as THREE.Color).copy(tint).lerp(white, 0.4)
    }

    // ---- Voice waveform: JARVIS bands push out (white), user bands (cyan) when listening.
    this.updateWave(f, userTalking)

    // ---- Rings: angular reveal sweeps outward during boot; spin and brightness per state.
    for (const r of this.rings) {
      const act = clamp01((1 + boot.outer * 1.25 - r.spec.r) / 0.18)
      const u = r.mat.uniforms
      r.mesh.rotation.z += f.dt * r.spec.speed * v.spin
      if (r.spec.hl) r.hl = (r.hl + f.dt * r.spec.hl.speed * (0.6 + v.spin * 0.6)) % 1
      u.uHl!.value = r.hl
      u.uHlGain!.value = r.spec.hl ? r.spec.hl.gain * (1 + this.flash) : 0
      u.uReveal!.value = act
      u.uTime!.value = f.time
      u.uFlicker!.value = v.alert * 0.6
      const voiceLift = r.spec.name === 'EnergyRing' ? this.flash * 1.0 + mic.level * 1.2 : r.spec.name === 'TickRing' ? mic.level * 1.2 : 0
      u.uIntensity!.value = r.spec.gain * 0.9 * (v.ring + voiceLift) * energy * Math.min(1, act * 3)
      const c = u.uColor!.value as THREE.Color
      c.copy(userTalking && (r.spec.name === 'EnergyRing' || r.spec.name === 'TickRing') ? new THREE.Color(0.45, 0.86, 1) : hudColor)
      if (r.spec.name === 'BracketRing' && v.alert > 0.01) c.lerp(new THREE.Color(v.alertColor[0], v.alertColor[1], v.alertColor[2]), v.alert)
    }
    this.markers.rotation.z += f.dt * 0.45 * v.spin
    this.markerMat.color.copy(hudColor).multiplyScalar(2.4 * v.ring * energy * clamp01((boot.outer - 0.6) * 3))
    const sw = this.sweepMat.uniforms
    sw.uAngle!.value = -f.scanAngle
    sw.uIntensity!.value = (0.03 + v.scan * 0.22) * energy * boot.hud
    ;(sw.uColor!.value as THREE.Color).copy(tint)

    // ---- A / P light frames: edges draw on during boot; pulses run when agents are working.
    const anyRunning = f.agents.some((a) => a.status === 'running')
    this.framePulse = (this.framePulse + f.dt * (anyRunning ? 0.5 : 0.16)) % 1
    for (const [m, k] of [
      [this.frameEdgeMat, 1.9],
      [this.frameGlowMat, 0.06],
    ] as const) {
      const u = m.uniforms
      u.uIntensity!.value = k * v.frame * energy
      u.uReveal!.value = boot.mark
      u.uPulse!.value = anyRunning ? 1.6 : 0.6
      u.uPulsePos!.value = this.framePulse
      u.uTime!.value = f.time
      ;(u.uColor!.value as THREE.Color).copy(tint)
    }
    const fu = this.frameFillMat.uniforms
    fu.uIntensity!.value = 0.16 * v.frame * energy * boot.mark
    fu.uTime!.value = f.time
    fu.uScanPos!.value = 1.3 - ((f.time * 0.35) % 2.6)
    ;(fu.uColor!.value as THREE.Color).copy(tint)
    this.frameGroup.position.z = -0.1 - (1 - boot.mark) * 0.6

    // ---- HUD
    const hudA = v.hud * boot.hud * energy
    for (const l of this.labels.deg) l.setColor(hudColor, hudA * 1.1)
    this.labels.title.setColor(hudColor, hudA * 1.3)
    this.labels.state.setColor(hudColor, hudA * 1.5)
    this.labels.cpu.setColor(hudColor, hudA * 1.4)
    this.labels.mem.setColor(hudColor, hudA * 1.4)
    this.labels.agents.setColor(hudColor, hudA * 1.2)
    for (const [g, value] of [
      [this.cpuGauge, f.telemetry ? f.telemetry.cpu / 100 : 0],
      [this.memGauge, f.telemetry ? f.telemetry.memUsed / Math.max(1, f.telemetry.memTotal) : 0],
    ] as const) {
      g.uniforms.uAlpha!.value = f.telemetry ? hudA * 1.4 : 0
      g.uniforms.uFill!.value += (value - g.uniforms.uFill!.value) * Math.min(1, f.dt * 4)
      ;(g.uniforms.uColor!.value as THREE.Color).copy(hudColor)
    }
    this.labelClock -= f.dt
    if (this.labelClock <= 0) {
      this.labelClock = 0.5
      this.labels.state.set(`STATE ${f.stateLabel}`)
      const t = f.telemetry
      this.labels.cpu.set(t ? `CPU ${t.cpu.toFixed(0).padStart(2, ' ')}%` : 'CPU —')
      this.labels.mem.set(t ? `MEM ${(t.memUsed / 1024 ** 3).toFixed(1)}/${(t.memTotal / 1024 ** 3).toFixed(0)}G` : 'MEM —')
      this.labels.agents.set(`AGENTS ${f.agents.filter((a) => a.status === 'running' || a.status === 'waiting').length}/6`)
    }

    // ---- Particles
    for (const l of this.sparks) {
      const u = l.mat.uniforms
      u.uTime!.value = f.time
      u.uBurst!.value = l.far ? 0 : this.flash * 0.35
      u.uPull!.value = l.far ? 0 : mic.level * 2
      u.uDensity!.value = clamp01(v.particles * boot.particles * (l.far ? 1 : 1 + this.flash * 0.6 + mic.level))
      u.uAlpha!.value = (l.far ? 0.35 : 0.9) * energy
      u.uPixelRatio!.value = f.pixelRatio
      u.uViewH!.value = f.viewHeight
      ;(u.uColor!.value as THREE.Color).copy(userTalking && !l.far ? new THREE.Color(0.5, 0.88, 1) : tint)
    }

    this.updateAgents(f.agents, f.dt, f.time, tint)
  }

  private emitShock(strength: number): void {
    const s = this.shocks[this.nextShock]!
    this.nextShock = (this.nextShock + 1) % SHOCKS
    s.age = 0
    s.strength = strength
  }

  private updateWave(f: SceneFrame, userTalking: boolean): void {
    const { out, mic, v, boot } = f
    const src = userTalking ? mic : out
    const level = userTalking ? mic.level : Math.min(1, out.level * 1.4)
    const bands = src.bands
    const R = 1.085
    for (const mesh of [this.wave, this.waveGlow]) {
      const width = mesh.geometry.userData.width as number
      const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute
      for (let i = 0; i <= WAVE_POINTS; i++) {
        const k = i % WAVE_POINTS
        const a = (i / WAVE_POINTS) * Math.PI * 2
        if (mesh === this.wave) {
          // Mirror-symmetric band mapping + fine jitter → a waveform that reads as voice, not a sine.
          const bf = Math.abs(Math.sin(a)) * (bands.length - 1)
          const b0 = Math.floor(bf)
          const band = (bands[b0] ?? 0) * (1 - (bf - b0)) + (bands[Math.min(bands.length - 1, b0 + 1)] ?? 0) * (bf - b0)
          const jitter = 0.55 + 0.45 * Math.sin(a * 23 + f.time * 19) * Math.sin(a * 7 - f.time * 11)
          const targetAmp = band * level * 0.32 * jitter
          this.waveAmp[k] = this.waveAmp[k]! + (targetAmp - this.waveAmp[k]!) * Math.min(1, f.dt * 22)
        }
        const r = R + this.waveAmp[k]!
        const cx = Math.cos(a)
        const sy = Math.sin(a)
        pos.setXYZ(i * 2, cx * (r + width / 2), sy * (r + width / 2), 0)
        pos.setXYZ(i * 2 + 1, cx * (r - width / 2), sy * (r - width / 2), 0)
      }
      pos.needsUpdate = true
      const u = mesh.material.uniforms
      const lit = clamp01(level * 4)
      u.uIntensity!.value = (mesh === this.wave ? 1.2 : 0.05) * lit * v.energy * boot.core
      u.uTime!.value = f.time
      u.uPulse!.value = 0
      ;(u.uColor!.value as THREE.Color).copy(userTalking ? new THREE.Color(0.45, 0.88, 1) : new THREE.Color(0.85, 0.94, 1))
    }
  }

  private updateAgents(agents: AgentVisual[], dt: number, time: number, color: THREE.Color): void {
    const k = 1 - Math.exp(-dt / 0.2)
    const inten = this.linkMat.uniforms.uIntensity!.value as number[]
    const running = this.linkMat.uniforms.uRunning!.value as number[]
    SLOT_IDS.forEach((id, i) => {
      const a = agents.find((x) => x.id === id)
      const target = !a ? 0 : a.status === 'queued' ? 0.35 : a.status === 'completed' ? 0.5 : a.status === 'failed' ? 0.6 : 1
      const current = (this.agentIntensity.get(id) ?? 0) + (target - (this.agentIntensity.get(id) ?? 0)) * k
      this.agentIntensity.set(id, current)
      const pulse = a?.status === 'running' ? 0.7 + 0.3 * Math.sin(time * 5 + i) : a?.status === 'waiting' ? 0.65 + 0.35 * Math.sin(time * 1.6) : 1
      const c = a?.status === 'failed' ? new THREE.Color(1, 0.4, 0.35) : a?.status === 'waiting' ? new THREE.Color(1, 0.75, 0.42) : color
      this.nodeGlows[i]!.uniforms.uIntensity!.value = current * pulse * 2.2
      ;(this.nodeGlows[i]!.uniforms.uColor!.value as THREE.Color).copy(c)
      this.nodeRings[i]!.material.color.copy(c).multiplyScalar(current * 2.5)
      this.nodeRings[i]!.rotation.z += dt * (a?.status === 'running' ? 2.2 : 0.4)
      inten[i] = a?.status === 'running' || a?.status === 'waiting' ? current * 1.6 : current * 0.4
      running[i] = a?.status === 'running' ? 1 : 0
    })
    this.linkMat.uniforms.uTime!.value = time
    ;(this.linkMat.uniforms.uColor!.value as THREE.Color).copy(color)
  }

  particleCount(): number {
    return this.sparks.reduce((n, l) => n + l.points.geometry.getAttribute('aSeed').count, 0)
  }

  dispose(): void {
    for (const l of Object.values(this.labels).flat()) l.dispose()
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Points) {
        o.geometry.dispose()
        const mats = Array.isArray(o.material) ? o.material : [o.material]
        mats.forEach((m: THREE.Material) => m.dispose())
      }
    })
    this.mats.occluder.dispose()
  }
}
