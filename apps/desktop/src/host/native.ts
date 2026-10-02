import type { DirEntry, ExecResult, FrontmostApp, NativePort, ProcessHandle, SystemMetrics } from '@aop/core'
import { Channel, invoke } from '@tauri-apps/api/core'
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'

type ProcEvent = { kind: 'line'; data: string } | { kind: 'exit'; data: number | null }

let execSeq = 1

/** The Tauri implementation of the runtime's host port. */
export async function createNativePort(): Promise<NativePort> {
  const paths = await invoke<{ home: string; temp: string; data: string }>('paths')
  return {
    homeDir: paths.home,
    tempDir: paths.temp,
    fetch: tauriFetch as typeof fetch,

    async exec(program, args, opts = {}): Promise<ExecResult> {
      const id = execSeq++
      const onAbort = () => void invoke('exec_cancel', { id })
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        return await invoke<ExecResult>('exec', {
          id,
          program,
          args,
          cwd: opts.cwd ?? null,
          stdin: opts.stdin ?? null,
          timeoutMs: opts.timeoutMs ?? null,
        })
      } finally {
        opts.signal?.removeEventListener('abort', onAbort)
      }
    },

    async spawn(program, args, opts = {}): Promise<ProcessHandle> {
      const lineHandlers: ((line: string) => void)[] = []
      const exitHandlers: ((code: number | null) => void)[] = []
      const channel = new Channel<ProcEvent>()
      channel.onmessage = (event) => {
        if (event.kind === 'line') lineHandlers.forEach((h) => h(event.data))
        else exitHandlers.forEach((h) => h(event.data))
      }
      const id = await invoke<number>('proc_spawn', { program, args, cwd: opts.cwd ?? null, env: opts.env ?? null, onEvent: channel })
      return {
        write: (data) => invoke('proc_write', { id, data }),
        onLine: (cb) => void lineHandlers.push(cb),
        onExit: (cb) => void exitHandlers.push(cb),
        kill: () => invoke('proc_kill', { id }),
      }
    },

    readTextFile: (path) => invoke<string>('read_text', { path }),
    writeTextFile: (path, content) => invoke('write_text', { path, content }),
    async readBinaryFile(path) {
      return new Uint8Array(await invoke<ArrayBuffer>('read_binary', { path }))
    },
    writeBinaryFile: (path, data) => invoke('write_binary', data, { headers: { 'x-path': path } }),
    removeTemp: (path) => invoke('remove_temp', { path }),
    listDir: (path) => invoke<DirEntry[]>('list_dir', { path }),
    exists: (path) => invoke<boolean>('path_exists', { path }),
    trash: (path) => invoke('trash_path', { path }),
    systemMetrics: () => invoke<SystemMetrics>('system_metrics'),
    frontmostApp: () => invoke<FrontmostApp | null>('frontmost_app'),
    clipboardRead: async () => (await readText().catch(() => '')) ?? '',
    clipboardWrite: (text) => writeText(text),
    async notify(title, body) {
      let granted = await isPermissionGranted()
      if (!granted) granted = (await requestPermission()) === 'granted'
      if (granted) sendNotification({ title, body })
    },
    secretGet: (account) => invoke<string | null>('secret_get', { account }),
  }
}

export const secretSet = (account: string, value: string): Promise<void> => invoke('secret_set', { account, value })
export const secretExists = (account: string): Promise<boolean> => invoke<boolean>('secret_exists', { account })
