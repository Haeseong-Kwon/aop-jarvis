import { z } from 'zod'
import { RISK_LEVELS } from './types'

// Centralized typed configuration. Persisted as JSON in SQLite (settings table);
// secrets are never stored here — only Keychain references (apiKeyRef).

const tier = z.enum(['L0', 'L1', 'L2', 'L3'])

export const providerSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['openai-compatible', 'anthropic', 'claude-cli']),
  label: z.string(),
  enabled: z.boolean(),
  /** Which tiers this provider may serve, cheapest first in routing. */
  tiers: z.array(tier),
  /** Model per tier; falls back to `model`. */
  model: z.string(),
  tierModels: z.record(z.string(), z.string()).default({}),
  baseUrl: z.string().optional(),
  /** Keychain account name holding the API key. */
  apiKeyRef: z.string().optional(),
  local: z.boolean().default(false),
  /** USD per 1M tokens, by model id. */
  pricing: z.record(z.string(), z.object({ input: z.number(), output: z.number() })).default({}),
})
export type ProviderConfig = z.infer<typeof providerSchema>

const policy = z.enum(['auto', 'approve'])

const voiceSchema = z.object({
  enabled: z.boolean().default(true),
  wakeWordEnabled: z.boolean().default(true),
  /** Extra wake variants on top of the built-in "Hey Jarvis" set. */
  wakeWords: z.array(z.string()).default([]),
  whisperBin: z.string().default('whisper-cli'),
  sttModelPath: z.string().default('~/Library/Application Support/aop-jarvis/models/ggml-small-q5_1.bin'),
  // 'ko' measured faster and more accurate for Korean while still transcribing English phrases (whisper.cpp small).
  sttLanguage: z.string().default('ko'),
  ttsVoiceKo: z.string().default('Yuna'),
  ttsVoiceEn: z.string().default('Samantha'),
  ttsRate: z.number().default(190),
  vadSensitivity: z.number().min(1).max(10).default(5),
  silenceMs: z.number().default(700),
  inputDeviceId: z.string().default('default'),
  bargeIn: z.boolean().default(true),
  /** Primary TTS engine. Falls back to macOS speech automatically when the sidecar is unavailable. */
  ttsEngine: z.enum(['qwen3-mlx', 'macos-say']).default('qwen3-mlx'),
  /** CINEMATIC: 1.7B + in-context identity lock. BALANCED: 1.7B + x-vector. FAST: 0.6B. */
  voiceQuality: z.enum(['CINEMATIC', 'BALANCED', 'FAST']).default('CINEMATIC'),
  voiceProfile: z.string().default('aop-core-d'),
  ttsPython: z.string().default('~/Library/Application Support/aop-jarvis/tts-venv/bin/python'),
  ttsServerScript: z.string().default('~/Library/Application Support/aop-jarvis/tts/aop_tts_server.py'),
  ttsPort: z.number().int().default(47821),
  ttsChunkSeconds: z.number().min(0.08).max(2).default(0.32),
  ttsIdleUnloadMin: z.number().nonnegative().default(30),
  /** Korean number reading: spell out (deterministic) or leave digits to the engine. */
  koNumbers: z.enum(['hangul', 'digits']).default('hangul'),
  /** Pronunciation lexicon: term → spoken form per language (overrides the built-in table). */
  lexicon: z.record(z.string(), z.object({ ko: z.string().optional(), en: z.string().optional() })).default({}),
  /** Post-synthesis mastering (high-pass, gentle EQ, light compression, limiter). */
  mastering: z.boolean().default(true),
  /** Spoken greeting after a cold boot only (never on ordinary wake). Empty = default per language. */
  bootGreeting: z.boolean().default(true),
  bootGreetingText: z.string().default(''),
})

const bootSchema = z.object({
  bootAudioEnabled: z.boolean().default(false),
  bootAudioSource: z.string().default(''),
  bootAudioStartOffset: z.number().nonnegative().default(0),
  bootAudioVolume: z.number().min(0).max(1).default(0.6),
  duckVolumeDuringSpeech: z.number().min(0).max(1).default(0.2),
  fadeInMs: z.number().nonnegative().default(400),
  fadeOutMs: z.number().nonnegative().default(1500),
})

const memorySchema = z.object({
  maxContextMemories: z.number().int().min(1).max(20).default(5),
  aopNote: z
    .object({
      enabled: z.boolean().default(true),
      appPath: z.string().default('/Applications/aop-note.app'),
      dataDir: z.string().default('~/Library/Application Support/aop-note'),
    })
    .default({ enabled: true, appPath: '/Applications/aop-note.app', dataDir: '~/Library/Application Support/aop-note' }),
})

export const configSchema = z.object({
  onboarded: z.boolean().default(false),
  /** Start at login (menu-bar resident) so "Hey Jarvis" works without opening the app first. */
  launchAtLogin: z.boolean().default(true),
  hotkey: z.string().default('CommandOrControl+Shift+J'),
  models: z
    .object({
      providers: z.array(providerSchema),
      dailyBudgetUsd: z.number().nonnegative().default(2),
    })
    .default(() => ({ providers: DEFAULT_PROVIDERS, dailyBudgetUsd: 2 })),
  routing: z
    .object({
      escalation: z.boolean().default(true),
      minConfidence: z.number().min(0).max(1).default(0.6),
      preferLocal: z.boolean().default(true),
    })
    .default({ escalation: true, minConfidence: 0.6, preferLocal: true }),
  voice: voiceSchema.default(() => voiceSchema.parse({})),
  boot: bootSchema.default(() => bootSchema.parse({})),
  permissions: z
    .object({ policy: z.record(z.enum(RISK_LEVELS), policy) })
    .default(() => ({ policy: DEFAULT_POLICY })),
  orb: z
    .object({
      quality: z.enum(['LOW', 'BALANCED', 'HIGH', 'ULTRA']).default('HIGH'),
      telemetry: z.boolean().default(true),
      /** Information hierarchy: CINEMATIC (Orb dominant), STANDARD (task cards), DEVELOPER (full diagnostics). */
      uiMode: z.enum(['cinematic', 'standard', 'developer']).default('cinematic'),
    })
    .default({ quality: 'HIGH', telemetry: true, uiMode: 'cinematic' }),
  memory: memorySchema.default(() => memorySchema.parse({})),
  context: z
    .object({
      trackActiveApp: z.boolean().default(true),
      trackClipboard: z.boolean().default(false),
      activeProjectPath: z.string().default(''),
    })
    .default({ trackActiveApp: true, trackClipboard: false, activeProjectPath: '' }),
  integrations: z
    .object({ codingAgent: z.enum(['claude', 'codex', 'none']).default('claude') })
    .default({ codingAgent: 'claude' }),
  developer: z.object({ panel: z.boolean().default(false) }).default({ panel: false }),
})

export type JarvisConfig = z.infer<typeof configSchema>
export type PermissionPolicy = JarvisConfig['permissions']['policy']

export const DEFAULT_POLICY: Record<(typeof RISK_LEVELS)[number], 'auto' | 'approve'> = {
  READ: 'auto',
  LOW_WRITE: 'auto',
  HIGH_WRITE: 'approve',
  SEND: 'approve',
  DELETE: 'approve',
  PURCHASE: 'approve',
  DEPLOY: 'approve',
  PRIVILEGED_SYSTEM: 'approve',
}

const ANTHROPIC_PRICING = {
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
}

export const DEFAULT_PROVIDERS: ProviderConfig[] = [
  {
    id: 'ollama',
    kind: 'openai-compatible',
    label: 'Ollama (local)',
    enabled: true,
    tiers: ['L1', 'L2'],
    model: 'qwen3:8b',
    tierModels: {},
    baseUrl: 'http://127.0.0.1:11434/v1',
    local: true,
    pricing: {},
  },
  {
    id: 'claude-cli',
    kind: 'claude-cli',
    label: 'Claude Code CLI',
    enabled: true,
    tiers: ['L1', 'L2', 'L3'],
    model: 'claude-sonnet-5-5',
    tierModels: { L1: 'claude-haiku-4-5', L2: 'claude-sonnet-5-5', L3: 'claude-opus-5-5' },
    local: false,
    pricing: ANTHROPIC_PRICING,
  },
  {
    id: 'anthropic',
    kind: 'anthropic',
    label: 'Anthropic API',
    enabled: false,
    tiers: ['L1', 'L2', 'L3'],
    model: 'claude-sonnet-5-5',
    tierModels: { L1: 'claude-haiku-4-5', L2: 'claude-sonnet-5-5', L3: 'claude-opus-5-5' },
    apiKeyRef: 'anthropic',
    local: false,
    pricing: ANTHROPIC_PRICING,
  },
]

export const defaultConfig = (): JarvisConfig => configSchema.parse({})

/** Parse untrusted stored JSON; any invalid section falls back to defaults rather than crashing boot. */
export function loadConfig(raw: unknown): JarvisConfig {
  const parsed = configSchema.safeParse(raw ?? {})
  if (parsed.success) return parsed.data
  const base = defaultConfig()
  if (typeof raw !== 'object' || raw === null) return base
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(raw)) {
    const one = configSchema.safeParse({ ...base, [key]: value })
    if (one.success) merged[key] = value
  }
  return configSchema.parse(merged)
}
