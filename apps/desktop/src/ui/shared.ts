import type { AgentId, RuntimeState, Task } from '@aop/core'
import { createContext, useContext } from 'react'
import type { Controller } from '../host/controller'
import type { AgentVisual, AgentVisualStatus } from '../orb/renderer'

export const ControllerContext = createContext<Controller | null>(null)

export function useController(): Controller {
  const c = useContext(ControllerContext)
  if (!c) throw new Error('Controller not ready')
  return c
}

/** Completed agents stay visible briefly, then collapse into their result card. */
const COMPLETED_VISIBLE_MS = 2500
const FAILED_VISIBLE_MS = 6000

const STATUS_RANK: Record<AgentVisualStatus, number> = { running: 5, waiting: 4, queued: 3, failed: 2, completed: 1 }

function visualStatus(t: Task, now: number): AgentVisualStatus | null {
  switch (t.status) {
    case 'RUNNING':
    case 'PLANNING':
      return 'running'
    case 'WAITING':
    case 'WAITING_APPROVAL':
      return 'waiting'
    case 'QUEUED':
      return 'queued'
    case 'FAILED':
      return now - (t.completedAt ?? now) < FAILED_VISIBLE_MS ? 'failed' : null
    case 'COMPLETED':
      return now - (t.completedAt ?? now) < COMPLETED_VISIBLE_MS ? 'completed' : null
    case 'CANCELLED':
      return null
  }
}

/** Only real tasks produce agent nodes — never decoration. */
export function agentVisuals(tasks: Record<string, Task>, now: number): (AgentVisual & { title: string })[] {
  const best = new Map<AgentId, AgentVisual & { title: string }>()
  for (const t of Object.values(tasks)) {
    const status = visualStatus(t, now)
    if (!status) continue
    const prev = best.get(t.agent)
    if (!prev || STATUS_RANK[status] > STATUS_RANK[prev.status]) best.set(t.agent, { id: t.agent, status, title: t.title })
  }
  return [...best.values()]
}

export const AGENT_LABEL: Record<AgentId, string> = {
  research: 'RESEARCH',
  code: 'CODE',
  operator: 'SYSTEM',
  analyst: 'ANALYSIS',
  communicator: 'VOICE',
  reviewer: 'REVIEW',
}

export const STATE_LABEL: Record<RuntimeState, string> = {
  DORMANT: 'Dormant',
  LISTENING: 'Listening',
  BOOTING: 'Initializing',
  ONLINE: 'Online',
  THINKING: 'Thinking',
  EXECUTING: 'Executing',
  SPEAKING: 'Speaking',
  INTERRUPTED: 'Interrupted',
  WAITING_APPROVAL: 'Waiting for approval',
  ERROR: 'Error',
  SLEEP: 'Ambient',
}

export const clock = (ts: number): string => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
export const gb = (b: number): string => `${(b / 1024 ** 3).toFixed(1)}`
