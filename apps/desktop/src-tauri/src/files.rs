//! File access for the runtime. Policy (risk, approval) lives in the TypeScript tool layer;
//! this layer adds the hard guards that must never depend on the webview: temp-only deletion
//! and Trash instead of unlink.
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager};

const MAX_TEXT_BYTES: u64 = 20 * 1024 * 1024;

pub fn temp_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("tmp");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Paths {
    home: String,
    temp: String,
    data: String,
}

#[tauri::command]
pub fn paths(app: AppHandle) -> Result<Paths, String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    Ok(Paths {
        home: std::env::var("HOME").map_err(|e| e.to_string())?,
        temp: temp_dir(&app)?.to_string_lossy().into_owned(),
        data: data.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub async fn read_text(path: String) -> Result<String, String> {
    let meta = tokio::fs::metadata(&path).await.map_err(|e| format!("{path}: {e}"))?;
    if meta.len() > MAX_TEXT_BYTES {
        return Err(format!("{path}: file too large ({} bytes)", meta.len()));
    }
    let bytes = tokio::fs::read(&path).await.map_err(|e| format!("{path}: {e}"))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
pub async fn write_text(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
    }
    tokio::fs::write(&path, content).await.map_err(|e| format!("{path}: {e}"))
}

/// Raw bytes out (audio files) without JSON-encoding them.
#[tauri::command]
pub async fn read_binary(path: String) -> Result<Response, String> {
    let bytes = tokio::fs::read(&path).await.map_err(|e| format!("{path}: {e}"))?;
    Ok(Response::new(bytes))
}

/// Raw bytes in: body is the file content, the path travels in a header.
#[tauri::command]
pub async fn write_binary(request: Request<'_>) -> Result<(), String> {
    let path = request.headers().get("x-path").and_then(|v| v.to_str().ok()).ok_or("missing x-path header")?.to_string();
    let InvokeBody::Raw(bytes) = request.body() else { return Err("expected raw body".into()) };
    tokio::fs::write(&path, bytes).await.map_err(|e| format!("{path}: {e}"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    name: String,
    is_dir: bool,
}

#[tauri::command]
pub async fn list_dir(path: String) -> Result<Vec<Entry>, String> {
    let mut out = Vec::new();
    let mut rd = tokio::fs::read_dir(&path).await.map_err(|e| format!("{path}: {e}"))?;
    while let Some(e) = rd.next_entry().await.map_err(|e| e.to_string())? {
        let is_dir = e.file_type().await.map(|t| t.is_dir()).unwrap_or(false);
        out.push(Entry { name: e.file_name().to_string_lossy().into_owned(), is_dir });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[tauri::command]
pub async fn path_exists(path: String) -> bool {
    tokio::fs::try_exists(&path).await.unwrap_or(false)
}

/// Deletion is always recoverable: Finder Trash, never unlink.
#[tauri::command]
pub async fn trash_path(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || trash::delete(&path).map_err(|e| e.to_string())).await.map_err(|e| e.to_string())?
}

/// The only hard delete, confined to this app's temp directory.
#[tauri::command]
pub async fn remove_temp(app: AppHandle, path: String) -> Result<(), String> {
    let dir = temp_dir(&app)?.canonicalize().map_err(|e| e.to_string())?;
    let target = Path::new(&path).canonicalize().map_err(|e| e.to_string())?;
    if !target.starts_with(&dir) {
        return Err(format!("refusing to delete outside temp dir: {path}"));
    }
    tokio::fs::remove_file(target).await.map_err(|e| e.to_string())
}
