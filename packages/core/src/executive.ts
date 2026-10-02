import { detectLang, t, type Lang } from './agents/base'
import type { ContextBroker } from './context'
import type { SqlDriver } from './db'
import { JarvisError, errorMessage } from './errors'
import type { EventBus } from './events'
import type { Logger } from './log'
import { formatMemoryContext, type MemorySearchResult, type MemoryService } from './memory/service'
import type { Orchestrator } from './orchestrator/orchestrator'
import { plan } from './orchestrator/planner'
import { classify, type Intent } from './router/intent'
import { newId, type Task, type Tier } from './types'

export interface HandleResult {
  requestId: string
  response: string
  /** What to say aloud (may be shorter/more natural than `response`, which is what the screen shows). */
  speech: string
  lang: Lang
  tier: Tier
  intent: Intent
  tasks: Task[]
  ok: boolean
}

const TIER_ORDER: Tier[] = ['L0', 'L1', 'L2', 'L3']
const NEEDS_MEMORY_CONTEXT = new Set(['chat', 'draft', 'analyze'])

/**
 * Chief of staff: understand → resolve context → assess → plan → delegate → monitor → combine → report.
 * It never does specialist work itself.
 */
export class Executive {
  private active: AbortController | null = null

  constructor(
    private readonly db: SqlDriver,
    private readonly context: ContextBroker,
    private readonly memory: MemoryService,
    private readonly orchestrator: Orchestrator,
    private readonly bus: EventBus,
    private readonly log: Logger,
  ) {}

  get busy(): boolean {
    return this.active !== null
  }

  cancel(): boolean {
    if (!this.active) return false
    this.active.abort()
    return true
  }

  async handle(text: string, outerSignal?: AbortSignal): Promise<HandleResult> {
    const requestId = newId('req')
    const lang = detectLang(text)
    const intent = classify(text)
    const log = this.log.child({ requestId, sessionId: this.context.state.sessionId })
    this.bus.emit('request:started', { requestId, text })
    this.bus.emit('intent:resolved', { requestId, intent: intent.name, tier: intent.tier, confidence: intent.confidence, entities: intent.entities })
    this.context.addTurn({ role: 'user', text, requestId })

    if (intent.name === 'cancel') {
      const cancelled = this.cancel()
      return this.finish(requestId, intent, lang, [], t(lang, cancelled ? '작업을 취소했습니다.' : '진행 중인 작업이 없습니다.', cancelled ? 'Cancelled.' : 'Nothing is running.'), true)
    }
    if (this.active) this.active.abort() // a new request supersedes the previous one

    const controller = new AbortController()
    outerSignal?.addEventListener('abort', () => controller.abort(), { once: true })
    this.active = controller
    const tiersUsed = new Set<Tier>(['L0'])
    const offUsage = this.bus.on('model:usage', (u) => u.requestId === requestId && tiersUsed.add(u.tier))

    try {
      await this.context.refresh().catch((error: unknown) => log.warn('context refresh failed', { error: errorMessage(error) }))
      const project = (intent.entities.project as string | undefined) ?? null

      if (intent.name === 'code.fix') {
        const decision = await this.context.resolveDecision(text, project, requestId)
        if (decision) this.context.setDecision(decision)
      }
      let memoryContext = ''
      if (NEEDS_MEMORY_CONTEXT.has(intent.name)) {
        const found = await this.memory.search({ query: text, project, limit: 3, requestId, includeExternal: intent.name !== 'chat' }).catch(() => null)
        if (found) memoryContext = formatMemoryContext({ local: found.local.filter((h) => h.score >= 0.2), external: found.external })
      }

      const tasks = plan({ requestId, text, intent, lang, session: this.context.snapshot(project), memoryContext, history: this.context.history() })
      const done = await this.orchestrator.run(tasks, controller.signal)
      this.learnFromResults(done)
      const ok = done.every((task) => task.status === 'COMPLETED' || task.agent === 'reviewer')
      const tier = TIER_ORDER[Math.max(...[...tiersUsed].map((x) => TIER_ORDER.indexOf(x)))]!
      return this.finish(requestId, intent, lang, done, compose(done, lang, controller.signal.aborted), ok, tier, composeSpeech(done, lang, controller.signal.aborted))
    } catch (error) {
      const message = errorMessage(error)
      this.bus.emit('error', { code: error instanceof JarvisError ? error.code : 'TASK_EXECUTION_FAILED', message, requestId })
      log.error('request failed', { error: message })
      return this.finish(requestId, intent, lang, [], t(lang, `처리하지 못했습니다: ${message}`, `I couldn't complete that: ${message}`), false)
    } finally {
      offUsage()
      if (this.active === controller) this.active = null
    }
  }

  /** Surface decisions so "그 방식대로" can resolve against what was just discussed. */
  private learnFromResults(tasks: Task[]): void {
    for (const task of tasks) {
      if (task.type === 'memory_research' && task.status === 'COMPLETED') {
        const result = task.result?.data as MemorySearchResult | undefined
        const decision = result?.local.find((h) => h.entry.type === 'decision' && h.score >= 0.2)
        if (decision) this.context.setDecision(decision.entry.content)
      }
      if (task.type === 'remember' && task.status === 'COMPLETED' && /\(decision\)/.test(task.result?.summary ?? '')) {
        this.context.setDecision(String(task.input.content))
      }
    }
  }

  private async finish(requestId: string, intent: Intent, lang: Lang, tasks: Task[], response: string, ok: boolean, tier: Tier = 'L0', speech = response): Promise<HandleResult> {
    this.context.addTurn({ role: 'assistant', text: response, requestId })
    await this.db
      .execute('INSERT INTO requests (id, ts, session_id, text, intent, tier, response, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        requestId,
        Date.now(),
        this.context.state.sessionId,
        this.context.state.turns.findLast((x) => x.requestId === requestId && x.role === 'user')?.text ?? '',
        intent.name,
        tier,
        response,
        ok ? 1 : 0,
      ])
      .catch((error: unknown) => this.log.error('request persist failed', { requestId, error: errorMessage(error) }))
    this.bus.emit('request:completed', { requestId, response, tier, ok })
    return { requestId, response, speech, lang, tier, intent, tasks, ok }
  }
}

/** Combine task results into one spoken/visible answer. Details stay in result cards. */
export function compose(tasks: Task[], lang: Lang, cancelled: boolean): string {
  if (cancelled) return t(lang, '취소했습니다.', 'Cancelled.')
  const work = tasks.filter((x) => x.agent !== 'reviewer')
  const review = tasks.find((x) => x.agent === 'reviewer')
  const failed = work.filter((x) => x.status === 'FAILED')
  if (failed.length && failed.length === work.length) {
    return t(lang, `실패했습니다: ${failed[0]!.result?.summary ?? ''}`, `That failed: ${failed[0]!.result?.summary ?? ''}`)
  }
  const primary = work.filter((x) => x.status === 'COMPLETED').at(-1)
  const parts = [primary?.result?.summary ?? '']
  if (failed.length) parts.push(t(lang, `일부 작업 실패: ${failed.map((f) => f.title).join(', ')}`, `Some steps failed: ${failed.map((f) => f.title).join(', ')}`))
  const issues = (review?.result?.data as { issues?: string[] } | undefined)?.issues ?? []
  if (review?.status === 'COMPLETED' && review.result) parts.push(issues.length ? t(lang, `검토 이슈 ${issues.length}건.`, `${issues.length} review issues.`) : t(lang, '검토 통과.', 'Review passed.'))
  return parts.filter(Boolean).join(' ')
}

/**
 * The spoken answer. An agent may supply a natural or shorter spoken form (`result.speech`); JARVIS
 * acknowledges rather than narrates, so a single successful task with a spoken form says only that.
 */
export function composeSpeech(tasks: Task[], lang: Lang, cancelled: boolean): string {
  const work = tasks.filter((x) => x.agent !== 'reviewer')
  const primary = work.filter((x) => x.status === 'COMPLETED').at(-1)
  const clean = !cancelled && work.every((x) => x.status === 'COMPLETED')
  const issues = (tasks.find((x) => x.agent === 'reviewer')?.result?.data as { issues?: string[] } | undefined)?.issues ?? []
  if (clean && primary?.result?.speech && !issues.length) return primary.result.speech
  return compose(tasks, lang, cancelled)
}
