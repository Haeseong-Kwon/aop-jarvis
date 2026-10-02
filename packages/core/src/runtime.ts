import type { Agent, AgentContext } from './agents/base'
import { CodeAgent } from './agents/code'
import { OperatorAgent } from './agents/operator'
import { AnalystAgent, CommunicatorAgent, ReviewerAgent } from './agents/reasoning'
import { ResearchAgent } from './agents/research'
import { configSchema, loadConfig, type JarvisConfig } from './config'
import { ContextBroker } from './context'
import { CostLedger } from './cost'
import { migrate, SettingsRepo, type SqlDriver } from './db'
import { EventBus } from './events'
import { Executive } from './executive'
import { Logger } from './log'
import { AopNoteMemoryProvider, type MemoryProvider } from './memory/aopNote'
import { McpStdioClient } from './memory/mcp'
import { MemoryService } from './memory/service'
import { MemoryStore } from './memory/store'
import { expandHome, type NativePort } from './native'
import { Orchestrator, TaskStore } from './orchestrator/orchestrator'
import { AuditLog, PermissionGate } from './permissions'
import { ClaudeCodeExecutor, ClaudeWebResearcher, createLLMProvider } from './providers/llm'
import type { LLMProvider } from './providers/types'
import { ModelRouter } from './router/model'
import { registerAgenticTools } from './tools/agentic'
import { registerFileTools } from './tools/files'
import { ToolRegistry } from './tools/registry'
import { registerSystemTools } from './tools/system'
import type { AgentId, Subsystem } from './types'
import { MacSpeechTTS, WhisperCppSTT } from './voice/local'

const CONFIG_KEY = 'config'

/** Resolve a CLI through the user's login shell (GUI apps don't inherit the terminal PATH). Cached. */
export function binResolver(native: NativePort): (name: string) => Promise<string | null> {
  const cache = new Map<string, Promise<string | null>>()
  return (name) => {
    if (!/^[\w.-]+$/.test(name)) return Promise.resolve(null)
    if (!cache.has(name)) {
      cache.set(
        name,
        native
          .exec('/bin/zsh', ['-lc', `command -v ${name}`], { timeoutMs: 5000 })
          .then((o) => (o.code === 0 && o.stdout.trim().startsWith('/') ? o.stdout.trim().split('\n')[0]! : null))
          .catch(() => null),
      )
    }
    return cache.get(name)!
  }
}

export type Runtime = Awaited<ReturnType<typeof createRuntime>>

export async function createRuntime(native: NativePort, db: SqlDriver) {
  const bus = new EventBus()
  const log = new Logger(bus, {})
  await migrate(db)
  const settings = new SettingsRepo(db)
  let config: JarvisConfig = loadConfig(await settings.get(CONFIG_KEY))

  const getConfig = (): JarvisConfig => config
  const saveConfig = async (next: JarvisConfig): Promise<JarvisConfig> => {
    config = configSchema.parse(next)
    await settings.set(CONFIG_KEY, config)
    return config
  }

  const bin = binResolver(native)
  const claudeBin = () => bin('claude')
  const ledger = new CostLedger(db)
  const audit = new AuditLog(db)
  const gate = new PermissionGate(() => config.permissions.policy, bus)
  const tools = new ToolRegistry(gate, audit, bus)

  const llms = new Map<string, LLMProvider>()
  const rebuildProviders = () => {
    llms.clear()
    for (const p of config.models.providers) llms.set(p.id, createLLMProvider(p, native, claudeBin))
  }
  rebuildProviders()
  const router = new ModelRouter(getConfig, llms, ledger, bus, log)

  const note = config.memory.aopNote
  const aopNoteClient = new McpStdioClient(native, {
    program: `${note.appPath}/Contents/MacOS/aop-note`,
    args: [`${note.appPath}/Contents/Resources/app.asar/out/mcp/server.js`],
    env: { ELECTRON_RUN_AS_NODE: '1', AOP_NOTE_DATA: expandHome(note.dataDir, native.homeDir) },
  })
  const memoryProviders: MemoryProvider[] = note.enabled
    ? [new AopNoteMemoryProvider(aopNoteClient, () => native.exists(`${note.appPath}/Contents/Resources/app.asar`))]
    : []
  const memory = new MemoryService(new MemoryStore(db), memoryProviders, bus, log)

  const codingAgent = config.integrations.codingAgent === 'claude' ? new ClaudeCodeExecutor(native, claudeBin) : null
  const web = new ClaudeWebResearcher(native, claudeBin)
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  registerSystemTools(tools, timers)
  registerFileTools(tools)
  registerAgenticTools(tools, { memory, coding: codingAgent, web })

  const context = new ContextBroker(native, getConfig, memory, bus, log)
  const agents = new Map<AgentId, Agent>(
    [new ResearchAgent(), new CodeAgent(), new OperatorAgent(), new AnalystAgent(), new CommunicatorAgent(), new ReviewerAgent()].map((a) => [a.id, a]),
  )
  const makeContext = (task: { id: string; agent: AgentId; requestId: string }, deps: AgentContext['deps'], signal: AbortSignal): AgentContext => ({
    requestId: task.requestId,
    signal,
    tools,
    native,
    router,
    memory,
    ledger,
    log: log.child({ requestId: task.requestId, taskId: task.id, agentId: task.agent }),
    deps,
    session: context.snapshot(),
  })
  const orchestrator = new Orchestrator(agents, makeContext, new TaskStore(db), bus, log)
  const executive = new Executive(db, context, memory, orchestrator, bus, log)

  let whisperBinCache: string | null = null
  const stt = new WhisperCppSTT(native, () => ({ bin: whisperBinCache, modelPath: config.voice.sttModelPath, language: config.voice.sttLanguage }))
  const tts = new MacSpeechTTS(native, () => ({ voiceKo: config.voice.ttsVoiceKo, voiceEn: config.voice.ttsVoiceEn, rate: config.voice.ttsRate }))

  /** Real readiness checks — a subsystem reports READY only when it actually is. */
  async function checkReadiness(): Promise<Record<Subsystem, { ok: boolean; detail: string }>> {
    whisperBinCache = config.voice.whisperBin.startsWith('/') ? config.voice.whisperBin : await bin(config.voice.whisperBin)
    const [sttOk, ttsOk, memCount, providerStatus, metrics] = await Promise.all([
      stt.available(),
      tts.available(),
      memory.store.count().then((n) => n, () => -1),
      router.status(),
      native.systemMetrics().then(() => true, () => false),
    ])
    const liveModels = providerStatus.filter((p) => p.available)
    const result: Record<Subsystem, { ok: boolean; detail: string }> = {
      voice: { ok: sttOk && ttsOk, detail: `STT ${sttOk ? 'whisper.cpp' : 'missing'} · TTS ${ttsOk ? 'macOS speech' : 'missing'}` },
      memory: { ok: memCount >= 0, detail: memCount >= 0 ? `${memCount} memories` : 'database unavailable' },
      router: { ok: true, detail: liveModels.length ? `L0 + ${liveModels.map((p) => p.label).join(', ')}` : 'L0 only (no model provider live)' },
      agents: { ok: agents.size === 6, detail: `${agents.size} agents · ${tools.list().length} tools` },
      system: { ok: metrics, detail: metrics ? 'native bridge online' : 'native bridge unavailable' },
    }
    for (const [subsystem, r] of Object.entries(result)) bus.emit('system:ready', { subsystem: subsystem as Subsystem, ok: r.ok, detail: r.detail })
    return result
  }

  return {
    bus,
    log,
    db,
    native,
    getConfig,
    saveConfig: async (next: JarvisConfig) => {
      const saved = await saveConfig(next)
      rebuildProviders()
      return saved
    },
    gate,
    audit,
    ledger,
    tools,
    router,
    memory,
    context,
    executive,
    agents,
    stt,
    tts,
    bin,
    checkReadiness,
    shutdown: async () => {
      executive.cancel()
      for (const timer of timers.values()) clearTimeout(timer)
      await aopNoteClient.close()
    },
  }
}
