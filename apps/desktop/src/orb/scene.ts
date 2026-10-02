// AOPOrbScene — the Orb as a physical optical instrument: real Z-depth layers, differentiated materials,
// emissive energy only where it means something. The renderer owns the camera, post chain and loop;
// this module owns the scene graph and per-frame art direction.
import type { AgentId } from '@aop/core'
import * as THREE from 'three'
import { annularSector, arcBand, hairline, irisBlade, lathe, lensElement, markGeometry, O_PROFILE, retainingRing } from './geometry'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { HudLabel } from './hudText'
import { createMaterials, type OrbMaterials } from './materials'
import type { BootFrame, QualityPreset, Visual } from './params'
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

/** Radii of the five ring families (orb units). */
export const RINGS = { glass: 0.832, energy: 1.018, chrome: 1.135, mech: 1.29, hud: 1.72, dial: 1.86, target: 2.06 }

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
  /** JARVIS output: rms + low/mid/high band energies from the playback analyser (0..1). */
  out: { level: number; low: number; mid: number; high: number }
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

type Tag = 'bloom' | 'hide' | 'occluder'
const tag = <T extends THREE.Object3D>(o: T, t: Tag): T => {
  o.userData.orb = t
  return o
}

const additive = (shader: { vertex: string; fragment: string }, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial =>
  new THREE.ShaderMaterial({ vertexShader: shader.vertex, fragmentShader: shader.fragment, uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })

const hudBasic = (): THREE.MeshBasicMaterial => new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide })

const merge = (geos: THREE.BufferGeometry[]): THREE.BufferGeometry => {
  const g = mergeGeometries(geos.map((x) => (x.index ? x.toNonIndexed() : x)))
  geos.forEach((x) => x.dispose())
  return g
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

interface ParticleLayer {
  points: THREE.Points
  mat: THREE.ShaderMaterial
  rMin: number
  rMax: number
  phase: number
  bounds: THREE.Box3Helper
}

export class AOPOrbScene {
  readonly root = new THREE.Group()
  readonly mats: OrbMaterials
  readonly core = new THREE.Group()
  readonly optical = new THREE.Group()
  readonly mechanical = new THREE.Group()
  readonly hud = new THREE.Group()
  readonly energy = new THREE.Group()
  readonly particleGroup = new THREE.Group()
  readonly agentGroup = new THREE.Group()
  /** Meshes that use physical glass; swapped to the lite material when transmission is off. */
  readonly glassMeshes: THREE.Mesh[] = []
  readonly debugGroup = new THREE.Group()

  private nucleusMat: THREE.ShaderMaterial
  private nucleusLight: THREE.PointLight
  private bounceLight: THREE.PointLight
  private keyLight: THREE.DirectionalLight
  private rimLight: THREE.DirectionalLight
  private blades: THREE.Mesh[] = []
  private innerMech: THREE.InstancedMesh
  private mechRing = new THREE.Group()
  private inserts: THREE.InstancedMesh
  private insertColor = new THREE.Color()
  private lensRim: THREE.ShaderMaterial
  private energyRing: THREE.ShaderMaterial
  private energyPhase = 0
  private fineTicks: THREE.InstancedMesh
  private fineTickMat: THREE.MeshBasicMaterial
  private ghosts: THREE.ShaderMaterial[] = []
  private glare: THREE.ShaderMaterial
  private halo: THREE.ShaderMaterial
  private sweepMat: THREE.ShaderMaterial
  private shellMat: THREE.ShaderMaterial
  private stripMat: THREE.ShaderMaterial
  private marks: THREE.Group
  private ticks: THREE.InstancedMesh
  private tickMat: THREE.MeshBasicMaterial
  private dialMat = hudBasic()
  private dialInnerMat = hudBasic()
  private target = new THREE.Group()
  private targetMat = hudBasic()
  private alertMat: THREE.MeshBasicMaterial
  private scanMarker: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>
  private cpuGauge: THREE.ShaderMaterial
  private memGauge: THREE.ShaderMaterial
  private labels: { deg: HudLabel[]; title: HudLabel; state: HudLabel; cpu: HudLabel; mem: HudLabel; agents: HudLabel; calib: HudLabel[] }
  private ringIdLabels: HudLabel[] = []
  private particleLayers: ParticleLayer[] = []
  private nodeBeads: THREE.Mesh[] = []
  private nodeGlows: THREE.ShaderMaterial[] = []
  private linkMat: THREE.ShaderMaterial
  private agentIntensity = new Map<AgentId, number>()
  private labelClock = 0
  private stripPulse = 0
  private tmpM = new THREE.Matrix4()
  private tmpQ = new THREE.Quaternion()
  private tmpV = new THREE.Vector3()
  private tmpS = new THREE.Vector3()

  constructor(preset: QualityPreset) {
    this.mats = createMaterials()
    this.root.add(this.core, this.optical, this.mechanical, this.hud, this.energy, this.particleGroup, this.agentGroup, this.debugGroup)
    this.root.name = 'AOPOrbScene'
    this.core.name = 'CoreAssembly'
    this.optical.name = 'OpticalAssembly'
    this.mechanical.name = 'MechanicalAssembly'
    this.hud.name = 'HUDAssembly'
    this.energy.name = 'EnergyAssembly'
    this.particleGroup.name = 'ParticleAssembly'
    this.agentGroup.name = 'AgentOrbitAssembly'
    const m = this.mats

    // ---------------------------------------------------------------- CoreAssembly
    this.nucleusMat = additive(S.nucleus, {
      uSize: { value: 0.95 },
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uLow: { value: 0 },
      uIgnite: { value: 0 },
      uPoint: { value: 0 },
      uColor: { value: new THREE.Color(0.62, 0.82, 1) },
    })
    const nucleus = tag(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.nucleusMat), 'bloom')
    nucleus.name = 'EnergyNucleus'
    nucleus.position.z = -0.62
    nucleus.frustumCulled = false
    nucleus.renderOrder = 2
    this.nucleusLight = new THREE.PointLight(0xbcd8ff, 0, 0, 2)
    this.nucleusLight.position.z = -0.5
    // Light reflected forward off the inner lens: lets the iris blades and retaining rings read from the front.
    this.bounceLight = new THREE.PointLight(0xbcd8ff, 0, 0, 2)
    this.bounceLight.position.z = -0.18
    this.core.add(nucleus, this.nucleusLight, this.bounceLight)
    // Studio key (top-left, in front) gives the A/P plates a readable gradient; cool rim from behind-right.
    this.keyLight = new THREE.DirectionalLight(0xe6efff, 0)
    this.keyLight.position.set(-3, 3.5, 4)
    this.rimLight = new THREE.DirectionalLight(0xa8c8ff, 0)
    this.rimLight.position.set(4, 1.5, -3)
    this.root.add(this.keyLight, this.rimLight)

    // Aperture: nine blades pivoting on the bore wall.
    const aperture = new THREE.Group()
    aperture.name = 'Aperture'
    aperture.position.z = -0.42
    const bladeGeo = irisBlade()
    for (let i = 0; i < 9; i++) {
      const pivot = new THREE.Group()
      const th = (i / 9) * Math.PI * 2
      pivot.position.set(Math.cos(th) * 0.6, Math.sin(th) * 0.6, i * 0.0011)
      pivot.rotation.z = th
      const blade = new THREE.Mesh(bladeGeo, m.edge)
      pivot.add(blade)
      this.blades.push(blade)
      aperture.add(pivot)
    }
    this.core.add(aperture)

    // Stepped bore: retaining rings narrowing with depth read as a lens barrel seen from the front.
    const rr = [
      [-0.12, 0.605],
      [-0.33, 0.57],
      [-0.6, 0.52],
      [-0.8, 0.49],
    ] as const
    rr.forEach(([z, inner], i) => {
      const ring = new THREE.Mesh(retainingRing(z, inner, 0.035 + i * 0.01), i % 2 ? m.interior : m.ring)
      ring.name = `RetainingRing0${i + 1}`
      this.core.add(ring)
    })
    const backPlate = new THREE.Mesh(new THREE.CircleGeometry(0.647, 96), m.interior)
    backPlate.position.z = -0.95
    backPlate.name = 'BackPlate'
    this.core.add(backPlate)

    // Inner mechanism: toothed ring between the glass elements, contra-rotating while thinking.
    this.innerMech = new THREE.InstancedMesh(annularSector(0.5, 0.575, ((Math.PI * 2) / 24) * 0.55, 0.026, 0.002), m.ring, 24)
    this.innerMech.name = 'InnerMechanism'
    this.innerMech.position.z = -0.22
    for (let i = 0; i < 24; i++) {
      this.tmpM.makeRotationZ((i / 24) * Math.PI * 2)
      this.innerMech.setMatrixAt(i, this.tmpM)
    }
    this.core.add(this.innerMech)

    // Stacked glass: front element at the bore mouth, second element deeper.
    const lens1 = new THREE.Mesh(lensElement(0.652, 0.11, 0.022, 1), m.glass)
    lens1.position.z = 0.015
    lens1.name = 'CoreGlass'
    const lens2 = new THREE.Mesh(lensElement(0.585, 0.06, 0.02, 1.4, -0.6), m.glass)
    lens2.position.z = -0.29
    lens2.name = 'InnerLens'
    this.glassMeshes.push(lens1, lens2)
    tag(lens1, 'hide')
    tag(lens2, 'hide')
    this.core.add(lens1, lens2)

    // Inner lens rim (mid-band speech response) and fine radial ticks (high-band response).
    this.lensRim = additive(S.energyRing, {
      uTime: { value: 0 },
      uLevel: { value: 0 },
      uBase: { value: 0 },
      uPhase: { value: 0 },
      uReveal: { value: 1 },
      uHigh: { value: 0 },
      uSegments: { value: 6 },
      uColor: { value: new THREE.Color(0.75, 0.88, 1) },
    })
    const rim = tag(new THREE.Mesh(new THREE.TorusGeometry(0.662, 0.0026, 8, 256), this.lensRim), 'bloom')
    rim.position.z = 0.072
    rim.name = 'InternalRefraction'
    this.core.add(rim)
    this.fineTickMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
    this.fineTicks = tag(new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), this.fineTickMat, 72), 'bloom')
    this.fineTicks.position.z = -0.09
    this.fineTicks.name = 'FineRadialTicks'
    this.core.add(this.fineTicks)

    // Internal reflections: two faint annular ghosts at different depths (they slide with parallax).
    ;[
      [-0.18, 0.95, 0.05],
      [-0.48, 0.62, 0.035],
    ].forEach(([z, size, intensity]) => {
      const g = additive(S.glow, { uSize: { value: size }, uColor: { value: new THREE.Color(0.7, 0.85, 1) }, uIntensity: { value: intensity }, uFalloff: { value: 4 }, uRing: { value: 1 } })
      g.userData.base = intensity
      const ghost = tag(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), g), 'hide')
      ghost.position.z = z!
      ghost.frustumCulled = false
      this.ghosts.push(g)
      this.core.add(ghost)
    })

    // ---------------------------------------------------------------- OpticalAssembly
    const housing = new THREE.Mesh(lathe(O_PROFILE, 200), m.housing)
    housing.name = 'OHousing'
    const glassRing = new THREE.Mesh(new THREE.TorusGeometry(RINGS.glass, 0.024, 24, 220), m.glass)
    glassRing.position.z = 0.07
    glassRing.name = 'LensRing01'
    this.glassMeshes.push(glassRing)
    tag(glassRing, 'hide')
    const chrome = new THREE.Mesh(new THREE.TorusGeometry(RINGS.chrome, 0.0055, 10, 280), m.chrome)
    chrome.name = 'ReflectiveRing'
    chrome.position.z = -0.01
    this.shellMat = additive(S.fresnelShell, { uColor: { value: new THREE.Color(0.65, 0.8, 1) }, uIntensity: { value: 0.3 } })
    this.shellMat.side = THREE.DoubleSide
    const shellGeo = new THREE.CylinderGeometry(1.19, 1.19, 0.42, 160, 1, true)
    shellGeo.rotateX(Math.PI / 2)
    const shell = tag(new THREE.Mesh(shellGeo, this.shellMat), 'hide')
    shell.position.z = -0.12
    shell.name = 'GlassCylinder'
    this.energyRing = additive(S.energyRing, {
      uTime: { value: 0 },
      uLevel: { value: 0 },
      uBase: { value: 0 },
      uPhase: { value: 0 },
      uReveal: { value: 1 },
      uHigh: { value: 0 },
      uSegments: { value: 5 },
      uColor: { value: new THREE.Color(0.7, 0.86, 1) },
    })
    const fresnelRing = tag(new THREE.Mesh(new THREE.TorusGeometry(RINGS.energy, 0.0034, 8, 360), this.energyRing), 'bloom')
    fresnelRing.position.z = 0.035
    fresnelRing.name = 'FresnelRing'
    this.optical.add(housing, glassRing, chrome, shell, fresnelRing)

    // ---------------------------------------------------------------- MechanicalAssembly
    const mark = markGeometry()
    this.marks = new THREE.Group()
    this.marks.name = 'AOPFrames'
    const aFrame = new THREE.Mesh(mark.a, [m.plate, m.edge])
    aFrame.name = 'AFrame'
    const pFrame = new THREE.Mesh(mark.p, [m.plate, m.edge])
    pFrame.name = 'PFrame'
    this.stripMat = additive(S.strip, { uColor: { value: new THREE.Color(0.7, 0.86, 1) }, uBase: { value: 0 }, uReveal: { value: 0 }, uPulse: { value: 0 }, uPulsePos: { value: 0 } })
    const strips = tag(new THREE.Mesh(mark.strips, this.stripMat), 'bloom')
    strips.position.z = 0.003
    strips.name = 'LightPath'
    this.marks.add(aFrame, pFrame, strips)
    this.marks.position.z = -0.04
    this.mechanical.add(this.marks)

    this.mechRing.name = 'SegmentRing02'
    this.mechRing.position.z = -0.045
    const segs = new THREE.InstancedMesh(annularSector(1.235, 1.345, ((Math.PI * 2) / 60) * 0.84, 0.05, 0.004), m.ring, 60)
    for (let i = 0; i < 60; i++) {
      this.tmpM.makeRotationZ((i / 60) * Math.PI * 2)
      segs.setMatrixAt(i, this.tmpM)
    }
    this.inserts = tag(new THREE.InstancedMesh(new THREE.BoxGeometry(0.06, 0.012, 0.004), new THREE.MeshBasicMaterial({ color: 0xffffff }), 12), 'bloom')
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2
      this.tmpM.compose(this.tmpV.set(Math.cos(a) * RINGS.mech, Math.sin(a) * RINGS.mech, 0.031), this.tmpQ.setFromAxisAngle(new THREE.Vector3(0, 0, 1), a), this.tmpS.set(1, 1, 1))
      this.inserts.setMatrixAt(i, this.tmpM)
      this.inserts.setColorAt(i, this.insertColor.setRGB(0, 0, 0))
    }
    this.mechRing.add(segs, this.inserts)
    this.mechanical.add(this.mechRing)

    // ---------------------------------------------------------------- HUDAssembly
    this.hud.position.z = 0.24
    this.tickMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
    this.ticks = tag(new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), this.tickMat, 180), 'hide')
    this.ticks.name = 'RadialTicks'
    for (let i = 0; i < 180; i++) this.ticks.setColorAt(i, new THREE.Color().setScalar(i % 15 === 0 ? 1 : 0.42))
    // Static HUD linework is merged per material (one draw call each).
    const dialGeos: THREE.BufferGeometry[] = [arcBand(1.705, 0.0032, 0, Math.PI * 2, 512)]
    for (let i = 0; i < 8; i++) {
      const a0 = (i / 8) * Math.PI * 2 + 0.06
      dialGeos.push(arcBand(RINGS.dial, 0.0026, a0, a0 + Math.PI / 4 - 0.12, 128))
    }
    // Alignment datums left/right and top/bottom, with end marks.
    dialGeos.push(
      hairline(-2.62, 0, -2.2, 0, 0.0026),
      hairline(2.2, 0, 2.62, 0, 0.0026),
      hairline(-2.62, -0.03, -2.62, 0.03, 0.0026),
      hairline(2.62, -0.03, 2.62, 0.03, 0.0026),
      hairline(0, 2.02, 0, 2.08, 0.0026),
      hairline(0, -2.02, 0, -2.08, 0.0026),
    )
    // Calibration: fine inner arcs with index marks, between the O and the mech ring.
    const innerGeos: THREE.BufferGeometry[] = []
    for (let i = 0; i < 4; i++) {
      const a0 = (i / 4) * Math.PI * 2 + Math.PI / 4 - 0.35
      innerGeos.push(arcBand(1.47, 0.0022, a0, a0 + 0.7, 64))
      for (let k = 0; k <= 7; k++) {
        const a = a0 + (k / 7) * 0.7
        const r1 = k % 7 === 0 ? 1.415 : 1.437
        innerGeos.push(hairline(Math.cos(a) * 1.45, Math.sin(a) * 1.45, Math.cos(a) * r1, Math.sin(a) * r1, 0.0022))
      }
    }
    const dial = tag(new THREE.Mesh(merge(dialGeos), this.dialMat), 'hide')
    dial.name = 'DialRings'
    const dialInner = tag(new THREE.Mesh(merge(innerGeos), this.dialInnerMat), 'hide')
    dialInner.name = 'CalibrationMarks'

    // External targeting ring: four arcs with brackets, plus a local alert sector.
    this.target.name = 'TargetingRing05'
    const targetGeos: THREE.BufferGeometry[] = []
    for (let i = 0; i < 4; i++) {
      const c = Math.PI / 4 + (i * Math.PI) / 2
      const a0 = c - 0.42
      const a1 = c + 0.42
      targetGeos.push(arcBand(RINGS.target, 0.003, a0, a1, 160))
      for (const a of [a0, a1]) targetGeos.push(hairline(Math.cos(a) * (RINGS.target - 0.04), Math.sin(a) * (RINGS.target - 0.04), Math.cos(a) * (RINGS.target + 0.01), Math.sin(a) * (RINGS.target + 0.01), 0.003))
    }
    this.target.add(tag(new THREE.Mesh(merge(targetGeos), this.targetMat), 'hide'))
    this.alertMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
    const alert = tag(new THREE.Mesh(arcBand(RINGS.target, 0.012, Math.PI / 2 - 0.2, Math.PI / 2 + 0.2, 64), this.alertMat), 'bloom')
    alert.name = 'AlertSector'
    this.scanMarker = tag(new THREE.Mesh(new THREE.CircleGeometry(0.022, 3), hudBasic()), 'hide')
    this.scanMarker.name = 'ScanMarker'

    // Data segments bound to real telemetry.
    const gaugeMat = (start: number, length: number) =>
      new THREE.ShaderMaterial({
        vertexShader: S.gauge.vertex,
        fragmentShader: S.gauge.fragment,
        uniforms: { uColor: { value: new THREE.Color(0.7, 0.86, 1) }, uAlpha: { value: 0 }, uFill: { value: 0 }, uStart: { value: start }, uLength: { value: length } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    const cpuStart = (200 * Math.PI) / 180
    const memStart = (-70 * Math.PI) / 180
    const gLen = (50 * Math.PI) / 180
    this.cpuGauge = gaugeMat(cpuStart, gLen)
    this.memGauge = gaugeMat(memStart, gLen)
    const cpuArc = tag(new THREE.Mesh(arcBand(1.8, 0.016, cpuStart, cpuStart + gLen, 96), this.cpuGauge), 'hide')
    const memArc = tag(new THREE.Mesh(arcBand(1.8, 0.016, memStart, memStart + gLen, 96), this.memGauge), 'hide')
    cpuArc.name = 'DataSegments'

    const deg: HudLabel[] = []
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2
      const l = new HudLabel(String(i * 30).padStart(3, '0'), 0.05)
      l.mesh.position.set(Math.cos(a) * 1.94, Math.sin(a) * 1.94, 0)
      deg.push(l)
    }
    const title = new HudLabel('AOP · OPTICAL CORE', 0.058)
    title.mesh.position.set(0, 2.36, 0)
    const state = new HudLabel('STATE  —', 0.06)
    state.mesh.position.set(0, 2.25, 0)
    const cpu = new HudLabel('CPU —', 0.058, 'right')
    cpu.mesh.position.set(Math.cos(cpuStart + gLen / 2) * 2.0 - 0.04, Math.sin(cpuStart + gLen / 2) * 2.0, 0)
    const mem = new HudLabel('MEM —', 0.058, 'left')
    mem.mesh.position.set(Math.cos(memStart + gLen / 2) * 2.0 + 0.04, Math.sin(memStart + gLen / 2) * 2.0, 0)
    const agents = new HudLabel('AGENTS 0/6', 0.052)
    agents.mesh.position.set(0, -2.2, 0)
    const calib = [new HudLabel('R 1.000', 0.04, 'left'), new HudLabel('R 1.290', 0.04, 'left')]
    calib[0]!.mesh.position.set(1.06, 0.3, 0)
    calib[1]!.mesh.position.set(1.4, 0.62, 0)
    this.labels = { deg, title, state, cpu, mem, agents, calib }
    this.hud.add(this.ticks, dial, dialInner, this.target, alert, this.scanMarker, cpuArc, memArc, ...[...deg, title, state, cpu, mem, agents, ...calib].map((l) => l.mesh))

    // ---------------------------------------------------------------- EnergyAssembly
    this.glare = additive(S.glow, { uSize: { value: 0.8 }, uColor: { value: new THREE.Color(0.75, 0.88, 1) }, uIntensity: { value: 0 }, uFalloff: { value: 14 }, uRing: { value: 0 } })
    const glare = tag(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.glare), 'hide')
    glare.position.z = 0.16
    glare.frustumCulled = false
    glare.name = 'CoreGlow'
    this.halo = additive(S.glow, { uSize: { value: 4.6 }, uColor: { value: new THREE.Color(0.55, 0.75, 1) }, uIntensity: { value: 0 }, uFalloff: { value: 2.6 }, uRing: { value: 0 } })
    const halo = tag(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.halo), 'hide')
    halo.position.z = -1.0
    halo.frustumCulled = false
    halo.name = 'Halo'
    this.sweepMat = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: /* glsl */ `precision highp float; uniform float uPos; uniform float uAmt; varying vec2 vP;
        void main(){ float r = length(vP); float d = dot(vP, normalize(vec2(0.8, 0.6))) - uPos;
          float band = exp(-d * d * 260.0) * 0.8 + exp(-d * d * 30.0) * 0.12;
          gl_FragColor = vec4(vec3(0.8, 0.9, 1.0) * band * uAmt * smoothstep(0.66, 0.6, r), 1.0); }`,
      uniforms: { uPos: { value: -2 }, uAmt: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    const sweep = tag(new THREE.Mesh(new THREE.CircleGeometry(0.66, 64), this.sweepMat), 'hide')
    sweep.position.z = 0.13
    sweep.name = 'LightSweep'
    this.energy.add(glare, halo, sweep)

    // ---------------------------------------------------------------- ParticleAssembly
    this.buildParticles(preset)

    // ---------------------------------------------------------------- AgentOrbitAssembly
    const linkPos: number[] = []
    const linkS: number[] = []
    const linkSlot: number[] = []
    const linkIdx: number[] = []
    SLOT_IDS.forEach((id, i) => {
      const a = AGENT_SLOTS[id]
      const bead = new THREE.Mesh(new THREE.SphereGeometry(0.024, 24, 16), m.chrome)
      bead.position.set(Math.cos(a) * ORBIT_RADIUS, Math.sin(a) * ORBIT_RADIUS, 0)
      bead.visible = false
      this.nodeBeads.push(bead)
      const gm = additive(S.glow, { uSize: { value: 0.22 }, uColor: { value: new THREE.Color(0.75, 0.88, 1) }, uIntensity: { value: 0 }, uFalloff: { value: 22 }, uRing: { value: 0 } })
      const g = tag(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), gm), 'bloom')
      g.position.copy(bead.position)
      g.position.z += 0.03
      g.frustumCulled = false
      this.nodeGlows.push(gm)
      this.agentGroup.add(bead, g)
      // Link ribbon from just outside the O rim to the node.
      const r0 = 1.06
      const r1 = ORBIT_RADIUS - 0.05
      const nx = -Math.sin(a) * 0.0018
      const ny = Math.cos(a) * 0.0018
      const k = linkPos.length / 3
      for (const [r, s] of [
        [r0, 0],
        [r1, 1],
      ] as const) {
        linkPos.push(Math.cos(a) * r + nx, Math.sin(a) * r + ny, 0, Math.cos(a) * r - nx, Math.sin(a) * r - ny, 0)
        linkS.push(s, s)
        linkSlot.push(i, i)
      }
      linkIdx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2)
    })
    const lg = new THREE.BufferGeometry()
    lg.setAttribute('position', new THREE.Float32BufferAttribute(linkPos, 3))
    lg.setAttribute('aS', new THREE.Float32BufferAttribute(linkS, 1))
    lg.setAttribute('aSlot', new THREE.Float32BufferAttribute(linkSlot, 1))
    lg.setIndex(linkIdx)
    this.linkMat = additive(S.link, { uColor: { value: new THREE.Color(0.7, 0.86, 1) }, uTime: { value: 0 }, uIntensity: { value: new Array(6).fill(0) }, uRunning: { value: new Array(6).fill(0) } })
    const links = tag(new THREE.Mesh(lg, this.linkMat), 'bloom')
    links.name = 'AgentLinks'
    this.agentGroup.add(links)
    this.agentGroup.position.z = 0.02

    // ---------------------------------------------------------------- Debug overlays (off by default)
    this.debugGroup.visible = false
    const ids: [string, number, number][] = [
      ['NUCLEUS z-0.62', 0.05, -0.62],
      ['IRIS z-0.42', 0.45, -0.42],
      ['L1 GLASS', 0.4, 0.06],
      ['R01 GLASS', RINGS.glass, 0.09],
      ['R04 ENERGY', RINGS.energy, 0.05],
      ['R02 MECH', RINGS.mech, 0],
      ['R03 HUD', RINGS.hud, 0.24],
      ['R05 TARGET', RINGS.target, 0.24],
    ]
    ids.forEach(([text, r, z], i) => {
      const l = new HudLabel(text, 0.05, 'left')
      const a = 0.35 + i * 0.13
      l.mesh.position.set(Math.cos(a) * r, Math.sin(a) * r, z + 0.01)
      l.setColor(new THREE.Color(1, 0.75, 0.4), 1)
      this.ringIdLabels.push(l)
      this.debugGroup.add(l.mesh)
    })
  }

  private buildParticles(preset: QualityPreset): void {
    for (const l of this.particleLayers) {
      this.particleGroup.remove(l.points, l.bounds)
      l.points.geometry.dispose()
      l.mat.dispose()
    }
    this.particleLayers = []
    const layer = (n: number, rMin: number, rMax: number, z0: number, z1: number, size: number, soft: number, speed: number) => {
      if (n <= 0) return
      const seed = new Float32Array(n)
      const radius = new Float32Array(n)
      const angle = new Float32Array(n)
      const spd = new Float32Array(n)
      const z = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        seed[i] = (i + Math.random()) / n
        radius[i] = Math.random()
        angle[i] = Math.random() * Math.PI * 2
        spd[i] = (0.2 + Math.random() * 0.8) * speed * (Math.random() < 0.5 ? -1 : 1)
        z[i] = z0 + Math.random() * (z1 - z0)
      }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3))
      g.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 1))
      g.setAttribute('aRadius', new THREE.Float32BufferAttribute(radius, 1))
      g.setAttribute('aAngle', new THREE.Float32BufferAttribute(angle, 1))
      g.setAttribute('aSpeed', new THREE.Float32BufferAttribute(spd, 1))
      g.setAttribute('aZ', new THREE.Float32BufferAttribute(z, 1))
      const mat = additive(S.particles, {
        uTime: { value: 0 },
        uPhase: { value: 0 },
        uRMin: { value: rMin },
        uRMax: { value: rMax },
        uFlowAmt: { value: 0 },
        uSize: { value: size },
        uPixelRatio: { value: 1 },
        uViewH: { value: 800 },
        uDensity: { value: 0 },
        uColor: { value: new THREE.Color(0.75, 0.88, 1) },
        uAlpha: { value: 0 },
        uSoft: { value: soft },
      })
      const points = tag(new THREE.Points(g, mat), 'hide')
      points.frustumCulled = false
      const bounds = new THREE.Box3Helper(new THREE.Box3(new THREE.Vector3(-rMax, -rMax, z0), new THREE.Vector3(rMax, rMax, z1)), 0xffaa55)
      bounds.visible = false
      tag(bounds, 'hide')
      this.particleGroup.add(points, bounds)
      this.particleLayers.push({ points, mat, rMin, rMax, phase: 0, bounds })
    }
    layer(preset.particles.far, 1.2, 4.2, -4, -1.6, 2.6, 0, 0.012) // far: tiny, slow
    layer(preset.particles.mid, 1.06, 2.35, -0.25, 0.25, 3.4, 0, 0.03) // mid: in the optical band, flow-reactive
    layer(preset.particles.near, 1.6, 3.2, 1.0, 1.9, 34, 1, 0.006) // near: rare, defocused
  }

  setQuality(preset: QualityPreset, glass: boolean): void {
    this.buildParticles(preset)
    this.setGlass(preset.transmission && glass)
  }

  setGlass(physical: boolean): void {
    for (const g of this.glassMeshes) g.material = physical ? this.mats.glass : this.mats.glassLite
  }

  setDebug(d: DebugFlags): void {
    this.debugGroup.visible = d.ringIds
    for (const l of this.particleLayers) {
      l.bounds.visible = d.bounds
      l.points.visible = d.particles
    }
  }

  /** Assembly offsets for the exploded "show depth layers" view. */
  explode(amount: number, depth: number): void {
    const z = (g: THREE.Group, base: number, off: number) => {
      g.position.z = base * depth + off * amount
      g.scale.z = depth * (1 + amount * 1.6)
    }
    z(this.core, 0, -0.9)
    z(this.optical, 0, 0)
    z(this.mechanical, 0, -0.45)
    z(this.hud, 0.24, 0.9)
    z(this.energy, 0, 0.45)
    z(this.agentGroup, 0.02, 0.5)
  }

  update(f: SceneFrame): void {
    const { v, boot, out, mic } = f
    const tint = new THREE.Color(v.tint[0], v.tint[1], v.tint[2])
    const hudColor = tint.clone().lerp(new THREE.Color(1, 1, 1), 0.2)
    const act = (r: number) => clamp01((1 + boot.outer * 1.55 - r) / 0.25)

    // Structure visibility: reflections come up per assembly during boot.
    const metal = v.metal
    this.mats.housing.envMapIntensity = metal * (0.12 + 0.88 * boot.core)
    this.mats.plate.envMapIntensity = metal * boot.mark
    this.mats.edge.envMapIntensity = metal * boot.mark * 1.1
    this.mats.ring.envMapIntensity = metal * act(RINGS.mech)
    this.mats.interior.envMapIntensity = metal * boot.inner * 0.4
    this.mats.chrome.envMapIntensity = metal * act(RINGS.chrome)
    this.mats.glass.envMapIntensity = 1.1 * metal * boot.core
    this.mats.glassLite.envMapIntensity = 1.2 * metal * boot.core

    // Nucleus: low band breathes, onset ignites. Output-driven only (never fabricated).
    const nucleus = v.nucleus * boot.core * v.energy
    const nu = this.nucleusMat.uniforms
    nu.uTime!.value = f.time
    nu.uIntensity!.value = nucleus * (1 + out.level * 0.35)
    nu.uLow!.value = out.low * 0.9
    nu.uIgnite!.value = f.ignite + boot.flare
    nu.uPoint!.value = boot.point
    nu.uSize!.value = 0.95 * v.nucleusSize
    ;(nu.uColor!.value as THREE.Color).copy(tint).lerp(new THREE.Color(0.6, 0.8, 1), 0.4)
    this.nucleusLight.intensity = (nucleus * (1 + out.low * 0.8) + f.ignite * 0.8 + boot.flare) * 1.1
    this.bounceLight.intensity = (nucleus * (1 + out.mid * 0.5) + f.ignite * 0.4) * 0.4
    this.bounceLight.color.copy(tint)
    this.keyLight.intensity = 2.0 * metal * boot.mark
    this.rimLight.intensity = 1.4 * metal * boot.core
    this.nucleusLight.color.copy(tint)

    // Iris: tightens while thinking, closed during cold boot until the inner stage.
    const open = v.aperture * boot.inner
    const phi = 0.08 + open * 1.0
    this.blades.forEach((b) => (b.rotation.z = phi))

    this.innerMech.rotation.z -= f.dt * v.innerSpeed
    this.mechRing.rotation.z += f.dt * v.segSpeed
    this.target.rotation.z += f.dt * v.targetSpeed

    // Inner lens rim ← mid band; fine radial ticks ← high band.
    const lr = this.lensRim.uniforms
    lr.uTime!.value = f.time
    lr.uBase!.value = v.lens * 0.55 * boot.inner * v.energy
    lr.uLevel!.value = out.mid * 1.4
    lr.uHigh!.value = out.high * 0.8
    lr.uPhase!.value = this.energyPhase * 0.5
    ;(lr.uColor!.value as THREE.Color).copy(tint)
    this.fineTickMat.color.copy(tint).multiplyScalar((0.05 + out.high * 2.2) * v.lens * boot.inner)
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2
      const len = 0.018 + (i % 6 === 0 ? 0.012 : 0) + out.high * 0.03 * (0.6 + 0.4 * Math.sin(i * 1.7 + f.time * 9))
      this.tmpM.compose(this.tmpV.set(Math.cos(a) * (0.61 - len / 2), Math.sin(a) * (0.61 - len / 2), 0), this.tmpQ.setFromAxisAngle(new THREE.Vector3(0, 0, 1), a), this.tmpS.set(len, 0.0024, 1))
      this.fineTicks.setMatrixAt(i, this.tmpM)
    }
    this.fineTicks.instanceMatrix.needsUpdate = true
    for (const g of this.ghosts) g.uniforms.uIntensity!.value = (g.userData.base as number) * (0.4 + v.lens) * boot.core

    // Energy transport ring: user speech flows inward (cyan), JARVIS speech flows outward (white-blue).
    const userTalking = mic.level > out.level
    const flowDir = userTalking ? -1 : out.level > 0.02 ? 1 : Math.sign(v.flow)
    this.energyPhase += f.dt * flowDir * (0.25 + Math.max(mic.level, out.level) * 1.6)
    const er = this.energyRing.uniforms
    er.uTime!.value = f.time
    er.uPhase!.value = this.energyPhase
    er.uBase!.value = (0.18 + v.ring * 0.8) * act(RINGS.energy) * v.energy
    er.uLevel!.value = (userTalking ? mic.level : out.level) * 1.3 + f.ignite * 0.6
    er.uHigh!.value = 0
    er.uReveal!.value = clamp01(boot.outer * 1.6)
    ;(er.uColor!.value as THREE.Color).copy(userTalking ? new THREE.Color(0.5, 0.85, 1) : tint)

    this.shellMat.uniforms.uIntensity!.value = 0.22 * metal * boot.core
    this.glare.uniforms.uIntensity!.value = nucleus * 0.05 * (1 + out.level * 0.4) + f.ignite * 0.15
    this.halo.uniforms.uIntensity!.value = nucleus * 0.035
    // Light sweep across the front glass: on ignition and boot flare, plus a slow idle pass.
    const idleSweep = (f.time % 14) / 14
    this.sweepMat.uniforms.uPos!.value = -0.9 + idleSweep * 4.5
    this.sweepMat.uniforms.uAmt!.value = (0.06 + f.ignite * 0.4 + boot.flare * 0.6) * boot.core * metal

    // A → O → P light path.
    const anyRunning = f.agents.some((a) => a.status === 'running')
    this.stripPulse = (this.stripPulse + f.dt * (anyRunning ? 0.55 : 0.18)) % 1.3
    const su = this.stripMat.uniforms
    su.uBase!.value = (0.12 + v.ring * 0.35) * v.energy * boot.mark
    su.uReveal!.value = boot.mark
    su.uPulse!.value = (anyRunning ? 1 : 0.25 * v.ring) + f.ignite
    su.uPulsePos!.value = this.stripPulse
    ;(su.uColor!.value as THREE.Color).copy(tint)
    this.marks.position.z = -0.04 - (1 - boot.mark) * 0.55

    // Segment inserts light up sequentially as the mech ring activates.
    const mechAct = act(RINGS.mech)
    for (let i = 0; i < 12; i++) {
      const lit = clamp01(mechAct * 12 - i) * (0.35 + v.ring * 2.2) * v.energy
      this.inserts.setColorAt(i, this.insertColor.copy(tint).multiplyScalar(lit))
    }
    this.inserts.instanceColor!.needsUpdate = true

    // HUD: precision instrumentation. Mic bands lengthen the outer ticks (user → outer ring).
    const hudA = v.hud * boot.hud * v.energy
    this.tickMat.color.copy(hudColor).multiplyScalar(hudA * act(RINGS.hud) * (0.75 + mic.level * 0.8))
    for (let i = 0; i < 180; i++) {
      const a = (i / 180) * Math.PI * 2
      const band = mic.bands[Math.floor(Math.abs(Math.sin(a * 0.5)) * 7.99)] ?? 0
      const major = i % 15 === 0
      const len = (major ? 0.07 : i % 5 === 0 ? 0.04 : 0.024) + band * mic.level * 0.2
      const r = RINGS.hud + len / 2
      this.tmpM.compose(this.tmpV.set(Math.cos(a) * r, Math.sin(a) * r, 0), this.tmpQ.setFromAxisAngle(new THREE.Vector3(0, 0, 1), a), this.tmpS.set(len, major ? 0.0042 : 0.0028, 1))
      this.ticks.setMatrixAt(i, this.tmpM)
    }
    this.ticks.instanceMatrix.needsUpdate = true
    this.dialMat.color.copy(hudColor).multiplyScalar(hudA * 0.45 * act(RINGS.dial))
    this.dialInnerMat.color.copy(hudColor).multiplyScalar(hudA * 0.4 * act(1.47))
    this.targetMat.color.copy(hudColor).multiplyScalar(hudA * 0.4 * act(RINGS.target))
    this.alertMat.color.setRGB(v.alertColor[0], v.alertColor[1], v.alertColor[2]).multiplyScalar(v.alert * 1.6)
    this.scanMarker.position.set(Math.cos(f.scanAngle) * 1.69, Math.sin(f.scanAngle) * 1.69, 0)
    this.scanMarker.rotation.z = f.scanAngle + Math.PI
    this.scanMarker.material.color.copy(hudColor).multiplyScalar(v.scan * hudA * 1.4)

    for (const l of this.labels.deg) l.setColor(hudColor, hudA * 0.55 * act(1.94))
    this.labels.title.setColor(hudColor, hudA * 0.7)
    this.labels.state.setColor(hudColor, hudA * 0.95)
    this.labels.cpu.setColor(hudColor, hudA * 0.8)
    this.labels.mem.setColor(hudColor, hudA * 0.8)
    this.labels.agents.setColor(hudColor, hudA * 0.6)
    for (const l of this.labels.calib) l.setColor(hudColor, hudA * 0.4)
    for (const [g, value] of [
      [this.cpuGauge, f.telemetry ? f.telemetry.cpu / 100 : 0],
      [this.memGauge, f.telemetry ? f.telemetry.memUsed / Math.max(1, f.telemetry.memTotal) : 0],
    ] as const) {
      g.uniforms.uAlpha!.value = f.telemetry ? hudA * 0.85 : 0
      g.uniforms.uFill!.value += (value - g.uniforms.uFill!.value) * Math.min(1, f.dt * 4)
      ;(g.uniforms.uColor!.value as THREE.Color).copy(hudColor)
    }
    this.labelClock -= f.dt
    if (this.labelClock <= 0) {
      this.labelClock = 0.5
      this.labels.state.set(`STATE  ${f.stateLabel}`)
      const t = f.telemetry
      this.labels.cpu.set(t ? `CPU ${t.cpu.toFixed(0).padStart(2, ' ')}%` : 'CPU —')
      this.labels.mem.set(t ? `MEM ${(t.memUsed / 1024 ** 3).toFixed(1)}/${(t.memTotal / 1024 ** 3).toFixed(0)}G` : 'MEM —')
      const active = f.agents.filter((a) => a.status === 'running' || a.status === 'waiting').length
      this.labels.agents.set(`AGENTS ${active}/6`)
    }

    // Particles: low density at idle; flow inward with the user, outward with JARVIS.
    for (const [i, l] of this.particleLayers.entries()) {
      const u = l.mat.uniforms
      const isMid = i === 1
      l.phase += f.dt * (isMid ? v.flow * 0.09 : 0)
      u.uTime!.value = f.time
      u.uPhase!.value = l.phase
      u.uFlowAmt!.value = isMid ? Math.min(1, Math.abs(v.flow)) : 0
      u.uDensity!.value = clamp01(v.particles * boot.particles * (isMid ? 1 + mic.level + out.level * 0.5 : 1))
      u.uAlpha!.value = (i === 2 ? 0.05 : i === 0 ? 0.35 : 0.5) * v.energy
      u.uPixelRatio!.value = f.pixelRatio
      u.uViewH!.value = f.viewHeight
      ;(u.uColor!.value as THREE.Color).copy(isMid && userTalking ? new THREE.Color(0.55, 0.85, 1) : tint)
    }

    this.updateAgents(f.agents, f.dt, f.time, tint)
  }

  private updateAgents(agents: AgentVisual[], dt: number, time: number, color: THREE.Color): void {
    const k = 1 - Math.exp(-dt / 0.2)
    const inten = this.linkMat.uniforms.uIntensity!.value as number[]
    const running = this.linkMat.uniforms.uRunning!.value as number[]
    SLOT_IDS.forEach((id, i) => {
      const a = agents.find((x) => x.id === id)
      const target = !a ? 0 : a.status === 'queued' ? 0.3 : a.status === 'completed' ? 0.45 : a.status === 'failed' ? 0.5 : 1
      const current = (this.agentIntensity.get(id) ?? 0) + (target - (this.agentIntensity.get(id) ?? 0)) * k
      this.agentIntensity.set(id, current)
      const pulse = a?.status === 'running' ? 0.75 + 0.25 * Math.sin(time * 4 + i) : a?.status === 'waiting' ? 0.7 + 0.3 * Math.sin(time * 1.5) : 1
      this.nodeGlows[i]!.uniforms.uIntensity!.value = current * pulse * (a?.status === 'failed' ? 0.6 : 1.6)
      ;(this.nodeGlows[i]!.uniforms.uColor!.value as THREE.Color).copy(a?.status === 'failed' ? new THREE.Color(1, 0.4, 0.35) : a?.status === 'waiting' ? new THREE.Color(1, 0.75, 0.42) : color)
      this.nodeBeads[i]!.visible = current > 0.02
      this.nodeBeads[i]!.scale.setScalar(0.6 + current * 0.4)
      inten[i] = a?.status === 'running' || a?.status === 'waiting' ? current : current * 0.3
      running[i] = a?.status === 'running' ? 1 : 0
    })
    this.linkMat.uniforms.uTime!.value = time
    ;(this.linkMat.uniforms.uColor!.value as THREE.Color).copy(color)
  }

  particleCount(): number {
    return this.particleLayers.reduce((n, l) => n + l.points.geometry.getAttribute('aSeed').count, 0)
  }

  dispose(): void {
    for (const l of [...Object.values(this.labels).flat(), ...this.ringIdLabels]) l.dispose()
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Points || o instanceof THREE.LineSegments) {
        o.geometry.dispose()
        const mats = Array.isArray(o.material) ? o.material : [o.material]
        mats.forEach((m: THREE.Material) => m.dispose())
      }
    })
    for (const mat of Object.values(this.mats)) if (mat instanceof THREE.Material) mat.dispose()
  }
}
