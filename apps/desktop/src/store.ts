import type { ApprovalRequest, JarvisConfig, LogEntry, RetrievalDiagnostic, RuntimeState, Subsystem, SystemMetrics, Task, Tier, UsageRecord, VoiceState } from '@aop/core'
import { useSyncExternalStore } from 'react'

export type WindowMode = 'ambient' | 'expanded' | 'cinematic'

export interface RequestCard {
  requestId: string
  text: string
  response: string
  tier: Tier | null
  ok: boolean | null
  startedAt: number
  taskIds: string[]
}

export interface StreamEvent {
  id: number
  ts: number
  name: string
  text: string
  tone: 'neutral' | 'ok' | 'warn' | 'error'
}

export interface UiState {
  runtimeState: RuntimeState
  voice: VoiceState
  executive: 'idle' | 'thinking' | 'executing'
  booted: boolean
  booting: boolean
  bootStartedAt: number | null
  sleeping: boolean
  readiness: Partial<Record<Subsystem, { ok: boolean; detail: string; at: number }>>
  tasks: Record<string, Task>
  requests: RequestCard[]
  stream: StreamEvent[]
  logs: LogEntry[]
  approvals: ApprovalRequest[]
  routing: { requestId: string; tier: Tier; provider: string; model: string; reason: string } | null
  usage: UsageRecord[]
  retrieval: { query: string; results: RetrievalDiagnostic[] } | null
  metrics: SystemMetrics | null
  context: Record<string, unknown>
  transcript: string
  lastErrorAt: number | null
  lastError: string | null
  mode: WindowMode
  config: JarvisConfig | null
  micError: string | null
  paletteOpen: boolean
  settingsOpen: boolean
  devOpen: boolean
  selectedRequest: string | null
}

const RING = 300

export const initialState: UiState = {
  runtimeState: 'DORMANT',
  voice: 'IDLE',
  executive: 'idle',
  booted: false,
  booting: false,
  bootStartedAt: null,
  sleeping: false,
  readiness: {},
  tasks: {},
  requests: [],
  stream: [],
  logs: [],
  approvals: [],
  routing: null,
  usage: [],
  retrieval: null,
  metrics: null,
  context: {},
  transcript: '',
  lastErrorAt: null,
  lastError: null,
  mode: 'expanded',
  config: null,
  micError: null,
  paletteOpen: false,
  settingsOpen: false,
  devOpen: false,
  selectedRequest: null,
}

type Listener = () => void

/** Minimal external store: immutable snapshots, one notify per update. */
class Store {
  private state: UiState = initialState
  private listeners = new Set<Listener>()
  private seq = 0

  get = (): UiState => this.state
  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  set(patch: Partial<UiState> | ((s: UiState) => Partial<UiState>)): void {
    const next = typeof patch === 'function' ? patch(this.state) : patch
    this.state = { ...this.state, ...next }
    this.listeners.forEach((l) => l())
  }

  pushStream(name: string, text: string, tone: StreamEvent['tone'] = 'neutral'): void {
    const event: StreamEvent = { id: ++this.seq, ts: Date.now(), name, text, tone }
    this.set((s) => ({ stream: [...s.stream.slice(-RING + 1), event] }))
  }

  pushLog(entry: LogEntry): void {
    this.set((s) => ({ logs: [...s.logs.slice(-RING + 1), entry] }))
  }
}

export const store = new Store()

export function useUi<T>(select: (s: UiState) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.get()))
}
