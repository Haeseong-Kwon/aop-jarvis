import type { Lang, SessionSnapshot } from '../agents/base'
import type { Intent } from '../router/intent'
import { newId, type AgentId, type RiskLevel, type Task } from '../types'

export interface PlanInput {
  requestId: string
  text: string
  intent: Intent
  lang: Lang
  session: SessionSnapshot
  memoryContext: string
  history: string
}

interface Spec {
  key: string
  agent: AgentId
  type: string
  title: string
  input?: Record<string, unknown>
  deps?: string[]
  risk?: RiskLevel
  maxAttempts?: number
}

/** Deterministic plan templates per intent. Independent tasks share no dependency and run concurrently. */
export function plan(p: PlanInput): Task[] {
  const { intent, text, lang, session } = p
  const e = intent.entities
  const base = { lang, request: text }
  const project = (e.project as string | undefined) ?? session.activeProject
  let specs: Spec[]
  switch (intent.name) {
    case 'app.open':
      specs = [{ key: 'op', agent: 'operator', type: 'launch_app', title: `Open ${String(e.app)}`, input: { app: e.app }, risk: 'LOW_WRITE' }]
      break
    case 'app.quit':
      specs = [{ key: 'op', agent: 'operator', type: 'quit_app', title: `Quit ${String(e.app)}`, input: { app: e.app }, risk: 'LOW_WRITE' }]
      break
    case 'system.memory':
      specs = [{ key: 'op', agent: 'operator', type: 'system_metrics', title: 'Memory status', input: { focus: 'memory' } }]
      break
    case 'system.status':
      specs = [{ key: 'op', agent: 'operator', type: 'system_metrics', title: 'System status' }]
      break
    case 'system.volume':
      specs = [{ key: 'op', agent: 'operator', type: 'volume', title: 'Volume', input: { level: e.level, delta: e.delta }, risk: 'LOW_WRITE' }]
      break
    case 'media.control':
      specs = [{ key: 'op', agent: 'operator', type: 'media', title: 'Music', input: { action: e.action }, risk: 'LOW_WRITE' }]
      break
    case 'time.now':
      specs = [{ key: 'op', agent: 'operator', type: 'time', title: 'Time' }]
      break
    case 'timer.set':
      specs = [{ key: 'op', agent: 'operator', type: 'timer', title: 'Timer', input: { seconds: e.seconds }, risk: 'LOW_WRITE' }]
      break
    case 'clipboard.read':
      specs = [{ key: 'op', agent: 'operator', type: 'clipboard_read', title: 'Clipboard' }]
      break
    case 'git.status':
      specs = [{ key: 'op', agent: 'operator', type: 'git_status', title: 'git status', input: { cwd: session.activeProjectPath } }]
      break
    case 'file.delete':
      specs = [{ key: 'op', agent: 'operator', type: 'trash_path', title: `Delete ${String(e.path || 'file')}`, input: { path: e.path }, risk: 'DELETE', maxAttempts: 1 }]
      break
    case 'memory.remember':
      specs = [{ key: 'mem', agent: 'research', type: 'remember', title: 'Remember', input: { content: e.content, raw: text, project }, risk: 'LOW_WRITE' }]
      break
    case 'memory.recall':
      specs = [{ key: 'mem', agent: 'research', type: 'memory_research', title: 'Search memory', input: { query: text, project } }]
      break
    case 'code.analyze':
      specs = [
        { key: 'inspect', agent: 'code', type: 'inspect_repo', title: 'Inspect repository', input: { path: session.activeProjectPath } },
        { key: 'review', agent: 'reviewer', type: 'review', title: 'Review findings', deps: ['inspect'], input: { runOnFailure: true } },
      ]
      break
    case 'code.fix':
      specs = [
        { key: 'fix', agent: 'code', type: 'fix_code', title: 'Change code', input: { path: session.activeProjectPath, decision: session.lastDecision }, risk: 'HIGH_WRITE', maxAttempts: 1 },
        { key: 'review', agent: 'reviewer', type: 'review', title: 'Verify change', deps: ['fix'], input: { runOnFailure: true, runTests: true } },
      ]
      break
    case 'research':
      specs = [
        { key: 'web', agent: 'research', type: 'web_research', title: 'Web research', input: { question: text } },
        { key: 'mem', agent: 'research', type: 'memory_research', title: 'Memory research', input: { query: text, project } },
        { key: 'synth', agent: 'analyst', type: 'synthesize', title: 'Synthesis', deps: ['web', 'mem'], input: { complexity: Math.max(0.5, intent.complexity) } },
        { key: 'review', agent: 'reviewer', type: 'review', title: 'Review', deps: ['synth'], input: { runOnFailure: true } },
      ]
      break
    case 'draft':
      specs = [{ key: 'draft', agent: 'communicator', type: 'draft', title: 'Draft', input: { memoryContext: p.memoryContext } }]
      break
    case 'analyze':
      specs = [{ key: 'an', agent: 'analyst', type: 'analyze', title: 'Analysis', input: { complexity: intent.complexity, memoryContext: p.memoryContext } }]
      break
    case 'cancel':
      specs = []
      break
    case 'chat':
      specs = [
        {
          key: 'reply',
          agent: 'communicator',
          type: 'respond',
          title: 'Reply',
          input: { memoryContext: p.memoryContext, history: p.history, complexity: intent.complexity, tier: intent.tier },
        },
      ]
      break
  }
  return materialize(p.requestId, specs, base)
}

function materialize(requestId: string, specs: Spec[], base: Record<string, unknown>): Task[] {
  const ids = new Map(specs.map((s) => [s.key, newId('task')]))
  const now = Date.now()
  return specs.map((s, index) => ({
    id: ids.get(s.key)!,
    requestId,
    parentTaskId: null,
    type: s.type,
    title: s.title,
    description: s.title,
    agent: s.agent,
    dependencies: (s.deps ?? []).map((d) => ids.get(d)!),
    status: 'QUEUED',
    priority: specs.length - index,
    risk: s.risk ?? 'READ',
    requiresApproval: ['HIGH_WRITE', 'SEND', 'DELETE', 'PURCHASE', 'DEPLOY', 'PRIVILEGED_SYSTEM'].includes(s.risk ?? 'READ'),
    input: { ...base, ...s.input },
    attempts: 0,
    maxAttempts: s.maxAttempts ?? 2,
    createdAt: now,
    startedAt: null,
    completedAt: null,
    result: null,
  }))
}
