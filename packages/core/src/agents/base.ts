import type { CostLedger } from '../cost'
import { errorMessage } from '../errors'
import type { Logger } from '../log'
import type { MemoryService } from '../memory/service'
import type { NativePort } from '../native'
import type { ModelRouter, RouteFeatures } from '../router/model'
import type { ToolRegistry } from '../tools/registry'
import { newId, type AgentId, type AgentResult, type Task, type Tier, type ToolCallRecord } from '../types'

export type Lang = 'ko' | 'en'
export const detectLang = (text: string): Lang => (/[가-힣]/.test(text) ? 'ko' : 'en')
export const t = (lang: Lang, ko: string, en: string): string => (lang === 'ko' ? ko : en)

export interface SessionSnapshot {
  activeProject: string | null
  activeProjectPath: string | null
  activeApp: string | null
  lastDecision: string | null
}

export interface AgentContext {
  requestId: string
  signal: AbortSignal
  tools: ToolRegistry
  native: NativePort
  router: ModelRouter
  memory: MemoryService
  ledger: CostLedger
  log: Logger
  /** Results of this task's dependencies, keyed by task id. */
  deps: Record<string, AgentResult>
  session: SessionSnapshot
}

export type Capability = string

export interface Agent {
  id: AgentId
  capabilities: Capability[]
  /** 0–1 fit for a task; the orchestrator assigns by task.agent but uses this to validate plans. */
  canHandle(task: Task): number
  execute(task: Task, ctx: AgentContext): Promise<AgentResult>
}

/** Tracks tool calls for an agent run and turns them into a structured AgentResult. */
export class AgentRun {
  readonly toolCalls: ToolCallRecord[] = []
  readonly observations: string[] = []
  readonly errors: string[] = []

  constructor(
    readonly task: Task,
    readonly ctx: AgentContext,
  ) {}

  get lang(): Lang {
    return (this.task.input.lang as Lang | undefined) ?? 'en'
  }

  async tool<O>(name: string, input: unknown): Promise<O> {
    const out = await this.ctx.tools.call<O>(name, input, {
      native: this.ctx.native,
      requestId: this.ctx.requestId,
      taskId: this.task.id,
      agent: this.task.agent,
      signal: this.ctx.signal,
    })
    this.toolCalls.push(out.record)
    return out.output
  }

  async think(system: string, prompt: string, features: RouteFeatures, tier?: Tier): Promise<string> {
    const res = await this.ctx.router.complete(
      { system, messages: [{ role: 'user', content: prompt }], signal: this.ctx.signal, maxTokens: 4096 },
      {
        requestId: this.ctx.requestId,
        features,
        ...(tier ? { tier } : {}),
        agent: this.task.agent,
        taskId: this.task.id,
        project: this.ctx.session.activeProject,
        allowEscalation: true,
      },
    )
    this.observations.push(`model ${res.provider}/${res.model} (${res.tier})`)
    return res.text
  }

  /** Cost incurred outside the router (e.g. the coding agent or web researcher CLI runs). */
  async recordExternalCost(provider: string, model: string, costUsd: number | null, tier: Tier, reason: string): Promise<void> {
    if (costUsd === null) return
    await this.ctx.ledger.record({
      id: newId('use'),
      ts: Date.now(),
      requestId: this.ctx.requestId,
      provider,
      model,
      tier,
      inputTokens: 0,
      outputTokens: 0,
      costUsd,
      latencyMs: 0,
      cacheHit: false,
      reason,
      agent: this.task.agent,
      taskId: this.task.id,
      project: this.ctx.session.activeProject,
    })
  }

  done(summary: string, extra: Partial<AgentResult> = {}): AgentResult {
    return {
      status: this.errors.length ? 'partial' : 'success',
      summary,
      artifacts: [],
      observations: this.observations,
      toolCalls: this.toolCalls,
      errors: this.errors,
      nextActions: [],
      confidence: 0.9,
      ...extra,
    }
  }

  fail(error: unknown): AgentResult {
    return {
      status: 'failed',
      summary: errorMessage(error),
      artifacts: [],
      observations: this.observations,
      toolCalls: this.toolCalls,
      errors: [...this.errors, errorMessage(error)],
      nextActions: [],
      confidence: 0,
    }
  }
}

export const depResults = (ctx: AgentContext): AgentResult[] => Object.values(ctx.deps)
export const depText = (ctx: AgentContext): string =>
  depResults(ctx)
    .map((r) => `## ${r.summary}\n${r.artifacts.map((a) => `### ${a.title}\n${a.content}`).join('\n')}`)
    .join('\n\n')
