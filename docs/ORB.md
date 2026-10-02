# AOP Orb

The Orb is a real-time Three.js scene in `apps/desktop/src/orb/`. Following the approved **Concept 04** direction, the AOP logo is built as a **physical optical machine**:
- the O is a lathe-turned housing with a stepped lens barrel, an iris, two glass elements and an energy nucleus;
- the A and P are bevelled graphite pieces with polished edges and light channels, mechanically joined to the O;
- a precision HUD sits in front.

Each frame reads live state directly, without going through React: runtime state and tasks, the mic and speech-output analysers, and telemetry.

## Scene (`scene.ts`, `parts.ts`, `geometry.ts`, `materials.ts`)

| Assembly | Parts | Material |
|---|---|---|
| Core | Nucleus (white-hot pin → plasma → corona), 4 retaining rings narrowing with depth, back plate, 9 iris blades, toothed inner mechanism, inner lens rim (speech mids), 72 fine radial ticks (speech highs), internal reflection ghosts | Machined interior, polished blades, emissive rim and ticks |
| Optical | O housing (lathe profile), glass ring, chrome ring, glass cylinder shell, fresnel energy ring | Graphite (machined normal map), physical glass (transmission, IOR 1.52, thin-film sheen), chrome |
| Mechanical | A as 3 pieces (left leg, right leg, crossbar); P as 3 pieces (spine and bottom bar, bowl, top bar); A→O→P light channel; 60-segment mechanical ring with 12 emissive inserts | Graphite plates (`0x3a414c`), polished edges (`0xd4dce8`, roughness 0.1), emissive channel |
| HUD | Radial ticks (mic bands), dial arcs, calibration marks, targeting ring with alert sector, telemetry gauges and labels | Thin additive lines |
| Particles | Far, mid and near layers, kept sparse | Additive |
| Agents | Bead, glow and link per real task | Chrome bead, emissive glow |

**Lighting:** studio PMREM environment (ring light, edge strips, top key), nucleus point light inside the barrel, a bounce light, a cold frontal key (3.4) and a side rim (2.6). The background stays near-black.

**Voice mapping:** speech output drives the nucleus (low band), the inner lens rim (mid) and the fine ticks (high); onsets trigger an ignition. The user's voice drives the outer HUD ticks and an inward cyan flow.

## Cold-boot assembly (`boot.ts` + `@aop/core` `Timeline`)

The assembly is one deterministic timeline. The renderer reads part transforms from it, the boot sound plays cues from its markers, and the readiness overlay reads its beats, all from the same clock (`timelineClock`). It's procedural and runtime-rendered: no video and no baked animation.

**Motion vocabulary:**

| Motion | Profile |
|---|---|
| slide | Fast start, long deceleration |
| rotate | Accelerate, then decelerate, with mass |
| align | Smooth, no overshoot |
| snap | Small overshoot, then settle |
| lock | Lands, then a damped recoil |
| energize | Slow build, hard ramp at the end |
| calibrate | Stepped |
| fade | Linear |

Staggers are 40–70 ms.

| t (s) | Segment | What happens | Cue |
|---|---|---|---|
| 0.2 | core.point | Seed point, tiny flare (`assembly:core-ignite`) | ignite |
| 0.5 | core.scan, core.glyphs | Vertical calibration scan through the centre; micro glyphs step in | scan |
| 0.8 | lens.inner | Retaining rings scale up and unwind into place (radial assembly) | lens |
| 1.1 | aperture.blade ×9 | Blades rotate in and lock, 40 ms stagger (`assembly:aperture-build`) | blade ×9 |
| 1.35–2.0 | housing, lens.glass | O housing rises from depth; front glass slides into the bore; fresnel ring traces on (`assembly:lens-build`) | glass |
| 1.8 | mech.seg ×12 | Sectors rotate in from alternating sides, translate in, lock; each insert flashes (`assembly:ring-lock`) | lock ×12 |
| 2.2 | a.lower → a.upper → a.bar → a.light | Left leg slides up, right leg rotates inward about the apex, crossbar snaps, channel energizes (`assembly:a-construct`) | slide, lockHeavy |
| 2.6 | p.spine → p.bowl → p.top → p.light | Spine slides up, bowl rotates around the O, top bar snaps in (`assembly:p-construct`) | slide, lockHeavy |
| 3.0 | integrate | AOP structure locked | — |
| 3.3 | hud.ticks, hud.target ×4 | Ticks populate stepwise, targeting arcs align (`assembly:hud-calibrate`) | calibrate |
| 3.6 | energy.link | Light pulse travels A → O → P (`assembly:energy-link`) | energize |
| 3.9 | core.flare | Nucleus surges; glass and metal edges catch the light (material reveal 0.62 → 1) | flare |
| 4.2 | settle | Mechanical rotation slows to rest, particles push out | — |
| 4.5 / 5.0 | ready / online | Readiness lines (real results only), then "AOP SYSTEM ONLINE" (`assembly:system-ready`) | ready |

- **Skip:** any key, click or wake during the boot plays the remainder 6× faster. Only structural cues sound during a skip, and every part resolves to its final transform; nothing is left half-assembled.
- **Normal wake** is separate: a ~220 ms ignition (nucleus, energy ring, light sweep, slight camera push), never the assembly.
- **Explicit replay:** Developer › Graphics › Replay cinematic boot.
- **Login standby:** the first "Hey Jarvis" replays the assembly with the boot track and greeting.

## Boot sound (`audio/bootSound.ts`)

The boot sound is procedural WebAudio:

| Cue | Sound |
|---|---|
| ignite | Sub swell |
| scan | Glint |
| lens / glass | Shimmer |
| blade | Tick |
| lock | Metallic transient plus body |
| lockHeavy | Heavier lock |
| slide | Servo |
| calibrate | Chirps |
| energize | Rising sweep |
| flare | Swell |
| ready | Two notes |

The context opens for the boot only and closes afterwards. Cues are triggered by timeline markers (`BOOT_TL.cuesBetween`), never by independent timeouts.

## Post-processing and quality

- **Bloom:** selective bloom (only `bloom`-tagged emitters, opaque structure as black occluders), radius 0.3, threshold 0.55.
- **Composite:** ACES composite, vignette 0.5, chromatic aberration 0.002, grain 0.005, streak 0.03 (boosted on the flare).
- **Particles** were cut to under half of the earlier counts:

| Preset | Particles (far/mid/near) |
|---|---|
| LOW | 0/18/0 |
| BALANCED | 10/30/1 |
| HIGH | 14/42/2 |
| ULTRA | 20/60/3 |

- **Adaptive pixel ratio** and **state frame budgets** work as before.

**Captures:** Orb Lab (`orb-lab.html?state=…&bootT=…`).

## Remaining gap from Concept 04

- **No reference image to compare against.** Concept 04 isn't in the repo, so this follows the brief's written description. Put the image at `docs/reference/orb-target.png` for a pixel comparison.
- **A/P detail:** the faces are flat bevelled extrusions. Ribs, seams and recessed channels aren't modelled yet.
- **No interactive Orb Lab controls:** tuning sliders (ring speeds, glass opacity, nucleus power, parallax, densities) don't exist yet. Orb Lab is URL-parameter based.
- **Presets:** the three named presets (CINEMATIC / BALANCED / PERFORMANCE) map onto the existing four (ULTRA/HIGH, BALANCED, LOW) and haven't been renamed in the UI.
