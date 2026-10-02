# Memory

AOP Memory lives in `packages/core/src/memory/`:

- `store.ts`: SQLite store and retrieval.
- `service.ts`: the Memory API, merged with external providers.
- `aopNote.ts` and `mcp.ts`: the AOP Note adapter.

## Types

`episodic`, `semantic`, `decision`, `preference`, `project`, `people`, `task`, `source`

`MemoryEntry` has these fields: `id`, `type`, `title`, `content`, `entities[]`, `projectId`, `importance`, `confidence`, `sourceId`, `sourceType`, `createdAt`, `updatedAt`.

## Provenance

Raw text stays the source of truth:

- `MemoryService.write({ ..., rawSource })` first inserts a row into `sources` and links the memory to it. The `memory.write` tool always passes the original utterance as `raw`.
- Search results carry `source { id, type, uri, title }`.
- The Research agent's answer cites the source, for example `(출처: conversation "…", 2026. 10. 2.)`.

Write paths today:

- **Explicit:** "기억해: …", "remember …" (`memory.remember` intent).
- **Inferred type:** `inferMemoryType` maps decision phrases (`…기로 했`, `결정`, `decided`) → `decision`, `prefer/선호` → `preference`, and `todo/마감` → `task`. Anything else is `semantic`.

## Hybrid retrieval (`MemoryStore.search`)

1. **Metadata filter.** Filters by `project` (case-insensitive) and `types`. If a project filter returns nothing, the search reruns without it.
2. **Keyword.**
   - FTS5 prefix query over title, content, entities and project. bm25 is normalized against the best hit.
   - A `LIKE` fallback catches substrings FTS can't, such as unspaced Korean compounds. It scores 0.8 × the fraction of terms matched.
3. **Query terms.** The query is lowercased and split on non-letters. Common Korean particles are stripped from words of 3 or more characters (파이프라인을 → 파이프라인), and stopwords are dropped.
4. **Semantic.** Runs only when an `EmbeddingProvider` is configured: cosine over JSON-stored vectors.
5. **Scoring.** The weighted sum is renormalized when no semantic score exists:

| Signal | Weight |
|---|---|
| keyword | 0.45 |
| semantic | 0.20 |
| importance | 0.15 |
| recency (half-life 30 days) | 0.10 |
| relation (1-hop link to a hit with keyword > 0.5) | 0.10 |

Candidate pool is 40; returned limit is 5 by default. `context()` keeps hits with score ≥ 0.15.

## Diagnostics

`MemoryStore.diagnostics()` returns `{ id, title, score, reasons{keyword, importance, recency, relation, semantic?, project?}, source }`. These are emitted as `memory:retrieved`. You can see them in **Developer → Memory** and in the CLI's `memory` lines.

## Memory API (`MemoryService`)

| Operation | Method |
|---|---|
| memory.write | `write(input & { rawSource })` |
| memory.search | `search({ query, project, types, limit, requestId, includeExternal })`: local + AOP Note, with `unavailable[]` for providers that failed |
| memory.update | `update(id, patch)` (re-indexes FTS) |
| memory.relate | `relate(fromId, toId, type)` |
| memory.promote | `promote(id)`: episodic → semantic, importance +0.2 |
| memory.context | `context(query, project, limit)` |
| memory.timeline | `timeline({ project, limit })` |

This is an in-process TypeScript API. See [AOP Note integration](AOP_NOTE_INTEGRATION.md) for the external boundary.

## Knowledge graph

Relationships are stored in the relational `relations` table, and 1-hop relations feed the scoring. No graph database is used.

## Not yet implemented / limitations

- **No embedding provider by default.** Semantic retrieval is inactive until one is wired; keyword and metadata still work.
- **Vector storage** is JSON plus cosine in JS. That's fine to roughly 10k memories; sqlite-vec would be the upgrade.
- **No automatic LLM memory extraction** from conversations. Memories come only from explicit "remember" commands.
- **No graph visualization**, and no UI for `relate` / `promote`; they're available through the API only.
- **No memory deletion** in the UI.
