import type { RuntimeState } from '@aop/core'

export type Quality = 'LOW' | 'BALANCED' | 'HIGH' | 'ULTRA'

export interface QualityPreset {
  pixelRatio: number
  bloom: boolean
  bloomStrength: number
  particles: number
  maxFps: number
}

export const QUALITY: Record<Quality, QualityPreset> = {
  LOW: { pixelRatio: 1, bloom: false, bloomStrength: 0, particles: 220, maxFps: 30 },
  BALANCED: { pixelRatio: 1.5, bloom: true, bloomStrength: 0.35, particles: 520, maxFps: 60 },
  HIGH: { pixelRatio: 2, bloom: true, bloomStrength: 0.45, particles: 900, maxFps: 60 },
  ULTRA: { pixelRatio: 3, bloom: true, bloomStrength: 0.6, particles: 1600, maxFps: 120 },
}

/** Visual targets per runtime state. Values are eased toward, never jumped to. */
export interface Visual {
  intensity: number
  core: number
  ring: number
  innerSpeed: number
  midSpeed: number
  outerSpeed: number
  scan: number
  particleSpeed: number
  particleAlpha: number
  pull: number
  distort: number
  micGain: number
  tint: [number, number, number]
}

const ICE: [number, number, number] = [0.72, 0.88, 1.0]
const WHITE: [number, number, number] = [0.9, 0.95, 1.0]
const AMBER: [number, number, number] = [1.0, 0.8, 0.55]
const ERR: [number, number, number] = [1.0, 0.5, 0.46]

const base: Visual = { intensity: 1, core: 0.3, ring: 0.6, innerSpeed: 0.06, midSpeed: -0.025, outerSpeed: 0.012, scan: 0, particleSpeed: 0.4, particleAlpha: 0.45, pull: 0, distort: 0.05, micGain: 0, tint: ICE }

export const VISUALS: Record<RuntimeState, Visual> = {
  DORMANT: { ...base, intensity: 0.22, core: 0.06, ring: 0.12, innerSpeed: 0.01, midSpeed: -0.005, outerSpeed: 0.003, particleSpeed: 0.12, particleAlpha: 0.12 },
  BOOTING: { ...base, intensity: 1, core: 0.4, ring: 0.8, innerSpeed: 0.35, scan: 0.25, particleSpeed: 0.8 },
  ONLINE: base,
  LISTENING: { ...base, core: 0.42, ring: 0.85, innerSpeed: 0.1, pull: 0.5, particleAlpha: 0.6, micGain: 1, tint: [0.68, 0.9, 1.0] },
  THINKING: { ...base, core: 0.5, ring: 0.75, innerSpeed: 0.7, midSpeed: -0.12, scan: 0.75, distort: 0.35, particleSpeed: 0.9 },
  EXECUTING: { ...base, core: 0.55, ring: 0.8, innerSpeed: 0.4, midSpeed: -0.3, outerSpeed: 0.06, scan: 0.45, particleSpeed: 1.3, particleAlpha: 0.65, distort: 0.2 },
  SPEAKING: { ...base, core: 0.45, ring: 0.8, innerSpeed: 0.12, particleAlpha: 0.55, tint: WHITE },
  INTERRUPTED: { ...base, intensity: 0.7, core: 0.2, ring: 0.5, innerSpeed: 0.02, particleSpeed: 0.2 },
  WAITING_APPROVAL: { ...base, core: 0.35, ring: 0.7, innerSpeed: 0.03, midSpeed: 0, particleSpeed: 0.15, tint: AMBER },
  ERROR: { ...base, intensity: 0.8, core: 0.25, ring: 0.55, innerSpeed: 0.02, distort: 0.25, tint: ERR },
  SLEEP: { ...base, intensity: 0.32, core: 0.08, ring: 0.2, innerSpeed: 0.01, midSpeed: -0.004, outerSpeed: 0.002, particleSpeed: 0.1, particleAlpha: 0.15 },
}

/** Frame budget by state: idle states render slowly, active ones at full rate. */
export function targetFps(state: RuntimeState, audioActive: boolean, preset: QualityPreset): number {
  if (state === 'DORMANT' || state === 'SLEEP') return 15
  if (state === 'ONLINE' && !audioActive) return Math.min(30, preset.maxFps)
  return preset.maxFps
}

const ramp = (t: number, from: number, to: number): number => Math.min(1, Math.max(0, (t - from) / (to - from)))
const easeOut = (x: number): number => 1 - Math.pow(1 - x, 3)

/** The boot timeline (seconds). Visual only — READY labels are gated on real readiness elsewhere. */
export const BOOT = { point: 0.2, audio: 0.5, mark: 0.7, inner: 1.2, outer: 1.8, diagnostics: 2.2, flare: 2.5, assembled: 3.0, online: 3.2, interactive: 3.4 }

export interface BootFrame {
  point: number
  mark: number
  inner: number
  outer: number
  flare: number
  core: number
  particles: number
}

export function bootFrame(t: number): BootFrame {
  const flareT = t - BOOT.flare
  return {
    point: ramp(t, BOOT.point, BOOT.point + 0.3) * (1 - ramp(t, BOOT.assembled, BOOT.assembled + 0.4) * 0.8),
    mark: easeOut(ramp(t, BOOT.mark, BOOT.mark + 0.9)),
    inner: easeOut(ramp(t, BOOT.inner, BOOT.inner + 0.45)),
    outer: easeOut(ramp(t, BOOT.outer, BOOT.outer + 0.5)),
    flare: flareT < 0 ? 0 : Math.exp(-flareT * 5) * Math.min(1, flareT * 12),
    core: easeOut(ramp(t, BOOT.inner, BOOT.assembled)),
    particles: ramp(t, BOOT.outer, BOOT.assembled),
  }
}

export const BOOT_DONE: BootFrame = { point: 0.2, mark: 1, inner: 1, outer: 1, flare: 0, core: 1, particles: 1 }

export function lerpVisual(a: Visual, b: Visual, k: number): Visual {
  const l = (x: number, y: number) => x + (y - x) * k
  return {
    intensity: l(a.intensity, b.intensity),
    core: l(a.core, b.core),
    ring: l(a.ring, b.ring),
    innerSpeed: l(a.innerSpeed, b.innerSpeed),
    midSpeed: l(a.midSpeed, b.midSpeed),
    outerSpeed: l(a.outerSpeed, b.outerSpeed),
    scan: l(a.scan, b.scan),
    particleSpeed: l(a.particleSpeed, b.particleSpeed),
    particleAlpha: l(a.particleAlpha, b.particleAlpha),
    pull: l(a.pull, b.pull),
    distort: l(a.distort, b.distort),
    micGain: l(a.micGain, b.micGain),
    tint: [l(a.tint[0], b.tint[0]), l(a.tint[1], b.tint[1]), l(a.tint[2], b.tint[2])],
  }
}
