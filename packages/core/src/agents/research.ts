import type { MemorySearchResult } from '../memory/service'
import type { MemoryType } from '../memory/store'
import type { CodingRunResult } from '../providers/types'
import type { AgentResult, Task } from '../types'
import { AgentRun, t, type Agent, type AgentContext, type Lang } from './base'

export function inferMemoryType(text: string): MemoryType {
  if (/(기로\s*(했|하자|함|결정)|결정|정했|decided|decision|we('| wi)ll use|agreed)/i.test(text)) return 'decision'
  if (/(좋아해|선호|싫어|항상|prefer|always|never|i like)/i.test(text)) return 'preference'
  if (/(해야|할 일|todo|to-do|deadline|마감)/i.test(text)) return 'task'
  return 'semantic'
}

const fmtDate = (ts: number, lang: Lang): string => new Date(ts).toLocaleDateString(lang === 'ko' ? 'ko-KR' : 'en-US')

/** Deterministic, provenance-first answer: what was stored, and where it came from. */
export function answerFromMemory(result: MemorySearchResult, lang: Lang): string {
  const hits = result.local.filter((h) => h.score >= 0.2).slice(0, 3)
  if (!hits.length && !result.external.length) {
    return t(lang, '관련 기억을 찾지 못했습니다.', "I couldn't find anything about that in memory.")
  }
  const lines = hits.map((h) => {
    const src = h.source ? t(lang, `출처: ${h.source.type} "${h.source.title}", ${fmtDate(h.entry.createdAt, lang)}`, `source: ${h.source.type} "${h.source.title}", ${fmtDate(h.entry.createdAt, lang)}`) : ''
    return `${h.entry.content}${src ? ` (${src})` : ''}`
  })
  const notes = result.external.slice(0, 2).map((e) => t(lang, `AOP Note "${e.title}" (${e.where})`, `AOP Note "${e.title}" (${e.where})`))
  return [...lines, ...(notes.length ? [t(lang, `관련 노트: ${notes.join(', ')}`, `Related notes: ${notes.join(', ')}`)] : [])].join('\n')
}

export class ResearchAgent implements Agent {
  readonly id = 'research' as const
  readonly capabilities = ['web-research', 'document-research', 'memory-research', 'source-collection', 'comparison']

  canHandle(task: Task): number {
    return ['memory_research', 'web_research', 'remember'].includes(task.type) ? 1 : 0
  }

  async execute(task: Task, ctx: AgentContext): Promise<AgentResult> {
    const run = new AgentRun(task, ctx)
    const i = task.input
    try {
      if (task.type === 'remember') {
        const content = String(i.content)
        const type = inferMemoryType(content)
        const entry = await run.tool<{ id: string }>('memory.write', {
          type,
          title: content.slice(0, 60),
          content,
          project: (i.project as string | undefined) ?? ctx.session.activeProject,
          importance: type === 'decision' ? 0.8 : 0.6,
          raw: String(i.raw ?? content),
        })
        return run.done(t(run.lang, `기억했습니다 (${type}).`, `Remembered (${type}).`), { data: entry })
      }
      if (task.type === 'memory_research') {
        const result = await run.tool<MemorySearchResult>('memory.search', {
          query: String(i.query),
          project: (i.project as string | undefined) ?? null,
          limit: 5,
        })
        const answer = answerFromMemory(result, run.lang)
        return run.done(answer, {
          data: result,
          artifacts: [{ kind: 'json', title: 'Retrieval diagnostics', content: JSON.stringify(result.diagnostics, null, 1) }],
          confidence: result.local[0]?.score ?? 0,
          ...(result.unavailable.length ? { errors: result.unavailable.map((p) => `${p} unavailable`) } : {}),
        })
      }
      const o = await run.tool<CodingRunResult>('web.research', { question: String(i.question) })
      await run.recordExternalCost('claude-cli', 'claude-sonnet-5-5', o.costUsd, 'L2', 'web research')
      if (!o.ok) return run.fail(new Error(o.summary))
      const sources = (o.summary.match(/https?:\/\/\S+/g) ?? []).length
      return run.done(t(run.lang, `리서치 완료 — 출처 ${sources}개`, `Research completed — ${sources} sources`), {
        artifacts: [{ kind: 'text', title: 'Research', content: o.summary }],
      })
    } catch (error) {
      return run.fail(error)
    }
  }
}
