# AOP JARVIS

AOP JARVIS is a local-first personal AI layer for macOS. A Tauri 2 desktop app wraps a pure-TypeScript runtime (`@aop/core`) that classifies each request, runs known commands natively (L0, no model), and routes the rest to the cheapest sufficient model tier. It delegates work to six capability agents through a task DAG, gates risky actions behind explicit approval, and keeps a local SQLite memory with source provenance. The interface centers on a realtime WebGL **AOP Orb** — a 3D optical instrument built from the AOP logo (machined O housing with a lens barrel, iris and stacked glass, A/P structural plates, precision HUD) — which renders the runtime's actual state. JARVIS speaks with an original local voice (Qwen3-TTS on MLX) through a streaming, interruptible speech pipeline.

## What works today

Verified live on an Apple M5 / macOS 26.6, in the desktop app or the headless CLI (same runtime):

| Scenario | Result |
|---|---|
| B: "Chrome 켜." | L0 → Operator → `apps.open` → Chrome launched in 66 ms. No model call. (app) |
| C: "현재 메모리 상태 확인해." | L0 → `system.metrics` → real numbers → spoken with the local Korean voice. (app) |
| D: "이 프로젝트 구조 분석해서 문제점 찾아." | CodeAgent `repo.inspect` → L2 Sonnet analysis → Reviewer (L1 Haiku), ≈ $0.02. (CLI) |
| E: "Buyer Pilot에서 전에 검색 파이프라인 어떻게 하기로 했지?" | Memory search → stored decision returned with provenance (source and date). AOP Note queried over MCP. (CLI) |
| F: "그 방식대로 현재 코드 고쳐." | Context Broker resolves "그 방식" to the stored decision → approval → Claude Code edits a scratch repo → Reviewer ran the tests. L1→L2 escalation fired live. (CLI) |
| H: delete a file | DELETE risk → approval → denied leaves the file untouched; approved moves it to the Trash. (CLI) |

Also verified live:
- Boot sequence with real readiness checks.
- Onboarding probes for microphone, whisper.cpp, model, voices, Claude CLI and AOP Note.
- Real telemetry in the system bar.
- Agent nodes driven by real tasks.
- Developer panel.

**Graphics/voice overhaul (this branch):** see [Orb](docs/ORB.md), [Voice](docs/VOICE.md) and [Benchmarks](docs/BENCHMARKS.md). The Orb rebuild was rendered and inspected (software GL); the Qwen3-TTS voice is implemented and protocol-tested but **has not been generated or heard yet** — that requires the Mac (`scripts/setup-tts.sh`, then `audition.py`).

**Voice (A, G):** implemented end to end. The code path is mic → energy VAD / echo gate → whisper.cpp → transcript wake word → runtime → SpeechPlanner → Qwen3-TTS sidecar (streaming; macOS speech as fallback) → gapless speech queue, with barge-in. Speech output and Orb sync were observed live (scenario C). The wake → listen → think → speak → interrupt lifecycle is covered by unit tests. Real STT and wake-word matching were verified on synthesized Korean and English speech run through the production whisper.cpp provider (about 300–400 ms per utterance on an M5). A full acoustic round trip through the live microphone, and barge-in with a real voice, were **not** verified: echo cancellation removes the Mac's own speaker output, so they can't be self-tested.

## Requirements

- macOS 13+ on Apple Silicon. The project is developed and verified on macOS 26.
- Node 24, pnpm 12, Rust stable, and Xcode Command Line Tools. `mise.toml` pins these.
- Optional:
  - Homebrew, for the local speech-to-text install.
  - The `claude` CLI (logged in), for the model and coding-agent paths.
  - Ollama, for a local model.
  - AOP Note at `/Applications/aop-note.app`.

## Setup and commands

```bash
pnpm install
scripts/setup-voice.sh            # brew install whisper-cpp + ggml-small-q5_1 (~190 MB)
scripts/setup-tts.sh              # AOP voice: Qwen3-TTS (MLX) venv + sidecar + models (~9 GB)
pnpm dev                          # tauri dev (desktop app)
pnpm build                        # tauri build → .app / .dmg
pnpm --filter @aop/cli jarvis "현재 메모리 상태 확인해"   # headless runtime
pnpm --filter @aop/cli jarvis --status
pnpm test                         # vitest (core)
pnpm check                        # typecheck + tests + cargo check
node scripts/capture-orb.mjs docs/captures/after   # Orb visual-regression captures (needs `pnpm --filter desktop dev`)
```

`mise run setup|dev|test|check|build` wraps the same commands.

The first launch shows onboarding. Each check there is a real probe and comes with a concrete fix when it fails.

## Repository layout

```
apps/desktop/          Tauri app: React HUD, Orb renderer, audio, host adapters
apps/desktop/src-tauri Rust native layer (process, telemetry, files, Keychain, tray)
apps/cli/              Headless JARVIS on Node (same runtime, shared DB)
packages/core/         Runtime: router, memory, tools, agents, orchestrator, voice state machine, SpeechPlanner
services/tts/          Local TTS sidecar (Qwen3-TTS via mlx-audio), voice candidates, audition/benchmark
assets/aop-mark.svg    AOP mark reconstructed from the logo (generated)
scripts/               setup-voice.sh, setup-tts.sh, capture-orb.mjs, gen-mark-svg.ts
docs/                  Architecture and subsystem docs
```

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [Voice](docs/VOICE.md)
- [Memory](docs/MEMORY.md)
- [Agents](docs/AGENTS.md)
- [Model routing](docs/MODEL_ROUTING.md)
- [Tools](docs/TOOLS.md)
- [Permissions](docs/PERMISSIONS.md)
- [Orb](docs/ORB.md)
- [Benchmarks](docs/BENCHMARKS.md)
- [AOP Note integration](docs/AOP_NOTE_INTEGRATION.md)
- [Development](docs/DEVELOPMENT.md)
