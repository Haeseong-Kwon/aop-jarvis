#!/usr/bin/env -S npx tsx
// Headless AOP JARVIS: the same runtime as the desktop app, in a terminal.
//   pnpm jarvis "현재 메모리 상태 확인해"
//   pnpm jarvis --project ~/code/app "이 프로젝트 구조 분석해서 문제점 찾아"
//   pnpm jarvis --status
// Approvals are asked on the terminal (y/N). Shares the desktop app's database unless --db is given.
import { createRuntime, type SqlDriver, type SqlValue } from '@aop/core'
import { mkdirSync } from 'node:fs'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createInterface } from 'node:readline/promises'
import { nodeNative } from './native'

const DEFAULT_DB = join(os.homedir(), 'Library/Application Support/com.aop.jarvis/jarvis.db')

function openDb(path: string): SqlDriver {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path, { timeout: 5000 })
  db.exec('PRAGMA journal_mode = WAL')
  return {
    async execute(sql: string, params: SqlValue[] = []) {
      db.prepare(sql).run(...params)
    },
    async select<T>(sql: string, params: SqlValue[] = []) {
      return db.prepare(sql).all(...params) as T[]
    },
  }
}

function parseArgs(argv: string[]): { db: string; project: string | null; status: boolean; verbose: boolean; text: string } {
  let db = DEFAULT_DB
  let project: string | null = null
  let status = false
  let verbose = false
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--db') db = resolve(argv[++i] ?? DEFAULT_DB)
    else if (a === '--project') project = resolve((argv[++i] ?? '.').replace(/^~/, os.homedir()))
    else if (a === '--status') status = true
    else if (a === '-v' || a === '--verbose') verbose = true
    else rest.push(a)
  }
  return { db, project, status, verbose, text: rest.join(' ').trim() }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const rt = await createRuntime(nodeNative, openDb(args.db))
  if (args.project) {
    const cfg = rt.getConfig()
    await rt.saveConfig({ ...cfg, context: { ...cfg.context, activeProjectPath: args.project } })
  }
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
  rt.bus.on('intent:resolved', (e) => console.error(dim(`intent  ${e.intent} · ${e.tier} · ${Math.round(e.confidence * 100)}%`)))
  rt.bus.on('model:routed', (e) => console.error(dim(`model   ${e.tier} → ${e.provider}/${e.model} (${e.reason})`)))
  rt.bus.on('agent:started', (e) => console.error(dim(`agent   ${e.agent} started`)))
  rt.bus.on('tool:result', (e) => console.error(dim(`tool    ${e.tool} ${e.ok ? 'ok' : 'failed'} ${e.durationMs}ms · ${e.summary.slice(0, 120)}`)))
  rt.bus.on('memory:retrieved', (e) => e.results.length && console.error(dim(`memory  ${e.results.map((r) => `${r.title} (${r.score})`).join(', ')}`)))
  rt.bus.on('model:usage', (u) => console.error(dim(`cost    ${u.model} ${u.inputTokens}→${u.outputTokens} tok $${u.costUsd.toFixed(4)} ${u.latencyMs}ms`)))
  if (args.verbose) rt.bus.on('log', (l) => console.error(dim(`log     ${l.level} ${l.msg}`)))
  rt.bus.on('approval:requested', async (a) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    const answer = await rl.question(`\nAUTHORIZATION REQUIRED — ${a.detail}\nRisk ${a.risk}. Approve? [y/N] `)
    rl.close()
    rt.gate.resolve(a.id, /^y(es)?$/i.test(answer.trim()))
  })

  if (args.status || !args.text) {
    const ready = await rt.checkReadiness()
    for (const [k, r] of Object.entries(ready)) console.log(`${r.ok ? '●' : '○'} ${k.padEnd(7)} ${r.detail}`)
    const s = await rt.ledger.summary()
    console.log(`  cost    today $${s.todayUsd.toFixed(4)} · 30d $${s.monthUsd.toFixed(4)} · L0/L1/L2/L3 ${Object.values(s.tierCounts).join('/')}`)
    if (!args.text) {
      await rt.shutdown()
      return
    }
  }
  await rt.checkReadiness()
  const res = await rt.executive.handle(args.text)
  console.log(res.response)
  for (const task of res.tasks) {
    for (const a of task.result?.artifacts ?? []) if (a.kind !== 'json' && a.content.trim()) console.log(`\n── ${a.title} ──\n${a.content.slice(0, 4000)}`)
  }
  await rt.shutdown()
  process.exitCode = res.ok ? 0 : 1
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
