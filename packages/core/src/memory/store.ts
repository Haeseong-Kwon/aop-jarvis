import type { SqlDriver, SqlValue } from '../db'
import type { RetrievalDiagnostic } from '../events'
import { newId } from '../types'
import type { EmbeddingProvider } from '../providers/types'

export const MEMORY_TYPES = ['episodic', 'semantic', 'decision', 'preference', 'project', 'people', 'task', 'source'] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]

export interface MemoryEntry {
  id: string
  type: MemoryType
  title: string
  content: string
  entities: string[]
  projectId: string | null
  importance: number
  confidence: number
  sourceId: string | null
  sourceType: string | null
  createdAt: number
  updatedAt: number
}

export interface SourceRecord {
  id: string
  type: string
  uri: string | null
  title: string
  content: string
  createdAt: number
}

export interface MemoryHit {
  entry: MemoryEntry
  score: number
  reasons: Record<string, number>
  source: Pick<SourceRecord, 'id' | 'type' | 'uri' | 'title'> | null
}

export interface SearchOptions {
  query: string
  project?: string | null
  types?: MemoryType[]
  limit?: number
}

export type MemoryInput = Pick<MemoryEntry, 'type' | 'title' | 'content'> &
  Partial<Pick<MemoryEntry, 'entities' | 'projectId' | 'importance' | 'confidence' | 'sourceId' | 'sourceType'>>

interface MemoryRow {
  id: string
  type: MemoryType
  title: string
  content: string
  entities: string
  project: string | null
  importance: number
  confidence: number
  source_id: string | null
  source_type: string | null
  embedding: string | null
  created_at: number
  updated_at: number
}

const DAY_MS = 86_400_000
const RECENCY_HALF_LIFE_DAYS = 30
const DEFAULT_LIMIT = 5
const CANDIDATE_POOL = 40
const WEIGHTS = { keyword: 0.45, semantic: 0.2, importance: 0.15, recency: 0.1, relation: 0.1 }

// Korean particles attach to nouns ("파이프라인을"); strip them so prefix search can match.
const KO_PARTICLES = /(으로|에서|에게|한테|까지|부터|이랑|하고|처럼|은|는|이|가|을|를|에|의|로|와|과|도|만)$/
const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'to', 'how', 'what', 'did', 'we', 'in', '어떻게', '뭐', '전에', '했지', '했어', '하기', '하기로', '했는지', '무엇'])

export function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => (/[가-힣]/.test(t) && t.length > 2 ? t.replace(KO_PARTICLES, '') : t))
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
}

const ftsQuery = (terms: string[]): string => terms.map((t) => `"${t.replace(/"/g, '')}"*`).join(' OR ')

export function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

const toEntry = (r: MemoryRow): MemoryEntry => ({
  id: r.id,
  type: r.type,
  title: r.title,
  content: r.content,
  entities: JSON.parse(r.entities) as string[],
  projectId: r.project,
  importance: r.importance,
  confidence: r.confidence,
  sourceId: r.source_id,
  sourceType: r.source_type,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

/**
 * AOP Memory: raw sources stay the source of truth; structured memories point back at them.
 * ponytail: vectors are JSON + cosine in JS — fine to ~10k memories; move to sqlite-vec past that.
 */
export class MemoryStore {
  constructor(
    private readonly db: SqlDriver,
    private readonly embedder: EmbeddingProvider | null = null,
  ) {}

  async addSource(input: Omit<SourceRecord, 'id' | 'createdAt'>): Promise<SourceRecord> {
    const source: SourceRecord = { ...input, id: newId('src'), createdAt: Date.now() }
    await this.db.execute('INSERT INTO sources (id, type, uri, title, content, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      source.id,
      source.type,
      source.uri,
      source.title,
      source.content,
      source.createdAt,
    ])
    return source
  }

  async getSource(id: string): Promise<SourceRecord | null> {
    const rows = await this.db.select<{ id: string; type: string; uri: string | null; title: string; content: string; created_at: number }>(
      'SELECT * FROM sources WHERE id = ?',
      [id],
    )
    const r = rows[0]
    return r ? { id: r.id, type: r.type, uri: r.uri, title: r.title, content: r.content, createdAt: r.created_at } : null
  }

  async write(input: MemoryInput): Promise<MemoryEntry> {
    const now = Date.now()
    const entry: MemoryEntry = {
      id: newId('mem'),
      type: input.type,
      title: input.title.trim(),
      content: input.content.trim(),
      entities: input.entities ?? [],
      projectId: input.projectId ?? null,
      importance: clamp01(input.importance ?? 0.5),
      confidence: clamp01(input.confidence ?? 0.8),
      sourceId: input.sourceId ?? null,
      sourceType: input.sourceType ?? null,
      createdAt: now,
      updatedAt: now,
    }
    const embedding = await this.embed(`${entry.title}\n${entry.content}`)
    await this.db.execute(
      `INSERT INTO memories (id, type, title, content, entities, project, importance, confidence, source_id, source_type, embedding, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.type,
        entry.title,
        entry.content,
        JSON.stringify(entry.entities),
        entry.projectId,
        entry.importance,
        entry.confidence,
        entry.sourceId,
        entry.sourceType,
        embedding ? JSON.stringify(embedding) : null,
        now,
        now,
      ],
    )
    await this.index(entry)
    return entry
  }

  async get(id: string): Promise<MemoryEntry | null> {
    const rows = await this.db.select<MemoryRow>('SELECT * FROM memories WHERE id = ?', [id])
    return rows[0] ? toEntry(rows[0]) : null
  }

  async update(id: string, patch: Partial<MemoryInput>): Promise<MemoryEntry> {
    const current = await this.get(id)
    if (!current) throw new Error(`Memory ${id} not found`)
    const next: MemoryEntry = { ...current, ...patch, updatedAt: Date.now() }
    await this.db.execute(
      'UPDATE memories SET type = ?, title = ?, content = ?, entities = ?, project = ?, importance = ?, confidence = ?, updated_at = ? WHERE id = ?',
      [next.type, next.title, next.content, JSON.stringify(next.entities), next.projectId, next.importance, next.confidence, next.updatedAt, id],
    )
    await this.db.execute('DELETE FROM memories_fts WHERE id = ?', [id])
    await this.index(next)
    return next
  }

  async relate(fromId: string, toId: string, type: string): Promise<void> {
    await this.db.execute('INSERT OR IGNORE INTO relations (id, from_id, to_id, type, created_at) VALUES (?, ?, ?, ?, ?)', [
      newId('rel'),
      fromId,
      toId,
      type,
      Date.now(),
    ])
  }

  async related(id: string): Promise<{ id: string; type: string }[]> {
    return this.db.select<{ id: string; type: string }>(
      `SELECT to_id AS id, type FROM relations WHERE from_id = ? UNION SELECT from_id AS id, type FROM relations WHERE to_id = ?`,
      [id, id],
    )
  }

  /** Promote an episodic observation into durable knowledge (semantic) and raise its importance. */
  async promote(id: string): Promise<MemoryEntry> {
    const current = await this.get(id)
    if (!current) throw new Error(`Memory ${id} not found`)
    return this.update(id, {
      type: current.type === 'episodic' ? 'semantic' : current.type,
      importance: Math.min(1, current.importance + 0.2),
    })
  }

  async timeline(opts: { project?: string | null; limit?: number } = {}): Promise<MemoryEntry[]> {
    const where = opts.project ? 'WHERE project = ? COLLATE NOCASE' : ''
    const params: SqlValue[] = opts.project ? [opts.project, opts.limit ?? 50] : [opts.limit ?? 50]
    const rows = await this.db.select<MemoryRow>(`SELECT * FROM memories ${where} ORDER BY created_at DESC LIMIT ?`, params)
    return rows.map(toEntry)
  }

  async count(): Promise<number> {
    const rows = await this.db.select<{ n: number }>('SELECT COUNT(*) AS n FROM memories')
    return rows[0]?.n ?? 0
  }

  async projects(): Promise<string[]> {
    const rows = await this.db.select<{ project: string }>('SELECT DISTINCT project FROM memories WHERE project IS NOT NULL')
    return rows.map((r) => r.project)
  }

  /** Hybrid retrieval: metadata filter → keyword (FTS5) + LIKE fallback → semantic → recency/importance → 1-hop relations. */
  async search(opts: SearchOptions): Promise<MemoryHit[]> {
    const limit = opts.limit ?? DEFAULT_LIMIT
    const terms = queryTerms(opts.query)
    let hits = await this.rank(opts, terms, opts.project ?? null)
    // A project filter that matches nothing should not hide globally relevant memories.
    if (hits.length === 0 && opts.project) hits = await this.rank(opts, terms, null)
    const top = hits.slice(0, limit)
    await this.touch(top.map((h) => h.entry.id))
    return top
  }

  /** Small relevant set for a model prompt, formatted with provenance. */
  async context(query: string, project: string | null, limit = DEFAULT_LIMIT): Promise<MemoryHit[]> {
    return (await this.search({ query, project, limit })).filter((h) => h.score >= 0.15)
  }

  static diagnostics(hits: MemoryHit[]): RetrievalDiagnostic[] {
    return hits.map((h) => ({
      id: h.entry.id,
      title: h.entry.title,
      score: round(h.score),
      reasons: Object.fromEntries(Object.entries(h.reasons).map(([k, v]) => [k, round(v)])),
      source: h.source ? `${h.source.type}:${h.source.title}` : 'none',
    }))
  }

  private async rank(opts: SearchOptions, terms: string[], project: string | null): Promise<MemoryHit[]> {
    const filters: string[] = []
    const params: SqlValue[] = []
    if (project) {
      filters.push('m.project = ? COLLATE NOCASE')
      params.push(project)
    }
    if (opts.types?.length) {
      filters.push(`m.type IN (${opts.types.map(() => '?').join(',')})`)
      params.push(...opts.types)
    }
    const where = filters.length ? `AND ${filters.join(' AND ')}` : ''

    const keyword = new Map<string, number>()
    const rows = new Map<string, MemoryRow>()
    if (terms.length) {
      const fts = await this.db.select<MemoryRow & { rank: number }>(
        `SELECT m.*, bm25(memories_fts) AS rank FROM memories_fts JOIN memories m ON m.id = memories_fts.id
         WHERE memories_fts MATCH ? ${where} ORDER BY rank LIMIT ${CANDIDATE_POOL}`,
        [ftsQuery(terms), ...params],
      )
      // bm25 is negative (more negative = better); normalize against the best hit.
      const best = Math.min(...fts.map((r) => r.rank), -1e-9)
      for (const r of fts) {
        keyword.set(r.id, r.rank / best)
        rows.set(r.id, r)
      }
      const like = await this.db.select<MemoryRow>(
        `SELECT m.* FROM memories m WHERE (${terms.map(() => '(m.title LIKE ? OR m.content LIKE ? OR m.entities LIKE ?)').join(' OR ')}) ${where} LIMIT ${CANDIDATE_POOL}`,
        [...terms.flatMap((t) => [`%${t}%`, `%${t}%`, `%${t}%`]), ...params],
      )
      for (const r of like) {
        const text = `${r.title} ${r.content} ${r.entities}`.toLowerCase()
        const matched = terms.filter((t) => text.includes(t)).length / terms.length
        keyword.set(r.id, Math.max(keyword.get(r.id) ?? 0, matched * 0.8))
        rows.set(r.id, r)
      }
    } else if (project || opts.types?.length) {
      const recent = await this.db.select<MemoryRow>(`SELECT m.* FROM memories m WHERE 1=1 ${where} ORDER BY updated_at DESC LIMIT ${CANDIDATE_POOL}`, params)
      for (const r of recent) rows.set(r.id, r)
    }

    const queryVec = this.embedder && rows.size ? await this.embed(opts.query) : null
    const now = Date.now()
    const scored: MemoryHit[] = [...rows.values()].map((r) => {
      const semantic = queryVec && r.embedding ? Math.max(0, cosine(queryVec, JSON.parse(r.embedding) as number[])) : 0
      const reasons: Record<string, number> = {
        keyword: keyword.get(r.id) ?? 0,
        importance: r.importance,
        recency: Math.pow(0.5, (now - r.updated_at) / DAY_MS / RECENCY_HALF_LIFE_DAYS),
        relation: 0,
      }
      if (queryVec) reasons.semantic = semantic
      if (project) reasons.project = 1
      return { entry: toEntry(r), score: 0, reasons, source: null }
    })

    // 1-hop relation boost: memories linked to strong keyword hits get lifted.
    const strong = new Set(scored.filter((h) => (h.reasons.keyword ?? 0) > 0.5).map((h) => h.entry.id))
    for (const hit of scored) {
      const links = await this.related(hit.entry.id)
      if (links.some((l) => strong.has(l.id))) hit.reasons.relation = 1
    }

    const weightSum = WEIGHTS.keyword + WEIGHTS.importance + WEIGHTS.recency + WEIGHTS.relation + (queryVec ? WEIGHTS.semantic : 0)
    for (const hit of scored) {
      const r = hit.reasons
      hit.score =
        (WEIGHTS.keyword * (r.keyword ?? 0) +
          WEIGHTS.importance * (r.importance ?? 0) +
          WEIGHTS.recency * (r.recency ?? 0) +
          WEIGHTS.relation * (r.relation ?? 0) +
          WEIGHTS.semantic * (r.semantic ?? 0)) /
        weightSum
    }
    scored.sort((a, b) => b.score - a.score)
    return Promise.all(
      scored.map(async (h) => {
        const src = h.entry.sourceId ? await this.getSource(h.entry.sourceId) : null
        return { ...h, source: src ? { id: src.id, type: src.type, uri: src.uri, title: src.title } : null }
      }),
    )
  }

  private async index(entry: MemoryEntry): Promise<void> {
    await this.db.execute('INSERT INTO memories_fts (id, title, content, entities, project) VALUES (?, ?, ?, ?, ?)', [
      entry.id,
      entry.title,
      entry.content,
      entry.entities.join(' '),
      entry.projectId ?? '',
    ])
  }

  private async touch(ids: string[]): Promise<void> {
    if (!ids.length) return
    await this.db.execute(`UPDATE memories SET last_accessed_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`, [Date.now(), ...ids])
  }

  private async embed(text: string): Promise<number[] | null> {
    if (!this.embedder) return null
    try {
      return await this.embedder.embed(text)
    } catch {
      return null // semantic retrieval is optional; keyword retrieval still works
    }
  }
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n))
const round = (n: number): number => Math.round(n * 1000) / 1000
