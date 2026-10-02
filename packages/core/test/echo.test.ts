import { describe, expect, it } from 'vitest'
import { EchoGate } from '../src/voice/audio'

const FRAME = 21.3
const run = (gate: EchoGate, frames: { mic: number; ref: number }[]) => frames.map((f) => gate.process(f.mic, f.ref, FRAME, true))

describe('EchoGate', () => {
  it('never fires on JARVIS’s own echo, even when loud', () => {
    const gate = new EchoGate()
    // Speech-like playback envelope; mic hears it attenuated (coupling 0.25) one frame later.
    const ref = Array.from({ length: 200 }, (_, i) => 0.15 * Math.max(0, Math.sin(i * 0.6)) ** 0.5)
    const frames = ref.map((r, i) => ({ ref: r, mic: (ref[i - 1] ?? 0) * 0.25 + 0.002 }))
    expect(run(gate, frames).some((d) => d.bargeIn)).toBe(false)
  })

  it('fires within ~200 ms when the user talks over playback', () => {
    const gate = new EchoGate()
    const echoOnly = Array.from({ length: 40 }, (_, i) => ({ ref: 0.12, mic: 0.03 + 0.002 * Math.sin(i) }))
    run(gate, echoOnly)
    const user = Array.from({ length: 20 }, () => ({ ref: 0.12, mic: 0.2 }))
    const decisions = run(gate, user)
    const firedAt = decisions.findIndex((d) => d.bargeIn)
    expect(firedAt).toBeGreaterThanOrEqual(0)
    expect((firedAt + 1) * FRAME).toBeLessThanOrEqual(200)
    expect(decisions.filter((d) => d.bargeIn).length).toBe(1) // fires once per utterance
  })

  it('ignores a short transient (cough, click)', () => {
    const gate = new EchoGate()
    run(gate, Array.from({ length: 30 }, () => ({ ref: 0.1, mic: 0.025 })))
    const decisions = run(gate, [...Array.from({ length: 3 }, () => ({ ref: 0.1, mic: 0.3 })), ...Array.from({ length: 20 }, () => ({ ref: 0.1, mic: 0.025 }))])
    expect(decisions.some((d) => d.bargeIn)).toBe(false)
  })

  it('holds during the onset window while the coupling is unknown', () => {
    const gate = new EchoGate()
    const d = run(gate, Array.from({ length: 6 }, () => ({ ref: 0.2, mic: 0.2 })))
    expect(d.some((x) => x.bargeIn)).toBe(false)
  })
})
