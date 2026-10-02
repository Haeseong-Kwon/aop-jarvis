import { createRuntime, deriveRuntimeState, errorMessage, expandHome, TranscriptWakeWord, VoiceSession, type JarvisConfig, type Runtime } from '@aop/core'
import { listen } from '@tauri-apps/api/event'
import { currentMonitor, getCurrentWindow, LogicalPosition, LogicalSize } from '@tauri-apps/api/window'
import { register, unregisterAll } from '@tauri-apps/plugin-global-shortcut'
import { disable as disableAutostart, enable as enableAutostart, isEnabled as autostartEnabled } from '@tauri-apps/plugin-autostart'
import { invoke } from '@tauri-apps/api/core'
import { Microphone } from '../audio/mic'
import { BootAudio, SpeechOutput } from '../audio/output'
import { store, type UiMode, type WindowMode } from '../store'
import { createNativePort } from './native'
import { openDatabase } from './sql'

const METRICS_INTERVAL_MS = 2000
const AMBIENT_SIZE = 240
const BOOT_AUDIO_TAIL_MS = 8000
/** Music keeps playing this long after the greeting before fading out. */
const GREETING_MUSIC_TAIL_MS = 9000
const GREETING_VOICE_WAIT_MS = 10_000

/** Owns the runtime and every host resource (mic, speakers, hotkey, window). The UI only calls its actions. */
export class Controller {
  readonly mic: Microphone
  readonly speech: SpeechOutput
  readonly bootAudio = new BootAudio()
  readonly voice: VoiceSession
  private metricsTimer: ReturnType<typeof setInterval> | null = null
  private disposers: (() => void)[] = []
  private warmed: Promise<void> | null = null
  /** Started at login: a silent ambient orb until the first "Hey Jarvis" brings the full welcome. */
  standby = false
  private silentBoot = false

  private constructor(readonly rt: Runtime) {
    const cfg = rt.getConfig()
    this.speech = new SpeechOutput(cfg.voice.mastering)
    this.mic = new Microphone(
      {
        onSpeechStart: () => this.voice.speechStart(),
        onSpeechEnd: (samples) => void this.voice.speechEnd(samples),
        isOutputActive: () => this.speech.active,
        outputLevel: () => this.speech.refLevel(),
        onActivity: (phase) => rt.bus.emit('voice:activity', { source: 'user', phase }),
      },
      cfg.voice.vadSensitivity,
      cfg.voice.silenceMs,
    )
    this.voice = new VoiceSession({
      stt: rt.stt,
      tts: rt.tts,
      wake: new TranscriptWakeWord(cfg.voice.wakeWords),
      output: this.speech,
      bus: rt.bus,
      handler: async (text, signal) => {
        const res = await rt.executive.handle(text, signal)
        return { speech: res.response, lang: res.lang }
      },
      wakeWordEnabled: () => rt.getConfig().voice.wakeWordEnabled,
      bargeIn: () => rt.getConfig().voice.bargeIn,
      planner: () => ({ koNumbers: rt.getConfig().voice.koNumbers }),
    })
    // One central audio timeline: the Orb and the UI react to these, not to private timers.
    this.speech.onActiveChange = (active) => {
      this.bootAudio.duck(active, rt.getConfig().boot)
      rt.bus.emit('voice:activity', { source: 'assistant', phase: active ? 'start' : 'end' })
    }
  }

  static async start(): Promise<Controller> {
    const native = await createNativePort()
    const db = await openDatabase()
    const rt = await createRuntime(native, db)
    const c = new Controller(rt)
    c.standby = await invoke<boolean>('launched_at_login').catch(() => false)
    c.wire()
    store.set({ config: rt.getConfig(), uiMode: rt.getConfig().orb.uiMode, devOpen: rt.getConfig().developer.panel || rt.getConfig().orb.uiMode === 'developer' })
    return c
  }

  // ---- runtime events → UI store --------------------------------------------------------

  private wire(): void {
    const { bus } = this.rt
    const on = <T>(off: () => T) => this.disposers.push(off as () => void)
    on(
      bus.on('voice:state', ({ state }) => {
        const prev = store.get().voice
        // "Hey Jarvis" from idle brings the window forward (expanding from the ambient orb).
        if (prev === 'IDLE' && (state === 'LISTENING' || state === 'THINKING')) {
          void this.reveal()
          if (this.standby) {
            this.standby = false
            if (state === 'LISTENING') void this.welcome() // wake word alone; "Hey Jarvis, <command>" just runs it
          }
        }
        this.update({ voice: state })
      }),
    )
    on(bus.on('voice:transcript', ({ text }) => store.set({ transcript: text })))
    on(
      bus.on('voice:latency', ({ stage, ms }) => {
        store.set((s) => ({ voiceLatency: { ...s.voiceLatency, [stage]: ms }, latencyLog: [...s.latencyLog.slice(-199), { ts: Date.now(), stage, ms }] }))
        store.pushStream('voice', `${stage} ${ms}ms`)
      }),
    )
    on(
      bus.on('request:started', ({ requestId, text }) => {
        store.set((s) => ({
          requests: [{ requestId, text, response: '', tier: null, ok: null, startedAt: Date.now(), taskIds: [] }, ...s.requests].slice(0, 50),
          transcript: text,
        }))
        store.pushStream('request', text)
        this.update({ executive: 'thinking' })
      }),
    )
    on(
      bus.on('request:completed', ({ requestId, response, tier, ok }) => {
        store.set((s) => ({ requests: s.requests.map((r) => (r.requestId === requestId ? { ...r, response, tier, ok } : r)) }))
        store.pushStream('result', response, ok ? 'ok' : 'error')
        this.update({ executive: 'idle' })
      }),
    )
    on(bus.on('intent:resolved', (e) => store.pushStream('intent', `${e.intent} · ${e.tier} · ${Math.round(e.confidence * 100)}%`)))
    on(
      bus.on('model:routed', (r) => {
        store.set({ routing: r })
        store.pushStream('model', `${r.tier} → ${r.provider}/${r.model}`)
      }),
    )
    on(bus.on('model:usage', (u) => store.set((s) => ({ usage: [u, ...s.usage].slice(0, 200) }))))
    const onTask = ({ task }: { task: import('@aop/core').Task }) => {
      store.set((s) => ({
        tasks: { ...s.tasks, [task.id]: task },
        requests: s.requests.map((r) => (r.requestId === task.requestId && !r.taskIds.includes(task.id) ? { ...r, taskIds: [...r.taskIds, task.id] } : r)),
      }))
      if (task.status === 'RUNNING') this.update({ executive: 'executing' })
    }
    on(bus.on('task:created', onTask))
    on(bus.on('task:updated', onTask))
    on(bus.on('agent:started', (e) => store.pushStream('agent', `${e.agent.toUpperCase()} started`)))
    on(bus.on('agent:completed', (e) => store.pushStream('agent', `${e.agent.toUpperCase()} · ${e.summary}`, 'ok')))
    on(bus.on('agent:failed', (e) => store.pushStream('agent', `${e.agent.toUpperCase()} failed · ${e.error}`, 'error')))
    on(bus.on('tool:called', (e) => store.pushStream('tool', `${e.tool} · ${e.inputSummary}`)))
    on(bus.on('tool:result', (e) => store.pushStream('tool', `${e.tool} ${e.ok ? '✓' : '✕'} ${e.durationMs}ms · ${e.summary}`, e.ok ? 'neutral' : 'warn')))
    on(bus.on('approval:requested', (a) => this.update({ approvals: [...store.get().approvals, a] })))
    on(bus.on('approval:resolved', ({ id }) => this.update({ approvals: store.get().approvals.filter((a) => a.id !== id) })))
    on(bus.on('memory:retrieved', (m) => store.set({ retrieval: { query: m.query, results: m.results } })))
    on(bus.on('context:updated', ({ context }) => store.set({ context })))
    on(bus.on('system:ready', (r) => store.set((s) => ({ readiness: { ...s.readiness, [r.subsystem]: { ok: r.ok, detail: r.detail, at: Date.now() } } }))))
    on(
      bus.on('error', (e) => {
        store.pushStream('error', `${e.code} · ${e.message}`, 'error')
        this.update({ lastErrorAt: Date.now(), lastError: `${e.code}: ${e.message}` })
      }),
    )
    on(bus.on('log', (entry) => store.pushLog(entry)))
    const errorDecay = setInterval(() => this.update({}), 1000)
    this.disposers.push(() => clearInterval(errorDecay))
    void listen<string>('tray', ({ payload }) => void this.setMode(payload === 'ambient' ? 'ambient' : 'expanded')).then((off) => this.disposers.push(off))
  }

  /** Apply a patch and recompute the one runtime state the Orb renders. */
  private update(patch: Partial<ReturnType<typeof store.get>>): void {
    store.set(patch)
    const s = store.get()
    const runtimeState = deriveRuntimeState({
      booted: s.booted,
      booting: s.booting,
      sleeping: s.sleeping,
      voice: s.voice,
      executive: s.executive,
      approvalsPending: s.approvals.length,
      lastErrorAt: s.lastErrorAt,
      now: Date.now(),
    })
    if (runtimeState !== s.runtimeState) {
      store.set({ runtimeState })
      this.rt.bus.emit('runtime:state', { state: runtimeState })
    }
  }

  // ---- lifecycle ---------------------------------------------------------------------

  /** Boot: real readiness checks run in parallel with the visual timeline; labels wait for real results. */
  async boot(opts: { silent?: boolean } = {}): Promise<void> {
    if (store.get().booting) return
    store.set({ readiness: {}, bootStartedAt: performance.now() })
    this.update({ booting: true, booted: false })
    const cfg = this.rt.getConfig()
    this.silentBoot = !!opts.silent
    if (!this.silentBoot) void this.playBootAudio(cfg)
    void this.syncLaunchAtLogin(cfg.launchAtLogin)
    // Load the voice while the boot sequence plays, so the greeting can start the moment it ends (~3 s cold start).
    if (cfg.voice.enabled && cfg.voice.bootGreeting) void this.warmVoice()
    await this.rt.checkReadiness().catch((error: unknown) => this.rt.bus.emit('error', { code: 'NOT_CONFIGURED', message: errorMessage(error) }))
    await this.registerHotkey(cfg.hotkey)
    void this.rt.context.refresh()
    this.startMetrics()
  }

  /** Called by the boot timeline when the visual sequence has fully assembled. */
  async bootComplete(): Promise<void> {
    this.update({ booting: false, booted: true })
    const cfg = this.rt.getConfig()
    const fadeMusic = (afterMs: number) => setTimeout(() => this.bootAudio.fadeOut(cfg.boot.fadeOutMs), afterMs)
    if (!cfg.voice.enabled) return void fadeMusic(BOOT_AUDIO_TAIL_MS)
    if (this.silentBoot) return void this.startMic(cfg.voice.inputDeviceId) // standby: listen for "Hey Jarvis", say nothing
    // Don't await the mic: a pending macOS permission prompt would otherwise hold back the greeting.
    void this.startMic(cfg.voice.inputDeviceId)
    // The music plays under the greeting (ducked) and fades out after it, instead of cutting it off on a timer.
    const greeted = await this.greet()
    fadeMusic(greeted ? GREETING_MUSIC_TAIL_MS : BOOT_AUDIO_TAIL_MS)
  }

  /**
   * Cold-boot greeting only (never on ordinary wake). It waits briefly for the primary voice; if the premium
   * engine isn't ready, JARVIS stays silent rather than greeting in the fallback voice.
   */
  private async greet(listenAfter = false): Promise<boolean> {
    const cfg = this.rt.getConfig()
    if (!cfg.voice.bootGreeting) return false
    const ready = await Promise.race([this.warmVoice().then(() => this.rt.tts.active === 'primary'), new Promise<boolean>((r) => setTimeout(() => r(false), GREETING_VOICE_WAIT_MS))])
    const state = store.get().voice
    if (!ready || (state !== 'IDLE' && !(listenAfter && state === 'LISTENING'))) return false
    const text = cfg.voice.bootGreetingText.trim() || (cfg.voice.sttLanguage === 'ko' ? '시스템 준비가 완료되었습니다.' : 'AOP online.')
    await this.voice.speak(text, /[가-힣]/.test(text) ? 'ko' : 'en', listenAfter)
    return true
  }

  /**
   * First "Hey Jarvis" after a login standby: the full welcome — boot track, assembly replay, greeting —
   * then keep listening for the command.
   */
  private async welcome(): Promise<void> {
    const cfg = this.rt.getConfig()
    void this.playBootAudio(cfg)
    this.replayBoot()
    await new Promise((r) => setTimeout(r, 3400))
    const greeted = await this.greet(true)
    setTimeout(() => this.bootAudio.fadeOut(cfg.boot.fadeOutMs), greeted ? GREETING_MUSIC_TAIL_MS : BOOT_AUDIO_TAIL_MS)
  }

  /** Keep the macOS login item in line with the setting. */
  private async syncLaunchAtLogin(want: boolean): Promise<void> {
    try {
      if ((await autostartEnabled()) !== want) await (want ? enableAutostart() : disableAutostart())
    } catch (error) {
      this.rt.bus.emit('error', { code: 'NOT_CONFIGURED', message: `Launch at login: ${errorMessage(error)}` })
    }
  }

  /** Lazy model residency: the TTS model loads on first voice use and then stays resident in the sidecar. */
  warmVoice(): Promise<void> {
    this.warmed ??= this.rt.tts.warmup().catch(() => undefined)
    return this.warmed
  }

  /** Explicit cinematic command: replay the full assembly sequence (never used for ordinary wake). */
  replayBoot(): void {
    if (store.get().booting) return
    store.set({ bootStartedAt: performance.now() })
    this.update({ booting: true })
    setTimeout(() => this.update({ booting: false, booted: true }), 3400)
  }

  setUiMode(mode: UiMode | 'ambient'): void {
    if (mode === 'ambient') return void this.setMode('ambient')
    if (store.get().mode === 'ambient') void this.setMode('expanded')
    store.set({ uiMode: mode, devOpen: mode === 'developer' })
    const cfg = this.rt.getConfig()
    void this.rt.saveConfig({ ...cfg, orb: { ...cfg.orb, uiMode: mode } }).then((saved) => store.set({ config: saved }))
  }

  private async playBootAudio(cfg: JarvisConfig): Promise<void> {
    if (!cfg.boot.bootAudioEnabled || !cfg.boot.bootAudioSource) return
    try {
      const bytes = await this.rt.native.readBinaryFile(expandHome(cfg.boot.bootAudioSource, this.rt.native.homeDir))
      await this.bootAudio.play(bytes, cfg.boot)
    } catch (error) {
      this.rt.bus.emit('error', { code: 'VOICE_ENGINE_ERROR', message: `Boot audio: ${errorMessage(error)}` })
    }
  }

  async startMic(deviceId: string): Promise<void> {
    try {
      await this.mic.start(deviceId)
      store.set({ micError: null })
    } catch (error) {
      const message = errorMessage(error)
      store.set({ micError: message })
      this.rt.bus.emit('error', { code: 'VOICE_ENGINE_ERROR', message: `Microphone: ${message}` })
    }
  }

  private async registerHotkey(hotkey: string): Promise<void> {
    try {
      await unregisterAll()
      await register(hotkey, (e) => {
        if (e.state === 'Pressed') void this.summon()
      })
    } catch (error) {
      this.rt.bus.emit('error', { code: 'NOT_CONFIGURED', message: `Hotkey ${hotkey}: ${errorMessage(error)}` })
    }
  }

  private startMetrics(): void {
    if (this.metricsTimer) clearInterval(this.metricsTimer)
    const poll = async () => {
      if (document.hidden || !this.rt.getConfig().orb.telemetry) return
      store.set({ metrics: await this.rt.native.systemMetrics().catch(() => store.get().metrics) })
    }
    void poll()
    this.metricsTimer = setInterval(() => void poll(), METRICS_INTERVAL_MS)
  }

  // ---- actions -----------------------------------------------------------------------

  /** Typed command (palette). Spoken back when voice output is on. */
  async submit(text: string): Promise<void> {
    if (!text.trim()) return
    if (this.voice.state === 'SPEAKING') this.speech.stop()
    const res = await this.rt.executive.handle(text.trim())
    if (this.rt.getConfig().voice.enabled) void this.voice.speak(res.response, res.lang)
  }

  /** Bring the window forward without changing what the voice session is doing. */
  async reveal(): Promise<void> {
    const w = getCurrentWindow()
    await w.show()
    await w.setFocus()
    if (store.get().mode === 'ambient') await this.setMode('expanded')
  }

  /** Hotkey / orb click: show, expand from ambient, listen. */
  async summon(): Promise<void> {
    const w = getCurrentWindow()
    await w.show()
    await w.setFocus()
    if (store.get().mode === 'ambient') await this.setMode('expanded')
    this.wake()
  }

  wake(): void {
    if (!store.get().booted) return
    if (!this.mic.active && this.rt.getConfig().voice.enabled) void this.startMic(this.rt.getConfig().voice.inputDeviceId)
    void this.warmVoice()
    this.voice.wake()
  }

  interrupt(): void {
    this.speech.stop()
    this.rt.executive.cancel()
    this.voice.sleep()
  }

  approve(id: string, approved: boolean): void {
    this.rt.gate.resolve(id, approved)
  }

  async saveConfig(next: JarvisConfig): Promise<void> {
    const prev = this.rt.getConfig()
    const saved = await this.rt.saveConfig(next)
    store.set({ config: saved })
    this.mic.setSensitivity(saved.voice.vadSensitivity)
    if (saved.voice.mastering !== prev.voice.mastering) this.speech.setMastering(saved.voice.mastering)
    if (saved.voice.voiceQuality !== prev.voice.voiceQuality || saved.voice.ttsEngine !== prev.voice.ttsEngine) {
      this.warmed = null
      void this.warmVoice()
    }
    if (saved.hotkey !== prev.hotkey) await this.registerHotkey(saved.hotkey)
    if (saved.launchAtLogin !== prev.launchAtLogin) await this.syncLaunchAtLogin(saved.launchAtLogin)
    if (saved.voice.inputDeviceId !== prev.voice.inputDeviceId && this.mic.active) await this.startMic(saved.voice.inputDeviceId)
    if (!saved.voice.enabled && this.mic.active) await this.mic.stop()
  }

  async setMode(mode: WindowMode): Promise<void> {
    const w = getCurrentWindow()
    const prev = store.get().mode
    store.set({ mode })
    if (prev === 'cinematic' && mode !== 'cinematic') await w.setFullscreen(false)
    if (mode === 'cinematic') {
      await w.setAlwaysOnTop(false)
      await w.setFullscreen(true)
      return
    }
    if (mode === 'ambient') {
      const monitor = await currentMonitor()
      await w.setResizable(false)
      await w.setSize(new LogicalSize(AMBIENT_SIZE, AMBIENT_SIZE))
      if (monitor) {
        const scale = monitor.scaleFactor
        const x = monitor.position.x / scale + monitor.size.width / scale - AMBIENT_SIZE - 24
        const y = monitor.position.y / scale + monitor.size.height / scale - AMBIENT_SIZE - 72
        await w.setPosition(new LogicalPosition(x, y))
      }
      await w.setAlwaysOnTop(true)
      return
    }
    await w.setAlwaysOnTop(false)
    await w.setResizable(true)
    await w.setSize(new LogicalSize(1280, 820))
    await w.center()
  }

  async dispose(): Promise<void> {
    this.disposers.forEach((d) => d())
    if (this.metricsTimer) clearInterval(this.metricsTimer)
    await unregisterAll().catch(() => undefined)
    await this.mic.stop()
    await this.rt.shutdown()
  }
}
