import type { AuditRecord, CostSummary } from '@aop/core'
import { useEffect, useState } from 'react'
import { store, useUi } from '../store'
import { GraphicsDebug } from './GraphicsDebug'
import { clock, useController } from './shared'
import { VoiceLab, VoiceLatency } from './VoiceLab'

const TABS = ['Overview', 'Tasks', 'Tools', 'Memory', 'Cost', 'Voice', 'Voice Lab', 'Graphics', 'Events', 'Logs'] as const
type Tab = (typeof TABS)[number]
const usd = (n: number): string => `$${n.toFixed(n < 1 ? 4 : 2)}`
const pct = (n: number): string => `${Math.round(n * 100)}%`

export function DevPanel() {
  const open = useUi((s) => s.devOpen)
  const [tab, setTab] = useState<Tab>('Overview')
  if (!open) return null
  return (
    <aside className="sheet dev" aria-label="Developer panel">
      <header>
        <h2>Developer</h2>
        <button className="iconbtn" onClick={() => store.set((s) => ({ devOpen: false, uiMode: s.uiMode === 'developer' ? 'standard' : s.uiMode }))}>
          Close
        </button>
      </header>
      <nav>
        {TABS.map((t) => (
          <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>
      <div className="body">
        {tab === 'Overview' && <Overview />}
        {tab === 'Tasks' && <Tasks />}
        {tab === 'Tools' && <Tools />}
        {tab === 'Memory' && <Memory />}
        {tab === 'Cost' && <Cost />}
        {tab === 'Voice' && <VoiceLatency />}
        {tab === 'Voice Lab' && <VoiceLab />}
        {tab === 'Graphics' && <GraphicsDebug />}
        {tab === 'Events' && <Events />}
        {tab === 'Logs' && <Logs />}
      </div>
    </aside>
  )
}

function Overview() {
  const state = useUi((s) => s.runtimeState)
  const voice = useUi((s) => s.voice)
  const executive = useUi((s) => s.executive)
  const context = useUi((s) => s.context)
  const routing = useUi((s) => s.routing)
  const readiness = useUi((s) => s.readiness)
  const usage = useUi((s) => s.usage)
  const last = usage[0]
  return (
    <>
      <div className="stat"><b>{state}</b><span>runtime</span></div>
      <div className="stat"><b>{voice}</b><span>voice</span></div>
      <div className="stat"><b>{executive}</b><span>executive</span></div>
      {last && <div className="stat"><b>{last.latencyMs}ms</b><span>last model latency</span></div>}
      <table>
        <tbody>
          <tr><th>route</th><td>{routing ? `${routing.tier} ${routing.provider}/${routing.model} — ${routing.reason}` : '—'}</td></tr>
          {last && <tr><th>tokens</th><td>{last.inputTokens} in / {last.outputTokens} out · {usd(last.costUsd)}</td></tr>}
          {Object.entries(readiness).map(([k, r]) => (
            <tr key={k}><th>{k}</th><td>{r?.ok ? 'ready' : 'limited'} — {r?.detail}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="note">Context</p>
      <pre>{JSON.stringify(context, null, 2)}</pre>
    </>
  )
}

function Tasks() {
  const tasks = useUi((s) => s.tasks)
  const list = Object.values(tasks).sort((a, b) => b.createdAt - a.createdAt).slice(0, 40)
  return (
    <table>
      <thead><tr><th>agent</th><th>task</th><th>status</th><th>ms</th><th>result</th></tr></thead>
      <tbody>
        {list.map((t) => (
          <tr key={t.id}>
            <td>{t.agent}</td>
            <td title={t.id}>{t.title}{t.dependencies.length ? ` ← ${t.dependencies.length}` : ''}</td>
            <td>{t.status}{t.attempts > 1 ? ` ×${t.attempts}` : ''}</td>
            <td>{t.startedAt && t.completedAt ? t.completedAt - t.startedAt : ''}</td>
            <td>{t.result?.summary.slice(0, 120)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Tools() {
  const c = useController()
  const [audit, setAudit] = useState<AuditRecord[]>([])
  const requests = useUi((s) => s.requests.length)
  useEffect(() => void c.rt.audit.recent(60).then(setAudit), [c, requests])
  return (
    <>
      <p className="note">{c.rt.tools.list().length} tools registered: {c.rt.tools.list().map((t) => `${t.name} (${t.risk})`).join(', ')}</p>
      <table>
        <thead><tr><th>time</th><th>tool</th><th>risk</th><th>approval</th><th>ms</th><th>result</th></tr></thead>
        <tbody>
          {audit.map((a) => (
            <tr key={a.id}>
              <td>{clock(a.ts)}</td>
              <td title={a.inputSummary}>{a.tool}</td>
              <td>{a.risk}</td>
              <td>{a.approval}</td>
              <td>{a.durationMs}</td>
              <td>{a.result.slice(0, 100)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

function Memory() {
  const retrieval = useUi((s) => s.retrieval)
  if (!retrieval) return <p className="note">No retrieval yet. Ask about something you told JARVIS to remember.</p>
  return (
    <>
      <p className="note">Query: {retrieval.query}</p>
      <table>
        <thead><tr><th>score</th><th>memory</th><th>why</th><th>source</th></tr></thead>
        <tbody>
          {retrieval.results.map((r) => (
            <tr key={r.id}>
              <td>{r.score}</td>
              <td>{r.title}</td>
              <td>{Object.entries(r.reasons).map(([k, v]) => `${k} ${v}`).join(', ')}</td>
              <td>{r.source}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

function Cost() {
  const c = useController()
  const [summary, setSummary] = useState<CostSummary | null>(null)
  const usage = useUi((s) => s.usage.length)
  useEffect(() => void c.rt.ledger.summary().then(setSummary), [c, usage])
  if (!summary) return null
  const total = Object.values(summary.tierCounts).reduce((a, b) => a + b, 0) || 1
  return (
    <>
      <div className="stat"><b>{usd(summary.todayUsd)}</b><span>today</span></div>
      <div className="stat"><b>{usd(summary.weekUsd)}</b><span>7 days</span></div>
      <div className="stat"><b>{usd(summary.monthUsd)}</b><span>30 days</span></div>
      <div className="stat"><b>{pct(summary.localRatio)}</b><span>local / native</span></div>
      <div className="stat"><b>{pct(summary.frontierRatio)}</b><span>frontier (L3)</span></div>
      <p className="note">
        Request mix (30 days): L0 {pct(summary.tierCounts.L0 / total)}, L1 {pct(summary.tierCounts.L1 / total)}, L2 {pct(summary.tierCounts.L2 / total)}, L3 {pct(summary.tierCounts.L3 / total)}. Target: 70–85% L0/L1, ≤5% L3.
      </p>
      {(['byModel', 'byAgent', 'byProject'] as const).map((k) => (
        <table key={k} style={{ marginBottom: 14 }}>
          <thead><tr><th>{k.replace('by', '').toLowerCase()}</th><th>calls</th><th>cost</th></tr></thead>
          <tbody>
            {summary[k].map((r) => {
              const name = 'model' in r ? r.model : 'agent' in r ? r.agent : r.project
              return <tr key={name}><td>{name}</td><td>{r.calls}</td><td>{usd(r.usd)}</td></tr>
            })}
          </tbody>
        </table>
      ))}
    </>
  )
}

function Events() {
  const stream = useUi((s) => s.stream)
  return (
    <table>
      <tbody>
        {[...stream].reverse().slice(0, 150).map((e) => (
          <tr key={e.id}><td>{clock(e.ts)}</td><td>{e.name}</td><td>{e.text}</td></tr>
        ))}
      </tbody>
    </table>
  )
}

function Logs() {
  const logs = useUi((s) => s.logs)
  return (
    <table>
      <tbody>
        {[...logs].reverse().slice(0, 150).map((l, i) => (
          <tr key={i}><td>{clock(l.ts)}</td><td>{l.level}</td><td>{l.msg}<br />{Object.keys(l.ctx).length ? JSON.stringify(l.ctx) : ''}</td></tr>
        ))}
      </tbody>
    </table>
  )
}
