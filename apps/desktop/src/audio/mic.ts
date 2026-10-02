import { EchoGate, EnergyVad, resample, rms, STT_SAMPLE_RATE } from '@aop/core'
import { BAND_COUNT, readBands, readRms, type AudioLevels } from './levels'

// ~21 ms frames at 48 kHz: barge-in decisions need fine time resolution.
const FRAME_SIZE = 1024
const PRE_ROLL_MS = 350
const MAX_UTTERANCE_MS = 15_000

export interface MicCallbacks {
  onSpeechStart: () => void
  onSpeechEnd: (samples16k: Float32Array) => void
  /** True while JARVIS speaks: user-speech onset is then decided by the EchoGate against the playback reference. */
  isOutputActive: () => boolean
  /** Playback reference level (RMS of what JARVIS is outputting right now). */
  outputLevel: () => number
  /** Speech activity transitions for the central audio timeline. */
  onActivity?: (phase: 'start' | 'end') => void
}

/**
 * Microphone → (echo-cancelled) stream → analyser (visuals) + energy VAD + utterance capture.
 * ponytail: ScriptProcessorNode is deprecated but universally supported in WKWebView; move to an AudioWorklet if
 * main-thread jank shows up in profiling.
 */
export class Microphone {
  readonly levels: AudioLevels = { rms: 0, bands: new Float32Array(BAND_COUNT) }
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private analyser: AnalyserNode | null = null
  private processor: ScriptProcessorNode | null = null
  private vad: EnergyVad
  private gate = new EchoGate()
  /** Last EchoGate decision, for the developer panel. */
  readonly echo = { estimate: 0, coupling: 0, bargeIns: 0 }
  private preRoll: Float32Array[] = []
  private utterance: Float32Array[] = []
  private utteranceMs = 0
  private speaking = false
  private freq = new Uint8Array(512)
  private time = new Float32Array(1024)

  constructor(
    private readonly cb: MicCallbacks,
    sensitivity: number,
    silenceMs: number,
  ) {
    this.vad = new EnergyVad(sensitivity, silenceMs)
  }

  get active(): boolean {
    return this.ctx !== null
  }

  setSensitivity(s: number): void {
    this.vad.setSensitivity(s)
  }

  static async devices(): Promise<MediaDeviceInfo[]> {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
  }

  async start(deviceId: string): Promise<void> {
    await this.stop()
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: deviceId === 'default' ? undefined : { exact: deviceId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    })
    const ctx = new AudioContext()
    const source = ctx.createMediaStreamSource(this.stream)
    this.analyser = ctx.createAnalyser()
    this.analyser.fftSize = 1024
    this.analyser.smoothingTimeConstant = 0.5
    this.processor = ctx.createScriptProcessor(FRAME_SIZE, 1, 1)
    const frameMs = (FRAME_SIZE / ctx.sampleRate) * 1000
    const preRollFrames = Math.ceil(PRE_ROLL_MS / frameMs)
    this.processor.onaudioprocess = (e) => {
      const frame = new Float32Array(e.inputBuffer.getChannelData(0))
      const outputActive = this.cb.isOutputActive()
      let d: { event: 'start' | 'end' | null }
      if (outputActive && !this.speaking) {
        // JARVIS is talking: never mute the mic (that would break barge-in) — validate against its echo instead.
        // The VAD is not fed here so its noise floor doesn't adapt to JARVIS's own voice.
        const g = this.gate.process(rms(frame), this.cb.outputLevel(), frameMs, true)
        this.echo.estimate = g.echo
        this.echo.coupling = this.gate.couplingEstimate
        d = { event: g.bargeIn ? 'start' : null }
        if (g.bargeIn) {
          this.echo.bargeIns++
          this.vad.forceStart()
        }
      } else {
        if (!outputActive) this.gate.reset()
        d = this.vad.process(frame, frameMs, false)
      }
      if (d.event === 'start') {
        this.speaking = true
        this.utterance = [...this.preRoll]
        this.utteranceMs = this.utterance.length * frameMs
        this.cb.onSpeechStart()
        this.cb.onActivity?.('start')
      }
      if (this.speaking) {
        this.utterance.push(frame)
        this.utteranceMs += frameMs
        if (d.event === 'end' || this.utteranceMs > MAX_UTTERANCE_MS) this.finish(ctx.sampleRate)
      } else {
        this.preRoll.push(frame)
        if (this.preRoll.length > preRollFrames) this.preRoll.shift()
      }
    }
    source.connect(this.analyser)
    source.connect(this.processor)
    // ScriptProcessor only runs while connected to the destination; a zero gain keeps it silent.
    const mute = ctx.createGain()
    mute.gain.value = 0
    this.processor.connect(mute).connect(ctx.destination)
    this.ctx = ctx
  }

  private finish(sampleRate: number): void {
    this.speaking = false
    this.cb.onActivity?.('end')
    this.vad.reset()
    const total = this.utterance.reduce((n, f) => n + f.length, 0)
    const joined = new Float32Array(total)
    let offset = 0
    for (const f of this.utterance) {
      joined.set(f, offset)
      offset += f.length
    }
    this.utterance = []
    this.cb.onSpeechEnd(resample(joined, sampleRate, STT_SAMPLE_RATE))
  }

  /** Called once per rendered frame by the Orb. */
  sample(): AudioLevels {
    if (!this.analyser) {
      this.levels.rms *= 0.9
      return this.levels
    }
    this.levels.rms = this.levels.rms * 0.5 + readRms(this.analyser, this.time) * 0.5
    readBands(this.analyser, this.freq, this.levels.bands)
    return this.levels
  }

  async stop(): Promise<void> {
    this.processor?.disconnect()
    this.stream?.getTracks().forEach((t) => t.stop())
    await this.ctx?.close().catch(() => undefined)
    this.ctx = null
    this.analyser = null
    this.processor = null
    this.stream = null
  }
}
