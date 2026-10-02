import type { NativePort, ProcessHandle, SystemMetrics } from '@aop/core'
import { execFile, spawn } from 'node:child_process'
import { mkdirSync, statfsSync } from 'node:fs'
import { access, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const HOME = os.homedir()
const TEMP = join(os.tmpdir(), 'aop-jarvis-cli')
mkdirSync(TEMP, { recursive: true })
// Same tool locations the desktop shell gives its children.
const PATH = `${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH ?? ''}`

const run = (program: string, args: string[]): Promise<string> =>
  new Promise((resolve) => execFile(program, args, { encoding: 'utf8' }, (_e, stdout) => resolve(stdout ?? '')))

let lastCpu = os.cpus().map((c) => c.times)

/** NativePort for Node: lets the exact runtime the desktop app uses run headless in a terminal. */
export const nodeNative: NativePort = {
  homeDir: HOME,
  tempDir: TEMP,
  fetch: globalThis.fetch,

  exec(program, args, opts = {}) {
    return new Promise((resolve) => {
      const child = execFile(
        program,
        args,
        { cwd: opts.cwd, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, PATH }, signal: opts.signal },
        (error, stdout, stderr) => {
          const code = error ? (typeof (error as NodeJS.ErrnoException).code === 'number' ? Number((error as NodeJS.ErrnoException).code) : (child.exitCode ?? 1)) : 0
          resolve({ code, stdout: stdout ?? '', stderr: stderr || (error && code !== 0 ? error.message : '') })
        },
      )
      if (opts.stdin !== undefined) child.stdin?.end(opts.stdin)
      else child.stdin?.end()
    })
  },

  async spawn(program, args, opts = {}): Promise<ProcessHandle> {
    const child = spawn(program, args, { cwd: opts.cwd, env: { ...process.env, PATH, ...opts.env }, stdio: ['pipe', 'pipe', 'ignore'] })
    const lines = createInterface({ input: child.stdout })
    return {
      write: (data) => new Promise((resolve, reject) => child.stdin.write(data, (e) => (e ? reject(e) : resolve()))),
      onLine: (cb) => void lines.on('line', cb),
      onExit: (cb) => void child.on('exit', cb),
      kill: async () => void child.kill(),
    }
  },

  readTextFile: (path) => readFile(path, 'utf8'),
  writeTextFile: (path, content) => writeFile(path, content),
  readBinaryFile: async (path) => new Uint8Array(await readFile(path)),
  writeBinaryFile: (path, data) => writeFile(path, data),
  removeTemp: async (path) => {
    if (!path.startsWith(TEMP)) throw new Error(`refusing to delete outside temp dir: ${path}`)
    await rm(path, { force: true })
  },
  listDir: async (path) => (await readdir(path, { withFileTypes: true })).map((d) => ({ name: d.name, isDir: d.isDirectory() })),
  exists: (path) => access(path).then(() => true, () => false),
  // macOS's own trash command — recoverable, never unlink. Verified, so a failure is never reported as done.
  trash: async (path) => {
    const out = await nodeNative.exec('/usr/bin/trash', ['--stopOnError', path], { timeoutMs: 15_000 })
    if (out.code !== 0 || (await nodeNative.exists(path))) throw new Error(`Could not move ${path} to the Trash: ${out.stderr.trim() || `exit ${out.code}`}`)
  },

  async systemMetrics(): Promise<SystemMetrics> {
    const now = os.cpus().map((c) => c.times)
    let idle = 0
    let total = 0
    now.forEach((t, i) => {
      const p = lastCpu[i] ?? t
      idle += t.idle - p.idle
      total += t.user + t.nice + t.sys + t.idle + t.irq - (p.user + p.nice + p.sys + p.idle + p.irq)
    })
    lastCpu = now
    const fs = statfsSync('/')
    // vm_stat "anonymous + wired + compressed" approximates what Activity Monitor calls memory used.
    const vm = await run('/usr/bin/vm_stat', [])
    const pages = (key: string) => Number(vm.match(new RegExp(`${key}:\\s+(\\d+)`))?.[1] ?? 0)
    const pageSize = Number(vm.match(/page size of (\d+)/)?.[1] ?? 16384)
    const used = (pages('Anonymous pages') + pages('Pages wired down') + pages('Pages occupied by compressor')) * pageSize
    const swap = await run('/usr/sbin/sysctl', ['-n', 'vm.swapusage'])
    const swapUsedMb = Number(swap.match(/used = ([\d.]+)M/)?.[1] ?? 0)
    return {
      cpuPercent: total ? (1 - idle / total) * 100 : 0,
      memUsedBytes: used || os.totalmem() - os.freemem(),
      memTotalBytes: os.totalmem(),
      swapUsedBytes: swapUsedMb * 1024 * 1024,
      diskUsedBytes: (fs.blocks - fs.bavail) * fs.bsize,
      diskTotalBytes: fs.blocks * fs.bsize,
      battery: null,
      uptimeSec: os.uptime(),
      processCount: 0,
    }
  },
  frontmostApp: async () => null,
  clipboardRead: () => run('/usr/bin/pbpaste', []),
  clipboardWrite: (text) =>
    new Promise((resolve) => {
      const p = spawn('/usr/bin/pbcopy')
      p.on('exit', () => resolve())
      p.stdin.end(text)
    }),
  notify: async (title, body) => void (await run('/usr/bin/osascript', ['-e', `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`])),
  secretGet: async (account) => {
    const out = await run('/usr/bin/security', ['find-generic-password', '-s', 'com.aop.jarvis', '-a', account, '-w'])
    return out.trim() || null
  },
}
