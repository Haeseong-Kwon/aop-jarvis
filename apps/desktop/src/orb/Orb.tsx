import { timelineClock } from '@aop/core'
import { useEffect, useRef } from 'react'
import { emptyLevels } from '../audio/levels'
import { store } from '../store'
import { agentVisuals, useController } from '../ui/shared'
import type { Quality } from './params'
import { OrbRenderer, type OrbInputs, type OrbMode } from './renderer'

const SILENT = emptyLevels()
const ORDER: Quality[] = ['LOW', 'BALANCED', 'HIGH', 'ULTRA']

/** The Orb reads live state directly each frame (store + analysers) — React never re-renders it. */
export function Orb() {
  const canvas = useRef<HTMLCanvasElement>(null)
  const controller = useController()

  useEffect(() => {
    if (!canvas.current) return
    let agentsCache: OrbInputs['agents'] = []
    let agentsAt = 0
    let statsAt = 0
    const renderer = new OrbRenderer(
      canvas.current,
      () => {
        const s = store.get()
        const now = Date.now()
        if (now - agentsAt > 100) {
          agentsCache = agentVisuals(s.tasks, now)
          agentsAt = now
        }
        const mode: OrbMode = s.mode === 'ambient' ? 'ambient' : s.uiMode
        const configured = s.config?.orb.quality ?? 'HIGH'
        // STANDARD = moderate effects; AMBIENT = low-resource mini Orb.
        const quality: Quality = mode === 'ambient' ? 'LOW' : mode === 'standard' ? ORDER[Math.min(ORDER.indexOf(configured), 1)]! : configured
        const m = s.metrics
        return {
          state: s.runtimeState,
          bootT: s.booting && s.bootStartedAt !== null ? timelineClock(performance.now(), s.bootStartedAt, s.bootSkipAt) : null,
          mic: controller.mic.active ? controller.mic.sample() : SILENT,
          out: controller.speech.sample(),
          agents: agentsCache,
          quality,
          telemetry: s.config?.orb.telemetry && m ? { cpu: m.cpuPercent, memUsed: m.memUsedBytes, memTotal: m.memTotalBytes } : null,
          mode,
          debug: s.orbDebug,
        }
      },
      (stats) => {
        const now = performance.now()
        if (now - statsAt < 500 || !store.get().devOpen) return
        statsAt = now
        store.set({ orbStats: stats })
      },
    )
    return () => renderer.dispose()
  }, [controller])

  return <canvas ref={canvas} aria-label="AOP Orb" role="img" />
}
