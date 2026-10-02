import { describe, expect, it } from 'vitest'
import { DEFAULT_POLICY, DEFAULT_PROVIDERS, defaultConfig, loadConfig } from '../src/config'
import { migrate } from '../src/db'
import { EventBus } from '../src/events'
import { AuditLog, PermissionGate } from '../src/permissions'
import { plan } from '../src/orchestrator/planner'
import { ClaudeCliProvider, OpenAICompatibleProvider } from '../src/providers/llm'
import { classify } from '../src/router/intent'
import { deriveRuntimeState, type StateInputs } from '../src/state'
import { ToolRegistry } from '../src/tools/registry'
import { registerSystemTools } from '../src/tools/system'
import { MacSpeechTTS, WhisperCppSTT } from '../src/voice/local'
import { fakeNative, memoryDb, ok } from './helpers'

const base: StateInputs = { booted: true, booting: false, sleeping: false, voice: 'IDLE', executive: 'idle', approvalsPending: 0, lastErrorAt: null, now: 10_000 }

describe('deriveRuntimeState', () => {
  it('follows the documented priority order', () => {
    expect(deriveRuntimeState({ ...base, booted: false })).toBe('DORMANT')
    expect(deriveRuntimeState({ ...base, booting: true, approvalsPending: 1 })).toBe('BOOTING')
    expect(deriveRuntimeState({ ...base, sleeping: true })).toBe('SLEEP')
    expect(deriveRuntimeState({ ...base, approvalsPending: 1, voice: 'SPEAKING' })).toBe('WAITING_APPROVAL')
    expect(deriveRuntimeState({ ...base, voice: 'SPEAKING', executive: 'executing' })).toBe('SPEAKING')
    expect(deriveRuntimeState({ ...base, voice: 'INTERRUPTED' })).toBe('INTERRUPTED')
    expect(deriveRuntimeState({ ...base, voice: 'TRANSCRIBING' })).toBe('LISTENING')
    expect(deriveRuntimeState({ ...base, executive: 'executing' })).toBe('EXECUTING')
    expect(deriveRuntimeState({ ...base, executive: 'thinking' })).toBe('THINKING')
    expect(deriveRuntimeState({ ...base, lastErrorAt: 9_000 })).toBe('ERROR')
    expect(deriveRuntimeState({ ...base, lastErrorAt: 1_000 })).toBe('ONLINE')
  })
})

describe('config', () => {
  it('keeps valid sections and drops invalid ones instead of failing boot', () => {
    const cfg = loadConfig({ hotkey: 'Alt+J', orb: { quality: 'INSANE' } })
    expect(cfg.hotkey).toBe('Alt+J')
    expect(cfg.orb.quality).toBe('HIGH')
    expect(defaultConfig().models.providers.map((p) => p.id)).toEqual(DEFAULT_PROVIDERS.map((p) => p.id))
  })
})

async function systemRegistry(handler: Parameters<typeof fakeNative>[0]) {
  const db = memoryDb()
  await migrate(db)
  const bus = new EventBus()
  const registry = new ToolRegistry(new PermissionGate(() => DEFAULT_POLICY, bus), new AuditLog(db), bus)
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  registerSystemTools(registry, timers)
  const native = fakeNative(handler)
  return { registry, timers, native, ctx: { native, requestId: 'r', taskId: null, agent: null } }
}

describe('system tools', () => {
  it('sets volume relative to the current level, clamped', async () => {
    const { registry, native, ctx } = await systemRegistry((p, a) => (p === '/usr/bin/osascript' ? ok(a[1]?.startsWith('output volume') ? '95' : '') : undefined))
    const out = await registry.call<{ from: number; to: number }>('system.volume', { delta: 15 }, ctx)
    expect(out.output).toEqual({ from: 95, to: 100 })
    expect(native.calls.at(-1)?.args).toEqual(['-e', 'set volume output volume 100'])
  })

  it('reports a missing app as a failure, not success', async () => {
    const { registry, ctx } = await systemRegistry((p) => (p === '/usr/bin/open' ? { code: 1, stdout: '', stderr: 'no app' } : undefined))
    await expect(registry.call('apps.open', { app: 'Nope' }, ctx)).rejects.toThrow(/Unable to find application/)
  })

  it('rejects app names that could break out of AppleScript strings', async () => {
    const { registry, ctx } = await systemRegistry(() => undefined)
    await expect(registry.call('apps.quit', { app: 'x" to do shell script "rm' }, ctx)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('schedules timers that notify', async () => {
    const { registry, timers, ctx } = await systemRegistry(() => undefined)
    await registry.call('timer.set', { seconds: 60, label: 'Tea' }, ctx)
    expect(timers.size).toBe(1)
    for (const t of timers.values()) clearTimeout(t)
  })
})

describe('local voice providers', () => {
  it('runs whisper.cpp on a temp WAV with the configured model and language', async () => {
    const native = fakeNative((p) => (p === '/opt/homebrew/bin/whisper-cli' ? ok('  안녕하세요 \n') : undefined), { '/Users/test/models/m.bin': 'x' })
    const stt = new WhisperCppSTT(native, () => ({ bin: '/opt/homebrew/bin/whisper-cli', modelPath: '~/models/m.bin', language: 'ko' }))
    expect(await stt.available()).toBe(true)
    expect(await stt.transcribe(new Float32Array(16000))).toBe('안녕하세요')
    const args = native.calls.at(-1)!.args
    expect(args.slice(0, 2)).toEqual(['-m', '/Users/test/models/m.bin'])
    expect(args).toContain('ko')
  })

  it('surfaces whisper failures as voice errors', async () => {
    const native = fakeNative((p) => (p === 'whisper' ? { code: 1, stdout: '', stderr: 'failed to load model' } : undefined))
    const stt = new WhisperCppSTT(native, () => ({ bin: 'whisper', modelPath: '/m', language: 'auto' }))
    await expect(stt.transcribe(new Float32Array(16000))).rejects.toMatchObject({ code: 'VOICE_ENGINE_ERROR', message: 'failed to load model' })
    await expect(new WhisperCppSTT(native, () => ({ bin: null, modelPath: '/m', language: 'auto' })).transcribe(new Float32Array(1))).rejects.toMatchObject({ code: 'NOT_CONFIGURED' })
  })

  it('picks the Korean or English macOS voice by language', async () => {
    const native = fakeNative((p) => (p === '/usr/bin/say' ? ok() : undefined))
    const tts = new MacSpeechTTS(native, () => ({ voiceKo: 'Yuna', voiceEn: 'Samantha', rate: 190 }))
    await tts.synthesize('안녕', 'ko')
    await tts.synthesize('hello', 'en')
    const voices = native.calls.filter((c) => c.program === '/usr/bin/say').map((c) => c.args[1])
    expect(voices).toEqual(['Yuna', 'Samantha'])
  })
})

describe('LLM adapters', () => {
  it('Claude CLI: lean flags, stdin prompt, reported cost', async () => {
    const native = fakeNative((p, _a, o) => (p === '/bin/claude' ? ok(JSON.stringify({ result: `echo:${o?.stdin}`, total_cost_usd: 0.01, usage: { input_tokens: 3, cache_read_input_tokens: 7, output_tokens: 2 } })) : undefined))
    const p = new ClaudeCliProvider(DEFAULT_PROVIDERS[1]!, native, async () => '/bin/claude')
    const res = await p.complete({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] })
    expect(res).toMatchObject({ text: 'echo:hi', costUsd: 0.01, inputTokens: 10, outputTokens: 2, cacheHit: true })
    const args = native.calls.at(-1)!.args
    expect(args).toEqual(expect.arrayContaining(['--tools', '', '--strict-mcp-config', '--no-session-persistence']))
  })

  it('Claude CLI: errors are surfaced as provider offline', async () => {
    const native = fakeNative((p) => (p === '/bin/claude' ? ok(JSON.stringify({ is_error: true, result: 'not logged in' })) : undefined))
    const p = new ClaudeCliProvider(DEFAULT_PROVIDERS[1]!, native, async () => '/bin/claude')
    await expect(p.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/not logged in/)
  })

  it('OpenAI-compatible: probes /models and parses chat completions', async () => {
    const native = fakeNative()
    native.fetch = (async (url: string) =>
      String(url).endsWith('/models')
        ? new Response('{}', { status: 200 })
        : new Response(JSON.stringify({ model: 'qwen3:8b', choices: [{ message: { content: 'pong' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }))) as typeof fetch
    const p = new OpenAICompatibleProvider(DEFAULT_PROVIDERS[0]!, native)
    expect(await p.available()).toBe(true)
    expect(await p.complete({ model: 'qwen3:8b', system: 's', messages: [{ role: 'user', content: 'ping' }] })).toMatchObject({ text: 'pong', inputTokens: 5 })
  })
})

describe('planner', () => {
  const session = { activeProject: 'Demo', activeProjectPath: '/p', activeApp: null, lastDecision: 'use X' }
  const shape = (text: string) => plan({ requestId: 'r', text, intent: classify(text), lang: 'ko', session, memoryContext: '', history: '' }).map((t) => `${t.agent}:${t.type}`)

  it.each([
    ['크롬 켜', ['operator:launch_app']],
    ['시스템 상태', ['operator:system_metrics']],
    ['5분 타이머', ['operator:timer']],
    ['클립보드 보여줘', ['operator:clipboard_read']],
    ['깃 상태', ['operator:git_status']],
    ['그 방식대로 고쳐', ['code:fix_code', 'reviewer:review']],
    ['Talkpic 경쟁사 조사해서 개선 보고서 만들어', ['research:web_research', 'research:memory_research', 'analyst:synthesize', 'reviewer:review']],
    ['고객에게 보낼 이메일 써줘', ['communicator:draft']],
  ])('%s', (text, expected) => expect(shape(text)).toEqual(expected))

  it('research fans out in parallel, then synthesizes', () => {
    const tasks = plan({ requestId: 'r', text: '경쟁사 조사', intent: classify('경쟁사 조사'), lang: 'ko', session, memoryContext: '', history: '' })
    const synth = tasks.find((t) => t.type === 'synthesize')!
    expect(synth.dependencies).toHaveLength(2)
    expect(tasks.filter((t) => t.dependencies.length === 0)).toHaveLength(2)
  })

  it('carries the resolved decision into code fixes and marks them for approval', () => {
    const [fix] = plan({ requestId: 'r', text: '고쳐', intent: classify('고쳐'), lang: 'ko', session, memoryContext: '', history: '' })
    expect(fix?.input.decision).toBe('use X')
    expect(fix?.requiresApproval).toBe(true)
  })
})
