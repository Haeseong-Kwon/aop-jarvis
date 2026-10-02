import { EnergyVad, resample, STT_SAMPLE_RATE } from '@aop/core'
import { BAND_COUNT, readBands, readRms, type AudioLevels } from './levels'

const FRAME_SIZE = 2048
const PRE_ROLL_MS = 350
const MAX_UTTERANCE_MS = 15_000

export interface MicCallbacks {
  onSpeechStart: () => void
  onSpeechEnd: (samples16k: Float32Array) => void
  /** True while JARVIS speaks: the VAD raises its bar so TTS echo is not taken as barge-in. */
  isOutputActive: () => boolean
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
      const d = this.vad.process(frame, frameMs, this.cb.isOutputActive())
      if (d.event === 'start') {
        this.speaking = true
        this.utterance = [...this.preRoll]
        this.utteranceMs = this.utterance.length * frameMs
        this.cb.onSpeechStart()
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
