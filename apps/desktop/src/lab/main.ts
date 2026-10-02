// Orb Lab — dev-only harness that renders the Orb without the Tauri runtime, for visual regression captures
// and shader iteration. URL params: ?state=THINKING&quality=HIGH&agents=code,research&audio=speech|mic|none
// Audio here is a synthetic speech-like envelope (capture harness only — the product only uses real analysers).
import type { AgentId, RuntimeState } from '@aop/core'
import { BAND_COUNT, type AudioLevels } from '../audio/levels'
import type { Quality } from '../orb/params'
import { DEFAULT_DEBUG, OrbRenderer, type AgentVisual, type DebugFlags } from '../orb/renderer'

const q = new URLSearchParams(location.search)
const state = (q.get('state') ?? 'ONLINE') as RuntimeState
const quality = (q.get('quality') ?? 'HIGH') as Quality
const audio = q.get('audio') ?? (state === 'SPEAKING' ? 'speech' : state === 'LISTENING' ? 'mic' : 'none')
const agents: AgentVisual[] = (q.get('agents') ?? (state === 'EXECUTING' ? 'code,research' : ''))
  .split(',')
  .filter(Boolean)
  .map((id, i) => ({ id: id as AgentId, status: i === 0 ? 'running' : 'queued' }))
// ?debug=layers,ringIds,bounds,!bloom,!particles,!glass,freeze
const debug: DebugFlags = { ...DEFAULT_DEBUG }
for (const f of (q.get('debug') ?? '').split(',').filter(Boolean)) {
  const off = f.startsWith('!')
  ;(debug as unknown as Record<string, boolean>)[f.replace('!', '')] = !off
}
// Lab-only sample telemetry so the HUD gauges have something to bind to (the app binds real metrics).
const telemetry = q.get('telemetry') === '0' ? null : { cpu: 26, memUsed: 16.5 * 1024 ** 3, memTotal: 32 * 1024 ** 3 }
const bootAt = state === 'BOOTING' ? performance.now() : null
// ?bootT=1.5 freezes the cold-boot timeline at that second (visual regression of the assembly sequence).
const fixedBootT = q.get('bootT') !== null ? Number(q.get('bootT')) : null

const silent = (): AudioLevels => ({ rms: 0, bands: new Float32Array(BAND_COUNT) })
const mic = silent()
const out = silent()
function speechLike(l: AudioLevels, t: number, gain: number): void {
  // Syllable-rate (~4.5 Hz) envelope with phrase gaps; formant-ish band shape.
  const syl = Math.max(0, Math.sin(t * 2 * Math.PI * 4.3)) ** 0.6
  const phrase = Math.sin(t * 0.9) > -0.3 ? 1 : 0.05
  const env = syl * phrase
  l.rms = env * gain
  for (let b = 0; b < BAND_COUNT; b++) l.bands[b] = env * Math.exp(-((b - 2.5) ** 2) / 6) * (0.7 + 0.3 * Math.sin(t * 7 + b))
}

const canvas = document.getElementById('orb') as HTMLCanvasElement
const t0 = performance.now()
const r = new OrbRenderer(canvas, () => {
  const t = (performance.now() - t0) / 1000
  if (audio === 'speech') speechLike(out, t, 0.16)
  if (audio === 'mic') speechLike(mic, t, 0.08)
  return { state, bootT: fixedBootT ?? (bootAt !== null ? (performance.now() - bootAt) / 1000 : null), mic, out, agents, quality, telemetry, debug }
})
;(window as unknown as { orb: OrbRenderer }).orb = r
if (q.get('snap') !== '0') r.snap()
