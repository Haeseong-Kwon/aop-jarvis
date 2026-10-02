import { decodeWav, type AudioOutput, type PcmChunk } from '@aop/core'
import { BAND_COUNT, readBands, readRms, type AudioLevels } from './levels'

/** Suspend idle audio contexts after this long, so the Mac can still idle-sleep while JARVIS waits. */
const IDLE_SUSPEND_MS = 1500

export interface SpeechQueueStats {
  /** Audio scheduled but not yet played (ms). */
  queuedMs: number
  underruns: number
  /** Current jitter-buffer lead (ms) — grows after underruns. */
  leadMs: number
  chunks: number
}

/**
 * SpeechQueue: gapless playback of streamed TTS PCM on the AudioContext timeline.
 *
 *   chunk → AudioBufferSource scheduled at `nextTime` (sample-accurate, no gaps or overlaps)
 *         → [mastering: high-pass → low-mid body → presence → compressor → limiter] → fade → analyser → speakers
 *
 * The analyser sits after mastering, so the Orb reacts to exactly what the user hears. Underruns (a chunk
 * arriving after its slot) are counted and grow the jitter-buffer lead; `stop()` fades out in ~12 ms (no pop)
 * and cancels everything queued — that is the barge-in path.
 */
export class SpeechOutput implements AudioOutput {
  readonly levels: AudioLevels = { rms: 0, bands: new Float32Array(BAND_COUNT) }
  private ctx = new AudioContext({ latencyHint: 'interactive' })
  private input = this.ctx.createGain()
  private fade = this.ctx.createGain()
  private analyser = this.ctx.createAnalyser()
  private master: AudioNode[] = []
  private sources = new Set<AudioBufferSourceNode>()
  private nextTime = 0
  private leadS = 0.05
  private underruns = 0
  private chunks = 0
  private started = false
  private speaking = false
  private onFirst: (() => void) | null = null
  private drainResolve: (() => void) | null = null
  private drainTimer: ReturnType<typeof setTimeout> | null = null
  private startTimer: ReturnType<typeof setTimeout> | null = null
  private freq = new Uint8Array(512)
  private time = new Float32Array(1024)
  private refTime = new Float32Array(256)
  private generation = 0
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  onActiveChange: (active: boolean) => void = () => undefined

  constructor(mastering = true) {
    this.analyser.fftSize = 1024
    this.analyser.smoothingTimeConstant = 0.35
    this.fade.connect(this.analyser).connect(this.ctx.destination)
    this.setMastering(mastering)
    // A running context holds the output device open, which macOS counts as "playing audio" and which
    // prevents idle sleep. Stay suspended until there is something to say.
    void this.ctx.suspend()
  }

  private wakeContext(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (this.ctx.state === 'suspended') void this.ctx.resume()
  }

  private sleepSoon(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (!this.started && !this.sources.size) void this.ctx.suspend()
    }, IDLE_SUSPEND_MS)
  }

  /** Subtle mastering — the model must provide the natural voice; this only cleans and steadies it. */
  setMastering(on: boolean): void {
    this.input.disconnect()
    this.master.forEach((n) => n.disconnect())
    this.master = []
    if (!on) {
      this.input.connect(this.fade)
      return
    }
    const c = this.ctx
    const hp = new BiquadFilterNode(c, { type: 'highpass', frequency: 75, Q: 0.7 })
    const body = new BiquadFilterNode(c, { type: 'peaking', frequency: 170, Q: 0.8, gain: 1.5 })
    const mud = new BiquadFilterNode(c, { type: 'peaking', frequency: 420, Q: 1.1, gain: -1.2 })
    const presence = new BiquadFilterNode(c, { type: 'peaking', frequency: 3800, Q: 0.9, gain: 1.0 })
    const comp = new DynamicsCompressorNode(c, { threshold: -22, knee: 8, ratio: 2.2, attack: 0.006, release: 0.14 })
    const makeup = new GainNode(c, { gain: 1.25 })
    const limiter = new DynamicsCompressorNode(c, { threshold: -2.5, knee: 0, ratio: 20, attack: 0.001, release: 0.06 })
    this.master = [hp, body, mud, presence, comp, makeup, limiter]
    this.input.connect(hp)
    this.master.reduce((a, b) => a.connect(b) as AudioNode)
    limiter.connect(this.fade)
  }

  get active(): boolean {
    return this.speaking
  }

  stats(): SpeechQueueStats {
    return { queuedMs: Math.max(0, (this.nextTime - this.ctx.currentTime) * 1000), underruns: this.underruns, leadMs: this.leadS * 1000, chunks: this.chunks }
  }

  /** Playback reference level for echo gating (cheap: 256-sample window). */
  refLevel(): number {
    if (!this.speaking) return 0
    this.analyser.getFloatTimeDomainData(this.refTime)
    let s = 0
    for (const x of this.refTime) s += x * x
    return Math.sqrt(s / this.refTime.length)
  }

  begin(onFirstAudio?: () => void): void {
    this.stop()
    this.generation++
    this.onFirst = onFirstAudio ?? null
    this.started = false
    this.chunks = 0
    this.wakeContext()
    this.fade.gain.cancelScheduledValues(this.ctx.currentTime)
    this.fade.gain.setValueAtTime(1, this.ctx.currentTime)
    this.nextTime = 0
  }

  push(chunk: PcmChunk): void {
    if (!chunk.samples.length) return
    const now = this.ctx.currentTime
    const buf = this.ctx.createBuffer(1, chunk.samples.length, chunk.sampleRate)
    const data = chunk.samples.slice()
    if (!this.started) {
      // 4 ms fade-in on the first sample of an utterance (no click on onset).
      const n = Math.min(data.length, Math.round(chunk.sampleRate * 0.004))
      for (let i = 0; i < n; i++) data[i]! *= i / n
    }
    buf.copyToChannel(data, 0)
    if (this.started && this.nextTime < now + 0.002) {
      // Underrun: the chunk missed its slot. Count it and give the jitter buffer more lead next time.
      this.underruns++
      this.leadS = Math.min(0.25, this.leadS + 0.04)
    }
    const at = Math.max(this.nextTime, now + (this.started ? 0.01 : this.leadS))
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    src.connect(this.input)
    src.onended = () => this.sources.delete(src)
    src.start(at)
    this.sources.add(src)
    this.nextTime = at + buf.duration
    this.chunks++
    if (!this.started) {
      this.started = true
      const gen = this.generation
      this.startTimer = setTimeout(() => {
        if (gen !== this.generation) return
        this.speaking = true
        this.onActiveChange(true)
        this.onFirst?.()
        this.onFirst = null
      }, Math.max(0, (at - now) * 1000))
    }
  }

  gap(ms: number): void {
    if (!this.started) return
    this.nextTime = Math.max(this.nextTime, this.ctx.currentTime) + ms / 1000
  }

  drain(): Promise<void> {
    if (!this.started) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.drainResolve = resolve
      const check = () => {
        const left = this.nextTime - this.ctx.currentTime
        if (left <= 0.005) this.finish()
        else this.drainTimer = setTimeout(check, Math.min(250, left * 1000 + 15))
      }
      check()
    })
  }

  private finish(): void {
    if (this.drainTimer) clearTimeout(this.drainTimer)
    if (this.startTimer) clearTimeout(this.startTimer)
    this.drainTimer = null
    this.startTimer = null
    if (this.speaking) {
      this.speaking = false
      this.onActiveChange(false)
    }
    this.started = false
    const r = this.drainResolve
    this.drainResolve = null
    r?.()
    this.sleepSoon()
  }

  /** Immediate stop (barge-in): ~12 ms fade, cancel everything queued. */
  stop(): void {
    if (!this.started && !this.sources.size) return this.finish()
    const now = this.ctx.currentTime
    this.fade.gain.cancelScheduledValues(now)
    this.fade.gain.setValueAtTime(this.fade.gain.value, now)
    this.fade.gain.setTargetAtTime(0, now, 0.004)
    for (const s of this.sources) {
      s.onended = null
      try {
        s.stop(now + 0.03)
      } catch {
        /* not started */
      }
    }
    this.sources.clear()
    this.nextTime = 0
    this.generation++
    this.finish()
  }

  /** Encoded audio (Voice Lab candidates, cached greeting files): decoded and played through the same chain. */
  async play(audio: Uint8Array): Promise<void> {
    let chunk: PcmChunk
    try {
      chunk = decodeWav(audio)
    } catch {
      const b = await this.ctx.decodeAudioData(audio.slice().buffer)
      chunk = { samples: b.getChannelData(0).slice(), sampleRate: b.sampleRate }
    }
    this.begin()
    this.push(chunk)
    await this.drain()
  }

  sample(): AudioLevels {
    if (!this.speaking) {
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
  /** True from play() until the fade-out has finished. */
  playing = false
  private gain = this.ctx.createGain()
  private source: AudioBufferSourceNode | null = null
  private volume = 0

  constructor() {
    this.gain.connect(this.ctx.destination)
    void this.ctx.suspend()
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
    this.playing = true
    source.onended = () => {
      if (this.source === source || this.source === null) this.playing = false
    }
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
    setTimeout(() => (this.playing = false), ms + 60)
    setTimeout(() => !this.source && void this.ctx.suspend(), ms + IDLE_SUSPEND_MS)
  }

  stop(): void {
    try {
      this.source?.stop()
    } catch {
      /* not started */
    }
    this.source = null
    this.playing = false
    void this.ctx.suspend()
  }
}
