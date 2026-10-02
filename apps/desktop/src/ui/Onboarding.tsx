import { expandHome, type JarvisConfig } from '@aop/core'
import { useEffect, useState } from 'react'
import { useUi } from '../store'
import { BootSound } from './Settings'
import { useController } from './shared'

interface Check {
  label: string
  ok: boolean | null
  detail: string
  fix?: string
}

/** First run: every line reflects a real probe. Missing pieces get a concrete fix, not a fake checkmark. */
export function Onboarding({ onDone }: { onDone: () => void }) {
  const c = useController()
  const config = useUi((s) => s.config)
  const [draft, setDraft] = useState<JarvisConfig | null>(config)
  const [checks, setChecks] = useState<Check[]>([])
  const [running, setRunning] = useState(false)

  const probe = async () => {
    setRunning(true)
    const rt = c.rt
    const cfg = rt.getConfig()
    const native = rt.native
    let mic: Check
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((t) => t.stop())
      mic = { label: 'Microphone', ok: true, detail: 'Access granted' }
    } catch (error) {
      mic = { label: 'Microphone', ok: false, detail: error instanceof Error ? error.message : String(error), fix: 'System Settings › Privacy & Security › Microphone → allow AOP JARVIS' }
    }
    const whisper = await rt.bin('whisper-cli')
    const modelOk = await native.exists(expandHome(cfg.voice.sttModelPath, native.homeDir))
    const voices = await native.exec('/usr/bin/say', ['-v', '?'], { timeoutMs: 5000 })
    const hasKo = voices.stdout.includes(cfg.voice.ttsVoiceKo)
    const providers = await rt.router.status()
    const live = providers.filter((p) => p.available)
    const memory = await rt.memory.providerStatus()
    const note = memory.find((p) => p.id === 'aop-note')
    const claude = await rt.bin('claude')
    setChecks([
      mic,
      { label: 'Speech recognition', ok: Boolean(whisper), detail: whisper ?? 'whisper.cpp not found', fix: 'Run scripts/setup-voice.sh (installs whisper.cpp with Homebrew)' },
      { label: 'Speech model', ok: modelOk, detail: cfg.voice.sttModelPath, fix: 'scripts/setup-voice.sh downloads ggml-small-q5_1 (~190 MB)' },
      { label: 'Speech output', ok: hasKo, detail: hasKo ? `macOS voices ${cfg.voice.ttsVoiceKo} / ${cfg.voice.ttsVoiceEn}` : `${cfg.voice.ttsVoiceKo} voice missing`, fix: 'System Settings › Accessibility › Spoken Content › System voice › Manage voices' },
      { label: 'Language models', ok: live.length > 0, detail: live.length ? live.map((p) => p.label).join(', ') : 'None reachable — native commands still work', fix: 'Log in to Claude Code (`claude`), start Ollama (`brew install ollama && ollama serve`), or add an API key in Settings › Models' },
      { label: 'Coding agent', ok: Boolean(claude), detail: claude ?? 'claude CLI not found', fix: 'Install Claude Code to let JARVIS edit code' },
      { label: 'AOP Note', ok: note?.available ?? false, detail: note?.available ? 'Connected over MCP' : 'App not found — JARVIS keeps its own memory', fix: `Install AOP Note at ${cfg.memory.aopNote.appPath}` },
    ])
    setRunning(false)
  }

  useEffect(() => void probe(), [])

  const finish = async () => {
    if (!draft) return
    await c.saveConfig({ ...draft, onboarded: true })
    onDone()
  }

  return (
    <div className="onboarding">
      <div className="card">
        <h1>Set up AOP JARVIS</h1>
        <p className="lede">JARVIS runs on this Mac. Speech is recognized and spoken locally; known commands never reach a model. These checks show what is ready now.</p>
        {checks.map((ch) => (
          <div key={ch.label} className="check">
            <span className="dot" data-ok={String(ch.ok)} />
            <span>{ch.label}</span>
            <span>
              <span style={{ color: 'var(--ink-2)' }}>{ch.detail}</span>
              {!ch.ok && ch.fix && (
                <>
                  <br />
                  <code>{ch.fix}</code>
                </>
              )}
            </span>
          </div>
        ))}
        {draft && (
          <>
            <p className="note" style={{ marginTop: 22 }}>Boot sound (optional)</p>
            <BootSound d={draft} set={(fn) => setDraft((d) => (d ? fn(d) : d))} />
          </>
        )}
        <div className="footer">
          <button className="btn" disabled={running} onClick={() => void probe()}>{running ? 'Checking…' : 'Check again'}</button>
          <button className="btn primary" onClick={() => void finish()}>Start JARVIS</button>
        </div>
      </div>
    </div>
  )
}
