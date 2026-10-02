import { describe, expect, it } from 'vitest'
import type { Agent, AgentContext } from '../src/agents/base'
import { migrate } from '../src/db'
import { EventBus } from '../src/events'
import { Logger } from '../src/log'
import { Orchestrator, TaskStore, validateGraph } from '../src/orchestrator/orchestrator'
import type { AgentId, AgentResult, Task } from '../src/types'
import { memoryDb } from './helpers'

const result = (summary: string, status: AgentResult['status'] = 'success'): AgentResult => ({
  status,
  summary,
  artifacts: [],
  observations: [],
  toolCalls: [],
  errors: [],
  nextActions: [],
  confidence: 1,
})

const task = (id: string, agent: AgentId, deps: string[] = [], input: Record<string, unknown> = {}): Task => ({
  id,
  requestId: 'r',
  parentTaskId: null,
  type: 'x',
  title: id,
  description: id,
  agent,
  dependencies: deps,
  status: 'QUEUED',
  priority: 0,
  risk: 'READ',
  requiresApproval: false,
  input,
  attempts: 0,
  maxAttempts: 2,
  createdAt: 0,
  startedAt: null,
  completedAt: null,
  result: null,
})

function agent(id: AgentId, run: (t: Task, ctx: AgentContext) => Promise<AgentResult>): Agent {
  return { id, capabilities: [], canHandle: () => 1, execute: run }
}

async function orchestrator(agents: Agent[]) {
  const db = memoryDb()
  await migrate(db)
  const bus = new EventBus()
  const makeCtx = (_t: Task, deps: AgentContext['deps'], signal: AbortSignal) => ({ deps, signal }) as AgentContext
  return { orch: new Orchestrator(new Map(agents.map((a) => [a.id, a])), makeCtx, new TaskStore(db), bus, new Logger(bus)), bus }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('validateGraph', () => {
  it('rejects cycles and unknown dependencies', () => {
    expect(() => validateGraph([task('a', 'research', ['b']), task('b', 'research', ['a'])])).toThrow(/cycle/)
    expect(() => validateGraph([task('a', 'research', ['zzz'])])).toThrow(/unknown/)
  })
})

describe('Orchestrator', () => {
  it('runs independent tasks concurrently and passes results downstream', async () => {
    let concurrent = 0
    let peak = 0
    const worker = agent('research', async (t) => {
      peak = Math.max(peak, ++concurrent)
      await sleep(20)
      concurrent--
      return result(`done ${t.id}`)
    })
    const synth = agent('analyst', async (_t, ctx) => result(Object.values(ctx.deps).map((d) => d.summary).sort().join('+')))
    const { orch } = await orchestrator([worker, synth])
    const out = await orch.run([task('a', 'research'), task('b', 'research'), task('s', 'analyst', ['a', 'b'])], new AbortController().signal)
    expect(peak).toBe(2)
    expect(out.find((t) => t.id === 's')?.result?.summary).toBe('done a+done b')
  })

  it('retries a failed task once, then fails it and cancels dependents', async () => {
    let attempts = 0
    const flaky = agent('code', async () => {
      attempts++
      return result('boom', 'failed')
    })
    const after = agent('analyst', async () => result('never'))
    const { orch } = await orchestrator([flaky, after])
    const out = await orch.run([task('a', 'code'), task('b', 'analyst', ['a'])], new AbortController().signal)
    expect(attempts).toBe(2)
    expect(out.map((t) => t.status)).toEqual(['FAILED', 'CANCELLED'])
  })

  it('still runs reviewers marked runOnFailure', async () => {
    const failing = agent('code', async () => result('not authorized', 'failed'))
    const reviewer = agent('reviewer', async (_t, ctx) => result(`saw ${Object.values(ctx.deps)[0]?.status}`))
    const { orch } = await orchestrator([failing, reviewer])
    const out = await orch.run([task('a', 'code'), task('r', 'reviewer', ['a'], { runOnFailure: true })], new AbortController().signal)
    expect(out[1]?.result?.summary).toBe('saw failed')
  })

  it('cancels running and queued tasks on abort', async () => {
    const slow = agent('research', async (_t, ctx) => {
      await new Promise((r) => ctx.signal.addEventListener('abort', r))
      return result('late')
    })
    const { orch } = await orchestrator([slow, agent('analyst', async () => result('x'))])
    const controller = new AbortController()
    const running = orch.run([task('a', 'research'), task('b', 'analyst', ['a'])], controller.signal)
    await sleep(10)
    controller.abort()
    expect((await running).map((t) => t.status)).toEqual(['CANCELLED', 'CANCELLED'])
  })

  it('emits task and agent lifecycle events', async () => {
    const { orch, bus } = await orchestrator([agent('research', async () => result('ok'))])
    const seen: string[] = []
    bus.onAny((name) => seen.push(name))
    await orch.run([task('a', 'research')], new AbortController().signal)
    expect(seen).toEqual(expect.arrayContaining(['task:created', 'task:updated', 'agent:started', 'agent:completed']))
  })
})
