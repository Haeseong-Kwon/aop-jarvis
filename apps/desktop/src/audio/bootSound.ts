// Procedural boot sound design: subtle optical / mechanical cues synthesized in WebAudio (no bundled
// assets). Cues are triggered by the boot timeline's markers, never by independent timeouts.
// Kept quiet and short so they sit under the boot track and support precision rather than spectacle.

type Voice = (ctx: AudioContext, out: AudioNode, at: number) => void

function noiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  return buf
}

function env(ctx: AudioContext, at: number, attack: number, decay: number, peak: number): GainNode {
  const g = ctx.createGain()
  g.gain.setValueAtTime(0, at)
  g.gain.linearRampToValueAtTime(peak, at + attack)
  g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay)
  return g
}

const tone = (type: OscillatorType, f0: number, f1: number, attack: number, decay: number, peak: number): Voice => (ctx, out, at) => {
  const o = ctx.createOscillator()
  o.type = type
  o.frequency.setValueAtTime(f0, at)
  o.frequency.exponentialRampToValueAtTime(f1, at + attack + decay)
  const g = env(ctx, at, attack, decay, peak)
  o.connect(g).connect(out)
  o.start(at)
  o.stop(at + attack + decay + 0.05)
}

const filteredNoise = (type: BiquadFilterType, f0: number, f1: number, q: number, attack: number, decay: number, peak: number): Voice => (ctx, out, at) => {
  const src = ctx.createBufferSource()
  src.buffer = noiseBuffer(ctx, attack + decay + 0.1)
  const f = ctx.createBiquadFilter()
  f.type = type
  f.Q.value = q
  f.frequency.setValueAtTime(f0, at)
  f.frequency.exponentialRampToValueAtTime(f1, at + attack + decay)
  const g = env(ctx, at, attack, decay, peak)
  src.connect(f).connect(g).connect(out)
  src.start(at)
  src.stop(at + attack + decay + 0.1)
}

const layer = (...voices: Voice[]): Voice => (ctx, out, at) => voices.forEach((v) => v(ctx, out, at))

/** Cue name → sound. Names match the `sound` fields in orb/boot.ts. */
const CUES: Record<string, Voice> = {
  // Low sub swell + faint air: the core ignites.
  ignite: layer(tone('sine', 38, 76, 0.25, 0.9, 0.35), filteredNoise('bandpass', 400, 2400, 1.2, 0.2, 0.6, 0.04)),
  // A thin high glint sweeping across: calibration scan.
  scan: filteredNoise('bandpass', 2500, 7000, 8, 0.05, 0.32, 0.05),
  // Glassy shimmer: a lens surface forms.
  lens: layer(tone('sine', 1320, 1760, 0.02, 0.45, 0.03), filteredNoise('highpass', 5000, 9000, 0.7, 0.03, 0.35, 0.02)),
  glass: layer(tone('triangle', 990, 1480, 0.04, 0.6, 0.03), filteredNoise('bandpass', 3000, 6000, 4, 0.05, 0.5, 0.03)),
  // Tiny precise tick: an aperture blade seats.
  blade: filteredNoise('bandpass', 4200, 3600, 14, 0.001, 0.035, 0.08),
  // Mechanical lock: short metallic transient + soft body thump.
  lock: layer(filteredNoise('bandpass', 2600, 1900, 9, 0.001, 0.06, 0.12), tone('sine', 140, 70, 0.002, 0.09, 0.08)),
  lockHeavy: layer(filteredNoise('bandpass', 1800, 1200, 7, 0.001, 0.1, 0.16), tone('sine', 95, 48, 0.003, 0.16, 0.16)),
  // Servo slide.
  slide: filteredNoise('bandpass', 700, 1400, 3, 0.08, 0.3, 0.05),
  // Stepped calibration chirps.
  calibrate: (ctx, out, at) => [0, 0.07, 0.14, 0.21].forEach((d, i) => tone('sine', 1600 + i * 220, 1600 + i * 220, 0.002, 0.05, 0.025)(ctx, out, at + d)),
  // Energy travelling through the structure.
  energize: layer(tone('sawtooth', 110, 330, 0.3, 0.25, 0.018), filteredNoise('lowpass', 300, 3000, 1, 0.3, 0.2, 0.03)),
  // Flare: soft bloom of noise + low swell.
  flare: layer(tone('sine', 55, 82, 0.05, 0.9, 0.22), filteredNoise('lowpass', 1200, 6000, 0.8, 0.04, 0.6, 0.05)),
  // System ready: a restrained two-note confirmation.
  ready: (ctx, out, at) => {
    tone('sine', 660, 660, 0.01, 0.6, 0.05)(ctx, out, at)
    tone('sine', 990, 990, 0.01, 0.8, 0.04)(ctx, out, at + 0.11)
  },
}

export class BootSound {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null

  /** Open the audio context for one boot; closed again by `end()` so the Mac can idle-sleep. */
  begin(volume = 0.8): void {
    this.end()
    this.ctx = new AudioContext()
    this.master = this.ctx.createGain()
    this.master.gain.value = volume
    this.master.connect(this.ctx.destination)
  }

  play(cue: string): void {
    const voice = CUES[cue]
    if (!voice || !this.ctx || !this.master) return
    voice(this.ctx, this.master, this.ctx.currentTime + 0.005)
  }

  end(): void {
    const ctx = this.ctx
    this.ctx = null
    this.master = null
    if (ctx) setTimeout(() => void ctx.close().catch(() => undefined), 1500)
  }
}
