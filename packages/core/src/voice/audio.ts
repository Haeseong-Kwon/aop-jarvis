// Pure audio helpers shared by the desktop audio pipeline and tests.

export const STT_SAMPLE_RATE = 16_000

/** 16-bit PCM mono WAV — the format whisper.cpp expects. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const ascii = (offset: number, s: string) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)))
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return bytes
}

/** Linear-interpolation resample (mic runs at 44.1/48 kHz; STT wants 16 kHz). */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input
  const ratio = from / to
  const out = new Float32Array(Math.floor(input.length / ratio))
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, input.length - 1)
    out[i] = input[i0]! + (input[i1]! - input[i0]!) * (pos - i0)
  }
  return out
}

export function rms(frame: Float32Array): number {
  let sum = 0
  for (const s of frame) sum += s * s
  return Math.sqrt(sum / (frame.length || 1))
}

export interface VadDecision {
  speech: boolean
  /** Fires once when speech starts / ends (after hangover). */
  event: 'start' | 'end' | null
  level: number
  noiseFloor: number
}

/**
 * Energy VAD with an adaptive noise floor and hangover.
 * ponytail: energy-based — robust in a quiet room, weaker in noise; swap for Silero (onnx) behind the same interface.
 */
export class EnergyVad {
  private noiseFloor = 0.004
  private speaking = false
  private aboveMs = 0
  private belowMs = 0

  constructor(
    private sensitivity: number, // 1 (strict) … 10 (eager)
    private readonly silenceMs: number,
    private readonly minSpeechMs = 120,
  ) {}

  setSensitivity(s: number): void {
    this.sensitivity = s
  }

  /** `strict` raises the bar while JARVIS speaks so its own voice does not trigger barge-in. */
  process(frame: Float32Array, frameMs: number, strict = false): VadDecision {
    const level = rms(frame)
    if (!this.speaking) this.noiseFloor = this.noiseFloor * 0.995 + Math.min(level, 0.05) * 0.005
    const factor = (strict ? 5 : 3.2) - (this.sensitivity - 5) * 0.25
    const threshold = Math.max(this.noiseFloor * factor, strict ? 0.03 : 0.008)
    let event: VadDecision['event'] = null
    if (level > threshold) {
      this.aboveMs += frameMs
      this.belowMs = 0
      if (!this.speaking && this.aboveMs >= (strict ? this.minSpeechMs * 2 : this.minSpeechMs)) {
        this.speaking = true
        event = 'start'
      }
    } else {
      this.belowMs += frameMs
      this.aboveMs = 0
      if (this.speaking && this.belowMs >= this.silenceMs) {
        this.speaking = false
        event = 'end'
      }
    }
    return { speech: this.speaking, event, level, noiseFloor: this.noiseFloor }
  }

  reset(): void {
    this.speaking = false
    this.aboveMs = 0
    this.belowMs = 0
  }

  /** Enter the speaking state directly (barge-in confirmed by the EchoGate); end detection proceeds normally. */
  forceStart(): void {
    this.speaking = true
    this.aboveMs = 0
    this.belowMs = 0
  }
}

/** Decode a PCM WAV (8/16/24/32-bit int or 32-bit float, any channel count) to mono float32. */
export function decodeWav(bytes: Uint8Array): { samples: Float32Array; sampleRate: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (o: number) => String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!)
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file')
  let off = 12
  let format = 1
  let channels = 1
  let sampleRate = 16000
  let bits = 16
  while (off + 8 <= bytes.length) {
    const id = tag(off)
    const size = view.getUint32(off + 4, true)
    const body = off + 8
    if (id === 'fmt ') {
      format = view.getUint16(body, true)
      channels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bits = view.getUint16(body + 14, true)
    } else if (id === 'data') {
      const len = Math.min(size, bytes.length - body)
      const bps = bits / 8
      const frames = Math.floor(len / (bps * channels))
      const out = new Float32Array(frames)
      for (let i = 0; i < frames; i++) {
        let acc = 0
        for (let c = 0; c < channels; c++) {
          const p = body + (i * channels + c) * bps
          acc +=
            format === 3 && bits === 32
              ? view.getFloat32(p, true)
              : bits === 16
                ? view.getInt16(p, true) / 32768
                : bits === 8
                  ? (bytes[p]! - 128) / 128
                  : bits === 24
                    ? (((bytes[p + 2]! << 24) | (bytes[p + 1]! << 16) | (bytes[p]! << 8)) >> 8) / 8388608
                    : view.getInt32(p, true) / 2147483648
        }
        out[i] = acc / channels
      }
      return { samples: out, sampleRate }
    }
    off = body + size + (size % 2)
  }
  throw new Error('WAV has no data chunk')
}

export interface EchoGateOptions {
  /** How far above the estimated echo the mic must be to count as the user (dB). */
  marginDb: number
  /** Sustained speech required before a barge-in fires (ms). */
  minSpeechMs: number
  /** After JARVIS starts a sound, the gate only learns for this long (speaker ring-up, AEC convergence). */
  onsetHoldMs: number
  /** Acoustic path delay window searched for the matching reference level (ms). */
  historyMs: number
  /** Absolute floor below which nothing is speech. */
  floor: number
}

/**
 * Barge-in validation without muting the microphone. While JARVIS speaks, the (echo-cancelled) mic still
 * carries residual echo. The gate tracks the playback reference level, learns the speaker→mic coupling from
 * frames where only JARVIS is audible, and confirms user speech only when the mic stays clearly above the
 * echo predicted from the reference for `minSpeechMs`.
 */
export class EchoGate {
  private readonly o: EchoGateOptions
  private history: number[] = []
  private coupling = 0.3
  private aboveMs = 0
  private activeMs = 0
  private fired = false

  constructor(options: Partial<EchoGateOptions> = {}) {
    this.o = { marginDb: 7, minSpeechMs: 160, onsetHoldMs: 150, historyMs: 300, floor: 0.012, ...options }
  }

  get couplingEstimate(): number {
    return this.coupling
  }

  process(micRms: number, refRms: number, frameMs: number, outputActive: boolean): { bargeIn: boolean; echo: number; speech: boolean } {
    if (!outputActive) {
      this.reset()
      return { bargeIn: false, echo: 0, speech: false }
    }
    this.history.push(refRms)
    const keep = Math.max(1, Math.ceil(this.o.historyMs / frameMs))
    while (this.history.length > keep) this.history.shift()
    this.activeMs += frameMs
    const ref = Math.max(...this.history)
    const echo = ref * this.coupling
    const threshold = Math.max(this.o.floor, echo * Math.pow(10, this.o.marginDb / 20))
    const speech = micRms > threshold
    if (this.activeMs <= this.o.onsetHoldMs || (!speech && ref > 0.01)) {
      // Echo-only frame: adapt coupling (fast up, slow down) so loud playback doesn't look like the user.
      if (ref > 0.01) {
        const ratio = Math.min(2, micRms / ref)
        this.coupling += (ratio - this.coupling) * (ratio > this.coupling ? 0.25 : 0.03)
      }
      this.aboveMs = 0
      return { bargeIn: false, echo, speech: false }
    }
    this.aboveMs = speech ? this.aboveMs + frameMs : Math.max(0, this.aboveMs - frameMs * 2)
    const bargeIn = !this.fired && this.aboveMs >= this.o.minSpeechMs
    if (bargeIn) this.fired = true
    return { bargeIn, echo, speech }
  }

  reset(): void {
    this.history = []
    this.aboveMs = 0
    this.activeMs = 0
    this.fired = false
  }
}
