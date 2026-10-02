import type { DebugFlags } from '../orb/renderer'
import { store, useUi } from '../store'
import { useController } from './shared'

const FLAGS: [keyof DebugFlags, string][] = [
  ['layers', 'Show depth layers (exploded view)'],
  ['ringIds', 'Show ring IDs'],
  ['bounds', 'Show particle bounds'],
  ['bloom', 'Bloom'],
  ['particles', 'Particles'],
  ['glass', 'Physical glass (transmission)'],
  ['freeze', 'Freeze animation'],
]

/** Orb renderer diagnostics: live frame stats and debug toggles. */
export function GraphicsDebug() {
  const c = useController()
  const d = useUi((s) => s.orbDebug)
  const st = useUi((s) => s.orbStats)
  return (
    <>
      {st && (
        <>
          <div className="stat"><b>{st.fps.toFixed(0)}</b><span>fps</span></div>
          <div className="stat"><b>{st.frameMs.toFixed(1)}</b><span>frame ms</span></div>
          <div className="stat"><b>{st.cpuMs.toFixed(1)}</b><span>CPU ms / frame</span></div>
          <div className="stat"><b>{st.drawCalls}</b><span>draw calls</span></div>
          <table>
            <tbody>
              <tr><th>quality</th><td>{st.quality} · pixel ratio {st.pixelRatio.toFixed(2)}{st.degraded ? ` · degraded ×${st.degraded === 99 ? 'glass off' : st.degraded}` : ''}</td></tr>
              <tr><th>triangles</th><td>{st.triangles.toLocaleString()}</td></tr>
              <tr><th>programs / geometries / textures</th><td>{st.programs} / {st.geometries} / {st.textures}</td></tr>
              <tr><th>particles</th><td>{st.particles}</td></tr>
              <tr><th>bloom / transmission</th><td>{st.bloom ? 'on' : 'off'} / {st.transmission ? 'on' : 'off'}</td></tr>
            </tbody>
          </table>
          <p className="note">Frame ms is the interval between rendered frames (includes GPU back-pressure). CPU ms is scene update + command submission.</p>
        </>
      )}
      <div className="toggles">
        {FLAGS.map(([k, label]) => (
          <label key={k}>
            <input type="checkbox" checked={d[k]} onChange={(e) => store.set((s) => ({ orbDebug: { ...s.orbDebug, [k]: e.target.checked } }))} /> {label}
          </label>
        ))}
      </div>
      <button className="btn ghost" onClick={() => c.replayBoot()}>Replay cinematic boot</button>
    </>
  )
}
