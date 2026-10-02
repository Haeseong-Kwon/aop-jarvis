import { JarvisError, errorMessage } from '../errors'
import type { RepoReport } from '../tools/files'
import type { CodingRunResult } from '../providers/types'
import type { AgentResult, Task } from '../types'
import { AgentRun, t, type Agent, type AgentContext } from './base'

const LARGE_FILE_LINES = 800

/** Findings that need no model: they come straight from the repository structure. */
export function heuristicFindings(r: RepoReport): string[] {
  const findings: string[] = []
  for (const f of r.largestFiles.filter((x) => x.lines > LARGE_FILE_LINES)) findings.push(`${f.path} has ${f.lines} lines (over ${LARGE_FILE_LINES}); split by responsibility.`)
  if (!r.hasTests) findings.push('No test files found.')
  if (r.todoCount > 20) findings.push(`${r.todoCount} TODO/FIXME markers.`)
  if (!r.readme) findings.push('No README.')
  if (!r.isGit) findings.push('Not a git repository.')
  return findings
}

export class CodeAgent implements Agent {
  readonly id = 'code' as const
  readonly capabilities = ['inspect-repository', 'search-code', 'edit-code', 'run-commands', 'run-tests', 'git']

  canHandle(task: Task): number {
    return ['inspect_repo', 'fix_code', 'run_tests'].includes(task.type) ? 1 : 0
  }

  async execute(task: Task, ctx: AgentContext): Promise<AgentResult> {
    const run = new AgentRun(task, ctx)
    const path = String(task.input.path ?? ctx.session.activeProjectPath ?? '')
    if (!path) {
      return run.fail(new JarvisError('INVALID_INPUT', t(run.lang, '활성 프로젝트가 없습니다. 설정에서 프로젝트 폴더를 지정하세요.', 'No active project. Set a project folder in Settings → General.')))
    }
    try {
      if (task.type === 'inspect_repo') return await this.inspect(run, path)
      if (task.type === 'run_tests') return await this.tests(run, path)
      return await this.fix(run, path)
    } catch (error) {
      return run.fail(error)
    }
  }

  private async inspect(run: AgentRun, path: string): Promise<AgentResult> {
    const report = await run.tool<RepoReport>('repo.inspect', { path })
    const findings = heuristicFindings(report)
    const reportText = JSON.stringify({ ...report, readme: report.readme.slice(0, 1500) }, null, 1)
    let analysis = ''
    try {
      analysis = await run.think(
        'You are a senior engineer reviewing a repository from a structural report. List the most important concrete problems (architecture, maintainability, testing, tooling) with file paths, most severe first. Be specific and brief. No preamble.',
        `Request: ${String(run.task.input.request ?? 'analyze project')}\nAnswer in ${run.lang === 'ko' ? 'Korean' : 'English'}.\n\nStructural report:\n${reportText}\n\nHeuristic findings:\n${findings.join('\n')}`,
        { complexity: 0.55, coding: true, contextChars: reportText.length },
      )
    } catch (error) {
      run.errors.push(`analysis model unavailable: ${errorMessage(error)}`)
    }
    // The summary must agree with the findings it summarizes (the reviewer checks this).
    const summary = analysis
      ? t(run.lang, `${report.fileCount}개 파일 분석 완료 — 문제점을 정리했습니다`, `Analyzed ${report.fileCount} files — findings below`)
      : t(run.lang, `${report.fileCount}개 파일 구조 검사, 휴리스틱 문제 ${findings.length}건 (모델 분석 없음)`, `Inspected ${report.fileCount} files, ${findings.length} heuristic findings (no model analysis)`)
    return run.done(summary, {
      data: report,
      artifacts: [
        { kind: 'text', title: 'Findings', content: [...findings.map((f) => `- ${f}`), '', analysis].join('\n').trim() },
        { kind: 'json', title: 'Repository report', content: reportText },
      ],
      confidence: analysis ? 0.8 : 0.5,
    })
  }

  private async tests(run: AgentRun, path: string): Promise<AgentResult> {
    const command = String(run.task.input.command ?? 'pnpm test')
    const o = await run.tool<{ code: number; stdout: string; stderr: string }>('shell.run', { command, cwd: path })
    const tail = (o.stdout + o.stderr).split('\n').slice(-40).join('\n')
    return run.done(o.code === 0 ? t(run.lang, '테스트 통과', 'Tests passed') : t(run.lang, '테스트 실패', 'Tests failed'), {
      status: o.code === 0 ? 'success' : 'failed',
      artifacts: [{ kind: 'text', title: command, content: tail }],
      data: { passed: o.code === 0 },
    })
  }

  private async fix(run: AgentRun, path: string): Promise<AgentResult> {
    const decision = run.task.input.decision ? `\n\nApply this previously agreed approach:\n${String(run.task.input.decision)}` : ''
    const prompt = `${String(run.task.input.request)}${decision}\n\nMake the change, keep it minimal, run the project's tests if they exist, and finish with a short summary of what changed.`
    const result = await run.tool<CodingRunResult>('code.agent', { cwd: path, prompt, allowEdits: true })
    await run.recordExternalCost('claude-code', 'claude-code', result.costUsd, 'L3', 'coding agent run')
    const diff = await run.tool<{ stat: string; diff: string }>('git.diff', { cwd: path }).catch((error: unknown) => {
      run.errors.push(`diff unavailable: ${errorMessage(error)}`)
      return { stat: '', diff: '' }
    })
    if (!result.ok) return run.fail(new Error(result.summary || 'coding agent failed'))
    return run.done(diff.stat ? `${t(run.lang, '코드 변경 완료', 'Code change completed')} — ${diff.stat.split('\n').pop()?.trim()}` : t(run.lang, '코딩 에이전트 완료 (변경 없음)', 'Coding agent finished (no changes)'), {
      artifacts: [
        { kind: 'text', title: 'Agent summary', content: result.summary },
        { kind: 'diff', title: 'Diff', content: diff.diff },
      ],
      data: { changed: Boolean(diff.stat) },
    })
  }
}
