import type { SqlDriver } from './db'
import type { Tier, UsageRecord } from './types'

export interface CostSummary {
  todayUsd: number
  weekUsd: number
  monthUsd: number
  byModel: { model: string; usd: number; calls: number }[]
  byAgent: { agent: string; usd: number; calls: number }[]
  byProject: { project: string; usd: number; calls: number }[]
  tierCounts: Record<Tier, number>
  localRatio: number
  frontierRatio: number
}

const DAY_MS = 86_400_000

export class CostLedger {
  constructor(private readonly db: SqlDriver) {}

  async record(u: UsageRecord): Promise<void> {
    await this.db.execute(
      `INSERT INTO usage (id, ts, request_id, provider, model, tier, input_tokens, output_tokens, cost_usd, latency_ms, cache_hit, reason, agent, task_id, project)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [u.id, u.ts, u.requestId, u.provider, u.model, u.tier, u.inputTokens, u.outputTokens, u.costUsd, u.latencyMs, u.cacheHit ? 1 : 0, u.reason, u.agent, u.taskId, u.project],
    )
  }

  async spentSince(ts: number): Promise<number> {
    const rows = await this.db.select<{ usd: number | null }>('SELECT SUM(cost_usd) AS usd FROM usage WHERE ts >= ?', [ts])
    return rows[0]?.usd ?? 0
  }

  /**
   * Tier mix counts every handled request (L0 included) from the requests table,
   * so the 70–85% L0/L1 target is measurable, not just the model calls.
   */
  async summary(now = Date.now()): Promise<CostSummary> {
    const startOfDay = new Date(now)
    startOfDay.setHours(0, 0, 0, 0)
    const day = startOfDay.getTime()
    const group = (col: string) =>
      this.db.select<{ key: string; usd: number; calls: number }>(
        `SELECT COALESCE(${col}, 'none') AS key, SUM(cost_usd) AS usd, COUNT(*) AS calls FROM usage WHERE ts >= ? GROUP BY key ORDER BY usd DESC`,
        [now - 30 * DAY_MS],
      )
    const [todayUsd, weekUsd, monthUsd, byModel, byAgent, byProject, tiers, local] = await Promise.all([
      this.spentSince(day),
      this.spentSince(now - 7 * DAY_MS),
      this.spentSince(now - 30 * DAY_MS),
      group('model'),
      group('agent'),
      group('project'),
      this.db.select<{ tier: Tier; n: number }>('SELECT tier, COUNT(*) AS n FROM requests WHERE ts >= ? AND tier IS NOT NULL GROUP BY tier', [now - 30 * DAY_MS]),
      this.db.select<{ local: number; total: number }>(
        "SELECT SUM(CASE WHEN provider IN ('native','ollama') OR cost_usd = 0 THEN 1 ELSE 0 END) AS local, COUNT(*) AS total FROM usage WHERE ts >= ?",
        [now - 30 * DAY_MS],
      ),
    ])
    const tierCounts: Record<Tier, number> = { L0: 0, L1: 0, L2: 0, L3: 0 }
    for (const t of tiers) tierCounts[t.tier] = t.n
    const totalRequests = Object.values(tierCounts).reduce((a, b) => a + b, 0)
    const l0Requests = tierCounts.L0
    const modelCalls = local[0]?.total ?? 0
    return {
      todayUsd,
      weekUsd,
      monthUsd,
      byModel: byModel.map((r) => ({ model: r.key, usd: r.usd, calls: r.calls })),
      byAgent: byAgent.map((r) => ({ agent: r.key, usd: r.usd, calls: r.calls })),
      byProject: byProject.map((r) => ({ project: r.key, usd: r.usd, calls: r.calls })),
      tierCounts,
      // L0 requests run natively, so they count as local work.
      localRatio: totalRequests ? (l0Requests + (local[0]?.local ?? 0)) / (l0Requests + modelCalls || 1) : 0,
      frontierRatio: totalRequests ? tierCounts.L3 / totalRequests : 0,
    }
  }

  async recent(limit = 50): Promise<UsageRecord[]> {
    const rows = await this.db.select<Record<string, unknown>>('SELECT * FROM usage ORDER BY ts DESC LIMIT ?', [limit])
    return rows.map((r) => ({
      id: String(r.id),
      ts: Number(r.ts),
      requestId: String(r.request_id ?? ''),
      provider: String(r.provider),
      model: String(r.model),
      tier: r.tier as Tier,
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      costUsd: Number(r.cost_usd),
      latencyMs: Number(r.latency_ms),
      cacheHit: Number(r.cache_hit) === 1,
      reason: String(r.reason ?? ''),
      agent: (r.agent as UsageRecord['agent']) ?? null,
      taskId: (r.task_id as string | null) ?? null,
      project: (r.project as string | null) ?? null,
    }))
  }
}

export function estimateCost(pricing: Record<string, { input: number; output: number }>, model: string, inputTokens: number, outputTokens: number): number {
  const p = pricing[model]
  return p ? (inputTokens * p.input + outputTokens * p.output) / 1_000_000 : 0
}
