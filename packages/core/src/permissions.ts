import type { PermissionPolicy } from './config'
import type { SqlDriver } from './db'
import type { EventBus } from './events'
import { newId, type ApprovalRequest, type RiskLevel } from './types'

export type ApprovalOutcome = 'auto' | 'approved' | 'denied'

export interface AuditRecord {
  id: string
  ts: number
  requestId: string | null
  taskId: string | null
  agent: string | null
  tool: string
  inputSummary: string
  result: string
  risk: RiskLevel
  approval: ApprovalOutcome
  durationMs: number
}

const APPROVAL_TIMEOUT_MS = 5 * 60_000

/** Risk policy + human approval gate. Approvals resolve only from an explicit user action (or time out as denied). */
export class PermissionGate {
  private pending = new Map<string, { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }>()

  constructor(
    private readonly getPolicy: () => PermissionPolicy,
    private readonly bus: EventBus,
  ) {}

  needsApproval(risk: RiskLevel): boolean {
    return (this.getPolicy()[risk] ?? 'approve') === 'approve'
  }

  async authorize(req: Omit<ApprovalRequest, 'id'>, signal?: AbortSignal): Promise<ApprovalOutcome> {
    if (!this.needsApproval(req.risk)) return 'auto'
    const id = newId('apr')
    const approved = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.resolve(id, false), APPROVAL_TIMEOUT_MS)
      this.pending.set(id, { resolve, timer })
      signal?.addEventListener('abort', () => this.resolve(id, false), { once: true })
      this.bus.emit('approval:requested', { ...req, id })
    })
    return approved ? 'approved' : 'denied'
  }

  /** Called by the approval UI. */
  resolve(id: string, approved: boolean): void {
    const entry = this.pending.get(id)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(id)
    entry.resolve(approved)
    this.bus.emit('approval:resolved', { id, approved })
  }

  get pendingCount(): number {
    return this.pending.size
  }
}

export class AuditLog {
  constructor(private readonly db: SqlDriver) {}

  async write(r: Omit<AuditRecord, 'id' | 'ts'>): Promise<void> {
    await this.db.execute(
      'INSERT INTO audit (id, ts, request_id, task_id, agent, tool, input_summary, result, risk, approval, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [newId('aud'), Date.now(), r.requestId, r.taskId, r.agent, r.tool, r.inputSummary, r.result, r.risk, r.approval, r.durationMs],
    )
  }

  async recent(limit = 100): Promise<AuditRecord[]> {
    const rows = await this.db.select<Record<string, unknown>>('SELECT * FROM audit ORDER BY ts DESC LIMIT ?', [limit])
    return rows.map((r) => ({
      id: String(r.id),
      ts: Number(r.ts),
      requestId: (r.request_id as string | null) ?? null,
      taskId: (r.task_id as string | null) ?? null,
      agent: (r.agent as string | null) ?? null,
      tool: String(r.tool),
      inputSummary: String(r.input_summary),
      result: String(r.result),
      risk: r.risk as RiskLevel,
      approval: r.approval as ApprovalOutcome,
      durationMs: Number(r.duration_ms),
    }))
  }
}
