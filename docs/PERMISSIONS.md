# Permissions and safety

## Risk levels and default policy (`config.permissions.policy`)

| Risk | Default | Editable in Settings |
|---|---|---|
| READ | auto | yes |
| LOW_WRITE | auto | yes |
| HIGH_WRITE | approve | yes |
| SEND | approve | no |
| DELETE | approve | no |
| PURCHASE | approve | no |
| DEPLOY | approve | no |
| PRIVILEGED_SYSTEM | approve | no |

## Approval flow (`core/src/permissions.ts`)

1. `ToolRegistry.call` resolves the risk. Tasks also carry `risk` and `requiresApproval`, set from the planner.
2. `PermissionGate.authorize` emits `approval:requested { id, tool, risk, title, detail }`. `detail` is the tool's plain-language `describe()` output, for example "Move ~/x.db to the Trash".
3. The UI shows the authorization panel. **Approve** (autofocused, Enter) and **Cancel** (Esc) call `gate.resolve(id, approved)`. The CLI asks `[y/N]` on the terminal.
4. A request is denied when:
   - the user denies it;
   - 5 minutes pass without an answer;
   - the request is aborted.

   A denial throws `TOOL_PERMISSION_DENIED`. The tool never runs, the task fails without retry, and the denial is audited.
5. While it waits, the task is WAITING_APPROVAL and the Orb tints amber (`WAITING_APPROVAL` state).

## Audit log (`audit` table)

Each row records: `ts`, `request_id`, `task_id`, `agent`, `tool`, `input_summary`, `result` (`ok: …`, `error: …`, `denied`), `risk`, `approval` (`auto`, `approved`, `denied`) and `duration_ms`.

You can view it in **Developer → Tools**.

## Hard guards in Rust (independent of the webview)

| Guard | Where |
|---|---|
| Deletion is always recoverable: `trash::delete` (NSFileManager), never unlink | `files.rs::trash_path` |
| The only hard delete is confined to the app's temp dir, checked after canonicalization | `files.rs::remove_temp` |
| Text reads are capped at 20 MB | `files.rs::read_text` |
| Secret names must match `[A-Za-z0-9_-]{1,64}`; values live in Keychain (service `com.aop.jarvis`) | `secrets.rs` |
| Child processes get a timeout (default 120 s), cancellation by id, 4 MB output caps and `kill_on_drop` | `proc.rs` |

Secrets never enter config, logs or the repo. `Logger` redacts key and token patterns.

## Trust boundary

The webview loads only bundled content, under a strict CSP: `default-src 'self'`, no remote scripts, and `connect-src` limited to IPC and the dev server. The Rust bridge (`exec`, `proc_spawn`, file commands) trusts that webview. **The TypeScript permission gate is the policy point**; Rust adds only the non-negotiable guards above. Model HTTP goes through `tauri-plugin-http`, scoped to `127.0.0.1`, `localhost` and `https://*`.

## macOS permissions

| Permission | Why | Declared in |
|---|---|---|
| Microphone | Wake word and voice commands, processed locally | `Info.plist` `NSMicrophoneUsageDescription`, `Entitlements.plist` audio-input |
| Automation (Apple Events) | `osascript` for volume, Music control and quitting apps | `NSAppleEventsUsageDescription`, apple-events entitlement |
| Notifications | Timer, long-task notices | Requested at first use |

No Accessibility or Screen Recording permission is needed. The frontmost app comes from `NSWorkspace`.

## Not yet implemented / limitations

- No per-tool or per-project policy overrides.
- No "remember this approval" option.
- The PURCHASE risk exists, but no tool uses it yet.
