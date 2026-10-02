import type { SessionSnapshot } from './agents/base'
import type { JarvisConfig } from './config'
import { errorMessage } from './errors'
import type { EventBus } from './events'
import type { Logger } from './log'
import type { MemoryService } from './memory/service'
import type { NativePort } from './native'
import { newId } from './types'

export interface Turn {
  role: 'user' | 'assistant'
  text: string
  ts: number
  requestId: string
}

export interface SessionState {
  sessionId: string
  activeProject: string | null
  activeProjectPath: string | null
  activeApp: string | null
  activeBranch: string | null
  clipboard: string | null
  currentTask: string | null
  recentTasks: { id: string; title: string; status: string }[]
  recentToolCalls: { tool: string; summary: string }[]
  /** The most recent decision surfaced or recorded — what "그 방식 / that approach" refers to. */
  lastDecision: string | null
  turns: Turn[]
}

const MAX_TURNS = 20
const MAX_RECENT = 10
const PRONOUN_REF = /(그\s*방식|그\s*방법|아까\s*(말한|얘기한)|그렇게|그대로|that approach|that way|the way we (discussed|decided)|as (we )?discussed)/i

const titleCase = (s: string): string => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

/**
 * Context Broker: structured session state. Each model request gets only the slice it needs
 * (resolved references, a few memories, the last few turns) — never the whole history.
 */
export class ContextBroker {
  readonly state: SessionState = {
    sessionId: newId('ses'),
    activeProject: null,
    activeProjectPath: null,
    activeApp: null,
    activeBranch: null,
    clipboard: null,
    currentTask: null,
    recentTasks: [],
    recentToolCalls: [],
    lastDecision: null,
    turns: [],
  }

  constructor(
    private readonly native: NativePort,
    private readonly getConfig: () => JarvisConfig,
    private readonly memory: MemoryService,
    private readonly bus: EventBus,
    private readonly log: Logger,
  ) {
    bus.on('task:updated', ({ task }) => {
      this.state.currentTask = task.status === 'RUNNING' ? task.title : this.state.currentTask
      this.state.recentTasks = [{ id: task.id, title: task.title, status: task.status }, ...this.state.recentTasks.filter((t) => t.id !== task.id)].slice(0, MAX_RECENT)
    })
    bus.on('tool:result', (r) => {
      this.state.recentToolCalls = [{ tool: r.tool, summary: r.summary }, ...this.state.recentToolCalls].slice(0, MAX_RECENT)
    })
  }

  /** Refresh only what privacy settings allow. */
  async refresh(): Promise<void> {
    const cfg = this.getConfig().context
    const path = cfg.activeProjectPath.trim() || null
    this.state.activeProjectPath = path
    if (path) {
      this.state.activeProject = titleCase(path.split('/').filter(Boolean).pop() ?? '')
      const out = await this.native.exec('/usr/bin/git', ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 3000 }).catch(() => null)
      this.state.activeBranch = out?.code === 0 ? out.stdout.trim() : null
    }
    if (cfg.trackActiveApp) {
      try {
        this.state.activeApp = (await this.native.frontmostApp())?.name ?? null
      } catch (error) {
        this.log.debug('frontmost app unavailable', { error: errorMessage(error) })
      }
    }
    this.state.clipboard = cfg.trackClipboard ? (await this.native.clipboardRead().catch(() => '')).slice(0, 2000) || null : null
    this.bus.emit('context:updated', { context: this.publicView() })
  }

  /**
   * Resolve "그 방식대로 / that approach": session decision first, then the latest decision memory
   * for the project in question.
   */
  async resolveDecision(text: string, project: string | null, requestId: string): Promise<string | null> {
    if (!PRONOUN_REF.test(text)) return null
    if (this.state.lastDecision) return this.state.lastDecision
    const result = await this.memory.search({ query: text, project: project ?? this.state.activeProject, types: ['decision'], limit: 1, requestId, includeExternal: false })
    const top = result.local[0]?.entry
    if (!top) {
      const recent = await this.memory.store.timeline({ project: project ?? this.state.activeProject, limit: 20 })
      return recent.find((m) => m.type === 'decision')?.content ?? null
    }
    return top.content
  }

  setDecision(decision: string): void {
    this.state.lastDecision = decision
  }

  addTurn(turn: Omit<Turn, 'ts'>): void {
    this.state.turns = [...this.state.turns, { ...turn, ts: Date.now() }].slice(-MAX_TURNS)
  }

  /** The last few turns only, for conversational replies. */
  history(n = 6): string {
    return this.state.turns
      .slice(-n)
      .map((t) => `${t.role === 'user' ? 'User' : 'JARVIS'}: ${t.text}`)
      .join('\n')
  }

  snapshot(project?: string | null): SessionSnapshot {
    return {
      activeProject: project ?? this.state.activeProject,
      activeProjectPath: this.state.activeProjectPath,
      activeApp: this.state.activeApp,
      lastDecision: this.state.lastDecision,
    }
  }

  publicView(): Record<string, unknown> {
    const s = this.state
    return {
      sessionId: s.sessionId,
      activeProject: s.activeProject,
      activeProjectPath: s.activeProjectPath,
      activeBranch: s.activeBranch,
      activeApp: s.activeApp,
      clipboard: s.clipboard ? `${s.clipboard.length} chars` : null,
      currentTask: s.currentTask,
      lastDecision: s.lastDecision,
      recentTasks: s.recentTasks.slice(0, 5),
      turns: s.turns.length,
    }
  }
}
