# Tools

Tools are capabilities. Agents consume them only through `ToolRegistry.call` (`core/src/tools/registry.ts`), which does five things in order:

1. Validates input with zod. Invalid input is rejected before any side effect.
2. Resolves the risk, which is static or derived from the input.
3. Calls `PermissionGate.authorize`.
4. Runs the tool and writes an `audit` row.
5. Emits `tool:called` and `tool:result`.

`registry.list()` exposes each tool's JSON Schema (`z.toJSONSchema`).

```ts
interface Tool<I, O> { name; description; input: z.ZodType<I>; risk: RiskLevel | (i) => RiskLevel;
                       describe(i): string /* shown verbatim in the approval panel */; execute(i, ctx); summarize?(o) }
```

## Registered tools (21)

| Tool | Risk | What it does |
|---|---|---|
| `apps.open` | LOW_WRITE | `open -a <app>` |
| `apps.quit` | LOW_WRITE | `osascript quit app "<app>"`. The name is validated so it can't escape the string literal. |
| `system.metrics` | READ | CPU, memory, swap, disk, battery, processes (native `sysinfo`) |
| `system.volume` | LOW_WRITE | Read and set the output volume (osascript) |
| `media.control` | LOW_WRITE | Music.app play / pause / next / previous |
| `clipboard.read` | READ | Clipboard text |
| `clipboard.write` | LOW_WRITE | Replace clipboard text |
| `notify` | LOW_WRITE | Native notification |
| `timer.set` | LOW_WRITE | Notify after N seconds (in-process timer) |
| `fs.list` | READ | List a directory |
| `fs.read` | READ | Read text, truncated at 200k chars |
| `fs.write` | HIGH_WRITE | Write or replace a text file |
| `fs.trash` | DELETE | Move to Trash. Refuses top-level paths (fewer than 3 segments, home, `/`). |
| `shell.run` | from `shellRisk` | `zsh -lc <command>` in a cwd, 60 s timeout, output capped at 20k chars |
| `git.status` | READ | Branch, porcelain status, last 5 commits |
| `git.diff` | READ | `--stat` plus a truncated diff |
| `repo.inspect` | READ | Structural report: files by extension, manifests, largest source files, TODO count, tests present, README |
| `memory.search` | READ | Hybrid memory plus AOP Note search with diagnostics |
| `memory.write` | LOW_WRITE | Structured memory with raw source |
| `code.agent` | READ, or HIGH_WRITE when `allowEdits` | Claude Code in the repo dir (see below) |
| `web.research` | READ | Claude CLI restricted to `WebSearch,WebFetch`; returns a sourced summary |

### Coding agent tool allowlists

- **Read-only runs:** `Read`, `Grep`, `Glob`, git status/log/diff.
- **Edit runs:** adds `Edit`, `Write` and test/typecheck commands, and uses `--permission-mode acceptEdits`. There is no push, deploy or delete.

## `shellRisk` (`tools/files.ts`)

The highest-risk component wins:

| Risk | Matches |
|---|---|
| PRIVILEGED_SYSTEM | `sudo`, `chown`, `launchctl`, `defaults write`, `csrutil`, `nvram`, world-writable chmod on `/…` |
| DELETE | `rm`, `rmdir`, `unlink`, `shred`, `find … -delete`, `git clean`, `git reset --hard`, `git push --force` |
| DEPLOY | `git push`, `npm publish`, `vercel`, `netlify`, `fly`, `kubectl`, `terraform apply`, `deploy` |
| SEND | `curl/wget … \| sh`, `mail`, `sendmail` |
| HIGH_WRITE | Any output redirection (`>`, `>>`), or any command not listed below |
| LOW_WRITE | Every segment is a test/lint/typecheck command (`pnpm test`, `cargo test`, `pytest`, `go test`, `mise run check`, …) or read-only |
| READ | Every pipeline/list segment is read-only: `ls`, `cat`, `grep`, `rg`, `find`, `ps`, `df`, `du`, … and read-only `git` subcommands |

## Not yet implemented / limitations

- No browser automation tool.
- No screen capture or Accessibility (window title) tool.
- No external MCP tool consumption, apart from the AOP Note memory provider.
- `outputSchema` isn't declared per tool; outputs are typed in TypeScript only.
- `media.control` targets Music.app only.
