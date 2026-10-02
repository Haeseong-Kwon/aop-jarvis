import type { SystemMetrics } from '../native'
import { describeMetrics } from '../tools/system'
import type { AgentResult, Task } from '../types'
import { AgentRun, t, type Agent, type AgentContext } from './base'

const GB = 1024 ** 3
const OPERATOR_TYPES = ['launch_app', 'quit_app', 'system_metrics', 'volume', 'media', 'clipboard_read', 'timer', 'trash_path', 'git_status', 'time']

/** macOS operations. Deterministic: every task maps to one or two tool calls, no model. */
export class OperatorAgent implements Agent {
  readonly id = 'operator' as const
  readonly capabilities = ['macos', 'apps', 'files', 'clipboard', 'system-controls', 'media']

  canHandle(task: Task): number {
    return OPERATOR_TYPES.includes(task.type) ? 1 : 0
  }

  async execute(task: Task, ctx: AgentContext): Promise<AgentResult> {
    const run = new AgentRun(task, ctx)
    const { lang } = run
    const i = task.input
    try {
      switch (task.type) {
        case 'launch_app': {
          await run.tool('apps.open', { app: i.app })
          return run.done(t(lang, `${i.app} 실행했습니다.`, `${i.app} is open.`))
        }
        case 'quit_app': {
          await run.tool('apps.quit', { app: i.app })
          return run.done(t(lang, `${i.app} 종료했습니다.`, `Quit ${i.app}.`))
        }
        case 'system_metrics': {
          const m = await run.tool<SystemMetrics>('system.metrics', {})
          return run.done(metricsSentence(m, lang, i.focus === 'memory'), { data: m, artifacts: [{ kind: 'metrics', title: 'System metrics', content: describeMetrics(m) }] })
        }
        case 'volume': {
          const o = await run.tool<{ from: number; to: number }>('system.volume', { level: i.level, delta: i.delta })
          return run.done(t(lang, `볼륨 ${o.to}%로 맞췄습니다.`, `Volume set to ${o.to}%.`))
        }
        case 'media': {
          await run.tool('media.control', { action: i.action })
          return run.done(t(lang, '음악을 제어했습니다.', `Music: ${String(i.action)}.`))
        }
        case 'clipboard_read': {
          const o = await run.tool<{ text: string }>('clipboard.read', {})
          return run.done(t(lang, `클립보드에 ${o.text.length}자가 있습니다.`, `The clipboard holds ${o.text.length} characters.`), {
            artifacts: [{ kind: 'text', title: 'Clipboard', content: o.text.slice(0, 4000) }],
          })
        }
        case 'timer': {
          const seconds = Number(i.seconds)
          await run.tool('timer.set', { seconds, label: i.label ?? 'Timer' })
          return run.done(t(lang, `${humanDuration(seconds, lang)} 타이머를 설정했습니다.`, `Timer set for ${humanDuration(seconds, lang)}.`))
        }
        case 'trash_path': {
          const o = await run.tool<{ trashed: string }>('fs.trash', { path: i.path })
          return run.done(t(lang, `${o.trashed}을(를) 휴지통으로 옮겼습니다.`, `Moved ${o.trashed} to the Trash.`))
        }
        case 'git_status': {
          const o = await run.tool<{ branch: string; changed: string[]; recent: string[] }>('git.status', { cwd: i.cwd })
          return run.done(
            t(lang, `${o.branch} 브랜치, 변경된 파일 ${o.changed.length}개.`, `On ${o.branch}, ${o.changed.length} changed files.`),
            { artifacts: [{ kind: 'text', title: 'git status', content: [...o.changed, '', ...o.recent].join('\n') }] },
          )
        }
        case 'time': {
          const now = new Date()
          return run.done(
            t(lang, `지금은 ${now.toLocaleString('ko-KR', { dateStyle: 'full', timeStyle: 'short' })}입니다.`, `It is ${now.toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' })}.`),
          )
        }
        default:
          return run.fail(new Error(`Operator cannot handle ${task.type}`))
      }
    } catch (error) {
      return run.fail(error)
    }
  }
}

function metricsSentence(m: SystemMetrics, lang: 'ko' | 'en', memoryFocus: boolean): string {
  const used = (m.memUsedBytes / GB).toFixed(1)
  const total = (m.memTotalBytes / GB).toFixed(0)
  const pct = Math.round((m.memUsedBytes / m.memTotalBytes) * 100)
  const swap = (m.swapUsedBytes / GB).toFixed(1)
  const pressureKo = pct > 90 ? '높음' : pct > 75 ? '다소 높음' : '정상'
  const pressureEn = pct > 90 ? 'high' : pct > 75 ? 'elevated' : 'normal'
  if (memoryFocus) {
    return t(lang, `메모리 ${total}GB 중 ${used}GB 사용 중(${pct}%), 압박 ${pressureKo}, 스왑 ${swap}GB.`, `Using ${used} of ${total} GB (${pct}%). Memory pressure ${pressureEn}, swap ${swap} GB.`)
  }
  const battery = m.battery ? t(lang, `, 배터리 ${Math.round(m.battery.percent)}%`, `, battery ${Math.round(m.battery.percent)}%`) : ''
  return t(lang, `CPU ${m.cpuPercent.toFixed(0)}%, 메모리 ${pct}% 사용${battery}. 상태 ${pressureKo}.`, `CPU ${m.cpuPercent.toFixed(0)}%, memory ${pct}%${battery}. Status ${pressureEn}.`)
}

function humanDuration(seconds: number, lang: 'ko' | 'en'): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  if (lang === 'ko') return [m ? `${m}분` : '', s ? `${s}초` : ''].filter(Boolean).join(' ')
  return [m ? `${m} min` : '', s ? `${s} s` : ''].filter(Boolean).join(' ')
}
