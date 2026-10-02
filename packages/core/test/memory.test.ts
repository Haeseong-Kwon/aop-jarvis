import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../src/db'
import { MemoryStore, queryTerms } from '../src/memory/store'
import { memoryDb } from './helpers'

let store: MemoryStore
beforeEach(async () => {
  const db = memoryDb()
  await migrate(db)
  store = new MemoryStore(db)
})

describe('MemoryStore', () => {
  it('strips Korean particles from query terms', () => {
    expect(queryTerms('검색 파이프라인을 어떻게 하기로 했지?')).toEqual(['검색', '파이프라인'])
  })

  it('persists memories with provenance back to the raw source', async () => {
    const src = await store.addSource({ type: 'conversation', uri: null, title: 'Buyer Pilot sync', content: 'raw transcript …' })
    await store.write({ type: 'decision', title: 'Search pipeline', content: '검색 파이프라인은 DataForSEO 수집 후 품질 필터를 거친다', projectId: 'Buyer Pilot', sourceId: src.id, sourceType: 'conversation' })
    const [hit] = await store.search({ query: '검색 파이프라인을 어떻게 하기로 했지', project: 'buyer pilot' })
    expect(hit?.entry.title).toBe('Search pipeline')
    expect(hit?.source).toMatchObject({ id: src.id, type: 'conversation', title: 'Buyer Pilot sync' })
    expect(hit?.reasons.keyword).toBeGreaterThan(0)
  })

  it('filters by project and falls back to global results when the project has none', async () => {
    await store.write({ type: 'semantic', title: 'Seed outreach', content: 'Instagram outreach cadence', projectId: 'Seed Pilot' })
    await store.write({ type: 'semantic', title: 'Buyer sources', content: 'Instagram is not a buyer source', projectId: 'Buyer Pilot' })
    const scoped = await store.search({ query: 'instagram', project: 'Seed Pilot' })
    expect(scoped.map((h) => h.entry.projectId)).toEqual(['Seed Pilot'])
    const fallback = await store.search({ query: 'instagram', project: 'Talkpic' })
    expect(fallback).toHaveLength(2)
  })

  it('boosts memories related to strong hits (1-hop graph)', async () => {
    const a = await store.write({ type: 'project', title: 'Quality filter', content: 'quality filter rules', importance: 0.5 })
    const b = await store.write({ type: 'semantic', title: 'Filter thresholds', content: 'quality thresholds 0.7', importance: 0.5 })
    await store.relate(a.id, b.id, 'part_of')
    const hits = await store.search({ query: 'quality filter' })
    expect(hits.find((h) => h.entry.id === b.id)?.reasons.relation).toBe(1)
  })

  it('updates the FTS index on update and promotes episodic → semantic', async () => {
    const m = await store.write({ type: 'episodic', title: 'old', content: 'alpha', importance: 0.4 })
    await store.update(m.id, { content: 'bravo' })
    expect(await store.search({ query: 'alpha' })).toHaveLength(0)
    expect(await store.search({ query: 'bravo' })).toHaveLength(1)
    const promoted = await store.promote(m.id)
    expect(promoted.type).toBe('semantic')
    expect(promoted.importance).toBeCloseTo(0.6)
  })

  it('returns small result sets with diagnostics', async () => {
    for (let i = 0; i < 12; i++) await store.write({ type: 'semantic', title: `note ${i}`, content: 'pipeline detail' })
    const hits = await store.search({ query: 'pipeline' })
    expect(hits).toHaveLength(5)
    expect(MemoryStore.diagnostics(hits)[0]).toHaveProperty('reasons.keyword')
  })
})
