//! API keys live in the macOS Keychain (generic passwords under one service), never on disk or in logs.
const SERVICE: &str = "com.aop.jarvis";

fn valid(account: &str) -> Result<(), String> {
    if account.is_empty() || account.len() > 64 || !account.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("invalid secret name".into());
    }
    Ok(())
}

#[tauri::command]
pub fn secret_get(account: String) -> Result<Option<String>, String> {
    valid(&account)?;
    #[cfg(target_os = "macos")]
    {
        match security_framework::passwords::get_generic_password(SERVICE, &account) {
            Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
            Err(e) if e.code() == -25300 => Ok(None), // errSecItemNotFound
            Err(e) => Err(e.to_string()),
        }
    }
    #[cfg(not(target_os = "macos"))]
    Ok(None)
}

#[tauri::command]
pub fn secret_set(account: String, value: String) -> Result<(), String> {
    valid(&account)?;
    #[cfg(target_os = "macos")]
    {
        if value.is_empty() {
            let _ = security_framework::passwords::delete_generic_password(SERVICE, &account);
            return Ok(());
        }
        security_framework::passwords::set_generic_password(SERVICE, &account, value.as_bytes()).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    Err("keychain unavailable".into())
}

#[tauri::command]
pub fn secret_exists(account: String) -> Result<bool, String> {
    Ok(secret_get(account)?.is_some())
}
