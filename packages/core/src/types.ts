// Shared domain types. Everything that crosses a module boundary is defined here.

export type Tier = 'L0' | 'L1' | 'L2' | 'L3'

export const RISK_LEVELS = [
  'READ',
  'LOW_WRITE',
  'HIGH_WRITE',
  'SEND',
  'DELETE',
  'PURCHASE',
  'DEPLOY',
  'PRIVILEGED_SYSTEM',
] as const
export type RiskLevel = (typeof RISK_LEVELS)[number]

export type RuntimeState =
  | 'DORMANT'
  | 'LISTENING'
  | 'BOOTING'
  | 'ONLINE'
  | 'THINKING'
  | 'EXECUTING'
  | 'SPEAKING'
  | 'INTERRUPTED'
  | 'WAITING_APPROVAL'
  | 'ERROR'
  | 'SLEEP'

export type VoiceState = 'IDLE' | 'LISTENING' | 'TRANSCRIBING' | 'THINKING' | 'SPEAKING' | 'INTERRUPTED' | 'ERROR'

export type AgentId = 'research' | 'code' | 'operator' | 'analyst' | 'communicator' | 'reviewer'

export type TaskStatus =
  | 'QUEUED'
  | 'PLANNING'
  | 'RUNNING'
  | 'WAITING'
  | 'WAITING_APPROVAL'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'

export interface Artifact {
  kind: 'text' | 'json' | 'diff' | 'file' | 'metrics'
  title: string
  content: string
}

export interface ToolCallRecord {
  id: string
  tool: string
  ok: boolean
  durationMs: number
  summary: string
}

export interface AgentResult {
  status: 'success' | 'partial' | 'failed'
  summary: string
  artifacts: Artifact[]
  observations: string[]
  toolCalls: ToolCallRecord[]
  errors: string[]
  nextActions: string[]
  confidence: number
  /** Structured payload for downstream tasks (e.g. metrics, file list). */
  data?: unknown
}

export interface Task {
  id: string
  requestId: string
  parentTaskId: string | null
  /** Agent-specific operation, e.g. 'launch_app', 'inspect_repo', 'synthesize'. */
  type: string
  title: string
  description: string
  agent: AgentId
  dependencies: string[]
  status: TaskStatus
  priority: number
  risk: RiskLevel
  requiresApproval: boolean
  input: Record<string, unknown>
  attempts: number
  maxAttempts: number
  createdAt: number
  startedAt: number | null
  completedAt: number | null
  result: AgentResult | null
}

export type Subsystem = 'voice' | 'memory' | 'router' | 'agents' | 'system'

export interface UsageRecord {
  id: string
  ts: number
  requestId: string
  provider: string
  model: string
  tier: Tier
  inputTokens: number
  outputTokens: number
  costUsd: number
  latencyMs: number
  cacheHit: boolean
  reason: string
  agent: AgentId | 'executive' | null
  taskId: string | null
  project: string | null
}

export interface ApprovalRequest {
  id: string
  requestId: string
  taskId: string | null
  tool: string
  risk: RiskLevel
  title: string
  /** Plain-language consequence. Never hidden behind visuals. */
  detail: string
}

export const newId = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
