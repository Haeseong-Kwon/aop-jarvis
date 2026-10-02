import { useEffect, useRef } from 'react'
import { emptyLevels } from '../audio/levels'
import { store } from '../store'
import { agentVisuals, useController } from '../ui/shared'
import { OrbRenderer, type OrbInputs } from './renderer'

const SILENT = emptyLevels()

/** The Orb reads live state directly each frame (store + analysers) — React never re-renders it. */
export function Orb() {
  const canvas = useRef<HTMLCanvasElement>(null)
  const controller = useController()

  useEffect(() => {
    if (!canvas.current) return
    let agentsCache: OrbInputs['agents'] = []
    let agentsAt = 0
    const renderer = new OrbRenderer(canvas.current, () => {
      const s = store.get()
      const now = Date.now()
      if (now - agentsAt > 100) {
        agentsCache = agentVisuals(s.tasks, now)
        agentsAt = now
      }
      return {
        state: s.runtimeState,
        bootT: s.booting && s.bootStartedAt !== null ? (performance.now() - s.bootStartedAt) / 1000 : null,
        mic: controller.mic.active ? controller.mic.sample() : SILENT,
        out: controller.speech.sample(),
        agents: agentsCache,
        quality: s.config?.orb.quality ?? 'HIGH',
      }
    })
    return () => renderer.dispose()
  }, [controller])

  return <canvas ref={canvas} aria-label="AOP Orb" role="img" />
}
