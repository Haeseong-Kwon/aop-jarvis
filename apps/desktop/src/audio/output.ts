import type { AudioOutput } from '@aop/core'
import { BAND_COUNT, readBands, readRms, type AudioLevels } from './levels'

/** Speech playback through an analyser so the Orb's core pulses with JARVIS's actual voice. */
export class SpeechOutput implements AudioOutput {
  readonly levels: AudioLevels = { rms: 0, bands: new Float32Array(BAND_COUNT) }
  private ctx = new AudioContext()
  private analyser = this.ctx.createAnalyser()
  private source: AudioBufferSourceNode | null = null
  private finish: (() => void) | null = null
  private freq = new Uint8Array(512)
  private time = new Float32Array(1024)
  onActiveChange: (active: boolean) => void = () => undefined

  constructor() {
    this.analyser.fftSize = 1024
    this.analyser.connect(this.ctx.destination)
  }

  get active(): boolean {
    return this.source !== null
  }

  async play(audio: Uint8Array): Promise<void> {
    this.stop()
    if (this.ctx.state === 'suspended') await this.ctx.resume()
    const buffer = await this.ctx.decodeAudioData(audio.slice().buffer)
    return new Promise<void>((resolve) => {
      const source = this.ctx.createBufferSource()
      source.buffer = buffer
      source.connect(this.analyser)
      this.source = source
      this.finish = () => {
        if (this.source === source) {
          this.source = null
          this.onActiveChange(false)
        }
        resolve()
      }
      source.onended = () => this.finish?.()
      this.onActiveChange(true)
      source.start()
    })
  }

  /** Immediate stop — used for barge-in. */
  stop(): void {
    const source = this.source
    if (!source) return
    source.onended = null
    try {
      source.stop()
    } catch {
      /* already stopped */
    }
    const done = this.finish
    this.finish = null
    done?.()
  }

  sample(): AudioLevels {
    if (!this.source) {
      this.levels.rms *= 0.85
      this.levels.bands.forEach((v, i) => (this.levels.bands[i] = v * 0.85))
      return this.levels
    }
    this.levels.rms = this.levels.rms * 0.4 + readRms(this.analyser, this.time) * 0.6
    readBands(this.analyser, this.freq, this.levels.bands)
    return this.levels
  }
}

export interface BootAudioSettings {
  bootAudioStartOffset: number
  bootAudioVolume: number
  duckVolumeDuringSpeech: number
  fadeInMs: number
  fadeOutMs: number
}

/** User-supplied boot track (never bundled). Synced to the boot timeline, ducked under speech. */
export class BootAudio {
  private ctx = new AudioContext()
  private gain = this.ctx.createGain()
  private source: AudioBufferSourceNode | null = null
  private volume = 0

  constructor() {
    this.gain.connect(this.ctx.destination)
  }

  async play(bytes: Uint8Array, s: BootAudioSettings): Promise<void> {
    this.stop()
    if (this.ctx.state === 'suspended') await this.ctx.resume()
    const buffer = await this.ctx.decodeAudioData(bytes.slice().buffer)
    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    source.connect(this.gain)
    const now = this.ctx.currentTime
    this.volume = s.bootAudioVolume
    this.gain.gain.cancelScheduledValues(now)
    this.gain.gain.setValueAtTime(0, now)
    this.gain.gain.linearRampToValueAtTime(this.volume, now + s.fadeInMs / 1000)
    source.start(now, Math.min(s.bootAudioStartOffset, Math.max(0, buffer.duration - 1)))
    this.source = source
  }

  duck(active: boolean, s: BootAudioSettings): void {
    if (!this.source) return
    const now = this.ctx.currentTime
    this.gain.gain.cancelScheduledValues(now)
    this.gain.gain.setTargetAtTime(active ? this.volume * s.duckVolumeDuringSpeech : this.volume, now, 0.08)
  }

  fadeOut(ms: number): void {
    const source = this.source
    if (!source) return
    const now = this.ctx.currentTime
    this.gain.gain.cancelScheduledValues(now)
    this.gain.gain.setValueAtTime(this.gain.gain.value, now)
    this.gain.gain.linearRampToValueAtTime(0, now + ms / 1000)
    source.stop(now + ms / 1000 + 0.05)
    this.source = null
  }

  stop(): void {
    try {
      this.source?.stop()
    } catch {
      /* not started */
    }
    this.source = null
  }
}
