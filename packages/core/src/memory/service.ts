import { errorMessage } from '../errors'
import type { EventBus, RetrievalDiagnostic } from '../events'
import type { Logger } from '../log'
import type { ExternalMemoryHit, MemoryProvider } from './aopNote'
import { MemoryStore, type MemoryEntry, type MemoryHit, type MemoryInput, type SearchOptions } from './store'

export interface MemorySearchResult {
  local: MemoryHit[]
  external: ExternalMemoryHit[]
  diagnostics: RetrievalDiagnostic[]
  /** Providers that failed during this search — surfaced, never silently swallowed. */
  unavailable: string[]
}

/**
 * The Memory API (memory.write / search / update / relate / promote / context / timeline).
 * JARVIS is both consumer and producer; AOP Note is consulted through its provider boundary.
 */
export class MemoryService {
  constructor(
    readonly store: MemoryStore,
    private readonly providers: MemoryProvider[],
    private readonly bus: EventBus,
    private readonly log: Logger,
  ) {}

  /** Writes always keep provenance: when no source is given, the raw text itself is stored as one. */
  async write(input: MemoryInput & { rawSource?: { type: string; title: string; content: string; uri?: string } }): Promise<MemoryEntry> {
    let { sourceId, sourceType } = input
    if (!sourceId && input.rawSource) {
      const src = await this.store.addSource({ type: input.rawSource.type, title: input.rawSource.title, content: input.rawSource.content, uri: input.rawSource.uri ?? null })
      sourceId = src.id
      sourceType = src.type
    }
    return this.store.write({ ...input, sourceId: sourceId ?? null, sourceType: sourceType ?? null })
  }

  async search(opts: SearchOptions & { requestId: string; includeExternal?: boolean }): Promise<MemorySearchResult> {
    const limit = opts.limit ?? 5
    const unavailable: string[] = []
    const [local, external] = await Promise.all([
      this.store.search(opts),
      opts.includeExternal === false
        ? Promise.resolve([])
        : Promise.all(
            this.providers.map(async (p) => {
              try {
                return await p.search([opts.project, opts.query].filter(Boolean).join(' '), limit)
              } catch (error) {
                unavailable.push(p.id)
                this.log.warn('memory provider failed', { provider: p.id, error: errorMessage(error) })
                return []
              }
            }),
          ).then((all) => all.flat()),
    ])
    const diagnostics = [
      ...MemoryStore.diagnostics(local),
      ...external.map((e) => ({ id: e.id, title: e.title, score: 0, reasons: { externalMatch: 1 }, source: `${e.provider}:${e.where}` })),
    ]
    this.bus.emit('memory:retrieved', { requestId: opts.requestId, query: opts.query, results: diagnostics })
    return { local, external, diagnostics, unavailable }
  }

  update = (id: string, patch: Partial<MemoryInput>): Promise<MemoryEntry> => this.store.update(id, patch)
  relate = (from: string, to: string, type: string): Promise<void> => this.store.relate(from, to, type)
  promote = (id: string): Promise<MemoryEntry> => this.store.promote(id)
  context = (query: string, project: string | null, limit?: number): Promise<MemoryHit[]> => this.store.context(query, project, limit)
  timeline = (opts: { project?: string | null; limit?: number }): Promise<MemoryEntry[]> => this.store.timeline(opts)

  async providerStatus(): Promise<{ id: string; available: boolean }[]> {
    return Promise.all(this.providers.map(async (p) => ({ id: p.id, available: await p.available().catch(() => false) })))
  }
}

export function formatMemoryContext(result: Pick<MemorySearchResult, 'local' | 'external'>): string {
  const lines = [
    ...result.local.map((h) => `- [${h.entry.type}${h.entry.projectId ? ` · ${h.entry.projectId}` : ''}] ${h.entry.title}: ${h.entry.content}${h.source ? ` (source: ${h.source.type} "${h.source.title}")` : ''}`),
    ...result.external.map((e) => `- [AOP Note · ${e.where}] ${e.title}${e.snippet ? `: ${e.snippet}` : ''}`),
  ]
  return lines.join('\n')
}
