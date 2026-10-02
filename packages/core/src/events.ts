import type { ErrorCode } from './errors'
import type { AgentId, ApprovalRequest, RuntimeState, Subsystem, Task, Tier, UsageRecord, VoiceState } from './types'

export interface LogEntry {
  ts: number
  level: 'debug' | 'info' | 'warn' | 'error'
  msg: string
  ctx: Record<string, unknown>
}

export interface RetrievalDiagnostic {
  id: string
  title: string
  score: number
  reasons: Record<string, number>
  source: string
}

/** Every realtime signal in the runtime. The UI subscribes; the runtime emits. */
export interface JarvisEvents {
  'runtime:state': { state: RuntimeState; reason?: string }
  'system:ready': { subsystem: Subsystem; ok: boolean; detail: string }
  'voice:state': { state: VoiceState }
  'voice:transcript': { text: string; final: boolean }
  'request:started': { requestId: string; text: string }
  'request:completed': { requestId: string; response: string; tier: Tier; ok: boolean }
  'intent:resolved': { requestId: string; intent: string; tier: Tier; confidence: number; entities: Record<string, unknown> }
  'model:routed': { requestId: string; tier: Tier; provider: string; model: string; reason: string }
  'model:usage': UsageRecord
  'task:created': { task: Task }
  'task:updated': { task: Task }
  'agent:started': { taskId: string; agent: AgentId }
  'agent:completed': { taskId: string; agent: AgentId; summary: string }
  'agent:failed': { taskId: string; agent: AgentId; error: string }
  'tool:called': { toolCallId: string; requestId: string; taskId: string | null; tool: string; risk: string; inputSummary: string }
  'tool:result': { toolCallId: string; tool: string; ok: boolean; durationMs: number; summary: string }
  'approval:requested': ApprovalRequest
  'approval:resolved': { id: string; approved: boolean }
  'memory:retrieved': { requestId: string; query: string; results: RetrievalDiagnostic[] }
  'context:updated': { context: Record<string, unknown> }
  error: { code: ErrorCode; message: string; requestId?: string }
  log: LogEntry
}

export type EventName = keyof JarvisEvents
type Handler<K extends EventName> = (payload: JarvisEvents[K]) => void
type AnyHandler = <K extends EventName>(name: K, payload: JarvisEvents[K]) => void

export class EventBus {
  private handlers = new Map<EventName, Set<(payload: never) => void>>()
  private anyHandlers = new Set<AnyHandler>()

  on<K extends EventName>(name: K, handler: Handler<K>): () => void {
    const set = this.handlers.get(name) ?? new Set()
    set.add(handler as (payload: never) => void)
    this.handlers.set(name, set)
    return () => set.delete(handler as (payload: never) => void)
  }

  onAny(handler: AnyHandler): () => void {
    this.anyHandlers.add(handler)
    return () => this.anyHandlers.delete(handler)
  }

  emit<K extends EventName>(name: K, payload: JarvisEvents[K]): void {
    // A broken subscriber must never break the runtime that emitted the event.
    for (const handler of this.handlers.get(name) ?? []) {
      try {
        ;(handler as Handler<K>)(payload)
      } catch (error) {
        console.error(`[bus] handler for ${name} failed`, error)
      }
    }
    for (const handler of this.anyHandlers) {
      try {
        handler(name, payload)
      } catch (error) {
        console.error('[bus] any-handler failed', error)
      }
    }
  }
}
