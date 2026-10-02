/** Live audio features read by the Orb every frame (never via React state). All values come from real analysers. */
export interface AudioLevels {
  rms: number
  bands: Float32Array // 8 log-spaced bands, 0..1
}

export const BAND_COUNT = 8

export function emptyLevels(): AudioLevels {
  return { rms: 0, bands: new Float32Array(BAND_COUNT) }
}

/** Log-spaced band energies from an AnalyserNode's byte spectrum (speech emphasis ~80 Hz–8 kHz). */
export function readBands(analyser: AnalyserNode, scratch: Uint8Array<ArrayBuffer>, out: Float32Array): void {
  analyser.getByteFrequencyData(scratch)
  const nyquist = analyser.context.sampleRate / 2
  const binHz = nyquist / scratch.length
  for (let b = 0; b < BAND_COUNT; b++) {
    const lo = 80 * Math.pow(100, b / BAND_COUNT)
    const hi = 80 * Math.pow(100, (b + 1) / BAND_COUNT)
    const i0 = Math.max(1, Math.floor(lo / binHz))
    const i1 = Math.min(scratch.length - 1, Math.ceil(hi / binHz))
    let sum = 0
    for (let i = i0; i <= i1; i++) sum += scratch[i]!
    const v = sum / ((i1 - i0 + 1) * 255)
    out[b] = out[b]! * 0.6 + v * 0.4 // light smoothing for visual continuity
  }
}

export function readRms(analyser: AnalyserNode, scratch: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(scratch)
  let sum = 0
  for (const s of scratch) sum += s * s
  return Math.sqrt(sum / scratch.length)
}
