# Development

## Commands

| Command | Does |
|---|---|
| `pnpm install` | Installs the workspace (`apps/*`, `packages/*`) |
| `scripts/setup-voice.sh [model]` | `brew install whisper-cpp` and downloads `ggml-<model>.bin` (default `small-q5_1`) |
| `pnpm dev` | `tauri dev`: Vite on :1420 plus the Rust app, with hot reload. Rust changes restart the app. |
| `pnpm build` | `tauri build` → `.app` / `.dmg` |
| `pnpm test` | vitest in `packages/core` |
| `pnpm typecheck` | `tsc --noEmit` in every package |
| `pnpm check` | typecheck + test + `cargo check` |
| `pnpm --filter @aop/cli jarvis "<text>"` | Headless runtime. Options: `--project <dir>`, `--status`, `-v`, `--db <file>`. Approvals prompt `[y/N]`. |
| `node scripts/gen-mark-svg.ts` | Regenerates `assets/aop-mark.svg` |

`mise run setup|dev|typecheck|test|check|build` wraps the same commands.

## Tests (`packages/core/test`)

- Use vitest, with `node:sqlite` in-memory databases (`memoryDb()`).
- `fakeNative()` is a scriptable `NativePort`. Any unexpected `exec` returns 127, so stray side effects fail loudly.
- No network calls: providers are fakes, and the Claude CLI is simulated through `exec`.

| File | Covers |
|---|---|
| `intent.test.ts` | Intent rules (scenario phrasings), reviewer verdict parsing |
| `router.test.ts` | Tier scoring, local preference, escalation, fallback, budget cap, no-provider error |
| `memory.test.ts` | Particles, provenance, project filter and fallback, relation boost, FTS update, promote, idempotent migrations |
| `permissions.test.ts` | `shellRisk`, auto / approve / deny / abort, invalid input |
| `orchestrator.test.ts` | Cycles, concurrency, retry, cancel propagation, `runOnFailure`, events |
| `voice.test.ts` | Wake word matching, VAD, WAV header, full voice lifecycle, barge-in |
| `mcp.test.ts` | MCP client against a fake AOP Note server |
| `scenarios.test.ts` | Acceptance scenarios B, C, D, E+F and H, plus chat and readiness, through `createRuntime` |

## Adding things

- **Tool:** `defineTool({ name, description, input: z.object(...), risk, describe, execute, summarize })` in `core/src/tools/*`, registered in `runtime.ts`. `describe()` must state the consequence plainly, because it is the approval text.
- **Agent:** implement `Agent` (use `AgentRun`), add it to the map in `runtime.ts`, extend `AgentId`, add an `AGENT_SLOTS` angle in `orb/renderer.ts` and a label in `ui/shared.ts`, then emit tasks for it in `orchestrator/planner.ts`.
- **LLM provider:** implement `LLMProvider` (`available`, `complete`), add a `kind` in `config.ts` and a case in `createLLMProvider`. OpenAI-compatible servers need only a config entry.
- **Intent:** add a rule to `RULES` in `router/intent.ts` (order matters) and a planner case.
- **Native capability:** add a Rust command in `src-tauri/src/*`, register it in `generate_handler!`, add the method to `NativePort` and implement it in the desktop, CLI and test hosts.

## Debugging

- **Developer panel** (⌘⇧D) has these tabs:

  | Tab | Shows |
  |---|---|
  | Overview | State, route, tokens, readiness, context |
  | Tasks | |
  | Tools | Registry and audit |
  | Memory | Retrieval diagnostics |
  | Cost | |
  | Events | |
  | Logs | |

- **CLI:** prints intent, route, agents, tool results, memory hits and cost on stderr. Add `-v` for logs.
- **Keyboard shortcuts:**

  | Shortcut | Action |
  |---|---|
  | ⌘K | Palette |
  | ⌘, | Settings |
  | ⌘↵ | Listen |
  | Esc | Interrupt speech |
  | ⌘⇧J | Global summon (configurable) |

## Known gotchas (found while building)

- **StrictMode double start:** effects run twice in dev, and two runtimes raced on the first migration. The fix is a module-level singleton (`startController`) plus idempotent migrations.
- **Paste needs an Edit menu:** without an app menu, ⌘C/⌘V do nothing in a Tauri webview. `Menu::default` is installed in `lib.rs`.
- **OutputPass gamma:** an sRGB-encoding pass lifted the near-black background to grey, so the bloom pass renders straight to screen.
- **Paused rAF:** macOS pauses `requestAnimationFrame` for occluded windows, so the Orb and boot timeline freeze while hidden. Expect this when screenshotting from automation.
- **Capabilities:** every plugin call needs its capability, for example `global-shortcut:allow-unregister-all`. A missing one surfaces as a `NOT_CONFIGURED` event.
- **GUI PATH:** apps launched from Finder get a minimal PATH. `exec` adds Homebrew and `~/.local/bin`, and CLIs are resolved through `zsh -lc 'command -v …'`.
- **Shared DB:** the desktop app and the CLI share `~/Library/Application Support/com.aop.jarvis/jarvis.db` (WAL), but config edits made by one aren't picked up live by the other.

## Not yet implemented / limitations

- No ESLint or Prettier config.
- No CI workflow.
- No Playwright E2E tests for the webview.
- Desktop UI components have no unit tests; UI verification was manual, with screenshots.
