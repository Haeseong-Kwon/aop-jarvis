import type { EventBus, LogEntry } from './events'

// Secrets must never reach logs: API keys, bearer tokens, private iCal URLs.
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /(api[_-]?key|token|secret|password|authorization)(["'\s:=]+)([^\s"',}]+)/gi,
  /Bearer\s+[A-Za-z0-9._-]+/g,
]

export function redact(text: string): string {
  return SECRET_PATTERNS.reduce(
    (acc, re) => acc.replace(re, (_match, key?: string, sep?: string) => (key && sep ? `${key}${sep}[REDACTED]` : '[REDACTED]')),
    text,
  )
}

/** Structured logger carrying correlation ids (sessionId, requestId, taskId, agentId, toolCallId). */
export class Logger {
  constructor(
    private readonly bus: EventBus,
    private readonly ctx: Record<string, unknown> = {},
  ) {}

  child(ctx: Record<string, unknown>): Logger {
    return new Logger(this.bus, { ...this.ctx, ...ctx })
  }

  debug(msg: string, ctx?: Record<string, unknown>): void {
    this.write('debug', msg, ctx)
  }
  info(msg: string, ctx?: Record<string, unknown>): void {
    this.write('info', msg, ctx)
  }
  warn(msg: string, ctx?: Record<string, unknown>): void {
    this.write('warn', msg, ctx)
  }
  error(msg: string, ctx?: Record<string, unknown>): void {
    this.write('error', msg, ctx)
  }

  private write(level: LogEntry['level'], msg: string, ctx?: Record<string, unknown>): void {
    const merged = { ...this.ctx, ...ctx }
    const entry: LogEntry = { ts: Date.now(), level, msg: redact(msg), ctx: JSON.parse(redact(JSON.stringify(merged))) }
    this.bus.emit('log', entry)
    if (level === 'error' || level === 'warn') console[level](`[jarvis] ${entry.msg}`, entry.ctx)
  }
}

export const truncate = (text: string, max = 200): string => (text.length > max ? `${text.slice(0, max)}…` : text)
