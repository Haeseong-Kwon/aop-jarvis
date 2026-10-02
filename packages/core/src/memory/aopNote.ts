import { JarvisError } from '../errors'
import type { McpStdioClient } from './mcp'

// AOP Note integration. AOP Note is the human-facing Second Brain; JARVIS talks to it only
// through its public MCP tool surface (search_notes, read_note, create_note, append_to_note),
// never its database. See docs/AOP_NOTE_INTEGRATION.md.

export interface ExternalMemoryHit {
  id: string
  title: string
  snippet: string
  where: string
  provider: string
}

/** A memory backend other than JARVIS's own store. */
export interface MemoryProvider {
  readonly id: string
  available(): Promise<boolean>
  search(query: string, limit: number): Promise<ExternalMemoryHit[]>
  read(id: string): Promise<string>
  append(id: string, markdown: string): Promise<void>
}

interface SearchNotesRow {
  id: string
  title: string
  where: string
  match: string | null
}

export class AopNoteMemoryProvider implements MemoryProvider {
  readonly id = 'aop-note'
  constructor(
    private readonly client: McpStdioClient,
    private readonly installed: () => Promise<boolean>,
  ) {}

  async available(): Promise<boolean> {
    if (!(await this.installed())) return false
    try {
      return (await this.client.listTools()).includes('search_notes')
    } catch {
      return false
    }
  }

  async search(query: string, limit: number): Promise<ExternalMemoryHit[]> {
    const text = await this.client.callTool('search_notes', { query, limit })
    let rows: SearchNotesRow[]
    try {
      rows = JSON.parse(text) as SearchNotesRow[]
    } catch {
      throw new JarvisError('MEMORY_UNAVAILABLE', `Unexpected search_notes output: ${text.slice(0, 120)}`)
    }
    return rows.map((r) => ({ id: r.id, title: r.title, snippet: r.match ?? '', where: r.where, provider: this.id }))
  }

  read(id: string): Promise<string> {
    return this.client.callTool('read_note', { id })
  }

  async append(id: string, markdown: string): Promise<void> {
    await this.client.callTool('append_to_note', { id, markdown })
  }
}
