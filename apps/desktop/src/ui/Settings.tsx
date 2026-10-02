import { RISK_LEVELS, type JarvisConfig, type MemoryEntry } from '@aop/core'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { useEffect, useState, type ReactNode } from 'react'
import { Microphone } from '../audio/mic'
import { secretExists, secretSet } from '../host/native'
import { store, useUi } from '../store'
import { useController } from './shared'

const TABS = ['General', 'Appearance', 'Voice', 'Models', 'Routing', 'Agents', 'Memory', 'Permissions', 'Integrations', 'System', 'Developer'] as const
type Tab = (typeof TABS)[number]

type Set = (fn: (c: JarvisConfig) => JarvisConfig) => void

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label>
        {label}
        {hint && <small>{hint}</small>}
      </label>
      <div>{children}</div>
    </div>
  )
}

const Toggle = ({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) => <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
const Text = ({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) => (
  <input type="text" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
)
const Num = ({ value, onChange, step = 1 }: { value: number; onChange: (v: number) => void; step?: number }) => (
  <input type="number" value={value} step={step} onChange={(e) => Number.isFinite(e.target.valueAsNumber) && onChange(e.target.valueAsNumber)} />
)

export function Settings() {
  const open = useUi((s) => s.settingsOpen)
  const config = useUi((s) => s.config)
  const c = useController()
  const [tab, setTab] = useState<Tab>('General')
  const [draft, setDraft] = useState<JarvisConfig | null>(config)
  const [status, setStatus] = useState('')
  useEffect(() => setDraft(config), [config, open])
  if (!open || !draft) return null
  const set: Set = (fn) => setDraft((d) => (d ? fn(d) : d))
  const dirty = JSON.stringify(draft) !== JSON.stringify(config)
  const save = async () => {
    try {
      await c.saveConfig(draft)
      setStatus('Saved')
    } catch (error) {
      setStatus(`Not saved: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return (
    <aside className="sheet" aria-label="Settings">
      <header>
        <h2>Settings</h2>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="note" style={{ margin: 0 }}>{status}</span>
          <button className="btn primary" disabled={!dirty} onClick={() => void save()}>Save changes</button>
          <button className="iconbtn" onClick={() => store.set({ settingsOpen: false })}>Close</button>
        </span>
      </header>
      <nav>
        {TABS.map((t) => (
          <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>{t}</button>
        ))}
      </nav>
      <div className="body">
        {tab === 'General' && <General d={draft} set={set} />}
        {tab === 'Appearance' && <Appearance d={draft} set={set} />}
        {tab === 'Voice' && <Voice d={draft} set={set} />}
        {tab === 'Models' && <Models d={draft} set={set} />}
        {tab === 'Routing' && <Routing d={draft} set={set} />}
        {tab === 'Agents' && <Agents />}
        {tab === 'Memory' && <MemoryTab d={draft} set={set} />}
        {tab === 'Permissions' && <Permissions d={draft} set={set} />}
        {tab === 'Integrations' && <Integrations d={draft} set={set} />}
        {tab === 'System' && <SystemTab d={draft} set={set} />}
        {tab === 'Developer' && <Developer d={draft} set={set} />}
      </div>
    </aside>
  )
}

type P = { d: JarvisConfig; set: Set }

function General({ d, set }: P) {
  const pick = async () => {
    const dir = await openDialog({ directory: true, title: 'Choose the project JARVIS works on' })
    if (typeof dir === 'string') set((c) => ({ ...c, context: { ...c.context, activeProjectPath: dir } }))
  }
  return (
    <>
      <Field label="Active project" hint="Where code commands run">
        <div style={{ display: 'flex', gap: 6 }}>
          <Text value={d.context.activeProjectPath} placeholder="/Users/you/code/project" onChange={(v) => set((c) => ({ ...c, context: { ...c.context, activeProjectPath: v } }))} />
          <button className="btn" onClick={() => void pick()}>Choose…</button>
        </div>
      </Field>
      <Field label="Summon hotkey" hint="Shows JARVIS and starts listening">
        <Text value={d.hotkey} onChange={(v) => set((c) => ({ ...c, hotkey: v }))} />
      </Field>
    </>
  )
}

function Appearance({ d, set }: P) {
  return (
    <>
      <Field label="Orb quality" hint="Bloom, particle count, frame rate">
        <select value={d.orb.quality} onChange={(e) => set((c) => ({ ...c, orb: { ...c.orb, quality: e.target.value as JarvisConfig['orb']['quality'] } }))}>
          {['LOW', 'BALANCED', 'HIGH', 'ULTRA'].map((q) => <option key={q}>{q}</option>)}
        </select>
      </Field>
      <Field label="System telemetry" hint="CPU, memory and battery in the top bar">
        <Toggle value={d.orb.telemetry} onChange={(v) => set((c) => ({ ...c, orb: { ...c.orb, telemetry: v } }))} />
      </Field>
      <p className="note">Boot sound</p>
      <BootSound d={d} set={set} />
    </>
  )
}

export function BootSound({ d, set }: P) {
  const b = d.boot
  const upd = (patch: Partial<JarvisConfig['boot']>) => set((c) => ({ ...c, boot: { ...c.boot, ...patch } }))
  const pick = async () => {
    const file = await openDialog({ title: 'Choose a boot track you own', filters: [{ name: 'Audio', extensions: ['mp3', 'm4a', 'wav', 'aac', 'aiff', 'flac'] }] })
    if (typeof file === 'string') upd({ bootAudioSource: file, bootAudioEnabled: true })
  }
  return (
    <>
      <Field label="Play on boot" hint="Your own local file; nothing is bundled">
        <Toggle value={b.bootAudioEnabled} onChange={(v) => upd({ bootAudioEnabled: v })} />
      </Field>
      <Field label="Audio file">
        <div style={{ display: 'flex', gap: 6 }}>
          <Text value={b.bootAudioSource} placeholder="~/Music/back-in-black.m4a" onChange={(v) => upd({ bootAudioSource: v })} />
          <button className="btn" onClick={() => void pick()}>Choose…</button>
        </div>
      </Field>
      <Field label="Start offset (s)"><Num value={b.bootAudioStartOffset} step={0.1} onChange={(v) => upd({ bootAudioStartOffset: Math.max(0, v) })} /></Field>
      <Field label="Volume"><input type="range" min={0} max={1} step={0.05} value={b.bootAudioVolume} onChange={(e) => upd({ bootAudioVolume: e.target.valueAsNumber })} /></Field>
      <Field label="Volume under speech"><input type="range" min={0} max={1} step={0.05} value={b.duckVolumeDuringSpeech} onChange={(e) => upd({ duckVolumeDuringSpeech: e.target.valueAsNumber })} /></Field>
      <Field label="Fade in / out (ms)">
        <div style={{ display: 'flex', gap: 6 }}>
          <Num value={b.fadeInMs} onChange={(v) => upd({ fadeInMs: Math.max(0, v) })} />
          <Num value={b.fadeOutMs} onChange={(v) => upd({ fadeOutMs: Math.max(0, v) })} />
        </div>
      </Field>
    </>
  )
}

function Voice({ d, set }: P) {
  const v = d.voice
  const upd = (patch: Partial<JarvisConfig['voice']>) => set((c) => ({ ...c, voice: { ...c.voice, ...patch } }))
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  useEffect(() => void Microphone.devices().then(setDevices).catch(() => setDevices([])), [])
  return (
    <>
      <Field label="Voice" hint="Microphone, wake word and speech output"><Toggle value={v.enabled} onChange={(x) => upd({ enabled: x })} /></Field>
      <Field label="Wake word" hint={`Say "AOP" or "Jarvis"`}><Toggle value={v.wakeWordEnabled} onChange={(x) => upd({ wakeWordEnabled: x })} /></Field>
      <Field label="Interrupt while speaking" hint="Talking over JARVIS stops it"><Toggle value={v.bargeIn} onChange={(x) => upd({ bargeIn: x })} /></Field>
      <Field label="Microphone">
        <select value={v.inputDeviceId} onChange={(e) => upd({ inputDeviceId: e.target.value })}>
          <option value="default">System default</option>
          {devices.filter((x) => x.deviceId !== 'default').map((x) => <option key={x.deviceId} value={x.deviceId}>{x.label || x.deviceId}</option>)}
        </select>
      </Field>
      <Field label="Sensitivity" hint="Higher hears quieter speech"><input type="range" min={1} max={10} value={v.vadSensitivity} onChange={(e) => upd({ vadSensitivity: e.target.valueAsNumber })} /></Field>
      <Field label="End of speech (ms)" hint="Silence before transcribing"><Num value={v.silenceMs} onChange={(x) => upd({ silenceMs: Math.max(200, x) })} /></Field>
      <Field label="Speech model" hint="whisper.cpp ggml file"><Text value={v.sttModelPath} onChange={(x) => upd({ sttModelPath: x })} /></Field>
      <Field label="Recognition language" hint="auto, ko, en"><Text value={v.sttLanguage} onChange={(x) => upd({ sttLanguage: x })} /></Field>
      <Field label="Korean voice"><Text value={v.ttsVoiceKo} onChange={(x) => upd({ ttsVoiceKo: x })} /></Field>
      <Field label="English voice"><Text value={v.ttsVoiceEn} onChange={(x) => upd({ ttsVoiceEn: x })} /></Field>
      <Field label="Speaking rate" hint="Words per minute"><Num value={v.ttsRate} onChange={(x) => upd({ ttsRate: x })} /></Field>
    </>
  )
}

function Models({ d, set }: P) {
  const c = useController()
  const [live, setLive] = useState<Record<string, boolean>>({})
  const [keys, setKeys] = useState<Record<string, boolean>>({})
  const [keyInput, setKeyInput] = useState<Record<string, string>>({})
  useEffect(() => {
    void c.rt.router.status().then((s) => setLive(Object.fromEntries(s.map((p) => [p.id, p.available]))))
    void Promise.all(d.models.providers.filter((p) => p.apiKeyRef).map(async (p) => [p.id, await secretExists(p.apiKeyRef!)] as const)).then((e) => setKeys(Object.fromEntries(e)))
  }, [c, d.models.providers])
  const upd = (id: string, patch: Partial<JarvisConfig['models']['providers'][number]>) =>
    set((cfg) => ({ ...cfg, models: { ...cfg.models, providers: cfg.models.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)) } }))
  return (
    <>
      <Field label="Daily budget (USD)" hint="L3 is capped to L2 once reached"><Num value={d.models.dailyBudgetUsd} step={0.5} onChange={(v) => set((cfg) => ({ ...cfg, models: { ...cfg.models, dailyBudgetUsd: Math.max(0, v) } }))} /></Field>
      {d.models.providers.map((p) => (
        <section key={p.id} style={{ marginTop: 18 }}>
          <p className="note" style={{ color: 'var(--ink-2)' }}>
            {p.label} — {p.enabled ? (live[p.id] ? 'live' : 'not reachable') : 'off'} · tiers {p.tiers.join(', ')}
          </p>
          <Field label="Enabled"><Toggle value={p.enabled} onChange={(v) => upd(p.id, { enabled: v })} /></Field>
          {p.baseUrl !== undefined && <Field label="Endpoint"><Text value={p.baseUrl} onChange={(v) => upd(p.id, { baseUrl: v })} /></Field>}
          <Field label="Default model"><Text value={p.model} onChange={(v) => upd(p.id, { model: v })} /></Field>
          {Object.entries(p.tierModels).map(([tier, m]) => (
            <Field key={tier} label={`${tier} model`}><Text value={m} onChange={(v) => upd(p.id, { tierModels: { ...p.tierModels, [tier]: v } })} /></Field>
          ))}
          {p.apiKeyRef && (
            <Field label="API key" hint={keys[p.id] ? 'Stored in Keychain' : 'Not set'}>
              <div style={{ display: 'flex', gap: 6 }}>
                <input type="password" value={keyInput[p.id] ?? ''} placeholder={keys[p.id] ? '••••••••' : 'Paste key'} onChange={(e) => setKeyInput((k) => ({ ...k, [p.id]: e.target.value }))} />
                <button className="btn" onClick={() => void secretSet(p.apiKeyRef!, keyInput[p.id] ?? '').then(() => { setKeys((k) => ({ ...k, [p.id]: Boolean(keyInput[p.id]) })); setKeyInput((k) => ({ ...k, [p.id]: '' })) })}>
                  {keyInput[p.id] ? 'Store' : 'Remove'}
                </button>
              </div>
            </Field>
          )}
        </section>
      ))}
    </>
  )
}

function Routing({ d, set }: P) {
  const upd = (patch: Partial<JarvisConfig['routing']>) => set((c) => ({ ...c, routing: { ...c.routing, ...patch } }))
  return (
    <>
      <p className="note">Known commands run natively (L0) and never reach a model. Everything else starts at the cheapest sufficient tier.</p>
      <Field label="Escalate on low confidence" hint="L1 → L2 → L3"><Toggle value={d.routing.escalation} onChange={(v) => upd({ escalation: v })} /></Field>
      <Field label="Prefer local models"><Toggle value={d.routing.preferLocal} onChange={(v) => upd({ preferLocal: v })} /></Field>
    </>
  )
}

function Agents() {
  const c = useController()
  return (
    <table className="dev" style={{ width: '100%' }}>
      <tbody>
        {[...c.rt.agents.values()].map((a) => (
          <tr key={a.id}><td style={{ padding: '8px 0', color: 'var(--ink)' }}>{a.id}</td><td style={{ color: 'var(--ink-3)' }}>{a.capabilities.join(', ')}</td></tr>
        ))}
      </tbody>
    </table>
  )
}

function MemoryTab({ d, set }: P) {
  const c = useController()
  const [items, setItems] = useState<MemoryEntry[]>([])
  const [providers, setProviders] = useState<{ id: string; available: boolean }[]>([])
  useEffect(() => {
    void c.rt.memory.timeline({ limit: 30 }).then(setItems)
    void c.rt.memory.providerStatus().then(setProviders)
  }, [c])
  const note = d.memory.aopNote
  return (
    <>
      <Field label="Memories per request" hint="Kept small on purpose"><Num value={d.memory.maxContextMemories} onChange={(v) => set((cfg) => ({ ...cfg, memory: { ...cfg.memory, maxContextMemories: Math.min(20, Math.max(1, v)) } }))} /></Field>
      <Field label="AOP Note" hint={providers.find((p) => p.id === 'aop-note')?.available ? 'Connected over MCP' : 'Not connected'}>
        <Toggle value={note.enabled} onChange={(v) => set((cfg) => ({ ...cfg, memory: { ...cfg.memory, aopNote: { ...note, enabled: v } } }))} />
      </Field>
      <Field label="AOP Note app"><Text value={note.appPath} onChange={(v) => set((cfg) => ({ ...cfg, memory: { ...cfg.memory, aopNote: { ...note, appPath: v } } }))} /></Field>
      <p className="note">Recent memories ({items.length}). Say “기억해: …” or “remember …” to add one.</p>
      {items.map((m) => (
        <div key={m.id} className="field" style={{ gridTemplateColumns: '90px 1fr' }}>
          <label>{m.type}{m.projectId && <small>{m.projectId}</small>}</label>
          <div style={{ color: 'var(--ink-2)' }}>{m.content}</div>
        </div>
      ))}
    </>
  )
}

function Permissions({ d, set }: P) {
  return (
    <>
      <p className="note">Actions that need approval show an authorization panel and run only after you approve. Deletions always go to the Trash.</p>
      {RISK_LEVELS.map((r) => (
        <Field key={r} label={r.replace('_', ' ').toLowerCase()}>
          <select
            value={d.permissions.policy[r]}
            disabled={r !== 'LOW_WRITE' && r !== 'READ' && r !== 'HIGH_WRITE'}
            onChange={(e) => set((c) => ({ ...c, permissions: { policy: { ...c.permissions.policy, [r]: e.target.value as 'auto' | 'approve' } } }))}
          >
            <option value="auto">Run automatically</option>
            <option value="approve">Ask first</option>
          </select>
        </Field>
      ))}
    </>
  )
}

function Integrations({ d, set }: P) {
  return (
    <Field label="Coding agent" hint="Runs repository edits in your project">
      <select value={d.integrations.codingAgent} onChange={(e) => set((c) => ({ ...c, integrations: { codingAgent: e.target.value as JarvisConfig['integrations']['codingAgent'] } }))}>
        <option value="claude">Claude Code</option>
        <option value="none">None</option>
      </select>
    </Field>
  )
}

function SystemTab({ d, set }: P) {
  const upd = (patch: Partial<JarvisConfig['context']>) => set((c) => ({ ...c, context: { ...c.context, ...patch } }))
  return (
    <>
      <p className="note">What JARVIS may observe. Nothing leaves this Mac unless a cloud model is used for a request.</p>
      <Field label="Active app" hint="Frontmost application name"><Toggle value={d.context.trackActiveApp} onChange={(v) => upd({ trackActiveApp: v })} /></Field>
      <Field label="Clipboard" hint="Read clipboard text as context"><Toggle value={d.context.trackClipboard} onChange={(v) => upd({ trackClipboard: v })} /></Field>
    </>
  )
}

function Developer({ d, set }: P) {
  return (
    <Field label="Open developer panel at launch">
      <Toggle value={d.developer.panel} onChange={(v) => set((c) => ({ ...c, developer: { panel: v } }))} />
    </Field>
  )
}
