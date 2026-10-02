import { JarvisError } from '../errors'
import { expandHome, type NativePort, type ProcessHandle } from '../native'
import { encodeWav } from './audio'
import type { PcmChunk, TTSProvider } from './session'

export type VoiceQuality = 'CINEMATIC' | 'BALANCED' | 'FAST'

export interface SidecarOptions {
  /** Python interpreter of the TTS venv (scripts/setup-tts.sh). */
  python: string
  /** services/tts/aop_tts_server.py (copied into Application Support by the setup script). */
  script: string
  port: number
  profile: string
  quality: VoiceQuality
  /** Streaming interval in seconds of audio per chunk (Qwen3 runs at 12.5 tokens/s → 0.32 s ≈ 4 tokens). */
  chunkSeconds: number
  idleUnloadMin: number
}

export interface SidecarHealth {
  ok: boolean
  engine: string
  loaded: string[]
  rss_mb: number
  mlx_active_mb?: number
  mlx_peak_mb?: number
  sample_rate: number
  profiles: string[]
}

export interface SidecarMetrics {
  id: string
  first_chunk_ms: number | null
  total_ms: number
  audio_s: number
  rtf: number | null
  peak_mem_mb: number | null
  rss_mb: number
  cancelled: boolean
  error: string | null
}

let seq = 0
const START_TIMEOUT_MS = 90_000

/**
 * Qwen3-TTS (MLX) through the local AOP TTS sidecar. The model stays resident in the sidecar process after
 * first use; the sidecar unloads it after a long idle period. PCM streams back as it is generated.
 */
export class QwenSidecarTTS implements TTSProvider {
  readonly id = 'qwen3-mlx'
  private proc: ProcessHandle | null = null
  private starting: Promise<void> | null = null
  private lastRequest: string | null = null

  constructor(
    private readonly native: NativePort,
    private readonly opts: () => SidecarOptions,
    /** fetch that can stream response bodies (Node fetch, or Tauri plugin-http). */
    private readonly fetchImpl: typeof fetch = native.fetch,
  ) {}

  private get base(): string {
    return `http://127.0.0.1:${this.opts().port}`
  }

  voiceKey(): string {
    const o = this.opts()
    return `${this.id}/${o.quality}/${o.profile}`
  }

  async available(): Promise<boolean> {
    if (await this.health().then(Boolean)) return true
    const o = this.opts()
    return (await this.native.exists(expandHome(o.python, this.native.homeDir))) && (await this.native.exists(expandHome(o.script, this.native.homeDir)))
  }

  async health(): Promise<SidecarHealth | null> {
    try {
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), 1500)
      const res = await this.fetchImpl(`${this.base}/health`, { signal: ctl.signal })
      clearTimeout(t)
      return res.ok ? ((await res.json()) as SidecarHealth) : null
    } catch {
      return null
    }
  }

  /** Start the sidecar if it is not already listening (lazy: first voice use). */
  async ensure(): Promise<void> {
    if (await this.health()) return
    this.starting ??= this.start().finally(() => (this.starting = null))
    return this.starting
  }

  private async start(): Promise<void> {
    const o = this.opts()
    const script = expandHome(o.script, this.native.homeDir)
    const cwd = script.replace(/\/[^/]+$/, '')
    this.proc = await this.native.spawn(expandHome(o.python, this.native.homeDir), [script, '--port', String(o.port), '--warm', o.quality, '--idle-unload-min', String(o.idleUnloadMin)], { cwd })
    this.proc.onExit(() => (this.proc = null))
    const deadline = Date.now() + START_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (await this.health()) return
      if (!this.proc) throw new JarvisError('VOICE_ENGINE_ERROR', 'TTS sidecar exited during start — run scripts/setup-tts.sh')
      await new Promise((r) => setTimeout(r, 400))
    }
    throw new JarvisError('VOICE_ENGINE_ERROR', 'TTS sidecar did not become ready')
  }

  async warmup(): Promise<void> {
    await this.ensure()
    await this.post('/warmup', { mode: this.opts().quality })
  }

  stream(text: string, lang: 'ko' | 'en', signal?: AbortSignal): AsyncIterable<PcmChunk> {
    const o = this.opts()
    return this.streamWith(text, lang, o.profile, o.quality, signal)
  }

  /** Voice Lab: synthesize with an explicit candidate and quality mode (bypasses the configured voice). */
  async *streamWith(text: string, lang: 'ko' | 'en', profile: string, quality: VoiceQuality, signal?: AbortSignal): AsyncIterable<PcmChunk> {
    await this.ensure()
    const o = this.opts()
    const id = `aop-${Date.now().toString(36)}-${seq++}`
    this.lastRequest = id
    const ctl = new AbortController()
    const onAbort = () => {
      ctl.abort()
      // Stop generation in the sidecar, not just delivery (it also notices the dropped connection).
      void this.post('/cancel', { id }).catch(() => undefined)
    }
    if (signal?.aborted) return
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const res = await this.fetchImpl(`${this.base}/synthesize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, text, lang, profile, mode: quality, chunk_s: o.chunkSeconds }),
        signal: ctl.signal,
      })
      if (!res.ok) throw new JarvisError('VOICE_ENGINE_ERROR', `TTS ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const sampleRate = Number(res.headers.get('x-sample-rate') ?? 24000)
      yield* pcmStream(res, sampleRate)
    } catch (error) {
      if (ctl.signal.aborted) return
      throw error
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  async synthesize(text: string, lang: 'ko' | 'en', signal?: AbortSignal): Promise<Uint8Array> {
    const chunks: Float32Array[] = []
    let sr = 24000
    for await (const c of this.stream(text, lang, signal)) {
      chunks.push(c.samples)
      sr = c.sampleRate
    }
    const total = chunks.reduce((n, c) => n + c.length, 0)
    const all = new Float32Array(total)
    let off = 0
    for (const c of chunks) {
      all.set(c, off)
      off += c.length
    }
    return encodeWav(all, sr)
  }

  async metrics(id = this.lastRequest): Promise<SidecarMetrics | null> {
    if (!id) return null
    const res = await this.fetchImpl(`${this.base}/metrics?id=${encodeURIComponent(id)}`).catch(() => null)
    return res?.ok ? ((await res.json()) as SidecarMetrics) : null
  }

  async profiles(): Promise<{ id: string; name: string; instruct: string; notes: string; seed: number; hasReference: boolean }[]> {
    await this.ensure()
    const res = await this.fetchImpl(`${this.base}/profiles`)
    return res.ok ? ((await res.json()) as Awaited<ReturnType<QwenSidecarTTS["profiles"]>>) : []
  }

  /** Create a candidate's reference clip with VoiceDesign (Voice Lab). */
  async design(profile: string, lab?: { instruct: string; seed: number; base?: string }): Promise<{ ms: number; audio_s: number; profile: string }> {
    await this.ensure()
    return this.post('/design', lab ? { profile: 'lab', ...lab } : { profile }) as Promise<{ ms: number; audio_s: number; profile: string }>
  }

  /** Promote the current Voice Lab design to a saved candidate. */
  async saveCandidate(id: string, name: string, notes = ''): Promise<void> {
    await this.post('/profiles/save', { id, name, notes })
  }

  async referenceClip(profile: string): Promise<Uint8Array | null> {
    const res = await this.fetchImpl(`${this.base}/voice?profile=${encodeURIComponent(profile)}`).catch(() => null)
    return res?.ok ? new Uint8Array(await res.arrayBuffer()) : null
  }

  async unload(): Promise<void> {
    await this.post('/unload', {}).catch(() => undefined)
  }

  async shutdown(): Promise<void> {
    await this.proc?.kill().catch(() => undefined)
    this.proc = null
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const json = (await res.json().catch(() => ({}))) as { error?: string }
    if (!res.ok) throw new JarvisError('VOICE_ENGINE_ERROR', json.error ?? `TTS ${path} ${res.status}`)
    return json
  }
}

/** int16 LE PCM byte stream → float32 chunks. Handles odd byte splits across network chunks. */
export async function* pcmStream(res: Response, sampleRate: number): AsyncGenerator<PcmChunk> {
  const toChunk = (bytes: Uint8Array): PcmChunk => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const out = new Float32Array(bytes.byteLength >> 1)
    for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768
    return { samples: out, sampleRate }
  }
  const reader = res.body?.getReader()
  if (!reader) {
    // Host fetch without streaming bodies: still works, just without early playback.
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.length >= 2) yield toChunk(buf.subarray(0, buf.length - (buf.length % 2)))
    return
  }
  let carry: Uint8Array | null = null
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value?.length) continue
      let bytes = value
      if (carry) {
        const joined = new Uint8Array(carry.length + value.length)
        joined.set(carry)
        joined.set(value, carry.length)
        bytes = joined
        carry = null
      }
      const even = bytes.length - (bytes.length % 2)
      if (even < bytes.length) carry = bytes.slice(even)
      if (even) yield toChunk(bytes.subarray(0, even))
    }
  } finally {
    // Early exit (barge-in) must close the connection so the sidecar stops generating.
    await reader.cancel().catch(() => undefined)
  }
}
