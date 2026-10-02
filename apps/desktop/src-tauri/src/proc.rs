//! Process execution for the runtime: one-shot `exec` (argv, no shell) with timeout and
//! cancellation, and long-lived `spawn` with line-streamed stdout (MCP stdio servers).
use serde::Serialize;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::State;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Default)]
pub struct Procs {
    next: AtomicU64,
    cancels: Mutex<HashMap<u64, oneshot::Sender<()>>>,
    children: Mutex<HashMap<u64, (Child, Option<ChildStdin>)>>,
}

#[derive(Serialize)]
pub struct ExecResult {
    code: i32,
    stdout: String,
    stderr: String,
}

/// GUI apps start with a minimal PATH; give children the usual tool locations.
fn base_command(program: &str, args: &[String], cwd: Option<String>, env: Option<HashMap<String, String>>) -> Command {
    let mut cmd = Command::new(program);
    cmd.args(args);
    let home = std::env::var("HOME").unwrap_or_default();
    let path = format!(
        "{home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:{}",
        std::env::var("PATH").unwrap_or_default()
    );
    cmd.env("PATH", path);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    if let Some(vars) = env {
        cmd.envs(vars);
    }
    cmd.kill_on_drop(true);
    cmd
}

async fn read_capped<R: AsyncReadExt + Unpin>(mut r: R) -> String {
    let mut buf = Vec::new();
    let _ = (&mut r).take(MAX_OUTPUT_BYTES as u64).read_to_end(&mut buf).await;
    String::from_utf8_lossy(&buf).into_owned()
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn exec(
    procs: State<'_, Procs>,
    id: Option<u64>,
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    stdin: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<ExecResult, String> {
    let mut cmd = base_command(&program, &args, cwd, None);
    cmd.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("{program}: {e}"))?;
    if let (Some(input), Some(mut pipe)) = (stdin, child.stdin.take()) {
        pipe.write_all(input.as_bytes()).await.map_err(|e| e.to_string())?;
        drop(pipe); // EOF
    }
    let stdout = child.stdout.take().map(|s| tokio::spawn(read_capped(s)));
    let stderr = child.stderr.take().map(|s| tokio::spawn(read_capped(s)));

    let (tx, rx) = oneshot::channel();
    if let Some(id) = id {
        procs.cancels.lock().await.insert(id, tx);
    }
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(120_000));
    let status = tokio::select! {
        s = child.wait() => s.map_err(|e| e.to_string())?.code().unwrap_or(-1),
        _ = tokio::time::sleep(timeout) => { let _ = child.kill().await; 124 }
        _ = rx => { let _ = child.kill().await; 130 }
    };
    if let Some(id) = id {
        procs.cancels.lock().await.remove(&id);
    }
    let out = match stdout { Some(h) => h.await.unwrap_or_default(), None => String::new() };
    let mut err = match stderr { Some(h) => h.await.unwrap_or_default(), None => String::new() };
    if status == 124 {
        err.push_str("\n[timed out]");
    }
    Ok(ExecResult { code: status, stdout: out, stderr: err })
}

#[tauri::command]
pub async fn exec_cancel(procs: State<'_, Procs>, id: u64) -> Result<(), String> {
    if let Some(tx) = procs.cancels.lock().await.remove(&id) {
        let _ = tx.send(());
    }
    Ok(())
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", content = "data", rename_all = "camelCase")]
pub enum ProcEvent {
    Line(String),
    Exit(Option<i32>),
}

#[tauri::command]
pub async fn proc_spawn(
    procs: State<'_, Procs>,
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    on_event: Channel<ProcEvent>,
) -> Result<u64, String> {
    let mut cmd = base_command(&program, &args, cwd, env);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| format!("{program}: {e}"))?;
    let id = procs.next.fetch_add(1, Ordering::Relaxed) + 1_000_000;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stdin = child.stdin.take();
    procs.children.lock().await.insert(id, (child, stdin));
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if on_event.send(ProcEvent::Line(line)).is_err() {
                break;
            }
        }
        let _ = on_event.send(ProcEvent::Exit(None));
    });
    Ok(id)
}

#[tauri::command]
pub async fn proc_write(procs: State<'_, Procs>, id: u64, data: String) -> Result<(), String> {
    let mut children = procs.children.lock().await;
    let (_, stdin) = children.get_mut(&id).ok_or("process not running")?;
    let pipe = stdin.as_mut().ok_or("stdin closed")?;
    pipe.write_all(data.as_bytes()).await.map_err(|e| e.to_string())?;
    pipe.flush().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn proc_kill(procs: State<'_, Procs>, id: u64) -> Result<(), String> {
    if let Some((mut child, _)) = procs.children.lock().await.remove(&id) {
        let _ = child.kill().await;
    }
    Ok(())
}
