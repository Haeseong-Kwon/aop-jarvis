# Agents

The agents are capability-based, not personas. Each one implements `Agent` from `core/src/agents/base.ts`:

```ts
interface Agent {
  id: AgentId
  capabilities: string[]
  canHandle(task: Task): number        // 0–1; the orchestrator rejects plans with a 0
  execute(task: Task, ctx: AgentContext): Promise<AgentResult>
}
```

`AgentRun` is a per-task helper:

- `tool()` calls the registry with correlation ids.
- `think()` calls the router with escalation allowed.
- `recordExternalCost()` covers CLI runs that the router doesn't see.
- `done()` and `fail()` build results.

## AgentResult

```ts
{ status: 'success'|'partial'|'failed', summary, artifacts: {kind,title,content}[],
  observations, toolCalls: {id,tool,ok,durationMs,summary}[], errors, nextActions, confidence, data? }
```

## The six agents

| Agent | Task types | Tools | Model use |
|---|---|---|---|
| `operator` (UI label SYSTEM) | `launch_app`, `quit_app`, `system_metrics`, `volume`, `media`, `clipboard_read`, `timer`, `trash_path`, `git_status`, `time` | apps.*, system.*, media.control, clipboard.read, timer.set, fs.trash, git.status | None (L0) |
| `code` | `inspect_repo`, `fix_code`, `run_tests` | repo.inspect, code.agent, git.diff, shell.run | `inspect_repo`: L2 analysis over the structural report, plus heuristic findings (files > 800 lines, no tests, > 20 TODOs, no README, not git). `fix_code`: delegates to Claude Code with the resolved decision in the prompt. |
| `research` | `memory_research`, `web_research`, `remember` | memory.search, memory.write, web.research | Memory answers are deterministic with provenance. Web research goes through the Claude CLI. |
| `analyst` | `analyze`, `synthesize` | none | L2 by complexity, over upstream results |
| `communicator` (UI label VOICE) | `respond`, `draft` | none | `respond`: L1 conversational, ≤ 3 sentences, with recent turns and memory. `draft`: L2. |
| `reviewer` | `review` | shell.run (tests, when `runTests`) | See the checks below. |

The reviewer checks:

- Upstream failures, empty output and upstream errors.
- Failing tests.
- When there are more than 200 chars of output, an LLM review (L1, escalates) for contradictions and unsupported claims. Top-level bullets become `issues`.

## Plans (planner templates)

| Intent | DAG |
|---|---|
| `code.analyze` | inspect_repo → review (runOnFailure) |
| `code.fix` | fix_code (HIGH_WRITE, 1 attempt) → review (runOnFailure, runTests) |
| `research` | web_research ∥ memory_research → synthesize → review |
| `memory.recall` | memory_research |
| `memory.remember` | remember |
| `chat` | respond |
| Operator intents | Single operator task |

## Orchestrator (`orchestrator/orchestrator.ts`)

- **Validation:** unknown dependencies and cycles are rejected (Kahn's algorithm). Each task must have an agent with `canHandle > 0`.
- **Scheduling:** a task runs when all its dependencies are terminal. Up to **4** tasks run concurrently.
- **Failure propagation:** dependents of a failed or cancelled task are CANCELLED, unless they have `input.runOnFailure` (reviewers).
- **Retry:** a failed task is requeued while `attempts < maxAttempts` (default 2). Results matching `not authorized | cancelled | No active project | not configured` are not retried.
- **Cancellation:** the AbortSignal marks every non-terminal task CANCELLED and is passed through to tools and models.
- **Approval waits:** `approval:requested` for a running task sets it to WAITING_APPROVAL, and it returns to RUNNING when resolved.
- **Persistence and events:** every status change is saved to `tasks` and emitted as `task:updated`. Agent lifecycle emits `agent:started`, `agent:completed` and `agent:failed`.

The Orb shows a node only for an agent with a real task:

| Task state | Node |
|---|---|
| Running | Orbit pulse |
| Waiting | Slow pulse |
| Queued | Dim |
| Failed | Visible 6 s |
| Completed | Visible 2.5 s, then collapses into the result card |

## Not yet implemented / limitations

- No LLM planner for open-ended multi-step requests; the templates above are the plans.
- `nextActions` is not populated yet.
- There's no Codex CLI executor; only Claude Code implements `CodingAgentProvider`.
