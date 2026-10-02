import { errorMessage } from '../errors'
import { decodeWav } from './audio'
import type { PcmChunk, TTSProvider } from './session'

/**
 * Primary engine with an automatic fallback. If the primary fails *before producing audio* (sidecar not
 * installed, model missing, crash), the same text is spoken with the fallback so JARVIS never goes silent.
 * Once audio has started, errors propagate (switching voices mid-sentence would be worse than stopping).
 */
export class FallbackTTS implements TTSProvider {
  readonly id: string
  active: 'primary' | 'fallback' = 'primary'
  lastError: string | null = null

  constructor(
    readonly primary: TTSProvider,
    readonly fallback: TTSProvider,
    private readonly usePrimary: () => boolean,
    private readonly onFallback: (reason: string) => void = () => undefined,
  ) {
    this.id = `${primary.id}+${fallback.id}`
  }

  voiceKey(): string {
    const p = this.usePrimary() && this.active === 'primary' ? this.primary : this.fallback
    return p.voiceKey?.() ?? p.id
  }

  async available(): Promise<boolean> {
    return (this.usePrimary() && (await this.primary.available())) || this.fallback.available()
  }

  async warmup(): Promise<void> {
    if (!this.usePrimary()) {
      this.active = 'fallback'
      return
    }
    try {
      await this.primary.warmup?.()
      this.active = 'primary'
    } catch (error) {
      this.degrade(error)
    }
  }

  async *stream(text: string, lang: 'ko' | 'en', signal?: AbortSignal): AsyncIterable<PcmChunk> {
    if (this.usePrimary() && this.primary.stream) {
      let produced = false
      try {
        for await (const c of this.primary.stream(text, lang, signal)) {
          produced = true
          this.active = 'primary'
          yield c
        }
        if (produced || signal?.aborted) return
      } catch (error) {
        if (produced || signal?.aborted) throw error
        this.degrade(error)
      }
    }
    if (signal?.aborted) return
    this.active = 'fallback'
    if (this.fallback.stream) yield* this.fallback.stream(text, lang, signal)
    else yield decodeWav(await this.fallback.synthesize(text, lang, signal))
  }

  async synthesize(text: string, lang: 'ko' | 'en', signal?: AbortSignal): Promise<Uint8Array> {
    if (this.usePrimary()) {
      try {
        return await this.primary.synthesize(text, lang, signal)
      } catch (error) {
        this.degrade(error)
      }
    }
    return this.fallback.synthesize(text, lang, signal)
  }

  private degrade(error: unknown): void {
    this.active = 'fallback'
    this.lastError = errorMessage(error)
    this.onFallback(this.lastError)
  }
}
