# AOP Orb

The Orb is a Three.js scene with custom GLSL, located in `apps/desktop/src/orb/`. It is not built from CSS animations. Each frame it reads live state directly, without going through React: the runtime state and tasks from the store, the mic analyser, and the speech analyser.

## Geometry from the logo (`mark.ts`)

The A/O/P frames are reconstructed from the supplied logo (`aop-note/image/logo image.png`). Pixel runs were sampled at 8 px row intervals, then normalized so the O's outer radius is 1 and its center is the origin.

| Measurement | Value |
|---|---|
| O center | (501, 481) px |
| O outer / inner radius | 119 / 77 px, so inner ratio 0.647 |
| A's right-leg slope | 0.56 |

The shapes:

- **O** is the optical core.
- **A**'s right leg runs tangent into the O's lower-left. Its inner edge passes about 4 px outside the O, so the closest point is used. The crossbar is cut parallel to the leg and stops short.
- **P** is a bowl whose left wall is the O itself, plus a stem below it.

`scripts/gen-mark-svg.ts` writes `assets/aop-mark.svg` from the same module (`node scripts/gen-mark-svg.ts`). That keeps a single geometric source of truth.

## Layers (`renderer.ts`, radii in orb units)

| Layer | Implementation |
|---|---|
| Background | Fullscreen shader: near-black radial lift, vignette, animated grain, faint state tint |
| Core | Fullscreen additive shader: glow, hot center, boot point, glass body (inner 0.647 to 1.0) with caustics, lens rims with minimal R/B split, rotating scan sweep, radial rays, anamorphic flare, noise distortion |
| A/P structural frames | Line segments with draw-on progress, faded toward their ends |
| Inner ring | Broken arcs at 0.55 / 0.48, fastest rotation |
| Mid ring | Full circle at 1.32 plus quarter arcs |
| Outer ring | 1.62, broken where the A/P frames pass |
| Radial ticks | 144 ticks at 1.76; length driven by mic bands |
| Glyph layer | Arc fragments and markers at 1.98, counter-rotating |
| Particles | 220–1600 points, mostly between the rings, with orbit, twinkle and inward pull |
| Agent orbit | 6 fixed slots at radius 2.25; node intensity and pulse come from real task status, with links from the O rim |
| Bloom | `UnrealBloomPass` (radius 0.32, threshold 0.42). No `OutputPass`: colors are authored for display. |

## State → visuals (`params.ts`)

Visuals ease toward their targets with a time constant of about 250 ms.

| State | Character |
|---|---|
| DORMANT / SLEEP | Dim, slow, few particles |
| BOOTING | Driven by the boot timeline |
| ONLINE | Baseline ice-blue |
| LISTENING | Brighter rings, particle pull, mic gain on |
| THINKING | Inner ring accelerates, scan sweep, distortion |
| EXECUTING | Faster mid ring, scan, more particles, agent nodes |
| SPEAKING | White tint; the core pulses from the TTS analyser |
| INTERRUPTED | Brief dip |
| WAITING_APPROVAL | Amber, near-still |
| ERROR | Muted red, decays after 3 s |

The state itself comes from `deriveRuntimeState()` in core, which uses this priority:

BOOTING > DORMANT > SLEEP > WAITING_APPROVAL > SPEAKING > INTERRUPTED > LISTENING > EXECUTING > THINKING > ERROR > ONLINE.

## Audio reactivity

| Source | Drives |
|---|---|
| Mic analyser (RMS + 8 log bands, 80 Hz–8 kHz) | Tick lengths, particle pull, core lift. Only in states with mic gain (LISTENING). |
| Speech analyser (TTS playback) | Core pulse and distortion |

When no audio is flowing the values decay to zero. There is no synthetic amplitude.

## Boot timeline (`BOOT`, seconds)

| Time | Event |
|---|---|
| 0.2 | Optical point appears |
| 0.5 | Boot audio (if configured) |
| 0.7 | A/P frames draw on |
| 1.2 | Inner ring and core |
| 1.8 | Outer rings, ticks, glyphs, particles |
| 2.2 | Diagnostics lines appear (staggered 0.12 s) |
| 2.5 | Flare |
| 3.0 | Assembled |
| 3.2 | AOP SYSTEM ONLINE |
| 3.4 | Interactive |

Readiness is real, not scripted:

- `Controller.boot()` runs `checkReadiness()` in parallel with the timeline.
- Each diagnostics line shows `READY` only when its subsystem check reported ok. It shows `LIMITED` when the check failed, and `…` while pending.
- "AOP SYSTEM ONLINE" and `bootComplete()` wait for both t ≥ 3.4 s and all five subsystem reports (voice, memory, router, agents, system).

## Quality presets and frame budget

| Preset | Pixel ratio cap | Bloom | Particles | Max fps |
|---|---|---|---|---|
| LOW | 1 | off | 220 | 30 |
| BALANCED | 1.5 | 0.35 | 520 | 60 |
| HIGH (default) | 2 | 0.45 | 900 | 60 |
| ULTRA | 3 | 0.6 | 1600 | 120 |

Frame rate by state:

| Condition | Frame rate |
|---|---|
| DORMANT / SLEEP | 15 fps |
| Idle ONLINE with no audio, boot or agents | ≤ 30 fps |
| Otherwise | The preset's max |
| Hidden window | Rendering stops (`visibilitychange`) |

## Window modes (`Controller.setMode`)

| Mode | Behavior |
|---|---|
| Expanded | 1280×820 |
| Ambient | 240×240, always on top, bottom-right, transparent body, SLEEP-style visuals. Click to summon. |
| Cinematic | Fullscreen |

## Not yet implemented / limitations

- WebGL only; no WebGPU path.
- No memory-graph visualization around the Orb.
- Ambient mode doesn't replay a dedicated wake animation; it re-expands and eases back to the ONLINE visuals.
- GPU usage hasn't been profiled numerically yet; only the frame budgeting above is in place.
