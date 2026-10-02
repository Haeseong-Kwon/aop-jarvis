import { JarvisError } from '../errors'
import { expandHome, type NativePort } from '../native'
import { encodeWav, STT_SAMPLE_RATE } from './audio'
import type { STTProvider, TTSProvider } from './session'

const STT_TIMEOUT_MS = 30_000
const TTS_TIMEOUT_MS = 20_000
let seq = 0
const tmpName = (native: NativePort, ext: string): string => `${native.tempDir}/jarvis-${Date.now()}-${seq++}.${ext}`

/** whisper.cpp CLI (Metal-accelerated on Apple Silicon). Installed by scripts/setup-voice.sh. */
export class WhisperCppSTT implements STTProvider {
  readonly id = 'whisper.cpp'
  constructor(
    private readonly native: NativePort,
    private readonly opts: () => { bin: string | null; modelPath: string; language: string },
  ) {}

  async available(): Promise<boolean> {
    const { bin, modelPath } = this.opts()
    return !!bin && (await this.native.exists(expandHome(modelPath, this.native.homeDir)))
  }

  async transcribe(samples16k: Float32Array, signal?: AbortSignal): Promise<string> {
    const { bin, modelPath, language } = this.opts()
    if (!bin) throw new JarvisError('NOT_CONFIGURED', 'whisper-cli not installed — run scripts/setup-voice.sh')
    const wav = tmpName(this.native, 'wav')
    await this.native.writeBinaryFile(wav, encodeWav(samples16k, STT_SAMPLE_RATE))
    const out = await this.native.exec(
      bin,
      ['-m', expandHome(modelPath, this.native.homeDir), '-f', wav, '-l', language, '-nt', '-np', '-t', '4'],
      { timeoutMs: STT_TIMEOUT_MS, ...(signal ? { signal } : {}) },
    )
    void this.native.removeTemp(wav).catch(() => undefined)
    if (out.code !== 0) throw new JarvisError('VOICE_ENGINE_ERROR', out.stderr.split('\n').filter(Boolean).pop() ?? 'whisper failed')
    return out.stdout.replace(/\s+/g, ' ').trim()
  }
}

/** macOS native speech synthesis — local, zero-install, with Korean voices (Kokoro has no Korean). */
export class MacSpeechTTS implements TTSProvider {
  readonly id = 'macos-say'
  constructor(
    private readonly native: NativePort,
    private readonly opts: () => { voiceKo: string; voiceEn: string; rate: number },
  ) {}

  async available(): Promise<boolean> {
    return this.native.exists('/usr/bin/say')
  }

  async synthesize(text: string, lang: 'ko' | 'en'): Promise<Uint8Array> {
    const { voiceKo, voiceEn, rate } = this.opts()
    const file = tmpName(this.native, 'wav')
    const out = await this.native.exec(
      '/usr/bin/say',
      ['-v', lang === 'ko' ? voiceKo : voiceEn, '-r', String(rate), '-o', file, '--file-format=WAVE', '--data-format=LEI16@22050', '--', text],
      { timeoutMs: TTS_TIMEOUT_MS },
    )
    if (out.code !== 0) throw new JarvisError('VOICE_ENGINE_ERROR', out.stderr.trim() || 'say failed')
    const audio = await this.native.readBinaryFile(file)
    void this.native.removeTemp(file).catch(() => undefined)
    return audio
  }
}
