// Integration: the TS provider against the real Python sidecar (dummy engine — protocol only, not speech).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NativePort } from '../src/native'
import { QwenSidecarTTS } from '../src/voice/sidecar'

const hasPython = spawnSync('python3', ['--version']).status === 0
const PORT = 47000 + Math.floor(Math.random() * 900)
const dir = resolve(__dirname, '../../../services/tts')

describe.skipIf(!hasPython)('Qwen sidecar protocol (dummy engine)', () => {
  let proc: ChildProcess
  const native = { exists: async () => true, homeDir: '/tmp', fetch } as unknown as NativePort
  const tts = new QwenSidecarTTS(native, () => ({ python: 'python3', script: `${dir}/aop_tts_server.py`, port: PORT, profile: 'aop-core-a', quality: 'CINEMATIC', chunkSeconds: 0.16, idleUnloadMin: 0 }), fetch)

  beforeAll(async () => {
    proc = spawn('python3', ['aop_tts_server.py', '--engine', 'dummy', '--port', String(PORT), '--voices-dir', '/tmp/aop-tts-test-voices'], { cwd: dir, stdio: 'ignore' })
    for (let i = 0; i < 50 && !(await tts.health()); i++) await new Promise((r) => setTimeout(r, 100))
  })
  afterAll(() => proc?.kill())

  it('reports health and profiles', async () => {
    const h = await tts.health()
    expect(h?.engine).toBe('dummy')
    expect(h?.profiles).toContain('aop-core-a')
  })

  it('streams PCM chunks before synthesis finishes and reports latency/RTF', async () => {
    const t0 = performance.now()
    let firstAt = 0
    let samples = 0
    let chunks = 0
    for await (const c of tts.stream('좋은 오후입니다. 현재 시스템은 정상적으로 작동하고 있습니다.', 'ko')) {
      if (!chunks) firstAt = performance.now() - t0
      chunks++
      samples += c.samples.length
      expect(c.sampleRate).toBe(24000)
    }
    const total = performance.now() - t0
    expect(chunks).toBeGreaterThan(3)
    expect(firstAt).toBeLessThan(total / 2) // audio arrived well before the end — real streaming
    const m = await tts.metrics()
    expect(m?.first_chunk_ms).toBeGreaterThan(0)
    expect(m?.audio_s).toBeCloseTo(samples / 24000, 2)
    expect(m?.rtf).toBeGreaterThan(0)
  })

  it('aborting stops generation in the sidecar (barge-in)', async () => {
    const ctl = new AbortController()
    let chunks = 0
    for await (const _ of tts.stream('이 문장은 아주 길어서 끝까지 생성하면 몇 초가 걸립니다. '.repeat(4), 'ko', ctl.signal)) {
      if (++chunks === 2) ctl.abort()
    }
    await new Promise((r) => setTimeout(r, 300))
    const m = await tts.metrics()
    expect(m?.cancelled).toBe(true)
    expect(m?.audio_s).toBeLessThan(3)
  })
})
