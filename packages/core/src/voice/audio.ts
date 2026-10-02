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
}
