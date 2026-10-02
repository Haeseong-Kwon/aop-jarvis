import { errorMessage } from '../errors'
import type { EventBus } from '../events'
import type { VoiceState } from '../types'
import { decodeWav } from './audio'
import { SpeechCache } from './cache'
import { planSpeech, type PlannerOptions } from './planner'

// Provider interfaces — local implementations are first-class (whisper.cpp, macOS speech).

export interface STTProvider {
  readonly id: string
  available(): Promise<boolean>
  transcribe(samples16k: Float32Array, signal?: AbortSignal): Promise<string>
}

/** Mono PCM, float32 in [-1, 1]. */
export interface PcmChunk {
  samples: Float32Array
  sampleRate: number
}

export interface TTSProvider {
  readonly id: string
  available(): Promise<boolean>
  /** Returns encoded audio (WAV). Used when the engine cannot stream. */
  synthesize(text: string, lang: 'ko' | 'en', signal?: AbortSignal): Promise<Uint8Array>
  /** Streams PCM as it is generated. Aborting the signal must stop generation, not just delivery. */
  stream?(text: string, lang: 'ko' | 'en', signal?: AbortSignal): AsyncIterable<PcmChunk>
  /** Identity of the current voice (engine + model + profile + parameters) — the phrase-cache key prefix. */
  voiceKey?(): string
  /** Load models ahead of the first utterance (lazy residency). */
  warmup?(): Promise<void>
}

/** Decides whether an utterance addresses JARVIS; returns the command after the wake word ('' = wake only). */
export interface WakeWordProvider {
  readonly id: string
  match(transcript: string): { woke: boolean; command: string }
}

/**
 * Gapless speech sink (the host's playback queue). Chunks pushed during one utterance play back-to-back;
 * `gap` inserts semantic silence; `stop` cancels instantly (barge-in).
 */
export interface AudioOutput {
  /** Start a new utterance (cancels anything still queued). `onFirstAudio` fires when sound actually starts. */
  begin(onFirstAudio?: () => void): void
  push(chunk: PcmChunk): void
  gap(ms: number): void
  /** Resolves when everything pushed has played, or as soon as `stop()` is called. */
  drain(): Promise<void>
  stop(): void
}

export type LatencyStage = 'wake' | 'vad_end' | 'stt' | 'handler' | 'tts_first_chunk' | 'first_audio' | 'turn_total' | 'interrupt'

// Transcript-based wake word: whisper writes "AOP" many ways. Matching happens on a normalized form.
const WAKE_VARIANTS = ['aop', 'a.o.p', 'ao p', 'eiop', '에이오피', '에이오비', '에이오프', '에이 오 피', '에이오 피', '에이 오피', 'jarvis', '자비스', '쟈비스']

const WAKE_FILLERS = new Set(['', 'hey', 'ok', 'okay', 'hi', '야', '헤이', '저기', '오케이'])

export class TranscriptWakeWord implements WakeWordProvider {
  readonly id = 'transcript'
  private readonly variants: string[]
  constructor(extra: string[] = []) {
    this.variants = [...new Set([...WAKE_VARIANTS, ...extra].map(norm))].sort((a, b) => b.length - a.length)
  }

  match(transcript: string): { woke: boolean; command: string } {
    const words = transcript.trim()
    const n = norm(words)
    for (const v of this.variants) {
      const at = n.indexOf(v)
      // The wake word must open the utterance (optionally after a filler like "hey" / "야").
      if (at === -1 || !WAKE_FILLERS.has(n.slice(0, at))) continue
      // Map the normalized cut back onto the original text by counting kept characters.
      let kept = 0
      let cut = 0
      for (; cut < words.length && kept < at + v.length; cut++) if (norm(words[cut]!) !== '') kept++
      return { woke: true, command: words.slice(cut).replace(/^[\s,.!?~]+/, '').trim() }
    }
    return { woke: false, command: '' }
  }
}

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}.]/gu, '')

export type CommandHandler = (text: string, signal: AbortSignal) => Promise<{ speech: string; lang: 'ko' | 'en' }>

export interface VoiceSessionDeps {
  stt: STTProvider
  tts: TTSProvider | null
  wake: WakeWordProvider
  output: AudioOutput
  handler: CommandHandler
  bus: EventBus
  wakeWordEnabled: () => boolean
  bargeIn: () => boolean
  /** How long to keep listening for a follow-up without the wake word. */
  followUpMs?: number
  /** SpeechPlanner options (number style, lexicon, chunk sizes). */
  planner?: () => PlannerOptions
  /** Phrase cache for stable system phrases (same voice + text). */
  cache?: SpeechCache
  now?: () => number
  /** Clock injection for tests. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void
}

const DEFAULT_FOLLOW_UP_MS = 5000
const MIN_UTTERANCE_SAMPLES = 16_000 * 0.25

/**
 * Voice state machine: IDLE → (wake) LISTENING → TRANSCRIBING → THINKING → SPEAKING → LISTENING (follow-up) → IDLE.
 * Barge-in: speech during SPEAKING stops TTS immediately → INTERRUPTED → LISTENING. Conversation context lives
 * in the executive, so an interruption loses nothing but the unspoken remainder.
 */
export class VoiceSession {
  private _state: VoiceState = 'IDLE'
  private request: AbortController | null = null
  private followUpTimer: ReturnType<typeof setTimeout> | null = null
  private capturing = false
  private speech: AbortController | null = null
  private turnStart: number | null = null
  private readonly cache: SpeechCache

  constructor(private readonly d: VoiceSessionDeps) {
    this.cache = d.cache ?? new SpeechCache()
  }

  private now(): number {
    return this.d.now ? this.d.now() : typeof performance !== 'undefined' ? performance.now() : Date.now()
  }

  private metric(stage: LatencyStage, ms: number): void {
    this.d.bus.emit('voice:latency', { stage, ms: Math.round(ms) })
  }

  get state(): VoiceState {
    return this._state
  }

  /** The VAD uses this to raise its threshold while JARVIS is talking (echo guard). */
  get isSpeaking(): boolean {
    return this._state === 'SPEAKING'
  }

  /** Push-to-talk / orb click / hotkey. */
  wake(): void {
    if (this._state === 'SPEAKING') this.interrupt()
    this.set('LISTENING')
    this.armFollowUp()
  }

  /** Stop everything and go idle. */
  sleep(): void {
    this.request?.abort()
    this.speech?.abort()
    this.d.output.stop()
    this.clearFollowUp()
    this.set('IDLE')
  }

  speechStart(): void {
    if (this._state === 'SPEAKING') {
      if (this.d.bargeIn()) {
        this.interrupt()
        this.set('LISTENING')
        this.capturing = true
      }
      return
    }
    if (this._state === 'IDLE' || this._state === 'LISTENING' || this._state === 'INTERRUPTED') {
      this.clearFollowUp()
      this.capturing = true
    }
  }

  /** End of an utterance with its audio at 16 kHz. */
  async speechEnd(samples16k: Float32Array): Promise<void> {
    if (!this.capturing) return
    this.capturing = false
    const vadEndAt = this.now()
    this.turnStart = vadEndAt
    if (samples16k.length < MIN_UTTERANCE_SAMPLES) return this.armFollowUpIfListening()
    const wasIdle = this._state === 'IDLE'
    if (wasIdle && !this.d.wakeWordEnabled()) return
    // A wake-word check on ambient speech stays silent; only a real command turn shows TRANSCRIBING.
    if (!wasIdle) this.set('TRANSCRIBING')
    let text: string
    try {
      text = (await this.d.stt.transcribe(samples16k)).trim()
    } catch (error) {
      this.fail(`STT failed: ${errorMessage(error)}`)
      return
    }
    this.metric('stt', this.now() - vadEndAt)
    if (wasIdle) {
      const m = isHallucination(text) ? { woke: false, command: '' } : this.d.wake.match(text)
      if (!m.woke) return
      this.d.bus.emit('voice:transcript', { text, final: true })
      if (!m.command) {
        this.set('LISTENING')
        this.metric('wake', this.now() - vadEndAt)
        return this.armFollowUp()
      }
      return this.run(m.command)
    }
    if (!text || isNoise(text) || isHallucination(text)) return this.armFollowUpIfListening(true)
    this.d.bus.emit('voice:transcript', { text, final: true })
    return this.run(text)
  }

  private async run(text: string): Promise<void> {
    this.set('THINKING')
    this.request = new AbortController()
    const signal = this.request.signal
    let reply: { speech: string; lang: 'ko' | 'en' }
    const handlerAt = this.now()
    try {
      reply = await this.d.handler(text, signal)
    } catch (error) {
      if (signal.aborted) return
      this.fail(errorMessage(error))
      return
    }
    this.metric('handler', this.now() - handlerAt)
    if (signal.aborted || this._state !== 'THINKING') return
    await this.speak(reply.speech, reply.lang, true)
  }

  /**
   * `followUp`: keep listening briefly without the wake word afterwards. Only voice turns do this —
   * a typed command must never open the microphone to whatever is said next in the room.
   */
  async speak(text: string, lang: 'ko' | 'en', followUp = false): Promise<void> {
    const after = () => {
      if (followUp) {
        this.set('LISTENING')
        this.armFollowUp()
      } else this.set('IDLE')
    }
    const plan = planSpeech(text, { lang, ...this.d.planner?.() })
    if (!this.d.tts || plan.skip) return after()
    this.speech?.abort()
    const ctl = new AbortController()
    this.speech = ctl
    const speakAt = this.now()
    const turnStart = this.turnStart
    this.turnStart = null
    let started = false
    this.d.output.begin(() => {
      this.metric('first_audio', this.now() - speakAt)
      if (turnStart !== null) this.metric('turn_total', this.now() - turnStart)
    })
    try {
      for (const seg of plan.segments) {
        for await (const chunk of this.chunks(seg.text, seg.lang, plan.cacheable, ctl.signal)) {
          if (ctl.signal.aborted) break
          if (!started) {
            // Only start talking if nothing else (barge-in, sleep, a newer turn) took over meanwhile.
            if (this._state !== 'THINKING' && this._state !== 'LISTENING' && this._state !== 'IDLE') {
              ctl.abort()
              break
            }
            started = true
            this.metric('tts_first_chunk', this.now() - speakAt)
            this.set('SPEAKING')
          }
          this.d.output.push(chunk)
        }
        if (ctl.signal.aborted) break
        if (seg.pauseAfterMs) this.d.output.gap(seg.pauseAfterMs)
      }
    } catch (error) {
      if (ctl.signal.aborted) return
      this.d.output.stop()
      this.fail(`TTS failed: ${errorMessage(error)}`)
      return
    }
    if (ctl.signal.aborted) return
    if (!started) return after()
    await this.d.output.drain()
    if (this.speech === ctl) this.speech = null
    if ((this._state as VoiceState) === 'SPEAKING' && !ctl.signal.aborted) after()
  }

  /** One segment's audio: phrase cache → streaming engine → whole-file fallback. */
  private async *chunks(text: string, lang: 'ko' | 'en', cacheable: boolean, signal: AbortSignal): AsyncGenerator<PcmChunk> {
    const tts = this.d.tts!
    const key = cacheable ? `${tts.voiceKey?.() ?? tts.id}|${lang}|${text}` : null
    const hit = key ? this.cache.get(key) : undefined
    if (hit) {
      yield hit
      return
    }
    const collected: PcmChunk[] = []
    if (tts.stream) {
      for await (const c of tts.stream(text, lang, signal)) {
        if (key) collected.push(c)
        yield c
      }
    } else {
      const c = decodeWav(await tts.synthesize(text, lang, signal))
      if (key) collected.push(c)
      yield c
    }
    if (key && !signal.aborted && collected.length) this.cache.set(key, SpeechCache.concat(collected))
  }

  private interrupt(): void {
    const at = this.now()
    this.speech?.abort()
    this.d.output.stop()
    this.metric('interrupt', this.now() - at)
    this.request?.abort()
    this.set('INTERRUPTED')
  }

  private fail(message: string): void {
    this.d.bus.emit('error', { code: 'VOICE_ENGINE_ERROR', message })
    this.set('ERROR')
    this.armFollowUp(2500)
  }

  private armFollowUpIfListening(keep = false): void {
    if (keep || this._state === 'LISTENING' || this._state === 'TRANSCRIBING') {
      this.set('LISTENING')
      this.armFollowUp()
    } else if (this._state !== 'IDLE') this.set('IDLE')
  }

  private armFollowUp(ms = this.d.followUpMs ?? DEFAULT_FOLLOW_UP_MS): void {
    this.clearFollowUp()
    const fire = () => {
      if (this._state === 'LISTENING' || this._state === 'ERROR' || this._state === 'INTERRUPTED') this.set('IDLE')
    }
    // DOM and Node disagree on setTimeout's return type; the handle is opaque either way.
    this.followUpTimer = this.d.setTimer ? this.d.setTimer(fire, ms) : (setTimeout(fire, ms) as ReturnType<typeof setTimeout>)
  }

  private clearFollowUp(): void {
    if (this.followUpTimer) (this.d.clearTimer ?? clearTimeout)(this.followUpTimer)
    this.followUpTimer = null
  }

  private set(state: VoiceState): void {
    if (this._state === state) return
    this._state = state
    this.d.bus.emit('voice:state', { state })
  }
}

// Whisper's well-known outputs for non-speech (subtitle-corpus artifacts), Korean and English.
const HALLUCINATIONS = /^(감사합니다|고맙습니다|시청해\s*주셔서\s*감사합니다|구독과\s*좋아요.*|MBC\s*뉴스.*|thank you( for watching)?|thanks for watching|you|bye)[.!\s]*$/i
export const isHallucination = (t: string): boolean => HALLUCINATIONS.test(t.trim())

// Whisper emits these for silence / background noise.
const isNoise = (t: string): boolean => /^[\s.\-–…]*$|^\[(blank_audio|music|silence|음악)\]$|^\(.*\)$/i.test(t)

/** Strip markdown so TTS does not read symbols aloud. */
export const speakable = (text: string): string =>
  text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[#*_`>|]/g, '')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/\n{2,}/g, '\n')
    .trim()
    .slice(0, 600)
