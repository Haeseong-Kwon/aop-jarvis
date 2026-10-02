import Anthropic from '@anthropic-ai/sdk'
import type { ProviderConfig } from '../config'
import { JarvisError, errorMessage } from '../errors'
import type { NativePort } from '../native'
import type { CodingAgentProvider, CodingRunResult, LLMProvider, LLMRequest, LLMResponse } from './types'

const PROBE_TIMEOUT_MS = 1500
const DEFAULT_MAX_TOKENS = 4096
const CLI_TIMEOUT_MS = 180_000

const transcript = (req: LLMRequest): string =>
  req.messages.length === 1 ? req.messages[0]!.content : req.messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n')

/** Ollama, llama.cpp server, LM Studio, vLLM, OpenRouter, OpenAI — anything speaking /v1/chat/completions. */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: string
  constructor(
    private readonly cfg: ProviderConfig,
    private readonly native: NativePort,
  ) {
    this.id = cfg.id
  }

  private async headers(): Promise<Record<string, string>> {
    const key = this.cfg.apiKeyRef ? await this.native.secretGet(this.cfg.apiKeyRef) : null
    return { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }
  }

  async available(): Promise<boolean> {
    try {
      const res = await this.native.fetch(`${this.cfg.baseUrl}/models`, {
        headers: await this.headers(),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      return res.ok
    } catch {
      return false
    }
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const messages = [...(req.system ? [{ role: 'system', content: req.system }] : []), ...req.messages]
    let res: Response
    try {
      res = await this.native.fetch(`${this.cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: await this.headers(),
        body: JSON.stringify({ model: req.model, messages, max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS }),
        signal: req.signal ?? null,
      })
    } catch (error) {
      throw new JarvisError('MODEL_PROVIDER_OFFLINE', `${this.id}: ${errorMessage(error)}`, error)
    }
    if (!res.ok) throw new JarvisError('MODEL_PROVIDER_OFFLINE', `${this.id}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
    const body = (await res.json()) as {
      model?: string
      choices?: { message?: { content?: string } }[]
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    return {
      text: body.choices?.[0]?.message?.content ?? '',
      model: body.model ?? req.model,
      inputTokens: body.usage?.prompt_tokens ?? 0,
      outputTokens: body.usage?.completion_tokens ?? 0,
      cacheHit: false,
    }
  }
}

export class AnthropicProvider implements LLMProvider {
  readonly id: string
  constructor(
    private readonly cfg: ProviderConfig,
    private readonly native: NativePort,
  ) {
    this.id = cfg.id
  }

  private async client(): Promise<Anthropic | null> {
    const apiKey = this.cfg.apiKeyRef ? await this.native.secretGet(this.cfg.apiKeyRef) : null
    if (!apiKey) return null
    // The runtime lives in the desktop webview; requests go through the native HTTP client (no CORS, key stays local).
    return new Anthropic({ apiKey, fetch: this.native.fetch, dangerouslyAllowBrowser: true })
  }

  async available(): Promise<boolean> {
    return (await this.client()) !== null
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const client = await this.client()
    if (!client) throw new JarvisError('NOT_CONFIGURED', 'Anthropic API key missing (Settings → Models)')
    try {
      const response = await client.messages.create(
        {
          model: req.model,
          max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
          ...(req.system ? { system: req.system } : {}),
          messages: req.messages,
        },
        { signal: req.signal },
      )
      if (response.stop_reason === 'refusal') throw new JarvisError('TASK_EXECUTION_FAILED', 'The model declined this request.')
      const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
      return {
        text,
        model: response.model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheHit: (response.usage.cache_read_input_tokens ?? 0) > 0,
      }
    } catch (error) {
      if (error instanceof JarvisError) throw error
      if (error instanceof Anthropic.AuthenticationError) throw new JarvisError('NOT_CONFIGURED', 'Anthropic API key rejected', error)
      if (error instanceof Anthropic.APIConnectionError) throw new JarvisError('MODEL_PROVIDER_OFFLINE', 'Anthropic API unreachable', error)
      throw new JarvisError('MODEL_PROVIDER_OFFLINE', `Anthropic: ${errorMessage(error)}`, error)
    }
  }
}

interface ClaudeCliJson {
  result?: string
  is_error?: boolean
  total_cost_usd?: number
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
}

/**
 * The locally logged-in Claude Code CLI as a plain completion engine.
 * Lean flags strip its agent context (~40k tokens) so a call costs what the prompt costs.
 */
export class ClaudeCliProvider implements LLMProvider {
  readonly id: string
  constructor(
    cfg: ProviderConfig,
    private readonly native: NativePort,
    private readonly bin: () => Promise<string | null>,
  ) {
    this.id = cfg.id
  }

  async available(): Promise<boolean> {
    return (await this.bin()) !== null
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const bin = await this.bin()
    if (!bin) throw new JarvisError('MODEL_PROVIDER_OFFLINE', 'claude CLI not found')
    const args = ['-p', '--output-format', 'json', '--model', req.model, '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--system-prompt', req.system ?? 'You are a concise, precise assistant.']
    const out = await this.native.exec(bin, args, { stdin: transcript(req), timeoutMs: CLI_TIMEOUT_MS, ...(req.signal ? { signal: req.signal } : {}), cwd: this.native.homeDir })
    const parsed = parseCliJson(out.stdout)
    if (out.code !== 0 || !parsed || parsed.is_error) {
      throw new JarvisError('MODEL_PROVIDER_OFFLINE', `claude CLI failed: ${(parsed?.result ?? out.stderr ?? out.stdout).slice(0, 300)}`)
    }
    const u = parsed.usage ?? {}
    return {
      text: parsed.result ?? '',
      model: req.model,
      inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      outputTokens: u.output_tokens ?? 0,
      ...(parsed.total_cost_usd !== undefined ? { costUsd: parsed.total_cost_usd } : {}),
      cacheHit: (u.cache_read_input_tokens ?? 0) > 0,
    }
  }
}

function parseCliJson(stdout: string): ClaudeCliJson | null {
  try {
    return JSON.parse(stdout.trim()) as ClaudeCliJson
  } catch {
    return null
  }
}

/** Claude Code as a coding executor: full agent with repo tools, run in the repository directory. */
export class ClaudeCodeExecutor implements CodingAgentProvider {
  readonly id = 'claude-code'
  constructor(
    private readonly native: NativePort,
    private readonly bin: () => Promise<string | null>,
  ) {}

  async available(): Promise<boolean> {
    return (await this.bin()) !== null
  }

  async run(opts: { cwd: string; prompt: string; allowEdits: boolean; signal?: AbortSignal }): Promise<CodingRunResult> {
    const bin = await this.bin()
    if (!bin) throw new JarvisError('NOT_CONFIGURED', 'claude CLI not found')
    // Read-only runs may only look; edit runs may change files but never push, deploy or delete outside the repo.
    const tools = opts.allowEdits ? 'Read,Grep,Glob,Edit,Write,Bash(git status:*),Bash(git diff:*),Bash(npm test:*),Bash(pnpm test:*),Bash(pnpm typecheck:*),Bash(cargo test:*),Bash(pytest:*)' : 'Read,Grep,Glob,Bash(git status:*),Bash(git log:*),Bash(git diff:*)'
    const args = ['-p', '--output-format', 'json', '--allowedTools', tools, '--permission-mode', opts.allowEdits ? 'acceptEdits' : 'default', '--no-session-persistence']
    const out = await this.native.exec(bin, args, { cwd: opts.cwd, stdin: opts.prompt, timeoutMs: 15 * 60_000, ...(opts.signal ? { signal: opts.signal } : {}) })
    const parsed = parseCliJson(out.stdout)
    return {
      ok: out.code === 0 && !!parsed && !parsed.is_error,
      summary: parsed?.result ?? out.stderr.slice(0, 2000),
      costUsd: parsed?.total_cost_usd ?? null,
      raw: out.stdout.slice(0, 20_000),
    }
  }
}

/** Web research through the Claude CLI restricted to its WebSearch/WebFetch tools (no file or shell access). */
export class ClaudeWebResearcher {
  readonly id = 'claude-web'
  constructor(
    private readonly native: NativePort,
    private readonly bin: () => Promise<string | null>,
  ) {}

  available = async (): Promise<boolean> => (await this.bin()) !== null

  async research(question: string, signal?: AbortSignal): Promise<CodingRunResult> {
    const bin = await this.bin()
    if (!bin) throw new JarvisError('NOT_CONFIGURED', 'claude CLI not found')
    const prompt = `${question}\n\nResearch this on the web. Answer concisely, then list the sources you used as "- title — url".`
    const args = ['-p', '--output-format', 'json', '--model', 'claude-sonnet-5-5', '--tools', 'WebSearch,WebFetch', '--allowedTools', 'WebSearch,WebFetch', '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']
    const out = await this.native.exec(bin, args, { stdin: prompt, cwd: this.native.homeDir, timeoutMs: 5 * 60_000, ...(signal ? { signal } : {}) })
    const parsed = parseCliJson(out.stdout)
    return { ok: out.code === 0 && !!parsed && !parsed.is_error, summary: parsed?.result ?? out.stderr.slice(0, 1000), costUsd: parsed?.total_cost_usd ?? null, raw: '' }
  }
}

export function createLLMProvider(cfg: ProviderConfig, native: NativePort, claudeBin: () => Promise<string | null>): LLMProvider {
  switch (cfg.kind) {
    case 'openai-compatible':
      return new OpenAICompatibleProvider(cfg, native)
    case 'anthropic':
      return new AnthropicProvider(cfg, native)
    case 'claude-cli':
      return new ClaudeCliProvider(cfg, native, claudeBin)
  }
}
