import { Component, useEffect, useState, type ReactNode } from 'react'
import { Controller } from './host/controller'
import { Orb } from './orb/Orb'
import { store, useUi } from './store'
import { DevPanel } from './ui/DevPanel'
import { ActiveTask, AgentLabels, Caption, ContextPanel, ExecutionStream, ResultCards, SystemBar } from './ui/Hud'
import { Onboarding } from './ui/Onboarding'
import { ApprovalPanel, BootOverlay, CommandPalette } from './ui/Overlays'
import { Settings } from './ui/Settings'
import { ControllerContext } from './ui/shared'

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  override render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="onboarding">
        <div className="card">
          <h1>JARVIS could not start</h1>
          <p className="lede">{this.state.error.message}</p>
          <button className="btn primary" onClick={() => location.reload()}>Restart interface</button>
        </div>
      </div>
    )
  }
}

function useShortcuts(c: Controller) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) {
        if (e.key === 'Escape' && store.get().voice !== 'IDLE') c.interrupt()
        return
      }
      if (e.key === 'k') {
        e.preventDefault()
        store.set((s) => ({ paletteOpen: !s.paletteOpen }))
      } else if (e.key === ',') {
        e.preventDefault()
        store.set({ settingsOpen: true })
      } else if (e.key.toLowerCase() === 'd' && e.shiftKey) {
        e.preventDefault()
        c.setUiMode(store.get().uiMode === 'developer' ? 'standard' : 'developer')
      } else if (e.key === 'Enter') {
        e.preventDefault()
        c.wake()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [c])
}

function Workspace({ c }: { c: Controller }) {
  const mode = useUi((s) => s.mode)
  const booted = useUi((s) => s.booted)
  const onboarded = useUi((s) => s.config?.onboarded ?? false)
  const uiMode = useUi((s) => s.uiMode)
  useShortcuts(c)
  useEffect(() => {
    document.body.classList.toggle('ambient', mode === 'ambient')
    document.body.dataset.mode = uiMode
  }, [mode, uiMode])
  useEffect(() => {
    if (onboarded && !booted && !store.get().booting) void c.boot()
  }, [onboarded, booted, c])

  return (
    <>
      <div className="stage">
        <Orb />
      </div>
      {mode === 'ambient' ? (
        <button className="ambient-hit" aria-label="Open JARVIS" onClick={() => void c.summon()} data-tauri-drag-region />
      ) : (
        <>
          <div className="drag" data-tauri-drag-region />
          <SystemBar />
          {booted && uiMode === 'cinematic' && (
            <>
              <Caption />
              <ContextPanel subtle />
              <ActiveTask />
            </>
          )}
          {booted && uiMode === 'standard' && (
            <>
              <AgentLabels />
              <Caption />
              <ContextPanel />
              <ResultCards />
            </>
          )}
          {booted && uiMode === 'developer' && (
            <>
              <AgentLabels />
              <Caption />
              <ContextPanel />
              <ExecutionStream />
              <ResultCards />
            </>
          )}
          <BootOverlay />
          <CommandPalette />
          <ApprovalPanel />
          <DevPanel />
          <Settings />
          {!onboarded && <Onboarding onDone={() => void c.boot()} />}
        </>
      )}
    </>
  )
}

// One controller per process (StrictMode mounts effects twice in development).
let starting: Promise<Controller> | null = null
const startController = (): Promise<Controller> => (starting ??= Controller.start())

export function App() {
  const [controller, setController] = useState<Controller | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    startController()
      .then(setController)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [])
  if (error) {
    return (
      <div className="onboarding">
        <div className="card">
          <h1>JARVIS could not start</h1>
          <p className="lede">{error}</p>
        </div>
      </div>
    )
  }
  if (!controller) return null
  return (
    <ErrorBoundary>
      <ControllerContext.Provider value={controller}>
        <Workspace c={controller} />
      </ControllerContext.Provider>
    </ErrorBoundary>
  )
}
