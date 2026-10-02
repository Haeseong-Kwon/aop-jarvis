import { z } from 'zod'
import { JarvisError, errorMessage, throwIfAborted } from '../errors'
import type { EventBus } from '../events'
import { truncate } from '../log'
import type { NativePort } from '../native'
import type { AuditLog, ApprovalOutcome, PermissionGate } from '../permissions'
import { newId, type AgentId, type RiskLevel, type ToolCallRecord } from '../types'

export interface ToolContext {
  native: NativePort
  requestId: string
  taskId: string | null
  agent: AgentId | null
  signal?: AbortSignal
}

export interface Tool<I = unknown, O = unknown> {
  name: string
  description: string
  input: z.ZodType<I>
  /** Static or input-dependent risk (e.g. a shell command's risk depends on the command). */
  risk: RiskLevel | ((input: I) => RiskLevel)
  /** Plain-language consequence, shown verbatim in the approval panel. */
  describe: (input: I) => string
  execute: (input: I, ctx: ToolContext) => Promise<O>
  summarize?: (output: O) => string
}

export interface ToolCallOutcome<O = unknown> {
  output: O
  record: ToolCallRecord
  approval: ApprovalOutcome
}

// Helper so each tool's I/O types are inferred from its zod schema.
export const defineTool = <I, O>(tool: Tool<I, O>): Tool<I, O> => tool

export class ToolRegistry {
  private tools = new Map<string, Tool<unknown, unknown>>()

  constructor(
    private readonly gate: PermissionGate,
    private readonly audit: AuditLog,
    private readonly bus: EventBus,
  ) {}

  register<I, O>(tool: Tool<I, O>): void {
    if (this.tools.has(tool.name)) throw new Error(`Tool ${tool.name} already registered`)
    this.tools.set(tool.name, tool as unknown as Tool<unknown, unknown>)
  }

  list(): { name: string; description: string; inputSchema: unknown; risk: string }[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: z.toJSONSchema(t.input),
      risk: typeof t.risk === 'string' ? t.risk : 'dynamic',
    }))
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  /** The single choke point: validate → assess risk → authorize → execute → audit → emit. */
  async call<O = unknown>(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolCallOutcome<O>> {
    const tool = this.tools.get(name)
    if (!tool) throw new JarvisError('INVALID_INPUT', `Unknown tool: ${name}`)
    const parsed = tool.input.safeParse(rawInput)
    if (!parsed.success) throw new JarvisError('INVALID_INPUT', `${name}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`)
    const input = parsed.data
    const risk = typeof tool.risk === 'function' ? tool.risk(input) : tool.risk
    const inputSummary = truncate(tool.describe(input), 300)
    const toolCallId = newId('tc')
    throwIfAborted(ctx.signal)

    this.bus.emit('tool:called', { toolCallId, requestId: ctx.requestId, taskId: ctx.taskId, tool: name, risk, inputSummary })
    const approval = await this.gate.authorize(
      { requestId: ctx.requestId, taskId: ctx.taskId, tool: name, risk, title: `${name.toUpperCase()} · ${risk}`, detail: inputSummary },
      ctx.signal,
    )
    const auditBase = { requestId: ctx.requestId, taskId: ctx.taskId, agent: ctx.agent, tool: name, inputSummary, risk, approval }
    if (approval === 'denied') {
      await this.audit.write({ ...auditBase, result: 'denied', durationMs: 0 })
      this.bus.emit('tool:result', { toolCallId, tool: name, ok: false, durationMs: 0, summary: 'denied by user' })
      throw new JarvisError('TOOL_PERMISSION_DENIED', `${name} was not authorized`)
    }

    const startedAt = Date.now()
    try {
      const output = (await tool.execute(input, ctx)) as O
      const durationMs = Date.now() - startedAt
      const summary = truncate(tool.summarize ? tool.summarize(output) : defaultSummary(output), 300)
      await this.audit.write({ ...auditBase, result: `ok: ${summary}`, durationMs })
      this.bus.emit('tool:result', { toolCallId, tool: name, ok: true, durationMs, summary })
      return { output, approval, record: { id: toolCallId, tool: name, ok: true, durationMs, summary } }
    } catch (error) {
      const durationMs = Date.now() - startedAt
      const message = errorMessage(error)
      await this.audit.write({ ...auditBase, result: `error: ${truncate(message, 200)}`, durationMs })
      this.bus.emit('tool:result', { toolCallId, tool: name, ok: false, durationMs, summary: message })
      if (error instanceof JarvisError) throw error
      throw new JarvisError('TASK_EXECUTION_FAILED', `${name}: ${message}`, error)
    }
  }
}

function defaultSummary(output: unknown): string {
  if (typeof output === 'string') return output
  try {
    return JSON.stringify(output)
  } catch {
    return String(output)
  }
}
