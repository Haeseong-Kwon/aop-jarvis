import type { RuntimeState, VoiceState } from './types'

export interface StateInputs {
  booted: boolean
  booting: boolean
  sleeping: boolean
  voice: VoiceState
  executive: 'idle' | 'thinking' | 'executing'
  approvalsPending: number
  /** Timestamp of the last error; ERROR shows briefly then decays. */
  lastErrorAt: number | null
  now: number
}

const ERROR_VISIBLE_MS = 3000

/** The single source of truth for what the Orb shows. Priority order is deliberate. */
export function deriveRuntimeState(s: StateInputs): RuntimeState {
  if (s.booting) return 'BOOTING'
  if (!s.booted) return 'DORMANT'
  if (s.sleeping) return 'SLEEP'
  if (s.approvalsPending > 0) return 'WAITING_APPROVAL'
  if (s.voice === 'SPEAKING') return 'SPEAKING'
  if (s.voice === 'INTERRUPTED') return 'INTERRUPTED'
  if (s.voice === 'LISTENING' || s.voice === 'TRANSCRIBING') return 'LISTENING'
  if (s.executive === 'executing') return 'EXECUTING'
  if (s.executive === 'thinking' || s.voice === 'THINKING') return 'THINKING'
  if (s.voice === 'ERROR' || (s.lastErrorAt !== null && s.now - s.lastErrorAt < ERROR_VISIBLE_MS)) return 'ERROR'
  return 'ONLINE'
}
