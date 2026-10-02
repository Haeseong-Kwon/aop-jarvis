import { z } from 'zod'
import { JarvisError } from '../errors'
import { expandHome, type NativePort } from '../native'
import type { RiskLevel } from '../types'
import { defineTool, type ToolRegistry } from './registry'

const MAX_READ_CHARS = 200_000
const SHELL_TIMEOUT_MS = 60_000
const MAX_OUTPUT_CHARS = 20_000
const path = z.string().min(1).max(1024)

const READ_ONLY_COMMANDS = new Set(['ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'du', 'df', 'ps', 'uname', 'which', 'echo', 'date', 'whoami', 'uptime', 'sw_vers', 'grep', 'rg', 'find', 'tree', 'file', 'stat', 'vm_stat', 'top', 'printenv', 'env'])
const TEST_COMMAND = /^((npm|pnpm|yarn|bun)\s+(run\s+)?(test|typecheck|lint|check)|cargo\s+(test|check|clippy)|pytest|go\s+(test|vet)|mise\s+run\s+(test|check|lint|typecheck))\b/
const READ_ONLY_GIT =/^git\s+(status|log|diff|show|branch|remote -v|rev-parse|ls-files|blame)\b/

/** Classify a shell command by its most dangerous component. Unknown → HIGH_WRITE (needs approval by default). */
export function shellRisk(command: string): RiskLevel {
  const cmd = command.trim()
  if (/\bsudo\b|\bchmod\s+[0-7]*7[0-7]*\s+\/|\bchown\b|\blaunchctl\b|\bdefaults\s+write\b|\bcsrutil\b|\bnvram\b/.test(cmd)) return 'PRIVILEGED_SYSTEM'
  if (/\b(rm|rmdir|unlink|shred)\b|\bfind\b.*\s-delete\b|\bgit\s+(clean|reset\s+--hard|push\s+.*--force)/.test(cmd)) return 'DELETE'
  if (/\b(vercel|netlify|fly|kubectl|terraform\s+apply)\b|\bgit\s+push\b|\bnpm\s+publish\b|\bdeploy\b/.test(cmd)) return 'DEPLOY'
  if (/\b(curl|wget)\b.*\|\s*(sh|bash|zsh)|\b(mail|sendmail)\b/.test(cmd)) return 'SEND'
  // Every segment of a pipeline / list must be read-only, and no redirection into files.
  if (/(^|[^>])>{1,2}(?!&)/.test(cmd)) return 'HIGH_WRITE'
  const segments = cmd.split(/\|\||&&|[|;]/).map((s) => s.trim()).filter(Boolean)
  const readOnly = segments.every((s) => READ_ONLY_GIT.test(s) || READ_ONLY_COMMANDS.has(s.split(/\s+/)[0] ?? ''))
  if (readOnly) return 'READ'
  // Test/lint/typecheck runs execute project code but only write caches.
  if (segments.every((s) => TEST_COMMAND.test(s) || READ_ONLY_COMMANDS.has(s.split(/\s+/)[0] ?? ''))) return 'LOW_WRITE'
  return 'HIGH_WRITE'
}

async function git(native: NativePort, cwd: string, args: string[]): Promise<string> {
  const out = await native.exec('/usr/bin/git', ['-C', expandHome(cwd, native.homeDir), ...args], { timeoutMs: 15_000 })
  if (out.code !== 0) throw new JarvisError('TASK_EXECUTION_FAILED', out.stderr.trim() || `git ${args[0]} failed`)
  return out.stdout
}

export interface RepoReport {
  root: string
  isGit: boolean
  branch: string | null
  fileCount: number
  byExtension: Record<string, number>
  manifests: Record<string, string>
  largestFiles: { path: string; lines: number }[]
  todoCount: number
  hasTests: boolean
  readme: string
}

const MANIFESTS = ['package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod', 'tsconfig.json', 'pnpm-workspace.yaml', 'CLAUDE.md']
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|py|rs|go|swift|java|kt|rb|php|cs|vue|svelte)$/

export async function inspectRepo(native: NativePort, rootRaw: string): Promise<RepoReport> {
  const root = expandHome(rootRaw, native.homeDir)
  if (!(await native.exists(root))) throw new JarvisError('INVALID_INPUT', `Path not found: ${root}`)
  let files: string[]
  let isGit = true
  let branch: string | null = null
  try {
    files = (await git(native, root, ['ls-files'])).split('\n').filter(Boolean)
    branch = (await git(native, root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  } catch {
    isGit = false
    const out = await native.exec('/usr/bin/find', [root, '-type', 'f', '-not', '-path', '*/node_modules/*', '-not', '-path', '*/.git/*', '-not', '-path', '*/target/*', '-not', '-path', '*/dist/*'], { timeoutMs: 20_000 })
    files = out.stdout.split('\n').filter(Boolean).map((f) => f.slice(root.length + 1)).slice(0, 20_000)
  }
  const byExtension: Record<string, number> = {}
  for (const f of files) {
    const ext = f.includes('.') ? f.slice(f.lastIndexOf('.')) : '(none)'
    byExtension[ext] = (byExtension[ext] ?? 0) + 1
  }
  const manifests: Record<string, string> = {}
  for (const m of MANIFESTS) {
    if (files.includes(m)) manifests[m] = (await native.readTextFile(`${root}/${m}`)).slice(0, 3000)
  }
  const sources = files.filter((f) => SOURCE_EXT.test(f)).slice(0, 400)
  const sized: { path: string; lines: number }[] = []
  let todoCount = 0
  for (const f of sources) {
    try {
      const text = await native.readTextFile(`${root}/${f}`)
      sized.push({ path: f, lines: text.split('\n').length })
      todoCount += (text.match(/\b(TODO|FIXME|HACK|XXX)\b/g) ?? []).length
    } catch {
      /* unreadable file (binary/permissions): skip */
    }
  }
  const readmeFile = files.find((f) => /^readme\.md$/i.test(f))
  return {
    root,
    isGit,
    branch,
    fileCount: files.length,
    byExtension: Object.fromEntries(Object.entries(byExtension).sort((a, b) => b[1] - a[1]).slice(0, 15)),
    manifests,
    largestFiles: sized.sort((a, b) => b.lines - a.lines).slice(0, 10),
    todoCount,
    hasTests: files.some((f) => /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[a-z]+$/.test(f)),
    readme: readmeFile ? (await native.readTextFile(`${root}/${readmeFile}`)).slice(0, 2000) : '',
  }
}

export function registerFileTools(registry: ToolRegistry): void {
  registry.register(
    defineTool({
      name: 'fs.list',
      description: 'List a directory.',
      input: z.object({ path }),
      risk: 'READ',
      describe: (i) => `List ${i.path}`,
      execute: (i, ctx) => ctx.native.listDir(expandHome(i.path, ctx.native.homeDir)),
      summarize: (o) => `${o.length} entries`,
    }),
  )

  registry.register(
    defineTool({
      name: 'fs.read',
      description: 'Read a UTF-8 text file (truncated at 200k chars).',
      input: z.object({ path }),
      risk: 'READ',
      describe: (i) => `Read ${i.path}`,
      execute: async (i, ctx) => {
        const text = await ctx.native.readTextFile(expandHome(i.path, ctx.native.homeDir))
        return { text: text.slice(0, MAX_READ_CHARS), truncated: text.length > MAX_READ_CHARS }
      },
      summarize: (o) => `${o.text.length} chars${o.truncated ? ' (truncated)' : ''}`,
    }),
  )

  registry.register(
    defineTool({
      name: 'fs.write',
      description: 'Write a text file, replacing any existing content.',
      input: z.object({ path, content: z.string().max(1_000_000) }),
      risk: 'HIGH_WRITE',
      describe: (i) => `Write ${i.content.length} characters to ${i.path} (replaces existing content)`,
      execute: async (i, ctx) => {
        await ctx.native.writeTextFile(expandHome(i.path, ctx.native.homeDir), i.content)
        return { written: i.path }
      },
    }),
  )

  registry.register(
    defineTool({
      name: 'fs.trash',
      description: 'Move a file or folder to the Trash.',
      input: z.object({ path }),
      risk: 'DELETE',
      describe: (i) => `Move ${i.path} to the Trash`,
      execute: async (i, ctx) => {
        const target = expandHome(i.path, ctx.native.homeDir)
        if (target === ctx.native.homeDir || target === '/' || target.split('/').filter(Boolean).length < 3) {
          throw new JarvisError('INVALID_INPUT', `Refusing to trash a top-level path: ${target}`)
        }
        if (!(await ctx.native.exists(target))) throw new JarvisError('INVALID_INPUT', `Not found: ${target}`)
        await ctx.native.trash(target)
        return { trashed: target }
      },
    }),
  )

  registry.register(
    defineTool({
      name: 'shell.run',
      description: 'Run a zsh command. Risk is classified from the command itself.',
      input: z.object({ command: z.string().min(1).max(4000), cwd: path.optional() }),
      risk: (i) => shellRisk(i.command),
      describe: (i) => `Run in ${i.cwd ?? '~'}: ${i.command}`,
      execute: async (i, ctx) => {
        const out = await ctx.native.exec('/bin/zsh', ['-lc', i.command], {
          cwd: expandHome(i.cwd ?? '~', ctx.native.homeDir),
          timeoutMs: SHELL_TIMEOUT_MS,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        })
        return { code: out.code, stdout: out.stdout.slice(0, MAX_OUTPUT_CHARS), stderr: out.stderr.slice(0, MAX_OUTPUT_CHARS) }
      },
      summarize: (o) => `exit ${o.code}`,
    }),
  )

  registry.register(
    defineTool({
      name: 'git.status',
      description: 'Branch, changed files and recent commits of a repository.',
      input: z.object({ cwd: path }),
      risk: 'READ',
      describe: (i) => `git status in ${i.cwd}`,
      execute: async (i, ctx) => {
        const [branch, status, log] = await Promise.all([
          git(ctx.native, i.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
          git(ctx.native, i.cwd, ['status', '--porcelain']),
          git(ctx.native, i.cwd, ['log', '--oneline', '-5']),
        ])
        return { branch: branch.trim(), changed: status.split('\n').filter(Boolean), recent: log.split('\n').filter(Boolean) }
      },
      summarize: (o) => `${o.branch}, ${o.changed.length} changed`,
    }),
  )

  registry.register(
    defineTool({
      name: 'git.diff',
      description: 'Working-tree diff of a repository (truncated).',
      input: z.object({ cwd: path }),
      risk: 'READ',
      describe: (i) => `git diff in ${i.cwd}`,
      execute: async (i, ctx) => {
        const [stat, diff] = await Promise.all([git(ctx.native, i.cwd, ['diff', '--stat']), git(ctx.native, i.cwd, ['diff'])])
        return { stat: stat.trim(), diff: diff.slice(0, MAX_OUTPUT_CHARS) }
      },
      summarize: (o) => o.stat.split('\n').pop() ?? 'no changes',
    }),
  )

  registry.register(
    defineTool({
      name: 'repo.inspect',
      description: 'Structural report of a repository: languages, manifests, largest files, TODOs, tests, README.',
      input: z.object({ path }),
      risk: 'READ',
      describe: (i) => `Inspect repository ${i.path}`,
      execute: (i, ctx) => inspectRepo(ctx.native, i.path),
      summarize: (o) => `${o.fileCount} files, ${o.todoCount} TODOs, tests: ${o.hasTests ? 'yes' : 'no'}`,
    }),
  )
}
