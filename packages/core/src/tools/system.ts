import { z } from 'zod'
import { JarvisError } from '../errors'
import type { NativePort, SystemMetrics } from '../native'
import { defineTool, type ToolRegistry } from './registry'

const GB = 1024 ** 3
const fmtGb = (b: number): string => `${(b / GB).toFixed(1)} GB`
// App names go into AppleScript string literals; refuse anything that could break out of one.
const appName = z.string().min(1).max(80).regex(/^[^"\\\n]+$/, 'invalid application name')

async function osascript(native: NativePort, script: string): Promise<string> {
  const out = await native.exec('/usr/bin/osascript', ['-e', script], { timeoutMs: 10_000 })
  if (out.code !== 0) throw new JarvisError('TASK_EXECUTION_FAILED', out.stderr.trim() || 'osascript failed')
  return out.stdout.trim()
}

export function describeMetrics(m: SystemMetrics): string {
  const memPct = Math.round((m.memUsedBytes / m.memTotalBytes) * 100)
  const pressure = memPct > 90 || m.swapUsedBytes > 4 * GB ? 'high' : memPct > 75 ? 'elevated' : 'normal'
  return `Memory ${fmtGb(m.memUsedBytes)} / ${fmtGb(m.memTotalBytes)} (${memPct}%), pressure ${pressure}, swap ${fmtGb(m.swapUsedBytes)}. CPU ${m.cpuPercent.toFixed(0)}%.`
}

export function registerSystemTools(registry: ToolRegistry, timers: Map<string, ReturnType<typeof setTimeout>>): void {
  registry.register(
    defineTool({
      name: 'apps.open',
      description: 'Launch or focus a macOS application by name.',
      input: z.object({ app: appName }),
      risk: 'LOW_WRITE',
      describe: (i) => `Open ${i.app}`,
      execute: async (i, ctx) => {
        const out = await ctx.native.exec('/usr/bin/open', ['-a', i.app], { timeoutMs: 10_000 })
        if (out.code !== 0) throw new JarvisError('TASK_EXECUTION_FAILED', `Unable to find application "${i.app}"`)
        return { opened: i.app }
      },
      summarize: (o) => `opened ${o.opened}`,
    }),
  )

  registry.register(
    defineTool({
      name: 'apps.quit',
      description: 'Quit a running macOS application (it may prompt to save).',
      input: z.object({ app: appName }),
      risk: 'LOW_WRITE',
      describe: (i) => `Quit ${i.app} (unsaved work prompts in the app)`,
      execute: async (i, ctx) => {
        await osascript(ctx.native, `quit app "${i.app}"`)
        return { quit: i.app }
      },
    }),
  )

  registry.register(
    defineTool({
      name: 'system.metrics',
      description: 'Read CPU, memory, swap, disk, battery and process count.',
      input: z.object({}),
      risk: 'READ',
      describe: () => 'Read system metrics',
      execute: (_i, ctx) => ctx.native.systemMetrics(),
      summarize: describeMetrics,
    }),
  )

  registry.register(
    defineTool({
      name: 'system.volume',
      description: 'Set output volume (0–100) or change it by a delta.',
      input: z.object({ level: z.number().min(0).max(100).optional(), delta: z.number().min(-100).max(100).optional() }),
      risk: 'LOW_WRITE',
      describe: (i) => (i.level !== undefined ? `Set volume to ${i.level}%` : `Change volume by ${i.delta}%`),
      execute: async (i, ctx) => {
        const current = Number(await osascript(ctx.native, 'output volume of (get volume settings)'))
        const target = Math.round(Math.max(0, Math.min(100, i.level ?? current + (i.delta ?? 0))))
        await osascript(ctx.native, `set volume output volume ${target}`)
        return { from: current, to: target }
      },
      summarize: (o) => `volume ${o.from}% → ${o.to}%`,
    }),
  )

  registry.register(
    defineTool({
      name: 'media.control',
      description: 'Control Music.app playback.',
      input: z.object({ action: z.enum(['play', 'pause', 'next', 'previous']) }),
      risk: 'LOW_WRITE',
      describe: (i) => `Music: ${i.action}`,
      execute: async (i, ctx) => {
        const verb = { play: 'play', pause: 'pause', next: 'next track', previous: 'previous track' }[i.action]
        await osascript(ctx.native, `tell application "Music" to ${verb}`)
        return { action: i.action }
      },
    }),
  )

  registry.register(
    defineTool({
      name: 'clipboard.read',
      description: 'Read the current clipboard text.',
      input: z.object({}),
      risk: 'READ',
      describe: () => 'Read clipboard',
      execute: async (_i, ctx) => ({ text: await ctx.native.clipboardRead() }),
      summarize: (o) => `${o.text.length} chars`,
    }),
  )

  registry.register(
    defineTool({
      name: 'clipboard.write',
      description: 'Replace the clipboard text.',
      input: z.object({ text: z.string().max(100_000) }),
      risk: 'LOW_WRITE',
      describe: (i) => `Copy ${i.text.length} characters to the clipboard`,
      execute: async (i, ctx) => {
        await ctx.native.clipboardWrite(i.text)
        return { chars: i.text.length }
      },
    }),
  )

  registry.register(
    defineTool({
      name: 'notify',
      description: 'Show a native macOS notification.',
      input: z.object({ title: z.string().max(120), body: z.string().max(400) }),
      risk: 'LOW_WRITE',
      describe: (i) => `Notify: ${i.title}`,
      execute: async (i, ctx) => {
        await ctx.native.notify(i.title, i.body)
        return { shown: true }
      },
    }),
  )

  registry.register(
    defineTool({
      name: 'timer.set',
      description: 'Notify after a duration.',
      input: z.object({ seconds: z.number().int().min(1).max(86_400), label: z.string().max(80).default('Timer') }),
      risk: 'LOW_WRITE',
      describe: (i) => `Set a ${i.seconds}s timer (${i.label})`,
      execute: async (i, ctx) => {
        const id = `timer_${Date.now()}`
        timers.set(
          id,
          setTimeout(() => {
            timers.delete(id)
            void ctx.native.notify('AOP JARVIS', `${i.label} — time is up`)
          }, i.seconds * 1000),
        )
        return { id, firesAt: Date.now() + i.seconds * 1000 }
      },
      summarize: (o) => `fires at ${new Date(o.firesAt).toLocaleTimeString()}`,
    }),
  )
}
