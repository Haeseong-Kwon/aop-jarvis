import { useEffect, useMemo, useState } from 'react'
import { AGENT_SLOTS, EXTENT, ORBIT_RADIUS } from '../orb/renderer'
import { store, useUi } from '../store'
import { AGENT_LABEL, agentVisuals, clock, gb, STATE_LABEL, useController } from './shared'

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

function useViewport(): { w: number; h: number } {
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight })
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return size
}

export function SystemBar() {
  const state = useUi((s) => s.runtimeState)
  const metrics = useUi((s) => s.metrics)
  const telemetry = useUi((s) => s.config?.orb.telemetry ?? true)
  const micError = useUi((s) => s.micError)
  const now = useNow(1000)
  const c = useController()
  const tone = state === 'ERROR' ? 'error' : state === 'WAITING_APPROVAL' ? 'warn' : 'ok'
  return (
    <header className="sysbar" data-tauri-drag-region>
      <span className="id">AOP JARVIS</span>
      <span className="state" data-tone={tone}>
        <i />
        {STATE_LABEL[state]}
      </span>
      {micError && <span style={{ color: 'var(--amber)' }}>Microphone unavailable — check System Settings › Privacy › Microphone</span>}
      <span className="spacer" />
      {telemetry && metrics && (
        <>
          <span className="metric">
            CPU <b>{metrics.cpuPercent.toFixed(0)}%</b>
          </span>
          <span className="metric">
            Memory <b>{gb(metrics.memUsedBytes)}</b> / {gb(metrics.memTotalBytes)} GB
          </span>
          {metrics.battery && (
            <span className="metric">
              Battery <b>{Math.round(metrics.battery.percent)}%</b>
            </span>
          )}
        </>
      )}
      <span className="metric">{clock(now).slice(0, 5)}</span>
      <span className="actions">
        <button className="iconbtn" onClick={() => store.set({ paletteOpen: true })} title="Command (⌘K)">
          Command
        </button>
        <button className="iconbtn" onClick={() => void c.setMode('ambient')} title="Shrink to the ambient orb">
          Ambient
        </button>
        <button className="iconbtn" onClick={() => store.set((s) => ({ devOpen: !s.devOpen }))} title="Developer panel (⌘⇧D)">
          Developer
        </button>
        <button className="iconbtn" onClick={() => store.set({ settingsOpen: true })} title="Settings (⌘,)">
          Settings
        </button>
      </span>
    </header>
  )
}

/** Labels for real running agents, placed exactly where the renderer draws their nodes. */
export function AgentLabels() {
  const tasks = useUi((s) => s.tasks)
  const now = useNow(250)
  const { w, h } = useViewport()
  const agents = useMemo(() => agentVisuals(tasks, now), [tasks, now])
  const scale = Math.min(w / (2 * EXTENT.x), h / (2 * EXTENT.y))
  return (
    <>
      {agents.map((a) => {
        const angle = AGENT_SLOTS[a.id]
        const below = Math.sin(angle) < 0
        const x = w / 2 + Math.cos(angle) * ORBIT_RADIUS * scale
        const y = h / 2 - Math.sin(angle) * ORBIT_RADIUS * scale + (below ? 34 : -34)
        return (
          <div key={a.id} className="agent-label" data-status={a.status} style={{ left: x, top: y }}>
            <div className="name">{AGENT_LABEL[a.id]}</div>
            <div className="what">{a.status === 'completed' ? 'Done' : a.status === 'failed' ? 'Failed' : a.title}</div>
          </div>
        )
      })}
    </>
  )
}

export function Caption() {
  const transcript = useUi((s) => s.transcript)
  const latest = useUi((s) => s.requests[0])
  const state = useUi((s) => s.runtimeState)
  if (!latest && !transcript) return null
  return (
    <div className="caption" aria-live="polite">
      <div className="heard">{state === 'LISTENING' && !latest?.response ? 'Listening…' : (latest?.text ?? transcript)}</div>
      {latest?.response && <div className="said">{latest.response.length > 220 ? `${latest.response.slice(0, 220)}…` : latest.response}</div>}
    </div>
  )
}

export function ContextPanel() {
  const ctx = useUi((s) => s.context)
  const routing = useUi((s) => s.routing)
  const rows: [string, unknown][] = [
    ['Project', ctx.activeProject],
    ['Branch', ctx.activeBranch],
    ['Active app', ctx.activeApp],
    ['Current task', ctx.currentTask],
    ['Last decision', ctx.lastDecision],
    ['Last route', routing ? `${routing.tier} · ${routing.model}` : null],
  ]
  const visible = rows.filter(([, v]) => v)
  if (!visible.length) return null
  return (
    <section className="panel context" aria-label="Context">
      <h3>Context</h3>
      <dl className="kv">
        {visible.map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt>{k}</dt>
            <dd title={String(v)}>{String(v)}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

export function ExecutionStream() {
  const stream = useUi((s) => s.stream)
  const recent = stream.slice(-9)
  if (!recent.length) return null
  return (
    <section className="panel stream" aria-label="Execution stream">
      <h3>Execution</h3>
      <ol>
        {recent.map((e) => (
          <li key={e.id} data-tone={e.tone}>
            <span className="k">{e.name}</span>
            <span title={e.text}>{e.text}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}

export function ResultCards() {
  const requests = useUi((s) => s.requests)
  const tasks = useUi((s) => s.tasks)
  const selected = useUi((s) => s.selectedRequest)
  const done = requests.filter((r) => r.ok !== null).slice(0, 3)
  if (!done.length) return null
  return (
    <div className="results">
      {done.map((r) => {
        const ts = r.taskIds.map((id) => tasks[id]).filter((t) => t !== undefined)
        const work = ts.filter((t) => t.agent !== 'reviewer')
        const toolCalls = ts.reduce((n, t) => n + (t.result?.toolCalls.length ?? 0), 0)
        const artifacts = ts.flatMap((t) => t.result?.artifacts ?? []).filter((a) => a.kind !== 'json' && a.content.trim())
        const open = selected === r.requestId
        return (
          <button key={r.requestId} className="result" data-ok={String(r.ok)} onClick={() => store.set({ selectedRequest: open ? null : r.requestId })} aria-expanded={open}>
            <div className="title">{work[work.length - 1]?.result?.summary.split('\n')[0] ?? r.response.split('\n')[0]}</div>
            <div className="meta">
              {r.tier} · {work.map((t) => t.agent).join(', ') || 'executive'} · {toolCalls} tool calls
            </div>
            {open && (
              <pre>
                {r.response}
                {artifacts.map((a) => `\n\n${a.title}\n${a.content.slice(0, 6000)}`).join('')}
              </pre>
            )}
          </button>
        )
      })}
    </div>
  )
}
