mod files;
mod proc;
mod secrets;
mod system;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager};

/// True when the OS started the app at login (silent standby until "Hey Jarvis").
#[tauri::command]
fn launched_at_login() -> bool {
    std::env::args().any(|a| a == "--autostart")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // The standard app menu supplies Edit › Copy/Paste — without it ⌘C/⌘V do nothing in the webview.
        .menu(|app| Menu::default(app))
        .plugin(tauri_plugin_sql::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        // Login item; "--autostart" tells the UI to start as a silent standby orb.
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--autostart"])))
        .manage(proc::Procs::default())
        .manage(system::Sys::default())
        .invoke_handler(tauri::generate_handler![
            proc::exec,
            proc::exec_cancel,
            proc::proc_spawn,
            proc::proc_write,
            proc::proc_kill,
            system::system_metrics,
            system::frontmost_app,
            files::paths,
            files::read_text,
            files::write_text,
            files::read_binary,
            files::write_binary,
            files::list_dir,
            files::path_exists,
            files::trash_path,
            files::remove_temp,
            secrets::secret_get,
            secrets::secret_set,
            secrets::secret_exists,
            launched_at_login,
        ])
        .setup(|app| {
            // Menu-bar resident: JARVIS keeps running when the window is hidden.
            let show = MenuItem::with_id(app, "show", "Open JARVIS", true, None::<&str>)?;
            let ambient = MenuItem::with_id(app, "ambient", "Ambient Orb", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit AOP JARVIS", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &ambient, &quit])?;
            TrayIconBuilder::with_id("jarvis")
                .icon(app.default_window_icon().cloned().ok_or("missing icon")?)
                .icon_as_template(true)
                .tooltip("AOP JARVIS")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    id => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                        let _ = app.emit("tray", id.to_string());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window hides it; the assistant stays resident in the menu bar.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running AOP JARVIS");
}
