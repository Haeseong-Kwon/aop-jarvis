import type { Agent, AgentContext } from '../agents/base'
import type { SqlDriver } from '../db'
import { JarvisError, errorMessage } from '../errors'
import type { EventBus } from '../events'
import type { Logger } from '../log'
import type { AgentId, AgentResult, Task, TaskStatus } from '../types'

const MAX_CONCURRENCY = 4
const TERMINAL: TaskStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED']
const NON_RETRYABLE = /not authorized|cancelled|No active project|not configured/i

/** Throws on unknown dependencies or cycles (Kahn's algorithm). */
export function validateGraph(tasks: Task[]): void {
  const ids = new Set(tasks.map((t) => t.id))
  for (const t of tasks) for (const d of t.dependencies) if (!ids.has(d)) throw new JarvisError('INVALID_INPUT', `Task ${t.id} depends on unknown ${d}`)
  const indegree = new Map(tasks.map((t) => [t.id, t.dependencies.length]))
  const queue = tasks.filter((t) => t.dependencies.length === 0).map((t) => t.id)
  let seen = 0
  while (queue.length) {
    const id = queue.shift()!
    seen++
    for (const t of tasks) {
      if (!t.dependencies.includes(id)) continue
      const n = indegree.get(t.id)! - 1
      indegree.set(t.id, n)
      if (n === 0) queue.push(t.id)
    }
  }
  if (seen !== tasks.length) throw new JarvisError('INVALID_INPUT', 'Task graph has a cycle')
}

export class TaskStore {
  constructor(private readonly db: SqlDriver) {}
  async save(t: Task): Promise<void> {
    await this.db.execute(
      `INSERT INTO tasks (id, request_id, agent, title, status, json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, json = excluded.json, updated_at = excluded.updated_at`,
      [t.id, t.requestId, t.agent, t.title, t.status, JSON.stringify(t), Date.now()],
    )
  }
}

export type ContextFactory = (task: Task, deps: Record<string, AgentResult>, signal: AbortSignal) => AgentContext

/** Executes a task DAG: dependency resolution, bounded concurrency, retry, cancellation, status events. */
export class Orchestrator {
  constructor(
    private readonly agents: Map<AgentId, Agent>,
    private readonly makeContext: ContextFactory,
    private readonly store: TaskStore,
    private readonly bus: EventBus,
    private readonly log: Logger,
  ) {}

  async run(input: Task[], signal: AbortSignal): Promise<Task[]> {
    validateGraph(input)
    const tasks = new Map(input.map((t) => [t.id, { ...t }]))
    for (const t of tasks.values()) {
      const agent = this.agents.get(t.agent)
      if (!agent || agent.canHandle(t) === 0) throw new JarvisError('INVALID_INPUT', `No agent can handle ${t.agent}:${t.type}`)
      await this.store.save(t)
      this.bus.emit('task:created', { task: t })
    }

    // Reflect approval waits on the task that triggered them.
    const offRequested = this.bus.on('approval:requested', (a) => {
      const t = a.taskId ? tasks.get(a.taskId) : undefined
      if (t && t.status === 'RUNNING') void this.update(tasks, t.id, { status: 'WAITING_APPROVAL' })
    })
    const offResolved = this.bus.on('approval:resolved', () => {
      for (const t of tasks.values()) if (t.status === 'WAITING_APPROVAL') void this.update(tasks, t.id, { status: 'RUNNING' })
    })

    const running = new Map<string, Promise<void>>()
    try {
      while (true) {
        if (signal.aborted) {
          for (const t of tasks.values()) if (!TERMINAL.includes(t.status)) await this.update(tasks, t.id, { status: 'CANCELLED', completedAt: Date.now() })
          break
        }
        for (const t of tasks.values()) {
          if (t.status !== 'QUEUED' || running.has(t.id) || running.size >= MAX_CONCURRENCY) continue
          const deps = t.dependencies.map((d) => tasks.get(d)!)
          if (deps.some((d) => !TERMINAL.includes(d.status))) continue
          const depFailed = deps.some((d) => d.status !== 'COMPLETED')
          if (depFailed && !t.input.runOnFailure) {
            await this.update(tasks, t.id, { status: 'CANCELLED', completedAt: Date.now() })
            continue
          }
          running.set(t.id, this.execute(tasks, t.id, signal).finally(() => running.delete(t.id)))
        }
        if ([...tasks.values()].every((t) => TERMINAL.includes(t.status))) break
        if (running.size === 0) {
          // Nothing runnable and nothing running: remaining tasks are blocked.
          for (const t of tasks.values()) if (!TERMINAL.includes(t.status)) await this.update(tasks, t.id, { status: 'CANCELLED', completedAt: Date.now() })
          break
        }
        await Promise.race([...running.values(), abortPromise(signal)])
      }
      await Promise.allSettled(running.values())
    } finally {
      offRequested()
      offResolved()
    }
    return [...tasks.values()]
  }

  private async execute(tasks: Map<string, Task>, id: string, signal: AbortSignal): Promise<void> {
    const task = tasks.get(id)!
    const agent = this.agents.get(task.agent)!
    const deps = Object.fromEntries(task.dependencies.map((d) => [d, tasks.get(d)!.result]).filter((e): e is [string, AgentResult] => e[1] !== null))
    await this.update(tasks, id, { status: 'RUNNING', startedAt: Date.now(), attempts: task.attempts + 1 })
    this.bus.emit('agent:started', { taskId: id, agent: task.agent })
    let result: AgentResult
    try {
      result = await agent.execute(tasks.get(id)!, this.makeContext(tasks.get(id)!, deps, signal))
    } catch (error) {
      result = { status: 'failed', summary: errorMessage(error), artifacts: [], observations: [], toolCalls: [], errors: [errorMessage(error)], nextActions: [], confidence: 0 }
    }
    const current = tasks.get(id)!
    if (signal.aborted) {
      await this.update(tasks, id, { status: 'CANCELLED', completedAt: Date.now(), result })
      return
    }
    if (result.status === 'failed') {
      const retry = current.attempts < current.maxAttempts && !NON_RETRYABLE.test(result.summary)
      this.log.warn('agent failed', { taskId: id, agentId: task.agent, retry, error: result.summary })
      if (retry) {
        await this.update(tasks, id, { status: 'QUEUED', result })
        return
      }
      await this.update(tasks, id, { status: 'FAILED', completedAt: Date.now(), result })
      this.bus.emit('agent:failed', { taskId: id, agent: task.agent, error: result.summary })
      return
    }
    await this.update(tasks, id, { status: 'COMPLETED', completedAt: Date.now(), result })
    this.bus.emit('agent:completed', { taskId: id, agent: task.agent, summary: result.summary })
  }

  private async update(tasks: Map<string, Task>, id: string, patch: Partial<Task>): Promise<void> {
    const next = { ...tasks.get(id)!, ...patch }
    tasks.set(id, next)
    this.bus.emit('task:updated', { task: next })
    await this.store.save(next).catch((error: unknown) => this.log.error('task persist failed', { taskId: id, error: errorMessage(error) }))
  }
}

const abortPromise = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => (signal.aborted ? resolve() : signal.addEventListener('abort', () => resolve(), { once: true })))
