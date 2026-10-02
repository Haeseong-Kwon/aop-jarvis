// Provider abstractions. Product logic depends only on these, never on a vendor SDK.

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface LLMRequest {
  model: string
  system?: string
  messages: ChatMessage[]
  maxTokens?: number
  signal?: AbortSignal
}

export interface LLMResponse {
  text: string
  model: string
  inputTokens: number
  outputTokens: number
  /** Set when the provider reports its own cost (e.g. Claude CLI); otherwise computed from pricing. */
  costUsd?: number
  cacheHit: boolean
}

export interface LLMProvider {
  readonly id: string
  available(): Promise<boolean>
  complete(req: LLMRequest): Promise<LLMResponse>
}

export interface EmbeddingProvider {
  readonly id: string
  embed(text: string): Promise<number[]>
}

export interface SearchResult {
  title: string
  url: string
  snippet: string
}
export interface SearchProvider {
  readonly id: string
  search(query: string, signal?: AbortSignal): Promise<SearchResult[]>
}

export interface CodingRunResult {
  ok: boolean
  summary: string
  costUsd: number | null
  raw: string
}
/** External coding runtimes (Claude Code, Codex CLI) — orchestrated, not reimplemented. */
export interface CodingAgentProvider {
  readonly id: string
  available(): Promise<boolean>
  run(opts: { cwd: string; prompt: string; allowEdits: boolean; signal?: AbortSignal }): Promise<CodingRunResult>
}
