import type { RuntimeState } from '@aop/core'

export type Quality = 'LOW' | 'BALANCED' | 'HIGH' | 'ULTRA'

export interface QualityPreset {
  /** Upper bound for the device pixel ratio; adaptive quality may go lower. */
  pixelRatio: number
  /** Floor for adaptive pixel-ratio degradation. */
  minPixelRatio: number
  bloom: boolean
  bloomStrength: number
  /** Bloom buffer resolution relative to the canvas. */
  bloomScale: number
  /** Physical glass (refraction through transmission). Off → cheap fresnel glass. */
  transmission: boolean
  transmissionScale: number
  msaa: number
  particles: { far: number; mid: number; near: number }
  streak: boolean
  maxFps: number
}

export const QUALITY: Record<Quality, QualityPreset> = {
  LOW: { pixelRatio: 1, minPixelRatio: 0.75, bloom: false, bloomStrength: 0, bloomScale: 0.5, transmission: false, transmissionScale: 0.5, msaa: 0, particles: { far: 0, mid: 18, near: 0 }, streak: false, maxFps: 30 },
  BALANCED: { pixelRatio: 1.5, minPixelRatio: 1, bloom: true, bloomStrength: 0.65, bloomScale: 0.5, transmission: true, transmissionScale: 0.5, msaa: 2, particles: { far: 10, mid: 30, near: 1 }, streak: true, maxFps: 60 },
  HIGH: { pixelRatio: 2, minPixelRatio: 1, bloom: true, bloomStrength: 0.72, bloomScale: 0.5, transmission: true, transmissionScale: 0.75, msaa: 4, particles: { far: 14, mid: 42, near: 2 }, streak: true, maxFps: 60 },
  ULTRA: { pixelRatio: 3, minPixelRatio: 1.5, bloom: true, bloomStrength: 0.75, bloomScale: 0.75, transmission: true, transmissionScale: 1, msaa: 4, particles: { far: 20, mid: 60, near: 3 }, streak: true, maxFps: 120 },
}

type RGB = [number, number, number]

/**
 * Art-direction targets per runtime state. Every value is eased toward, never jumped to.
 * Stillness is deliberate: most mechanisms only move in THINKING / EXECUTING.
 */
export interface Visual {
  /** Global emissive scale (HUD, rings, strips). */
  energy: number
  /** Environment reflection on the metal structure — how visible the hardware silhouette is. */
  metal: number
  nucleus: number
  nucleusSize: number
  /** Inner lens rim + internal reflections. */
  lens: number
  /** Energy transport ring + segment inserts. */
  ring: number
  hud: number
  /** Inner mechanism contra-rotation (rad/s). */
  innerSpeed: number
  /** Segmented mechanical ring (rad/s). */
  segSpeed: number
  /** External targeting ring (rad/s). */
  targetSpeed: number
  /** Iris opening 0 (closed) … 1 (open). */
  aperture: number
  particles: number
  /** Particle radial flow: −1 inward (user speaking / thinking), +1 outward (JARVIS speaking). */
  flow: number
  scan: number
  /** Camera distance relative to fit (1 = fit). */
  camDist: number
  /** Field of view relative to base (focus tightening < 1). */
  camFov: number
  /** Z-spread of the assemblies (execution depth expansion > 1). */
  depth: number
  micGain: number
  /** Local alert (approval / error) — applied to the targeting ring and one HUD sector only. */
  alert: number
  alertColor: RGB
  tint: RGB
}

const ICE: RGB = [0.7, 0.86, 1.0]
const CYAN: RGB = [0.55, 0.86, 1.0]
const WHITE: RGB = [0.86, 0.93, 1.0]
const AMBER: RGB = [1.0, 0.72, 0.38]
const RED: RGB = [1.0, 0.36, 0.3]

const base: Visual = {
  energy: 1,
  metal: 1,
  nucleus: 0.55,
  nucleusSize: 1,
  lens: 0.4,
  ring: 0.35,
  hud: 0.55,
  innerSpeed: 0.015,
  segSpeed: 0,
  targetSpeed: 0,
  aperture: 0.78,
  particles: 0.3,
  flow: 0,
  scan: 0,
  camDist: 1,
  camFov: 1,
  depth: 1,
  micGain: 0,
  alert: 0,
  alertColor: AMBER,
  tint: ICE,
}

export const VISUALS: Record<RuntimeState, Visual> = {
  DORMANT: { ...base, energy: 0.18, metal: 0.16, nucleus: 0.07, nucleusSize: 0.55, lens: 0.04, ring: 0, hud: 0.07, innerSpeed: 0, aperture: 0.22, particles: 0.06, camDist: 1.03, depth: 0.96 },
  BOOTING: { ...base, ring: 0.5, hud: 0.6, innerSpeed: 0.12, scan: 0.4 },
  ONLINE: base,
  LISTENING: { ...base, nucleus: 0.6, ring: 0.55, hud: 0.75, aperture: 0.86, particles: 0.42, flow: -1, camDist: 0.965, micGain: 1, tint: CYAN },
  THINKING: { ...base, nucleus: 0.78, lens: 0.62, ring: 0.45, hud: 0.6, innerSpeed: 0.34, segSpeed: -0.07, aperture: 0.55, particles: 0.32, flow: -0.45, scan: 0.85, camFov: 0.982, camDist: 0.985 },
  EXECUTING: { ...base, nucleus: 0.82, lens: 0.5, ring: 0.72, hud: 0.75, innerSpeed: 0.12, segSpeed: 0.11, targetSpeed: -0.045, aperture: 0.82, particles: 0.46, flow: 0.35, scan: 0.35, depth: 1.12, camDist: 1.025 },
  SPEAKING: { ...base, nucleus: 0.72, lens: 0.58, ring: 0.42, hud: 0.6, aperture: 0.9, particles: 0.36, flow: 1, tint: WHITE },
  INTERRUPTED: { ...base, energy: 0.75, nucleus: 0.32, ring: 0.2, aperture: 0.5, particles: 0.18 },
  WAITING_APPROVAL: { ...base, nucleus: 0.48, ring: 0.3, innerSpeed: 0, aperture: 0.6, particles: 0.16, alert: 0.85, alertColor: AMBER },
  ERROR: { ...base, energy: 0.8, nucleus: 0.28, ring: 0.1, innerSpeed: 0, aperture: 0.36, particles: 0.12, alert: 1, alertColor: RED },
  SLEEP: { ...base, energy: 0.35, metal: 0.4, nucleus: 0.22, nucleusSize: 0.7, lens: 0.12, ring: 0.08, hud: 0.12, innerSpeed: 0.004, aperture: 0.5, particles: 0.08 },
}

/** Ease time constant per target state (seconds). Daily wake must ignite fast. */
export const EASE_TAU: Partial<Record<RuntimeState, number>> = { LISTENING: 0.12, SPEAKING: 0.15, INTERRUPTED: 0.08 }
export const DEFAULT_TAU = 0.28

/** Frame budget by state: idle states render slowly, active ones at full rate. */
export function targetFps(state: RuntimeState, active: boolean, preset: QualityPreset): number {
  if (state === 'DORMANT' || state === 'SLEEP') return Math.min(20, preset.maxFps)
  if (state === 'ONLINE' && !active) return Math.min(30, preset.maxFps)
  return preset.maxFps
}

const ramp = (t: number, from: number, to: number): number => Math.min(1, Math.max(0, (t - from) / (to - from)))
const easeOut = (x: number): number => 1 - Math.pow(1 - x, 3)
const easeInOut = (x: number): number => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2)

/** Cold-boot timeline (seconds). Visual only — READY labels are gated on real readiness elsewhere. */
export const BOOT = { point: 0.2, audio: 0.5, mark: 0.7, inner: 1.2, outer: 1.8, diagnostics: 2.2, flare: 2.5, assembled: 3.0, online: 3.2, interactive: 3.4 }

export interface BootFrame {
  /** Seed point of light before anything else exists. */
  point: number
  /** A/P structures emerge (slide forward from depth + reflections come up). */
  mark: number
  /** O housing + nucleus. */
  core: number
  /** Iris and internal mechanisms. */
  inner: number
  /** Rings activate outward: 0 → 1 sweeps from r = 1 to r = 2.1. */
  outer: number
  hud: number
  flare: number
  particles: number
}

export function bootFrame(t: number): BootFrame {
  const flareT = t - BOOT.flare
  return {
    point: ramp(t, BOOT.point, BOOT.point + 0.3) * (1 - ramp(t, BOOT.assembled, BOOT.assembled + 0.4) * 0.85),
    mark: easeInOut(ramp(t, BOOT.mark, BOOT.mark + 1.0)),
    core: easeOut(ramp(t, BOOT.inner - 0.2, BOOT.assembled)),
    inner: easeOut(ramp(t, BOOT.inner, BOOT.inner + 0.6)),
    outer: easeOut(ramp(t, BOOT.outer, BOOT.outer + 0.7)),
    hud: easeOut(ramp(t, BOOT.diagnostics - 0.2, BOOT.assembled)),
    flare: flareT < 0 ? 0 : Math.exp(-flareT * 5) * Math.min(1, flareT * 12),
    particles: ramp(t, BOOT.outer, BOOT.assembled + 0.3),
  }
}

export const BOOT_DONE: BootFrame = { point: 0.15, mark: 1, core: 1, inner: 1, outer: 1, hud: 1, flare: 0, particles: 1 }

export function lerpVisual(a: Visual, b: Visual, k: number): Visual {
  const out = { ...a }
  for (const key of Object.keys(b) as (keyof Visual)[]) {
    const x = a[key]
    const y = b[key]
    if (Array.isArray(x) && Array.isArray(y)) (out as Record<string, unknown>)[key] = [x[0] + (y[0] - x[0]) * k, x[1] + (y[1] - x[1]) * k, x[2] + (y[2] - x[2]) * k]
    else (out as Record<string, unknown>)[key] = (x as number) + ((y as number) - (x as number)) * k
  }
  return out
}
