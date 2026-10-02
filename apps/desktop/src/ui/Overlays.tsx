import type { Subsystem } from '@aop/core'
import { useEffect, useRef, useState } from 'react'
import { BOOT } from '../orb/params'
import { store, useUi } from '../store'
import { useController } from './shared'

const SUGGESTIONS = ['크롬 켜', '현재 메모리 상태 확인해', '이 프로젝트 구조 분석해서 문제점 찾아', '기억해: ', '5분 타이머', '시스템 상태']

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen)
  const requests = useUi((s) => s.requests)
  const c = useController()
  const [text, setText] = useState('')
  const [index, setIndex] = useState(-1)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (open) {
      setText('')
      setIndex(-1)
      setTimeout(() => input.current?.focus(), 0)
    }
  }, [open])
  if (!open) return null
  const history = requests.map((r) => r.text)
  const items = [...new Set([...history, ...SUGGESTIONS])].filter((s) => !text || s.toLowerCase().includes(text.toLowerCase())).slice(0, 8)
  const close = () => store.set({ paletteOpen: false })
  const run = (value: string) => {
    close()
    void c.submit(value)
  }
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-label="Command">
        <input
          ref={input}
          value={text}
          placeholder="Ask JARVIS or give a command"
          onChange={(e) => {
            setText(e.target.value)
            setIndex(-1)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close()
            if (e.key === 'ArrowDown') setIndex((i) => Math.min(items.length - 1, i + 1))
            if (e.key === 'ArrowUp') setIndex((i) => Math.max(-1, i - 1))
            if (e.key === 'Tab' && items[Math.max(0, index)]) {
              e.preventDefault()
              setText(items[Math.max(0, index)]!)
            }
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              const value = index >= 0 ? items[index] : text
              if (value?.trim()) run(value)
            }
          }}
        />
        {items.length > 0 && (
          <ul role="listbox">
            {items.map((item, i) => (
              <li key={item} role="option" aria-selected={i === index} onMouseEnter={() => setIndex(i)} onMouseDown={() => run(item)}>
                <span>{item}</span>
                <span className="r">{history.includes(item) ? 'Recent' : 'Example'}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

const RISK_COPY: Record<string, string> = {
  HIGH_WRITE: 'This changes files or settings.',
  DELETE: 'This removes data. Files go to the Trash.',
  SEND: 'This sends something outside this Mac.',
  DEPLOY: 'This publishes or deploys.',
  PURCHASE: 'This spends money.',
  PRIVILEGED_SYSTEM: 'This changes system-level settings.',
  LOW_WRITE: 'This makes a small change.',
}

/** Consequences in plain words; nothing hidden behind effects. Enter approves, Escape cancels. */
export function ApprovalPanel() {
  const approval = useUi((s) => s.approvals[0])
  const c = useController()
  useEffect(() => {
    if (!approval) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') c.approve(approval.id, false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [approval, c])
  if (!approval) return null
  return (
    <div className="scrim approval">
      <div className="approval-card" role="alertdialog" aria-labelledby="approval-title" aria-describedby="approval-detail">
        <div className="kicker">AUTHORIZATION REQUIRED</div>
        <h2 id="approval-title">{approval.detail.split(':')[0]}?</h2>
        <p id="approval-detail">{approval.detail}</p>
        <div className="risk">
          {RISK_COPY[approval.risk] ?? ''} Risk: {approval.risk.replace('_', ' ').toLowerCase()} · tool {approval.tool}
        </div>
        <div className="buttons">
          <button className="btn" onClick={() => c.approve(approval.id, false)}>
            Cancel
          </button>
          <button className="btn warn" autoFocus onClick={() => c.approve(approval.id, true)}>
            Approve
          </button>
        </div>
      </div>
    </div>
  )
}

const DIAGNOSTICS: { subsystem: Subsystem; label: string }[] = [
  { subsystem: 'voice', label: 'VOICE ENGINE' },
  { subsystem: 'memory', label: 'MEMORY' },
  { subsystem: 'router', label: 'MODEL ROUTER' },
  { subsystem: 'agents', label: 'AGENT RUNTIME' },
  { subsystem: 'system', label: 'SYSTEM ACCESS' },
]

/** Timeline-driven labels. A line says READY only after its real check reported ok. */
export function BootOverlay() {
  const booting = useUi((s) => s.booting)
  const startedAt = useUi((s) => s.bootStartedAt)
  const readiness = useUi((s) => s.readiness)
  const c = useController()
  const [t, setT] = useState(0)
  const completed = useRef(false)

  useEffect(() => {
    if (!booting || startedAt === null) return
    completed.current = false
    let raf = 0
    const tick = () => {
      setT((performance.now() - startedAt) / 1000)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [booting, startedAt])

  const allReported = DIAGNOSTICS.every((d) => readiness[d.subsystem])
  useEffect(() => {
    if (booting && !completed.current && t >= BOOT.interactive && allReported) {
      completed.current = true
      void c.bootComplete()
    }
  }, [t, booting, allReported, c])

  if (!booting) return null
  return (
    <div className="boot" aria-live="polite">
      {t >= BOOT.online && allReported && <div className="online">AOP SYSTEM ONLINE</div>}
      {t >= BOOT.diagnostics && (
        <div className="diag">
          {DIAGNOSTICS.map((d, i) => {
            if (t < BOOT.diagnostics + i * 0.12) return null
            const r = readiness[d.subsystem]
            return (
              <div key={d.subsystem} title={r?.detail}>
                <span>{d.label}</span>
                {r ? <b className={r.ok ? '' : 'off'}>{r.ok ? 'READY' : 'LIMITED'}</b> : <b className="off">…</b>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
