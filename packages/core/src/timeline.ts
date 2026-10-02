// Deterministic animation timeline (boot assembly). Pure: progress is a function of time only, so the
// renderer, sound and overlay can each read the same script from the same clock and stay in sync.

/** Motion vocabulary. Each has its own acceleration profile — no generic ease-in-out everywhere. */
export type Motion = 'slide' | 'rotate' | 'align' | 'snap' | 'lock' | 'energize' | 'calibrate' | 'fade'

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)

export const EASE: Record<Motion, (x: number) => number> = {
  // Heavy part travelling on a rail: quick start, long deceleration.
  slide: (x) => 1 - Math.pow(1 - x, 4),
  // Rotation into place with mass: accelerate, then decelerate.
  rotate: (x) => (x < 0.5 ? 8 * x ** 4 : 1 - Math.pow(-2 * x + 2, 4) / 2),
  // Fine alignment: smooth, no overshoot.
  align: (x) => x * x * (3 - 2 * x),
  // Snap: fast approach with a small overshoot that settles.
  snap: (x) => {
    const c1 = 1.9
    const c3 = c1 + 1
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2)
  },
  // Lock: lands, then a tiny damped recoil (mechanical seating).
  lock: (x) => (x >= 1 ? 1 : 1 - Math.exp(-7 * x) * Math.cos(x * 14)),
  // Energize: slow build that ramps hard at the end.
  energize: (x) => x * x * x,
  // Calibrate: stepped progression (ticks populating).
  calibrate: (x) => Math.floor(x * 24) / 24,
  fade: (x) => x,
}

export interface Segment {
  id: string
  /** Start time (s). */
  at: number
  /** Duration of one instance (s). */
  dur: number
  motion: Motion
  /** Repeated instances (e.g. 12 ring segments), each offset by `stagger` seconds. */
  count?: number
  stagger?: number
  /** Event emitted when the segment starts (once). */
  event?: string
  /** Sound cue played at the start of the segment, or of every instance when `soundEach`. */
  sound?: string
  soundEach?: boolean
}

export interface Cue {
  t: number
  kind: 'event' | 'sound'
  name: string
  segment: string
  instance: number
}

export class Timeline {
  private byId = new Map<string, Segment>()
  readonly duration: number
  private cues: Cue[]

  constructor(readonly segments: Segment[]) {
    for (const s of segments) {
      if (this.byId.has(s.id)) throw new Error(`duplicate segment ${s.id}`)
      this.byId.set(s.id, s)
    }
    this.duration = Math.max(0, ...segments.map((s) => s.at + (Math.max(1, s.count ?? 1) - 1) * (s.stagger ?? 0) + s.dur))
    const cues: Cue[] = []
    for (const s of segments) {
      if (s.event) cues.push({ t: s.at, kind: 'event', name: s.event, segment: s.id, instance: 0 })
      if (s.sound) {
        const n = s.soundEach ? Math.max(1, s.count ?? 1) : 1
        for (let i = 0; i < n; i++) cues.push({ t: s.at + i * (s.stagger ?? 0), kind: 'sound', name: s.sound, segment: s.id, instance: i })
      }
    }
    this.cues = cues.sort((a, b) => a.t - b.t)
  }

  has(id: string): boolean {
    return this.byId.has(id)
  }

  /** Linear 0..1 progress of one instance. */
  raw(id: string, t: number, i = 0): number {
    const s = this.byId.get(id)
    if (!s) throw new Error(`unknown segment ${id}`)
    const start = s.at + i * (s.stagger ?? 0)
    if (s.dur <= 0) return t >= start ? 1 : 0
    // Tolerance so an instance that has landed is exactly at rest (no float residue at the seam).
    return t - start >= s.dur - 1e-9 ? 1 : clamp01((t - start) / s.dur)
  }

  /** Eased progress with the segment's motion profile (may overshoot slightly for snap/lock). */
  p(id: string, t: number, i = 0): number {
    const s = this.byId.get(id)!
    const x = this.raw(id, t, i)
    return x <= 0 ? 0 : x >= 1 ? 1 : EASE[s.motion](x)
  }

  /** A short pulse (0 → 1 → 0) that fires as the instance lands — used for lock flashes. */
  pulse(id: string, t: number, i = 0, width = 0.18): number {
    const s = this.byId.get(id)!
    const end = s.at + i * (s.stagger ?? 0) + s.dur
    const d = t - end
    return d < 0 || d > width ? 0 : Math.sin((d / width) * Math.PI) * (1 - d / width)
  }

  /** Cues whose time lies in (from, to]. */
  cuesBetween(from: number, to: number): Cue[] {
    return this.cues.filter((c) => c.t > from && c.t <= to)
  }

  done(t: number): boolean {
    return t >= this.duration
  }
}

/**
 * Effective timeline time. A skip (user interaction during boot) doesn't jump — it plays the remainder
 * `rate`× faster, so every part still resolves to its final state and nothing is left half-assembled.
 */
export function timelineClock(nowMs: number, startMs: number, skipAtMs: number | null, rate = 6): number {
  const t = (nowMs - startMs) / 1000
  if (skipAtMs === null || nowMs <= skipAtMs) return t
  const ts = (skipAtMs - startMs) / 1000
  return ts + ((nowMs - skipAtMs) / 1000) * rate
}
