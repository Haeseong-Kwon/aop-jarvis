import { describe, expect, it } from 'vitest'
import { AopNoteMemoryProvider } from '../src/memory/aopNote'
import { McpStdioClient } from '../src/memory/mcp'
import type { ProcessHandle } from '../src/native'
import { fakeNative } from './helpers'

/** A fake MCP server speaking newline-delimited JSON-RPC, like AOP Note's. */
function fakeServer(): { handle: ProcessHandle; received: unknown[] } {
  const received: unknown[] = []
  let emit: (line: string) => void = () => undefined
  const handle: ProcessHandle = {
    async write(data) {
      for (const line of data.split('\n').filter(Boolean)) {
        const msg = JSON.parse(line) as { id?: number; method: string; params?: { name?: string } }
        received.push(msg)
        if (msg.id === undefined) continue
        const result =
          msg.method === 'initialize'
            ? { protocolVersion: '2025-06-18', capabilities: { tools: {} } }
            : msg.method === 'tools/list'
              ? { tools: [{ name: 'search_notes' }] }
              : { content: [{ type: 'text', text: JSON.stringify([{ id: 'n1', title: 'Search pipeline', where: 'Buyer Pilot / Design', match: 'quality filter first' }]) }] }
        setTimeout(() => emit(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })), 0)
      }
    },
    onLine(cb) {
      emit = cb
    },
    onExit() {},
    async kill() {},
  }
  return { handle, received }
}

describe('AOP Note adapter over MCP stdio', () => {
  it('initializes once and maps search_notes results with provenance', async () => {
    const server = fakeServer()
    const native = { ...fakeNative(), spawn: async () => server.handle }
    const client = new McpStdioClient(native, { program: 'aop-note', args: [] })
    const provider = new AopNoteMemoryProvider(client, async () => true)
    expect(await provider.available()).toBe(true)
    const hits = await provider.search('검색 파이프라인', 5)
    expect(hits).toEqual([{ id: 'n1', title: 'Search pipeline', snippet: 'quality filter first', where: 'Buyer Pilot / Design', provider: 'aop-note' }])
    const methods = server.received.map((m) => (m as { method: string }).method)
    expect(methods.filter((m) => m === 'initialize')).toHaveLength(1)
    expect(methods).toContain('notifications/initialized')
  })

  it('reports unavailable when the app is not installed', async () => {
    const client = new McpStdioClient(fakeNative(), { program: 'x', args: [] })
    expect(await new AopNoteMemoryProvider(client, async () => false).available()).toBe(false)
  })
})
