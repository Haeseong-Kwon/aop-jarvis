import { JarvisError } from '../errors'
import type { NativePort, ProcessHandle } from '../native'

const REQUEST_TIMEOUT_MS = 15_000
const PROTOCOL_VERSION = '2025-06-18'

interface RpcResponse {
  id?: number
  result?: { content?: { type: string; text?: string }[]; isError?: boolean } & Record<string, unknown>
  error?: { code: number; message: string }
}

/** Minimal MCP stdio client: initialize, tools/list, tools/call over newline-delimited JSON-RPC. */
export class McpStdioClient {
  private proc: ProcessHandle | null = null
  private starting: Promise<ProcessHandle> | null = null
  private nextId = 1
  private pending = new Map<number, { resolve: (r: RpcResponse) => void; timer: ReturnType<typeof setTimeout> }>()

  constructor(
    private readonly native: NativePort,
    private readonly command: { program: string; args: string[]; env?: Record<string, string> },
  ) {}

  private async ensure(): Promise<ProcessHandle> {
    if (this.proc) return this.proc
    this.starting ??= this.start().finally(() => (this.starting = null))
    return this.starting
  }

  private async start(): Promise<ProcessHandle> {
    const proc = await this.native.spawn(this.command.program, this.command.args, this.command.env ? { env: this.command.env } : {})
    proc.onLine((line) => this.onLine(line))
    proc.onExit(() => {
      this.proc = null
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer)
        p.resolve({ id, error: { code: -1, message: 'MCP server exited' } })
      }
      this.pending.clear()
    })
    this.proc = proc
    await this.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'aop-jarvis', version: '0.1.0' } }, proc)
    await proc.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    return proc
  }

  private onLine(line: string): void {
    let msg: RpcResponse
    try {
      msg = JSON.parse(line) as RpcResponse
    } catch {
      return // not protocol output
    }
    if (typeof msg.id !== 'number') return
    const p = this.pending.get(msg.id)
    if (!p) return
    clearTimeout(p.timer)
    this.pending.delete(msg.id)
    p.resolve(msg)
  }

  private async request(method: string, params: unknown, proc?: ProcessHandle): Promise<RpcResponse> {
    const target = proc ?? (await this.ensure())
    const id = this.nextId++
    const response = new Promise<RpcResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ id, error: { code: -2, message: `${method} timed out` } })
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, timer })
    })
    await target.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return response
  }

  async listTools(): Promise<string[]> {
    const res = await this.request('tools/list', {})
    if (res.error) throw new JarvisError('MEMORY_UNAVAILABLE', res.error.message)
    return ((res.result?.tools as { name: string }[] | undefined) ?? []).map((t) => t.name)
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const res = await this.request('tools/call', { name, arguments: args })
    if (res.error) throw new JarvisError('MEMORY_UNAVAILABLE', res.error.message)
    const text = (res.result?.content ?? []).map((c) => c.text ?? '').join('\n')
    if (res.result?.isError) throw new JarvisError('MEMORY_UNAVAILABLE', text || `${name} failed`)
    return text
  }

  async close(): Promise<void> {
    await this.proc?.kill()
    this.proc = null
  }
}
