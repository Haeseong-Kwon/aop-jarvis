# Architecture

## Layers

```
┌──────────────────────── apps/desktop (webview) ────────────────────────┐
│ React HUD · Orb (Three.js) · Microphone / SpeechOutput / BootAudio      │
│ store.ts (UI state from events) · host/controller.ts (actions, wiring)  │
│ host/native.ts  → NativePort over Tauri invoke                          │
│ host/sql.ts     → SqlDriver over tauri-plugin-sql                       │
├──────────────────────────── packages/core ─────────────────────────────┤
│ Executive → ContextBroker → planner → Orchestrator → Agents → Tools     │
│ ModelRouter + providers · MemoryService · PermissionGate · AuditLog     │
│ CostLedger · VoiceSession · EventBus · Logger · config (zod)            │
├──────────────────── apps/desktop/src-tauri (Rust) ─────────────────────┤
│ exec / proc_spawn · system_metrics · frontmost_app · files · Keychain   │
│ plugins: sql, http, notification, clipboard, global-shortcut, dialog    │
└────────────────────────────────────────────────────────────────────────┘
apps/cli: the same packages/core with a Node NativePort (child_process, fs, node:sqlite)
```

## Host boundary

`packages/core` imports neither the DOM nor Tauri. It depends on two interfaces:

| Interface | File | Implementations |
|---|---|---|
| `NativePort` | `core/src/native.ts` | Tauri (`desktop/src/host/native.ts`), Node (`cli/src/native.ts`), fakes (`core/test/helpers.ts`) |
| `SqlDriver` (`execute`, `select`) | `core/src/db.ts` | tauri-plugin-sql, `node:sqlite` |

This boundary lets three things share the same runtime code: the full runtime runs under vitest, the CLI runs it headless, and the desktop app runs it in the webview. `exec` is argv-based, with no shell. A shell is used only by `shell.run` and the binary resolver (`/bin/zsh -lc`).

## Request lifecycle (`Executive.handle`)

1. **Classify**: `router/intent.ts` produces an intent with a tier, confidence, entities and complexity. No model is involved.
2. **Context**:
   - `ContextBroker.refresh()` collects the active project, branch, frontmost app and (optionally) the clipboard.
   - For `code.fix`, `resolveDecision` resolves "그 방식 / that approach".
   - For `chat`, `draft` and `analyze`, a small memory context of up to 3 hits is attached.
3. **Plan**: `orchestrator/planner.ts` uses a deterministic template per intent to produce a `Task[]` DAG.
4. **Orchestrate**: `Orchestrator.run` handles dependencies, concurrency, retry, cancellation and events.
5. **Compose**: `compose()` takes the summary of the last completed non-reviewer task, adds failures and the review verdict, and returns the result. The request is persisted to `requests`.

A new request aborts any request still running. The `cancel` intent aborts the active one.

## Event bus (`core/src/events.ts`)

| Group | Events |
|---|---|
| Runtime | `runtime:state`, `system:ready`, `context:updated`, `error`, `log` |
| Voice | `voice:state`, `voice:transcript` |
| Request | `request:started`, `request:completed`, `intent:resolved` |
| Models | `model:routed`, `model:usage` |
| Tasks | `task:created`, `task:updated`, `agent:started`, `agent:completed`, `agent:failed` |
| Tools | `tool:called`, `tool:result` |
| Approval | `approval:requested`, `approval:resolved` |
| Memory | `memory:retrieved` |

Handlers are isolated: a throwing subscriber is logged and doesn't break the emitter. The desktop `Controller` maps events into `store.ts`. `deriveRuntimeState()` in `core/src/state.ts` is the single source of the Orb state.

## Data model (SQLite, `core/src/db.ts`)

| Table | Purpose |
|---|---|
| `settings` | JSON config (`config` key) |
| `sources` | Raw source text (provenance) |
| `memories` + `memories_fts` (FTS5) | Structured memory + full-text index |
| `relations` | Memory graph edges (`from_id`, `to_id`, `type`) |
| `usage` | Per model call: provider, model, tier, tokens, cost, latency, reason, agent, task, project |
| `audit` | Per tool call: risk, approval, input summary, result, duration |
| `requests` | Each handled request with its intent and the tier actually used |
| `tasks` | Task snapshots (JSON) |
| `schema_version` | Migration version |

Migrations are append-only and idempotent (`IF NOT EXISTS`), and they run one statement at a time.

- **Desktop DB:** `~/Library/Application Support/com.aop.jarvis/jarvis.db`. The CLI uses the same file by default.

## Correlation ids

`Logger.child()` carries `sessionId`, `requestId`, `taskId`, `agentId`. Tool calls get a `toolCallId` (`tool:called`/`tool:result`), and usage and audit rows store `request_id` and `task_id`. The logger redacts API keys, bearer tokens and `key=value` secrets before emitting.

## Not yet implemented / limitations

- No LLM-based task decomposition. Plans come from per-intent templates.
- No proactive mode.
- No MCP tool consumption beyond AOP Note.
