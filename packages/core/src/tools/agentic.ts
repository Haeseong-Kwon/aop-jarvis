import { z } from 'zod'
import { JarvisError } from '../errors'
import { expandHome } from '../native'
import { MEMORY_TYPES } from '../memory/store'
import type { MemoryService } from '../memory/service'
import type { ClaudeWebResearcher } from '../providers/llm'
import type { CodingAgentProvider } from '../providers/types'
import { defineTool, type ToolRegistry } from './registry'

export interface AgenticDeps {
  memory: MemoryService
  coding: CodingAgentProvider | null
  web: ClaudeWebResearcher | null
}

export function registerAgenticTools(registry: ToolRegistry, deps: AgenticDeps): void {
  registry.register(
    defineTool({
      name: 'memory.search',
      description: 'Hybrid search over JARVIS memory and AOP Note, with provenance.',
      input: z.object({ query: z.string().min(1).max(500), project: z.string().max(100).nullable().optional(), types: z.array(z.enum(MEMORY_TYPES)).optional(), limit: z.number().int().min(1).max(20).optional() }),
      risk: 'READ',
      describe: (i) => `Search memory: "${i.query}"${i.project ? ` in ${i.project}` : ''}`,
      execute: (i, ctx) =>
        deps.memory.search({
          query: i.query,
          requestId: ctx.requestId,
          ...(i.project ? { project: i.project } : {}),
          ...(i.types ? { types: i.types } : {}),
          ...(i.limit ? { limit: i.limit } : {}),
        }),
      summarize: (o) => `${o.local.length} memories, ${o.external.length} notes${o.unavailable.length ? ` (unavailable: ${o.unavailable.join(', ')})` : ''}`,
    }),
  )

  registry.register(
    defineTool({
      name: 'memory.write',
      description: 'Store a structured memory; the raw text is kept as its source.',
      input: z.object({
        type: z.enum(MEMORY_TYPES),
        title: z.string().min(1).max(200),
        content: z.string().min(1).max(10_000),
        project: z.string().max(100).nullable().optional(),
        entities: z.array(z.string().max(80)).max(20).optional(),
        importance: z.number().min(0).max(1).optional(),
        raw: z.string().max(20_000),
      }),
      risk: 'LOW_WRITE',
      describe: (i) => `Remember (${i.type}): ${i.title}`,
      execute: (i) =>
        deps.memory.write({
          type: i.type,
          title: i.title,
          content: i.content,
          projectId: i.project ?? null,
          entities: i.entities ?? [],
          ...(i.importance !== undefined ? { importance: i.importance } : {}),
          rawSource: { type: 'conversation', title: i.title, content: i.raw },
        }),
      summarize: (o) => `stored ${o.id}`,
    }),
  )

  registry.register(
    defineTool({
      name: 'code.agent',
      description: 'Delegate a repository task to the external coding agent (Claude Code), run in the repo directory.',
      input: z.object({ cwd: z.string().min(1).max(1024), prompt: z.string().min(1).max(20_000), allowEdits: z.boolean() }),
      risk: (i) => (i.allowEdits ? 'HIGH_WRITE' : 'READ'),
      describe: (i) => `${i.allowEdits ? 'Let the coding agent EDIT files in' : 'Let the coding agent read'} ${i.cwd}: ${i.prompt.slice(0, 160)}`,
      execute: async (i, ctx) => {
        if (!deps.coding) throw new JarvisError('NOT_CONFIGURED', 'No coding agent configured (Settings → Integrations)')
        return deps.coding.run({ cwd: expandHome(i.cwd, ctx.native.homeDir), prompt: i.prompt, allowEdits: i.allowEdits, ...(ctx.signal ? { signal: ctx.signal } : {}) })
      },
      summarize: (o) => `${o.ok ? 'ok' : 'failed'}${o.costUsd !== null ? ` $${o.costUsd.toFixed(3)}` : ''}`,
    }),
  )

  registry.register(
    defineTool({
      name: 'web.research',
      description: 'Research a question on the web and return a sourced summary.',
      input: z.object({ question: z.string().min(1).max(2000) }),
      risk: 'READ',
      describe: (i) => `Web research: ${i.question.slice(0, 160)}`,
      execute: async (i, ctx) => {
        if (!deps.web) throw new JarvisError('NOT_CONFIGURED', 'No web research provider configured')
        return deps.web.research(i.question, ctx.signal)
      },
      summarize: (o) => `${o.ok ? 'ok' : 'failed'}${o.costUsd !== null ? ` $${o.costUsd.toFixed(3)}` : ''}`,
    }),
  )
}
