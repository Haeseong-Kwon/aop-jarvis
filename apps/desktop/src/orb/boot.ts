// The AOP cold-boot script: one deterministic timeline shared by the renderer (geometry/light), the boot
// sound engine and the readiness overlay. Times follow the art-direction beat sheet (~5 s).
import { Timeline } from '@aop/core'

export const BOOT_TL = new Timeline([
  // Darkness, then a single optical point.
  { id: 'core.point', at: 0.2, dur: 0.35, motion: 'energize', event: 'assembly:core-ignite', sound: 'ignite' },
  { id: 'core.scan', at: 0.5, dur: 0.38, motion: 'align', sound: 'scan' },
  { id: 'core.glyphs', at: 0.55, dur: 0.45, motion: 'calibrate' },
  // The O assembles from the inside out.
  { id: 'lens.inner', at: 0.8, dur: 0.5, motion: 'rotate', sound: 'lens' },
  { id: 'aperture.blade', at: 1.1, dur: 0.34, motion: 'lock', count: 9, stagger: 0.04, event: 'assembly:aperture-build', sound: 'blade', soundEach: true },
  { id: 'lens.glass', at: 1.4, dur: 0.55, motion: 'align', event: 'assembly:lens-build', sound: 'glass' },
  { id: 'housing', at: 1.35, dur: 0.7, motion: 'slide' },
  { id: 'mech.seg', at: 1.8, dur: 0.36, motion: 'lock', count: 12, stagger: 0.045, event: 'assembly:ring-lock', sound: 'lock', soundEach: true },
  // A: lower segment slides up, upper segment rotates inward, cross structure locks, light channel energizes.
  { id: 'a.lower', at: 2.2, dur: 0.42, motion: 'slide', event: 'assembly:a-construct', sound: 'slide' },
  { id: 'a.upper', at: 2.29, dur: 0.4, motion: 'rotate' },
  { id: 'a.bar', at: 2.47, dur: 0.3, motion: 'snap', sound: 'lockHeavy' },
  { id: 'a.light', at: 2.72, dur: 0.3, motion: 'energize' },
  // P: spine forms, housing arc rotates around the O, frame locks into the O structure.
  { id: 'p.spine', at: 2.6, dur: 0.4, motion: 'slide', event: 'assembly:p-construct', sound: 'slide' },
  { id: 'p.bowl', at: 2.68, dur: 0.48, motion: 'rotate' },
  { id: 'p.top', at: 2.86, dur: 0.3, motion: 'snap', sound: 'lockHeavy' },
  { id: 'p.light', at: 3.05, dur: 0.3, motion: 'energize' },
  { id: 'integrate', at: 3.0, dur: 0.25, motion: 'align' },
  // Outer instrumentation populates outward, then energy links A → O → P.
  { id: 'hud.ticks', at: 3.3, dur: 0.55, motion: 'calibrate', event: 'assembly:hud-calibrate', sound: 'calibrate' },
  { id: 'hud.target', at: 3.38, dur: 0.4, motion: 'align', count: 4, stagger: 0.07 },
  { id: 'energy.link', at: 3.6, dur: 0.42, motion: 'fade', event: 'assembly:energy-link', sound: 'energize' },
  { id: 'core.flare', at: 3.9, dur: 0.4, motion: 'energize', sound: 'flare' },
  { id: 'settle', at: 4.2, dur: 0.45, motion: 'align' },
  { id: 'ready', at: 4.5, dur: 0.12, motion: 'fade', event: 'assembly:readiness' },
  { id: 'online', at: 5.0, dur: 0.2, motion: 'fade', event: 'assembly:system-ready', sound: 'ready' },
])

/** Overlay beats (seconds on the same clock). */
export const BOOT = { diagnostics: 4.5, online: 5.0, interactive: BOOT_TL.duration }

/** A frozen "fully assembled" time for non-boot rendering. */
export const ASSEMBLED_T = BOOT_TL.duration + 10
