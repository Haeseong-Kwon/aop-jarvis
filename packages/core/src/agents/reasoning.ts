import { JarvisError } from '../errors'
import type { AgentResult, Task, Tier } from '../types'
import { AgentRun, depResults, depText, t, type Agent, type AgentContext } from './base'

const langName = (lang: string): string => (lang === 'ko' ? 'Korean' : 'English')

/** Structured reasoning, comparison, calculation and synthesis over upstream results. */
export class AnalystAgent implements Agent {
  readonly id = 'analyst' as const
  readonly capabilities = ['structured-reasoning', 'data-comparison', 'calculations', 'synthesis', 'business-analysis']

  canHandle(task: Task): number {
    return ['analyze', 'synthesize'].includes(task.type) ? 1 : 0
  }

  async execute(task: Task, ctx: AgentContext): Promise<AgentResult> {
    const run = new AgentRun(task, ctx)
    try {
      const upstream = depText(ctx)
      const text = await run.think(
        'You are an analyst. Reason step by step internally, then output only the conclusion: key findings, then concrete recommendations. Use short headings and bullet points.',
        `Task: ${String(task.input.request)}\nAnswer in ${langName(run.lang)}.${upstream ? `\n\nInputs from other agents:\n${upstream}` : ''}`,
        { complexity: Number(task.input.complexity ?? 0.6), contextChars: upstream.length },
      )
      return run.done(t(run.lang, '분석 완료', 'Analysis completed'), { artifacts: [{ kind: 'text', title: 'Analysis', content: text }] })
    } catch (error) {
      return run.fail(error)
    }
  }
}

/** Human-readable output: conversational replies, drafts, reports. */
export class CommunicatorAgent implements Agent {
  readonly id = 'communicator' as const
  readonly capabilities = ['draft-email', 'draft-messages', 'documents', 'structured-reports', 'conversation']

  canHandle(task: Task): number {
    return ['respond', 'draft'].includes(task.type) ? 1 : 0
  }

  async execute(task: Task, ctx: AgentContext): Promise<AgentResult> {
    const run = new AgentRun(task, ctx)
    try {
      const memory = String(task.input.memoryContext ?? '')
      const history = String(task.input.history ?? '')
      if (task.type === 'respond') {
        const text = await run.think(
          `You are JARVIS, a calm, precise personal assistant running on the user's Mac. Reply in ${langName(run.lang)} in at most three short sentences suitable for speech. Do not invent facts about the user; use the provided memory only.`,
          [history && `Recent conversation:\n${history}`, memory && `Relevant memory:\n${memory}`, `User: ${String(task.input.request)}`].filter(Boolean).join('\n\n'),
          { complexity: Number(task.input.complexity ?? 0.2), latencySensitive: true },
          task.input.tier as Tier | undefined,
        )
        return run.done(text.trim())
      }
      const text = await run.think(
        `You write clear, well-structured documents in ${langName(run.lang)}. Output only the draft.`,
        `Request: ${String(task.input.request)}${memory ? `\n\nRelevant memory:\n${memory}` : ''}${depText(ctx) ? `\n\nMaterial:\n${depText(ctx)}` : ''}`,
        { complexity: 0.5 },
      )
      return run.done(t(run.lang, '초안 작성 완료', 'Draft ready'), { artifacts: [{ kind: 'text', title: 'Draft', content: text }] })
    } catch (error) {
      return run.fail(error)
    }
  }
}

/** Verifies upstream work: failures, empty output, failing tests, and (when a model is available) contradictions. */
export class ReviewerAgent implements Agent {
  readonly id = 'reviewer' as const
  readonly capabilities = ['verify-result', 'check-contradictions', 'test-execution', 'check-constraints', 'detect-incomplete-work']

  canHandle(task: Task): number {
    return task.type === 'review' ? 1 : 0
  }

  async execute(task: Task, ctx: AgentContext): Promise<AgentResult> {
    const run = new AgentRun(task, ctx)
    const upstream = depResults(ctx)
    const issues: string[] = []
    for (const r of upstream) {
      if (r.status === 'failed') issues.push(`upstream failed: ${r.summary}`)
      if (r.status !== 'failed' && !r.artifacts.some((a) => a.content.trim()) && !r.summary.trim()) issues.push('upstream produced no output')
      issues.push(...r.errors.map((e) => `upstream error: ${e}`))
    }
    try {
      if (task.input.runTests && ctx.session.activeProjectPath) {
        const o = await run.tool<{ code: number; stdout: string; stderr: string }>('shell.run', { command: String(task.input.testCommand ?? 'pnpm test'), cwd: ctx.session.activeProjectPath })
        if (o.code !== 0) issues.push(`tests failed (exit ${o.code}): ${(o.stdout + o.stderr).split('\n').slice(-5).join(' ')}`)
      }
      const content = depText(ctx)
      if (content.length > 200 && upstream.every((r) => r.status !== 'failed')) {
        const verdict = await run.think(
          'You are a strict reviewer. Check the work against the request: missing parts, contradictions, unsupported claims, unmet constraints. Reply "OK" if acceptable, otherwise a short bullet list of concrete issues.',
          `Request: ${String(task.input.request)}\n\nWork:\n${content.slice(0, 30_000)}`,
          { complexity: 0.4, contextChars: content.length },
        )
        if (!/^\s*ok\b/i.test(verdict)) issues.push(...verdict.split('\n').map((l) => l.replace(/^[-*]\s*/, '').trim()).filter(Boolean))
      }
    } catch (error) {
      if (error instanceof JarvisError && error.code === 'CANCELLED') throw error
      run.errors.push(`review incomplete: ${error instanceof Error ? error.message : String(error)}`)
    }
    const passed = issues.length === 0
    return run.done(passed ? t(run.lang, '검토 통과', 'Review passed') : t(run.lang, `검토: 이슈 ${issues.length}건`, `Review: ${issues.length} issues`), {
      status: passed ? (run.errors.length ? 'partial' : 'success') : 'partial',
      artifacts: issues.length ? [{ kind: 'text', title: 'Review issues', content: issues.map((i) => `- ${i}`).join('\n') }] : [],
      confidence: passed ? 0.85 : 0.5,
      data: { passed, issues },
    })
  }
}
