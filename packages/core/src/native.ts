// What the core runtime needs from its host (Tauri in the app, fakes in tests).
// Keeping this narrow is what lets the whole runtime run under Node for tests.

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export interface ExecOptions {
  cwd?: string
  timeoutMs?: number
  stdin?: string
  signal?: AbortSignal
}

export interface SystemMetrics {
  cpuPercent: number
  memUsedBytes: number
  memTotalBytes: number
  swapUsedBytes: number
  diskUsedBytes: number
  diskTotalBytes: number
  battery: { percent: number; charging: boolean } | null
  uptimeSec: number
  processCount: number
}

export interface FrontmostApp {
  name: string
  bundleId: string | null
  pid: number
}

export interface DirEntry {
  name: string
  isDir: boolean
}

/** A long-lived child process with line-oriented stdout (used for MCP stdio servers). */
export interface ProcessHandle {
  write(data: string): Promise<void>
  onLine(cb: (line: string) => void): void
  onExit(cb: (code: number | null) => void): void
  kill(): Promise<void>
}

export interface NativePort {
  spawn(program: string, args: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<ProcessHandle>
  /** Run a program with argv (no shell). Use exec('/bin/zsh', ['-lc', script]) only when a shell is required. */
  exec(program: string, args: string[], opts?: ExecOptions): Promise<ExecResult>
  readTextFile(path: string): Promise<string>
  writeTextFile(path: string, content: string): Promise<void>
  readBinaryFile(path: string): Promise<Uint8Array>
  writeBinaryFile(path: string, data: Uint8Array): Promise<void>
  /** A writable per-app temp directory (no trailing slash). */
  tempDir: string
  /** Deletes a file inside tempDir only (host enforces the prefix). */
  removeTemp(path: string): Promise<void>
  listDir(path: string): Promise<DirEntry[]>
  exists(path: string): Promise<boolean>
  /** Moves to Trash where possible — never a hard delete. */
  trash(path: string): Promise<void>
  systemMetrics(): Promise<SystemMetrics>
  frontmostApp(): Promise<FrontmostApp | null>
  clipboardRead(): Promise<string>
  clipboardWrite(text: string): Promise<void>
  notify(title: string, body: string): Promise<void>
  secretGet(account: string): Promise<string | null>
  homeDir: string
  fetch: typeof fetch
}

export const expandHome = (path: string, home: string): string => (path.startsWith('~') ? home + path.slice(1) : path)

/** POSIX single-quote escaping for the rare cases that need a shell. */
export const shellQuote = (arg: string): string => `'${arg.replace(/'/g, `'\\''`)}'`
