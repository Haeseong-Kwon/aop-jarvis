# AOP Note integration

AOP Note is the human-facing Second Brain (a separate Electron app). JARVIS consumes it through **AOP Note's own public MCP tool surface only**.

## Contract

AOP Note ships an MCP server: newline-delimited JSON-RPC 2.0 on stdio, supporting `initialize`, `tools/list` and `tools/call`. JARVIS launches it with the app's own Electron binary in Node mode, the same way AOP Note's `claude mcp add` command does:

```
ELECTRON_RUN_AS_NODE=1 AOP_NOTE_DATA="~/Library/Application Support/aop-note" \
  /Applications/aop-note.app/Contents/MacOS/aop-note \
  /Applications/aop-note.app/Contents/Resources/app.asar/out/mcp/server.js
```

| JARVIS piece | File |
|---|---|
| MCP stdio client (one long-lived process, single `initialize`, 15 s request timeout, respawn after exit) | `core/src/memory/mcp.ts` |
| `AopNoteMemoryProvider` | `core/src/memory/aopNote.ts` |
| Process spawn (`proc_spawn` / `proc_write` / `proc_kill`, stdout lines over a Tauri Channel) | `src-tauri/src/proc.rs` |

## Tools used

| AOP Note tool | JARVIS use |
|---|---|
| `tools/list` | Availability check (`search_notes` must exist) |
| `search_notes { query, limit }` | `MemoryProvider.search`. Rows `{id, title, where, match}` become `ExternalMemoryHit` with `provider: 'aop-note'` and `where` as provenance. |
| `read_note { id }` | `MemoryProvider.read` |
| `append_to_note { id, markdown }` | `MemoryProvider.append` |

`MemoryService.search` queries JARVIS's local store and AOP Note in parallel. If AOP Note fails, the provider is listed in `unavailable[]` and logged, and the local results are still returned.

## Configuration (`config.memory.aopNote`)

`enabled` (default true), `appPath` (`/Applications/aop-note.app`), `dataDir`. Status is shown in Onboarding and in Settings → Memory.

## What JARVIS never does

- It never opens AOP Note's SQLite database or reads its internal schema.
- It never deletes notes (AOP Note exposes no delete tool).
- It never couples UI code to AOP Note internals. The UI sees only `MemoryService`.

## Memory API status

The brief describes conceptual HTTP endpoints: `POST /memory/write`, `/memory/search`, `/memory/relate`, `/memory/promote`, and `GET /memory/context`, `/memory/timeline`. **These HTTP endpoints are not implemented.** The same operations exist as an in-process TypeScript interface, `MemoryService` (`write`, `search`, `update`, `relate`, `promote`, `context`, `timeline`). See [Memory](MEMORY.md).

## Not yet implemented / limitations

- No write-back from JARVIS memories into AOP Note. `append` is implemented but no agent calls it yet.
- `create_note`, `get_project_context` and `list_tasks` aren't used yet.
- JARVIS memories are not shown inside AOP Note; the stores are separate.
