import { errorMessage } from '../errors'
import type { EventBus } from '../events'
import type { VoiceState } from '../types'

// Provider interfaces — local implementations are first-class (whisper.cpp, macOS speech).

export interface STTProvider {
  readonly id: string
  available(): Promise<boolean>
  transcribe(samples16k: Float32Array, signal?: AbortSignal): Promise<string>
}

export interface TTSProvider {
  readonly id: string
  available(): Promise<boolean>
  /** Returns encoded audio (WAV) for the host to play through its analyser. */
  synthesize(text: string, lang: 'ko' | 'en'): Promise<Uint8Array>
}

/** Decides whether an utterance addresses JARVIS; returns the command after the wake word ('' = wake only). */
export interface WakeWordProvider {
  readonly id: string
  match(transcript: string): { woke: boolean; command: string }
}

export interface AudioOutput {
  /** Resolves when playback ends or is stopped. */
  play(audio: Uint8Array): Promise<void>
  stop(): void
}

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

  constructor(private readonly d: VoiceSessionDeps) {}

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
    if (wasIdle) {
      const m = isHallucination(text) ? { woke: false, command: '' } : this.d.wake.match(text)
      if (!m.woke) return
      this.d.bus.emit('voice:transcript', { text, final: true })
      if (!m.command) {
        this.set('LISTENING')
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
    try {
      reply = await this.d.handler(text, signal)
    } catch (error) {
      if (signal.aborted) return
      this.fail(errorMessage(error))
      return
    }
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
    if (!this.d.tts || !text.trim()) return after()
    let audio: Uint8Array
    try {
      audio = await this.d.tts.synthesize(speakable(text), lang)
    } catch (error) {
      this.fail(`TTS failed: ${errorMessage(error)}`)
      return
    }
    if (this._state !== 'THINKING' && this._state !== 'LISTENING' && this._state !== 'IDLE') return
    this.set('SPEAKING')
    await this.d.output.play(audio)
    if ((this._state as VoiceState) === 'SPEAKING') after()
  }

  private interrupt(): void {
    this.d.output.stop()
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
