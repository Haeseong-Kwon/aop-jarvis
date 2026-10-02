# Model routing

LLMs are replaceable reasoning engines. Product logic depends only on `LLMProvider` (`core/src/providers/types.ts`).

## Tiers

| Tier | Meaning | Engine |
|---|---|---|
| L0 | Deterministic / native | Intent rules + tools; no model |
| L1 | Fast brain: conversation, light reasoning | Cheapest live provider for L1 (default: Claude Haiku 4.5 via CLI; local Ollama first when running) |
| L2 | Worker: analysis, synthesis, drafting | Default: Claude Sonnet 5.5 |
| L3 | Frontier: hard architecture/debugging | Default: Claude Opus 5.5; the coding agent run is recorded as L3 |

## Deterministic intents (`router/intent.ts`)

Rules are ordered; the first match wins, and entity extractors can veto a match.

| Intent | Tier | Examples |
|---|---|---|
| `cancel` | L0 | 취소, stop |
| `memory.remember` | L0 | 기억해: …, remember … |
| `memory.recall` | L1 | …하기로 했지?, what did we decide |
| `file.delete` | L0 | ~/x.pdf 파일 삭제해 (needs a path or "파일/file") |
| `code.fix` | L3 | 고쳐, fix, refactor |
| `code.analyze` | L2 | 프로젝트 구조 분석, review the repo |
| `system.memory` | L0 | 메모리 상태, RAM usage |
| `system.status` | L0 | 시스템 상태, CPU, 배터리 |
| `system.volume` | L0 | 볼륨 30, 소리 줄여, mute |
| `media.control` | L0 | 음악 틀어/멈춰/다음 |
| `timer.set` | L0 | 5분 타이머 (Korean numerals supported) |
| `time.now` | L0 | 몇 시야 |
| `clipboard.read` | L0 | 클립보드 |
| `git.status` | L0 | 깃 상태, 현재 브랜치 |
| `app.quit` | L0 | 슬랙 꺼, quit Slack |
| `app.open` | L0 | Chrome 켜, open Slack (Korean app aliases → macOS names) |
| `research` | L2 | 조사해, compare, 경쟁사 |
| `draft` | L2 | 이메일 써줘 |
| `analyze` | L2 | 분석, recommend |
| `chat` (fallback) | L1; L2 if over 280 chars; L3 on architecture/debug/strategy signals | |

Known project names (Buyer Pilot, Seed Pilot, Autopilot, Talkpic, AOP Note, …) are extracted as `entities.project`.

## Tier scoring (`scoreTier`)

score = complexity, adjusted as follows:

| Condition | Adjustment |
|---|---|
| Coding | +0.15 |
| Context over 40k chars | +0.15 |
| Risk above 0.5 | +0.10 |
| Latency-sensitive | −0.10 |

The score maps to a tier: L3 at ≥ 0.8, L2 at ≥ 0.45, otherwise L1. When the intent already fixed a tier, that tier is used.

## Provider selection (`ModelRouter`)

- **Candidates:** a provider qualifies when it's enabled, lists the tier, and passes `available()`. Availability is cached for 30 s, and a provider is marked down on failure. Privacy requests keep only local providers.
- **Order:** local providers first (when `routing.preferLocal`), then by input+output price for the tier's model.
- **Fallback:** if a provider throws, the router tries the next one, then the next tier.
- **Escalation:** below the top tier, the system prompt says to answer exactly `[[ESCALATE]]` when not confident. That reply moves the request to the next tier, and it was observed live (Reviewer, L1 → L2).
- **Budget:** once the day's spend reaches `models.dailyBudgetUsd` (default $2), L3 is capped to L2.
- **No live provider:** the router raises `MODEL_PROVIDER_OFFLINE` with a configuration hint. L0 commands still work.

## Default providers (`config.ts`)

| id | Kind | Tiers | Notes |
|---|---|---|---|
| `ollama` | openai-compatible | L1, L2 | `http://127.0.0.1:11434/v1`, model `qwen3:8b`, local. Probed via `/models`. |
| `claude-cli` | claude-cli | L1, L2, L3 | Uses the logged-in `claude` CLI with lean flags (below). Cost comes from the CLI's `total_cost_usd`. |
| `anthropic` | anthropic (official SDK) | L1, L2, L3 | Disabled by default. The key is in Keychain (`com.aop.jarvis` / `anthropic`), and requests go through the Tauri HTTP client. |

The lean Claude CLI invocation strips its roughly 40k-token agent context, so a call costs what the prompt costs (measured at $0.0006 vs $0.055):

```
claude -p --output-format json --model <m> --tools "" --setting-sources "" --strict-mcp-config \
  --disable-slash-commands --no-session-persistence --system-prompt "<system>"   (prompt on stdin)
```

The OpenAI-compatible adapter also covers llama.cpp server, LM Studio, vLLM, OpenRouter and OpenAI (set `baseUrl`, plus `apiKeyRef` if needed).

## Pricing (USD per 1M tokens, editable per provider)

| Model | Input | Output |
|---|---|---|
| claude-haiku-4-5 | 1 | 5 |
| claude-sonnet-5-5 | 2 | 10 |
| claude-opus-5-5 | 4 | 20 |

## Cost observability (`cost.ts`)

- **What's recorded:** every routed call writes a `usage` row (provider, model, tier, tokens, cost, latency, cache hit, reason, agent, task, project).
- **CLI runs:** coding-agent and web-research runs record their reported cost.
- **Summary** (Developer → Cost, CLI `--status`):
  - today, 7-day and 30-day spend
  - cost by model, by agent and by project
  - request tier mix over 30 days, from `requests` (L0 counted)
  - local/native ratio
  - frontier (L3) ratio
  - the design target: 70–85% L0/L1, ≤ 5% L3

## Not yet implemented / limitations

- No local model was running during verification. The Ollama path is implemented and probed, but it wasn't exercised live.
- The Anthropic adapter doesn't send server-side refusal `fallbacks`. A `refusal` stop reason becomes an explicit error instead.
- Claude CLI calls take about 2–6 s, mostly process startup. L1 chat latency is therefore higher than a resident local model would give.
- No streaming responses.
- The scoring inputs are heuristic. There is no learned classifier.
