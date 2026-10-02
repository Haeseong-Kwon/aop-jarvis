//! Real system telemetry and workspace awareness (no randomized values, ever).
use serde::Serialize;
use std::sync::Mutex;
use sysinfo::{Disks, System};
use tauri::State;

pub struct Sys(pub Mutex<System>);

impl Default for Sys {
    fn default() -> Self {
        let mut sys = System::new();
        sys.refresh_cpu_usage();
        Sys(Mutex::new(sys))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Battery {
    percent: f64,
    charging: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    cpu_percent: f32,
    mem_used_bytes: u64,
    mem_total_bytes: u64,
    swap_used_bytes: u64,
    disk_used_bytes: u64,
    disk_total_bytes: u64,
    battery: Option<Battery>,
    uptime_sec: u64,
    process_count: usize,
}

/// `pmset -g batt` is the documented CLI surface for battery state on macOS.
fn battery() -> Option<Battery> {
    let out = std::process::Command::new("/usr/bin/pmset").args(["-g", "batt"]).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let pct = text.split('\t').nth(1)?.split('%').next()?.trim().parse::<f64>().ok()?;
    Some(Battery { percent: pct, charging: text.contains("AC Power") })
}

#[tauri::command]
pub fn system_metrics(sys: State<'_, Sys>) -> Result<Metrics, String> {
    let mut s = sys.0.lock().map_err(|e| e.to_string())?;
    // CPU usage is a delta between refreshes; the poller calls this periodically.
    s.refresh_cpu_usage();
    s.refresh_memory();
    s.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let disks = Disks::new_with_refreshed_list();
    let root = disks.list().iter().find(|d| d.mount_point() == std::path::Path::new("/"));
    let (total, avail) = root.map(|d| (d.total_space(), d.available_space())).unwrap_or((0, 0));
    Ok(Metrics {
        cpu_percent: s.global_cpu_usage(),
        mem_used_bytes: s.used_memory(),
        mem_total_bytes: s.total_memory(),
        swap_used_bytes: s.used_swap(),
        disk_used_bytes: total.saturating_sub(avail),
        disk_total_bytes: total,
        battery: battery(),
        uptime_sec: System::uptime(),
        process_count: s.processes().len(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontApp {
    name: String,
    bundle_id: Option<String>,
    pid: i32,
}

/// NSWorkspace.frontmostApplication — needs no Accessibility permission.
#[tauri::command]
pub fn frontmost_app() -> Option<FrontApp> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSWorkspace;
        let ws = NSWorkspace::sharedWorkspace();
        let app = ws.frontmostApplication()?;
        let name = app.localizedName().map(|s| s.to_string()).unwrap_or_default();
        let bundle_id = app.bundleIdentifier().map(|s| s.to_string());
        Some(FrontApp { name, bundle_id, pid: app.processIdentifier() })
    }
    #[cfg(not(target_os = "macos"))]
    None
}
