// Developer-only tools for tuning AOP's voice and inspecting the speech pipeline. Not part of normal UI.
import { planSpeech, type LatencyStage, type PcmChunk, type SidecarHealth, type SidecarMetrics, type VoiceQuality } from '@aop/core'
import { useEffect, useRef, useState } from 'react'
import { useUi } from '../store'
import { useController } from './shared'

const STAGES: [LatencyStage, string][] = [
  ['wake', 'wake detection (VAD end → LISTENING)'],
  ['stt', 'STT (VAD end → transcript)'],
  ['handler', 'router + LLM + execution'],
  ['tts_first_chunk', 'TTS first chunk'],
  ['first_audio', 'TTS first audio (sound out)'],
  ['turn_total', 'total turn (VAD end → first audio)'],
  ['interrupt', 'barge-in stop'],
]

/** Pipeline latency (measured on every voice turn) + echo gate + playback queue health. */
export function VoiceLatency() {
  const c = useController()
  const latency = useUi((s) => s.voiceLatency)
  const log = useUi((s) => s.latencyLog)
  const vad = useUi((s) => s.config?.voice.silenceMs ?? 700)
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 500)
    return () => clearInterval(t)
  }, [])
  const q = c.speech.stats()
  const p = (stage: LatencyStage, pct: number) => {
    const xs = log.filter((l) => l.stage === stage).map((l) => l.ms).sort((a, b) => a - b)
    return xs.length ? xs[Math.min(xs.length - 1, Math.floor(xs.length * pct))] : undefined
  }
  return (
    <>
      <p className="note">Measured live on every voice turn. VAD end-of-speech hangover is configured at {vad} ms and precedes every stage below.</p>
      <table>
        <thead><tr><th>stage</th><th>last</th><th>p50</th><th>p95</th></tr></thead>
        <tbody>
          {STAGES.map(([k, label]) => (
            <tr key={k}><td>{label}</td><td>{latency[k] ?? '—'}</td><td>{p(k, 0.5) ?? '—'}</td><td>{p(k, 0.95) ?? '—'}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="note">Speech queue</p>
      <table>
        <tbody>
          <tr><th>queued</th><td>{q.queuedMs.toFixed(0)} ms</td></tr>
          <tr><th>underruns</th><td>{q.underruns}</td></tr>
          <tr><th>jitter lead</th><td>{q.leadMs.toFixed(0)} ms</td></tr>
          <tr><th>echo estimate / coupling</th><td>{c.mic.echo.estimate.toFixed(4)} / {c.mic.echo.coupling.toFixed(2)}</td></tr>
          <tr><th>barge-ins</th><td>{c.mic.echo.bargeIns}</td></tr>
          <tr><th>TTS path</th><td>{c.rt.tts.active === 'primary' ? 'Qwen3-TTS sidecar' : `macOS speech (fallback)${c.rt.tts.lastError ? ` — ${c.rt.tts.lastError}` : ''}`}</td></tr>
        </tbody>
      </table>
    </>
  )
}

const MODEL_IDS: Record<VoiceQuality, string> = {
  CINEMATIC: 'Qwen3-TTS-12Hz-1.7B-Base-bf16',
  BALANCED: 'Qwen3-TTS-12Hz-1.7B-Base-bf16',
  FAST: 'Qwen3-TTS-12Hz-0.6B-Base-bf16',
}
const quantOf = (id: string): string => (/(\d)bit/.test(id) ? `${/(\d)bit/.exec(id)![1]}-bit quantized` : /bf16|fp16/.test(id) ? 'bf16 — not quantized' : 'unknown precision')

interface Take {
  label: string
  profile: string
  mode: VoiceQuality
  text: string
  pcm: PcmChunk | null
  metrics: SidecarMetrics | null
  clientFirstMs: number | null
}

const SAMPLES = [
  '좋은 오후입니다. 현재 시스템은 정상적으로 작동하고 있습니다.',
  'CPU 26%, RAM 16.5/32GB이고 task 3개 실행 중입니다.',
  'Buyer Pilot 분석을 완료했습니다. Search pipeline에서 두 가지 병목을 발견했습니다.',
  "Good evening. All systems are operational. I've completed the analysis.",
  'AOP Memory is online. 관련된 이전 decision 3건을 찾았습니다.',
  '이 파일을 휴지통으로 옮길까요?',
]

export function VoiceLab() {
  const c = useController()
  const cfg = useUi((s) => s.config)
  const qwen = c.rt.qwen
  const [health, setHealth] = useState<SidecarHealth | null>(null)
  const [profiles, setProfiles] = useState<Awaited<ReturnType<typeof qwen.profiles>>>([])
  const [profile, setProfile] = useState(cfg?.voice.voiceProfile ?? 'aop-core-a')
  const [mode, setMode] = useState<VoiceQuality>(cfg?.voice.voiceQuality ?? 'CINEMATIC')
  const [text, setText] = useState(SAMPLES[0]!)
  const [lang, setLang] = useState<'auto' | 'ko' | 'en'>('auto')
  const [instruct, setInstruct] = useState('')
  const [seed, setSeed] = useState(1103)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [takes, setTakes] = useState<{ A: Take | null; B: Take | null; C: Take | null }>({ A: null, B: null, C: null })
  const [current, setCurrent] = useState<Take | null>(null)
  const canvas = useRef<HTMLCanvasElement>(null)

  const refresh = async () => {
    setHealth(await qwen.health())
    try {
      const list = await qwen.profiles()
      setProfiles(list)
      if (!instruct) setInstruct(list.find((p) => p.id === profile)?.instruct ?? '')
    } catch (e) {
      setError(String(e))
    }
  }
  useEffect(() => void refresh(), [])

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
      void refresh()
    }
  }

  const speak = () =>
    run('Generating…', async () => {
      // Same pipeline as production: SpeechPlanner → streaming sidecar → speech queue (mastering, Orb).
      const plan = planSpeech(text, { lang: lang === 'auto' ? undefined : lang, koNumbers: cfg?.voice.koNumbers, lexicon: cfg?.voice.lexicon })
      const all: Float32Array[] = []
      let sr = 24000
      let first: number | null = null
      const t0 = performance.now()
      c.speech.begin()
      for (const seg of plan.segments) {
        for await (const chunk of qwen.streamWith(seg.text, seg.lang, profile, mode)) {
          first ??= performance.now() - t0
          c.speech.push(chunk)
          all.push(chunk.samples)
          sr = chunk.sampleRate
        }
        if (seg.pauseAfterMs) c.speech.gap(seg.pauseAfterMs)
      }
      const merged = new Float32Array(all.reduce((n, a) => n + a.length, 0))
      let o = 0
      for (const a of all) {
        merged.set(a, o)
        o += a.length
      }
      const take: Take = { label: profile, profile, mode, text: plan.segments.map((s) => s.text).join(' / '), pcm: { samples: merged, sampleRate: sr }, metrics: await qwen.metrics(), clientFirstMs: first }
      setCurrent(take)
      await c.speech.drain()
    })

  useEffect(() => {
    const cv = canvas.current
    const pcm = current?.pcm
    if (!cv || !pcm) return
    const g = cv.getContext('2d')!
    const w = (cv.width = cv.clientWidth * devicePixelRatio)
    const h = (cv.height = 80 * devicePixelRatio)
    g.clearRect(0, 0, w, h)
    g.fillStyle = 'rgba(159,211,255,0.8)'
    const step = Math.max(1, Math.floor(pcm.samples.length / w))
    for (let x = 0; x < w; x++) {
      let peak = 0
      for (let i = x * step; i < (x + 1) * step && i < pcm.samples.length; i++) peak = Math.max(peak, Math.abs(pcm.samples[i]!))
      const bar = Math.max(1, peak * h)
      g.fillRect(x, (h - bar) / 2, 1, bar)
    }
  }, [current])

  const replay = (t: Take | null) => {
    if (!t?.pcm) return
    c.speech.begin()
    c.speech.push(t.pcm)
    void c.speech.drain()
  }

  const selected = profiles.find((p) => p.id === profile)
  return (
    <div className="voicelab">
      <p className="note">
        Engine {health ? `${health.engine} · loaded ${health.loaded.join(', ') || 'nothing'} · RSS ${health.rss_mb} MB${health.mlx_active_mb !== undefined ? ` · MLX ${health.mlx_active_mb} MB (peak ${health.mlx_peak_mb})` : ''}` : 'sidecar not running — run scripts/setup-tts.sh, then Speak to start it'}
      </p>
      <p className="note">
        Weights {MODEL_IDS[mode]} · {quantOf(MODEL_IDS[mode])} · {health?.sample_rate ?? 24000} Hz · stream chunk {cfg?.voice.ttsChunkSeconds ?? 0.32} s · default voice {cfg?.voice.voiceProfile ?? '—'}
      </p>
      <div className="row">
        <label>Model
          <select value={mode} onChange={(e) => setMode(e.target.value as VoiceQuality)}>
            <option value="CINEMATIC">CINEMATIC — 1.7B, ICL identity lock</option>
            <option value="BALANCED">BALANCED — 1.7B, x-vector</option>
            <option value="FAST">FAST — 0.6B, x-vector</option>
          </select>
        </label>
        <label>Voice
          <select value={profile} onChange={(e) => { setProfile(e.target.value); setInstruct(profiles.find((p) => p.id === e.target.value)?.instruct ?? '') }}>
            {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}{p.hasReference ? '' : ' (no reference yet)'}</option>)}
          </select>
        </label>
      </div>
      {selected && !selected.hasReference && (
        <button className="btn" disabled={!!busy} onClick={() => run('Designing…', async () => void (await qwen.design(profile)))}>Design reference clip for {profile}</button>
      )}
      {selected?.hasReference && (
        <button className="btn ghost" onClick={() => run('Loading…', async () => { const wav = await qwen.referenceClip(profile); if (wav) await c.speech.play(wav) })}>Play identity reference</button>
      )}
      <label>Voice design prompt (VoiceDesign → new lab candidate)
        <textarea rows={4} value={instruct} onChange={(e) => setInstruct(e.target.value)} />
      </label>
      <div className="row">
        <label>Seed <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} /></label>
        <button className="btn" disabled={!!busy || !instruct.trim()} onClick={() => run('Designing…', async () => { await qwen.design('lab', { instruct, seed, base: profile }); setProfile('lab'); const wav = await qwen.referenceClip('lab'); if (wav) await c.speech.play(wav) })}>Design lab voice</button>
        <button className="btn ghost" disabled={!!busy || !profiles.some((p) => p.id === 'lab')} onClick={() => { const id = prompt('Save lab voice as id (e.g. aop-core-d)'); if (id) void run('Saving…', () => qwen.saveCandidate(id, id)) }}>Save candidate</button>
      </div>
      <label>Text
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="row">
        <select onChange={(e) => e.target.value && setText(e.target.value)} value="">
          <option value="">Test scripts…</option>
          {SAMPLES.map((s) => <option key={s} value={s}>{s.slice(0, 48)}</option>)}
        </select>
        <select value={lang} onChange={(e) => setLang(e.target.value as typeof lang)}>
          <option value="auto">language: auto</option>
          <option value="ko">ko</option>
          <option value="en">en</option>
        </select>
        <button className="btn primary" disabled={!!busy} onClick={speak}>{busy ?? 'Speak'}</button>
      </div>
      {error && <p className="note" style={{ color: 'var(--err)' }}>{error}</p>}
      <canvas ref={canvas} className="wave" />
      {current && (
        <>
          <p className="note">Spoken form: {current.text}</p>
          <MetricsTable take={current} />
          <div className="row">
            <button className="btn ghost" onClick={() => setTakes((t) => ({ ...t, A: { ...current, label: 'A' } }))}>Keep as A</button>
            <button className="btn ghost" onClick={() => setTakes((t) => ({ ...t, B: { ...current, label: 'B' } }))}>Keep as B</button>
            <button className="btn ghost" onClick={() => setTakes((t) => ({ ...t, C: { ...current, label: 'C' } }))}>Keep as C</button>
          </div>
        </>
      )}
      {(takes.A || takes.B || takes.C) && (
        <div className="ab">
          {(['A', 'B', 'C'] as const).map((k) => (
            <div key={k}>
              <b>{k}</b> {takes[k] ? `${takes[k]!.profile} · ${takes[k]!.mode}` : '—'}
              {takes[k] && <button className="btn ghost" onClick={() => replay(takes[k])}>Play {k}</button>}
              {takes[k] && cfg && (
                <button className="btn ghost" disabled={cfg.voice.voiceProfile === takes[k]!.profile} onClick={() => void c.saveConfig({ ...cfg, voice: { ...cfg.voice, voiceProfile: takes[k]!.profile, voiceQuality: takes[k]!.mode } })}>
                  {cfg.voice.voiceProfile === takes[k]!.profile ? 'Preferred' : 'Use as my voice'}
                </button>
              )}
              {takes[k] && <MetricsTable take={takes[k]!} />}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function MetricsTable({ take }: { take: Take }) {
  const m = take.metrics
  return (
    <table>
      <tbody>
        <tr><th>first chunk (server / client)</th><td>{m?.first_chunk_ms ?? '—'} ms / {take.clientFirstMs?.toFixed(0) ?? '—'} ms</td></tr>
        <tr><th>synthesis / audio</th><td>{m ? `${m.total_ms} ms / ${m.audio_s} s` : '—'}</td></tr>
        <tr><th>RTF</th><td>{m?.rtf ?? '—'}</td></tr>
        <tr><th>memory</th><td>{m ? `MLX peak ${m.peak_mem_mb ?? '—'} MB · RSS ${m.rss_mb} MB` : '—'}</td></tr>
      </tbody>
    </table>
  )
}
