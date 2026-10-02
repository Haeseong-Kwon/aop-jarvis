import { DatabaseSync } from 'node:sqlite'
import type { SqlDriver, SqlValue } from '../src/db'
import type { ExecOptions, ExecResult, NativePort, ProcessHandle, SystemMetrics } from '../src/native'

export function memoryDb(): SqlDriver {
  const db = new DatabaseSync(':memory:')
  return {
    async execute(sql: string, params: SqlValue[] = []) {
      db.prepare(sql).run(...params)
    },
    async select<T>(sql: string, params: SqlValue[] = []) {
      return db.prepare(sql).all(...params) as T[]
    },
  }
}

export const GB = 1024 ** 3

export const METRICS: SystemMetrics = {
  cpuPercent: 12,
  memUsedBytes: 14 * GB,
  memTotalBytes: 32 * GB,
  swapUsedBytes: 0,
  diskUsedBytes: 200 * GB,
  diskTotalBytes: 1000 * GB,
  battery: { percent: 80, charging: false },
  uptimeSec: 1000,
  processCount: 500,
}

export interface ExecCall {
  program: string
  args: string[]
  opts?: ExecOptions
}

type ExecHandler = (program: string, args: string[], opts?: ExecOptions) => ExecResult | Promise<ExecResult> | undefined

export interface FakeNative extends NativePort {
  calls: ExecCall[]
  files: Map<string, string>
  trashed: string[]
  notifications: { title: string; body: string }[]
}

export const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' })

/** A scriptable NativePort. Unhandled exec calls fail loudly so tests notice unexpected side effects. */
export function fakeNative(handler: ExecHandler = () => undefined, files: Record<string, string> = {}): FakeNative {
  const calls: ExecCall[] = []
  const fileMap = new Map(Object.entries(files))
  const trashed: string[] = []
  const notifications: { title: string; body: string }[] = []
  return {
    calls,
    files: fileMap,
    trashed,
    notifications,
    homeDir: '/Users/test',
    tempDir: '/tmp/jarvis-test',
    fetch: (async () => {
      throw new Error('network disabled in tests')
    }) as unknown as typeof fetch,
    async exec(program, args, opts) {
      calls.push({ program, args, ...(opts ? { opts } : {}) })
      const custom = await handler(program, args, opts)
      if (custom) return custom
      if (program === '/bin/zsh' && args[1]?.startsWith('command -v')) return { code: 1, stdout: '', stderr: '' }
      return { code: 127, stdout: '', stderr: `unexpected exec: ${program} ${args.join(' ')}` }
    },
    async spawn(): Promise<ProcessHandle> {
      throw new Error('spawn disabled in tests')
    },
    async readTextFile(path) {
      const v = fileMap.get(path)
      if (v === undefined) throw new Error(`ENOENT ${path}`)
      return v
    },
    async writeTextFile(path, content) {
      fileMap.set(path, content)
    },
    async readBinaryFile() {
      return new Uint8Array(44)
    },
    async writeBinaryFile() {},
    async removeTemp() {},
    async listDir() {
      return []
    },
    async exists(path) {
      return fileMap.has(path) || [...fileMap.keys()].some((k) => k.startsWith(`${path}/`))
    },
    async trash(path) {
      trashed.push(path)
      fileMap.delete(path)
    },
    async systemMetrics() {
      return METRICS
    },
    async frontmostApp() {
      return { name: 'Terminal', bundleId: 'com.apple.Terminal', pid: 1 }
    },
    async clipboardRead() {
      return 'clip'
    },
    async clipboardWrite() {},
    async notify(title, body) {
      notifications.push({ title, body })
    },
    async secretGet() {
      return null
    },
  }
}
