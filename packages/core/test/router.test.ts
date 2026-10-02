import { describe, expect, it } from 'vitest'
import { defaultConfig, type JarvisConfig, type ProviderConfig } from '../src/config'
import { CostLedger } from '../src/cost'
import { migrate } from '../src/db'
import { EventBus } from '../src/events'
import { Logger } from '../src/log'
import type { LLMProvider, LLMRequest } from '../src/providers/types'
import { ModelRouter, scoreTier } from '../src/router/model'
import { memoryDb } from './helpers'

class FakeLLM implements LLMProvider {
  calls: LLMRequest[] = []
  constructor(
    readonly id: string,
    private readonly reply: (req: LLMRequest) => string | Error,
    private readonly live = true,
  ) {}
  async available() {
    return this.live
  }
  async complete(req: LLMRequest) {
    this.calls.push(req)
    const r = this.reply(req)
    if (r instanceof Error) throw r
    return { text: r, model: req.model, inputTokens: 100, outputTokens: 50, cacheHit: false }
  }
}

const provider = (id: string, tiers: ProviderConfig['tiers'], local = false): ProviderConfig => ({
  id,
  kind: 'openai-compatible',
  label: id,
  enabled: true,
  tiers,
  model: `${id}-model`,
  tierModels: { L3: `${id}-big` },
  local,
  pricing: { [`${id}-model`]: { input: 1, output: 5 }, [`${id}-big`]: { input: 4, output: 20 } },
})

async function setup(providers: ProviderConfig[], fakes: FakeLLM[], patch: Partial<JarvisConfig> = {}) {
  const db = memoryDb()
  await migrate(db)
  const cfg = { ...defaultConfig(), ...patch, models: { providers, dailyBudgetUsd: patch.models?.dailyBudgetUsd ?? 2 } }
  const bus = new EventBus()
  const ledger = new CostLedger(db)
  const router = new ModelRouter(() => cfg, new Map(fakes.map((f) => [f.id, f])), ledger, bus, new Logger(bus))
  return { router, ledger, bus, db }
}

describe('scoreTier', () => {
  it('never picks L3 for simple work and escalates hard work', () => {
    expect(scoreTier({ complexity: 0.1 }).tier).toBe('L1')
    expect(scoreTier({ complexity: 0.5 }).tier).toBe('L2')
    expect(scoreTier({ complexity: 0.7, coding: true }).tier).toBe('L3')
    expect(scoreTier({ complexity: 0.4, contextChars: 100_000 }).tier).toBe('L2')
  })
})

describe('ModelRouter', () => {
  it('prefers a live local provider and records usage with cost', async () => {
    const local = new FakeLLM('local', () => 'hi')
    const cloud = new FakeLLM('cloud', () => 'hi')
    const { router, ledger } = await setup([provider('cloud', ['L1', 'L2']), provider('local', ['L1'], true)], [local, cloud])
    const res = await router.complete({ messages: [{ role: 'user', content: 'x' }] }, { requestId: 'r1', features: { complexity: 0.1 } })
    expect(res.provider).toBe('local')
    expect(cloud.calls).toHaveLength(0)
    const usage = await ledger.recent()
    expect(usage[0]).toMatchObject({ provider: 'local', tier: 'L1', requestId: 'r1' })
  })

  it('escalates L1 → L2 when the model reports low confidence', async () => {
    const small = new FakeLLM('small', () => '[[ESCALATE]]')
    const big = new FakeLLM('big', () => 'answer')
    const { router } = await setup([provider('small', ['L1']), provider('big', ['L2'])], [small, big])
    const res = await router.complete({ messages: [{ role: 'user', content: 'x' }] }, { requestId: 'r', features: { complexity: 0.2 }, allowEscalation: true })
    expect(res.tier).toBe('L2')
    expect(res.text).toBe('answer')
  })

  it('falls back to the next provider when one fails', async () => {
    const broken = new FakeLLM('a', () => new Error('offline'))
    const good = new FakeLLM('b', () => 'ok')
    const { router } = await setup([provider('a', ['L2']), provider('b', ['L2'])], [broken, good])
    const res = await router.complete({ messages: [{ role: 'user', content: 'x' }] }, { requestId: 'r', features: { complexity: 0.5 } })
    expect(res.provider).toBe('b')
  })

  it('caps at L2 once the daily budget is spent', async () => {
    const p = new FakeLLM('p', () => 'ok')
    const { router, ledger } = await setup([provider('p', ['L2', 'L3'])], [p], { models: { providers: [], dailyBudgetUsd: 0.01 } })
    await ledger.record({ id: 'u', ts: Date.now(), requestId: 'old', provider: 'p', model: 'm', tier: 'L3', inputTokens: 0, outputTokens: 0, costUsd: 1, latencyMs: 0, cacheHit: false, reason: '', agent: null, taskId: null, project: null })
    const res = await router.complete({ messages: [{ role: 'user', content: 'x' }] }, { requestId: 'r', features: { complexity: 0.9 } })
    expect(res.tier).toBe('L2')
  })

  it('errors clearly when no provider is live', async () => {
    const dead = new FakeLLM('d', () => 'x', false)
    const { router } = await setup([provider('d', ['L1', 'L2', 'L3'])], [dead])
    await expect(router.complete({ messages: [{ role: 'user', content: 'x' }] }, { requestId: 'r', features: { complexity: 0.1 } })).rejects.toThrow(/No model provider is available/)
  })
})
