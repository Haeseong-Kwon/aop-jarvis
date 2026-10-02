import { describe, expect, it } from 'vitest'
import { createRuntime } from '../src/runtime'
import { fakeNative, memoryDb, ok, type FakeNative } from './helpers'

const PROJECT = '/Users/test/code/buyer-pilot'
const CLAUDE = '/Users/test/.local/bin/claude'

/** A host where the claude CLI exists and answers like the real one (JSON with result + cost). */
function host(extra: (program: string, args: string[]) => ReturnType<NonNullable<Parameters<typeof fakeNative>[0]>> = () => undefined): FakeNative {
  return fakeNative(
    (program, args, opts) => {
      const custom = extra(program, args)
      if (custom) return custom
      if (program === '/bin/zsh' && args[1] === 'command -v claude') return ok(CLAUDE)
      if (program === CLAUDE) return ok(JSON.stringify({ result: `model reply to: ${(opts?.stdin ?? '').slice(0, 40)}`, total_cost_usd: 0.002, usage: { input_tokens: 50, output_tokens: 20 } }))
      if (program === '/usr/bin/git' && args.includes('rev-parse')) return ok('main\n')
      if (program === '/usr/bin/git' && args.includes('ls-files')) return ok('package.json\nsrc/huge.ts\nREADME.md\n')
      if (program === '/usr/bin/git' && args.includes('diff')) return ok(args.includes('--stat') ? ' src/huge.ts | 10 +++---\n 1 file changed' : 'diff --git a/src/huge.ts')
      if (program === '/usr/bin/git' && args.includes('status')) return ok('')
      if (program === '/usr/bin/git' && args.includes('log')) return ok('abc init\n')
      return undefined
    },
    { [`${PROJECT}/package.json`]: '{"name":"buyer-pilot"}', [`${PROJECT}/src/huge.ts`]: 'x\n'.repeat(1200), [`${PROJECT}/README.md`]: '# Buyer Pilot' },
  )
}

async function runtime(native: FakeNative) {
  const rt = await createRuntime(native, memoryDb())
  const cfg = rt.getConfig()
  await rt.saveConfig({
    ...cfg,
    models: { ...cfg.models, providers: cfg.models.providers.map((p) => ({ ...p, enabled: p.id === 'claude-cli' })) },
    memory: { ...cfg.memory, aopNote: { ...cfg.memory.aopNote, enabled: false } },
    context: { ...cfg.context, activeProjectPath: PROJECT, trackActiveApp: false },
  })
  return rt
}

describe('acceptance scenarios', () => {
  it('B: "Chrome 켜." → L0 → Operator → apps.open, no LLM', async () => {
    const native = host((program) => (program === '/usr/bin/open' ? ok() : undefined))
    const rt = await runtime(native)
    const res = await rt.executive.handle('Chrome 켜.')
    expect(res.ok).toBe(true)
    expect(res.tier).toBe('L0')
    expect(native.calls.some((c) => c.program === '/usr/bin/open' && c.args.join(' ') === '-a Google Chrome')).toBe(true)
    expect(native.calls.some((c) => c.program === CLAUDE)).toBe(false)
    expect(res.tasks.map((t) => t.agent)).toEqual(['operator'])
  })

  it('C: "현재 메모리 상태 확인해." → system tool → real metrics, no model', async () => {
    const native = host()
    const rt = await runtime(native)
    const res = await rt.executive.handle('현재 메모리 상태 확인해.')
    expect(res.response).toContain('32GB 중 14.0GB')
    expect(res.tier).toBe('L0')
    expect(native.calls.some((c) => c.program === CLAUDE)).toBe(false)
  })

  it('D: project analysis → CodeAgent inspects files → worker model → Reviewer', async () => {
    const native = host()
    const rt = await runtime(native)
    const res = await rt.executive.handle('이 프로젝트 구조 분석해서 문제점 찾아.')
    const [inspect, review] = res.tasks
    expect(inspect?.agent).toBe('code')
    expect(inspect?.status).toBe('COMPLETED')
    expect(inspect?.result?.artifacts[0]?.content).toContain('src/huge.ts has 1201 lines')
    expect(review?.agent).toBe('reviewer')
    const usage = await rt.ledger.recent()
    expect(usage.some((u) => u.tier === 'L2' && u.agent === 'code')).toBe(true)
  })

  it('E + F: recall a decision with provenance, then "그 방식대로" carries it into the coding agent', async () => {
    const native = host()
    const rt = await runtime(native)
    await rt.executive.handle('기억해: Buyer Pilot 검색 파이프라인은 DataForSEO로 1차 수집하고 품질 필터를 거치기로 했어')
    const recall = await rt.executive.handle('Buyer Pilot에서 전에 검색 파이프라인 어떻게 하기로 했지?')
    expect(recall.response).toContain('DataForSEO')
    expect(recall.response).toMatch(/출처: conversation/)

    rt.bus.on('approval:requested', (a) => rt.gate.resolve(a.id, true)) // HIGH_WRITE edit approved by the user
    const fix = await rt.executive.handle('그 방식대로 현재 코드 고쳐.')
    const agentRun = native.calls.find((c) => c.program === CLAUDE && c.args.includes('acceptEdits'))
    expect(agentRun?.opts?.cwd).toBe(PROJECT)
    expect(agentRun?.opts?.stdin).toContain('DataForSEO')
    expect(fix.tasks.map((t) => t.agent)).toEqual(['code', 'reviewer'])
  })

  it('H: deleting data waits for approval and runs only after it', async () => {
    const native = host()
    native.files.set('/Users/test/Documents/important/data.db', 'x')
    const rt = await runtime(native)
    const order: string[] = []
    rt.bus.on('approval:requested', (a) => {
      order.push(`approval:${a.risk}`)
      expect(native.trashed).toHaveLength(0)
      setTimeout(() => rt.gate.resolve(a.id, true), 5)
    })
    const res = await rt.executive.handle('~/Documents/important/data.db 파일 삭제해')
    order.push('done')
    expect(order).toEqual(['approval:DELETE', 'done'])
    expect(native.trashed).toEqual(['/Users/test/Documents/important/data.db'])
    expect(res.ok).toBe(true)
  })

  it('H: a denied deletion leaves the file alone', async () => {
    const native = host()
    native.files.set('/Users/test/Documents/important/data.db', 'x')
    const rt = await runtime(native)
    rt.bus.on('approval:requested', (a) => rt.gate.resolve(a.id, false))
    const res = await rt.executive.handle('~/Documents/important/data.db 파일 삭제해')
    expect(native.trashed).toEqual([])
    expect(res.ok).toBe(false)
  })

  it('chat goes to an LLM at L1 and is costed', async () => {
    const native = host()
    const rt = await runtime(native)
    const res = await rt.executive.handle('안녕 자비스')
    expect(res.response).toContain('model reply')
    expect(res.tier).toBe('L1')
    expect((await rt.ledger.summary()).todayUsd).toBeCloseTo(0.002)
  })

  it('reports real readiness, never a fake READY', async () => {
    const rt = await runtime(host())
    const ready = await rt.checkReadiness()
    expect(ready.voice.ok).toBe(false) // whisper not installed in this fake host
    expect(ready.memory.ok).toBe(true)
    expect(ready.agents.detail).toMatch(/6 agents/)
  })
})
