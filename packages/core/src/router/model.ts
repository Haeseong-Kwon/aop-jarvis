import type { JarvisConfig, ProviderConfig } from '../config'
import { CostLedger, estimateCost } from '../cost'
import { JarvisError, errorMessage } from '../errors'
import type { EventBus } from '../events'
import type { Logger } from '../log'
import type { LLMProvider, LLMRequest, LLMResponse } from '../providers/types'
import { newId, type AgentId, type Tier } from '../types'

export interface RouteFeatures {
  complexity: number
  coding?: boolean
  contextChars?: number
  risk?: number
  /** Keep this request on local providers only. */
  privacy?: boolean
  latencySensitive?: boolean
}

export interface RouteDecision {
  tier: Tier
  reason: string
}

const TIERS: Tier[] = ['L0', 'L1', 'L2', 'L3']
const LARGE_CONTEXT_CHARS = 40_000
const ESCALATE_TOKEN = '[[ESCALATE]]'

/** Pure scoring: features → minimum sufficient tier. L3 is never a default. */
export function scoreTier(f: RouteFeatures): RouteDecision {
  const reasons: string[] = []
  let score = f.complexity
  if (f.coding) {
    score += 0.15
    reasons.push('coding')
  }
  if ((f.contextChars ?? 0) > LARGE_CONTEXT_CHARS) {
    score += 0.15
    reasons.push('large context')
  }
  if ((f.risk ?? 0) > 0.5) {
    score += 0.1
    reasons.push('high risk')
  }
  if (f.latencySensitive) {
    score -= 0.1
    reasons.push('latency-sensitive')
  }
  const tier: Tier = score >= 0.8 ? 'L3' : score >= 0.45 ? 'L2' : 'L1'
  return { tier, reason: `complexity ${f.complexity.toFixed(2)} → score ${score.toFixed(2)}${reasons.length ? ` (${reasons.join(', ')})` : ''}` }
}

export interface CompleteOptions {
  requestId: string
  features: RouteFeatures
  /** Force a starting tier (e.g. intent already decided L2). */
  tier?: Tier
  agent?: AgentId | 'executive'
  taskId?: string | null
  project?: string | null
  /** Allow the model to answer [[ESCALATE]] when it is not confident. */
  allowEscalation?: boolean
}

export interface RoutedResponse extends LLMResponse {
  tier: Tier
  provider: string
  costUsd: number
}

export class ModelRouter {
  private availability = new Map<string, { ok: boolean; at: number }>()
  private static readonly AVAILABILITY_TTL_MS = 30_000

  constructor(
    private readonly getConfig: () => JarvisConfig,
    private readonly providers: Map<string, LLMProvider>,
    private readonly ledger: CostLedger,
    private readonly bus: EventBus,
    private readonly log: Logger,
  ) {}

  async isAvailable(id: string): Promise<boolean> {
    const cached = this.availability.get(id)
    if (cached && Date.now() - cached.at < ModelRouter.AVAILABILITY_TTL_MS) return cached.ok
    const provider = this.providers.get(id)
    const ok = provider ? await provider.available().catch(() => false) : false
    this.availability.set(id, { ok, at: Date.now() })
    return ok
  }

  async status(): Promise<{ id: string; label: string; enabled: boolean; available: boolean; tiers: Tier[] }[]> {
    return Promise.all(
      this.getConfig().models.providers.map(async (p) => ({
        id: p.id,
        label: p.label,
        enabled: p.enabled,
        available: p.enabled && (await this.isAvailable(p.id)),
        tiers: p.tiers,
      })),
    )
  }

  /** Candidates for a tier: enabled + live, local first when preferred, then cheapest. */
  async candidates(tier: Tier, privacy = false): Promise<ProviderConfig[]> {
    const cfg = this.getConfig()
    const eligible = cfg.models.providers.filter((p) => p.enabled && p.tiers.includes(tier) && (!privacy || p.local))
    const live = (await Promise.all(eligible.map(async (p) => ((await this.isAvailable(p.id)) ? p : null)))).filter((p): p is ProviderConfig => p !== null)
    const price = (p: ProviderConfig) => {
      const m = p.tierModels[tier] ?? p.model
      const pr = p.pricing[m]
      return pr ? pr.input + pr.output : 0
    }
    return live.sort((a, b) => (cfg.routing.preferLocal ? Number(b.local) - Number(a.local) : 0) || price(a) - price(b))
  }

  async complete(req: Omit<LLMRequest, 'model'>, opts: CompleteOptions): Promise<RoutedResponse> {
    const cfg = this.getConfig()
    const decision = opts.tier ? { tier: opts.tier, reason: 'tier set by intent' } : scoreTier(opts.features)
    let start = Math.max(1, TIERS.indexOf(decision.tier))
    let reason = decision.reason

    const spentToday = await this.ledger.spentSince(startOfDay())
    if (start === 3 && spentToday >= cfg.models.dailyBudgetUsd) {
      start = 2
      reason += `; daily budget $${cfg.models.dailyBudgetUsd} reached → capped at L2`
    }
    const maxTier = cfg.routing.escalation ? 3 : start
    const errors: string[] = []

    for (let t = start; t <= maxTier; t++) {
      const tier = TIERS[t]!
      for (const p of await this.candidates(tier, opts.features.privacy)) {
        const provider = this.providers.get(p.id)
        if (!provider) continue
        const model = p.tierModels[tier] ?? p.model
        const system =
          opts.allowEscalation && t < maxTier
            ? `${req.system ?? ''}\nIf you cannot answer this reliably at your capability level, reply with exactly ${ESCALATE_TOKEN} and nothing else.`.trim()
            : req.system
        this.bus.emit('model:routed', { requestId: opts.requestId, tier, provider: p.id, model, reason })
        const startedAt = Date.now()
        try {
          const res = await provider.complete({ ...req, model, ...(system ? { system } : {}) })
          const costUsd = res.costUsd ?? estimateCost(p.pricing, model, res.inputTokens, res.outputTokens)
          await this.recordUsage(opts, { provider: p.id, model, tier, res, costUsd, latencyMs: Date.now() - startedAt, reason })
          if (res.text.trim() === ESCALATE_TOKEN) {
            reason = `${tier} self-reported low confidence → escalate`
            break // next tier
          }
          return { ...res, model, tier, provider: p.id, costUsd }
        } catch (error) {
          if (req.signal?.aborted) throw new JarvisError('CANCELLED', 'Cancelled')
          errors.push(`${p.id}/${tier}: ${errorMessage(error)}`)
          this.availability.set(p.id, { ok: false, at: Date.now() })
          this.log.warn('provider failed, trying next', { requestId: opts.requestId, provider: p.id, error: errorMessage(error) })
          reason = `${p.id} failed → fallback`
        }
      }
    }
    throw new JarvisError(
      'MODEL_PROVIDER_OFFLINE',
      errors.length ? `No model could complete the request: ${errors.join('; ')}` : 'No model provider is available. Configure one in Settings → Models.',
    )
  }

  private async recordUsage(
    opts: CompleteOptions,
    r: { provider: string; model: string; tier: Tier; res: LLMResponse; costUsd: number; latencyMs: number; reason: string },
  ): Promise<void> {
    const usage = {
      id: newId('use'),
      ts: Date.now(),
      requestId: opts.requestId,
      provider: r.provider,
      model: r.model,
      tier: r.tier,
      inputTokens: r.res.inputTokens,
      outputTokens: r.res.outputTokens,
      costUsd: r.costUsd,
      latencyMs: r.latencyMs,
      cacheHit: r.res.cacheHit,
      reason: r.reason,
      agent: opts.agent ?? null,
      taskId: opts.taskId ?? null,
      project: opts.project ?? null,
    }
    await this.ledger.record(usage)
    this.bus.emit('model:usage', usage)
  }
}

function startOfDay(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
