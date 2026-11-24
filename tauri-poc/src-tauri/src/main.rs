#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Serialize;
use std::collections::HashMap;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::ContextMenu;
// Tray is removed: no TrayIconEvent handling needed.
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow, WindowEvent};

mod application_menu_spec;
mod authorized_roots;
// Disabled in this fork — the `poc_*` commands that would consume these
// modules are commented out of `invoke_handler!`. Keeping the files on disk
// makes a targeted revert cheap; removing them from compilation keeps the
// binary small.
// mod agent_awake;
// mod ai_vault_delete;
mod browser_cdp_events;
// mod browser_client_route_authority;
// mod browser_client_route_partitions;
// mod browser_client_route_sources;
// mod browser_cookie_import;
// mod browser_cookie_source_import;
mod browser_identity;
// mod browser_session;
// mod browser_session_detection;
// mod browser_upload_staging;
mod browser_webview;
mod clipboard_files;
mod code_lsp;
mod code_lsp_convert;
mod code_lsp_servers;
mod code_lsp_uri;
mod code_nav_fallback;
mod crash_reports;
mod debug_adapters;
mod debug_dap;
mod debug_launch_discovery;
// mod desktop_away_state;
mod diagnostics;
mod doc_preview;
mod external_editor;
// mod feature_wall;
mod filesystem_download;
mod filesystem_import;
mod filesystem_io;
mod filesystem_search;
mod filesystem_upload;
mod git_inspection;
// mod keybindings_file;
// mod local_log_tail;
mod menu_appearance;
// mod host_memory;
mod menu_hints;
mod minidump;
mod runtime_process;
mod runtime_readiness;
mod second_instance;
// mod settings_theme_directories;
mod shell_availability;
mod system_fonts;
mod workflow_command;
// mod system_tray;
// mod terminal_desync;
// mod updater;
mod window_state;
// mod windows_admin;
// mod workspace_space;

use application_menu_spec::{application_menu_bar, ids, MenuEntry, MenuPlatform};
use runtime_process::OrcadRuntime;
use second_instance::{
    resolve_opened_documents, OpenedDocument, SecondInstancePayload, SecondInstanceState,
};
use window_state::WindowStateSaver;

// Why 10 MiB: main caps custom notification sounds at MAX_NOTIFICATION_SOUND_BYTES.

/// Renderer-emitted events mirror the Electron IPC channel names so the shared
/// web preload can subscribe without a second, Tauri-only contract.
const EVENT_MAXIMIZE_CHANGED: &str = "window:maximize-changed";
const EVENT_FULLSCREEN_CHANGED: &str = "window:fullscreen-changed";
const EVENT_WINDOW_CLOSE_REQUESTED: &str = "window:close-requested";
const EVENT_TERMINAL_ZOOM: &str = "terminal:zoom";

/// UI zoom level bookkeeping for non-main windows (Workspace Space, dashboard
/// popout). The main renderer persists its own level through `window.api.ui`,
/// but secondary windows have no settings store, so the menu handler keeps a
/// per-window log-scale level here and pushes `1.2^level` through `set_zoom`.
/// Mirrors `src/shared/ui-zoom-level.ts`.
const UI_ZOOM_BASE: f64 = 1.2;
const UI_ZOOM_STEP: f64 = 0.5;
const UI_ZOOM_MIN: f64 = -3.0;
const UI_ZOOM_MAX: f64 = 5.0;

fn window_zoom_levels() -> &'static Mutex<HashMap<String, f64>> {
    static MAP: LazyLock<Mutex<HashMap<String, f64>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));
    &MAP
}

fn step_ui_zoom_level(current: f64, direction: &str) -> f64 {
    if direction == "reset" {
        return 0.0;
    }
    let next = if direction == "in" {
        current + UI_ZOOM_STEP
    } else {
        current - UI_ZOOM_STEP
    };
    next.clamp(UI_ZOOM_MIN, UI_ZOOM_MAX)
}
/// Recover the log-scale level for a raw zoom factor, so `poc_set_zoom` calls
/// that only carry the factor still keep the per-window map current.
fn zoom_level_for_factor(scale_factor: f64) -> Option<f64> {
    if !scale_factor.is_finite() || scale_factor <= 0.0 {
        return None;
    }
    Some(scale_factor.ln() / UI_ZOOM_BASE.ln())
}

/// The zoom factor a window is currently showing: the tracked level mapped
/// through the shared base, 100% when nothing was ever set.
fn zoom_factor_for_level(level: f64) -> f64 {
    UI_ZOOM_BASE.powf(level)
}

/// Apply a menu zoom step to whichever window currently has focus, matching
/// Electron's `zoomDashboardPopoutIfFocused`/`zoomWorkspaceSpaceWindowIfFocused`
/// chain. Secondary windows zoom their own webview; the main window routes the
/// step to the shared `terminal:zoom` listener so it can pick UI zoom vs
/// editor font zoom vs PDF zoom itself.
fn route_menu_zoom(app: &AppHandle, direction: &str) {
    let secondary_labels = ["workspace-space", "dashboard-popout"];
    for label in secondary_labels {
        if let Some(window) = app.get_webview_window(label) {
            if window.is_focused().unwrap_or(false) {
                let levels = window_zoom_levels();
                let mut map = levels.lock().unwrap_or_else(|p| p.into_inner());
                let current = *map.get(label).unwrap_or(&0.0);
                let next = step_ui_zoom_level(current, direction);
                map.insert(label.to_string(), next);
                drop(map);
                let _ = window.set_zoom(UI_ZOOM_BASE.powf(next));
                return;
            }
        }
    }
    emit_menu_event(app, EVENT_TERMINAL_ZOOM, direction);
}

/// The zoom level the main window most recently reported through
/// `poc_set_zoom`, used to seed a newly opened secondary window so it matches
/// the app-wide zoom the moment it mounts (Electron's `dom-ready` handler).
#[allow(dead_code)]
fn main_window_zoom_level() -> f64 {
    let map = window_zoom_levels();
    map.lock()
        .ok()
        .and_then(|levels| levels.get("main").copied())
        .unwrap_or(0.0)
}

/// Seed the label zoom map slot from the main window latest level.
/// Called by secondary-window openers so the new window honors app-wide zoom.
/// Only the map slot is seeded here; the factor lands on page load.
#[allow(dead_code)]
pub(crate) fn seed_secondary_window_zoom_level(label: &str) {
    let level = main_window_zoom_level();
    if let Ok(mut levels) = window_zoom_levels().lock() {
        levels.insert(label.to_string(), level);
    }
}
/// Push the seeded level through set_zoom. Call only once the page has loaded,
/// never synchronously after build: set_zoom on a just-built window can block
/// until the webview answers, wedging the invoke and every later one.
#[allow(dead_code)]
pub(crate) fn apply_seeded_secondary_window_zoom(app: &AppHandle, label: &str) {
    let level = window_zoom_levels()
        .lock()
        .ok()
        .and_then(|levels| levels.get(label).copied())
        .unwrap_or(0.0);
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.set_zoom(UI_ZOOM_BASE.powf(level));
    }
}

struct NativeWindowState {
    close_confirmed: AtomicBool,
    close_request_sequence: AtomicU64,
    last_maximized: AtomicBool,
    last_fullscreen: AtomicBool,
    /// Set once the native window is destroyed so a racing debounce save
    /// cannot resurrect bounds after teardown, like Electron freeze on quit.
    window_closed: AtomicBool,
}

impl Default for NativeWindowState {
    fn default() -> Self {
        Self {
            close_confirmed: AtomicBool::new(false),
            close_request_sequence: AtomicU64::new(0),
            last_maximized: AtomicBool::new(false),
            last_fullscreen: AtomicBool::new(false),
            window_closed: AtomicBool::new(false),
        }
    }
}

impl NativeWindowState {
    fn confirm_close(&self) {
        self.close_confirmed.store(true, Ordering::SeqCst);
    }
}

#[derive(Debug, Serialize)]
struct HostInfo {
    host: &'static str,
    transport: &'static str,
    runtime: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileDataUrl {
    data_url: String,
    file_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativePlatformInfo {
    platform: &'static str,
    os_release: String,
    arch: &'static str,
    shell: String,
    display_server: Option<&'static str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeAppIdentity {
    name: String,
    is_dev: bool,
    dev_label: Option<String>,
    dev_branch: Option<String>,
    dev_worktree_name: Option<String>,
    dev_repo_root: Option<String>,
    dock_badge_label: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloseRequestedPayload {
    is_quitting: bool,
    request_id: u64,
}

#[tauri::command]
fn poc_host_info() -> HostInfo {
    HostInfo {
        host: "tauri",
        transport: "rust-command",
        runtime: "Tauri 2",
    }
}

#[tauri::command]
fn poc_platform_info() -> NativePlatformInfo {
    NativePlatformInfo {
        platform: current_platform(),
        os_release: std::env::var("OS").unwrap_or_default(),
        arch: std::env::consts::ARCH,
        shell: std::env::var("ComSpec")
            .or_else(|_| std::env::var("SHELL"))
            .map(|value| value.trim().to_owned())
            .unwrap_or_default(),
        display_server: None,
    }
}

fn current_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        platform => platform,
    }
}

#[tauri::command]
fn poc_app_identity() -> NativeAppIdentity {
    let repo_root = std::env::var("ORCA_DEV_REPO_ROOT").ok().or_else(|| {
        std::env::current_dir()
            .ok()
            .map(|path| path.to_string_lossy().into_owned())
    });
    let branch = std::env::var("ORCA_DEV_BRANCH").ok();
    let worktree_name = std::env::var("ORCA_DEV_WORKTREE_NAME").ok();
    NativeAppIdentity {
        name: branch
            .as_ref()
            .map(|branch| format!("Orca: {branch}"))
            .unwrap_or_else(|| "Orca Dev".to_string()),
        is_dev: true,
        dev_label: branch.clone().or_else(|| worktree_name.clone()),
        dev_branch: branch,
        dev_worktree_name: worktree_name,
        dev_repo_root: repo_root,
        dock_badge_label: None,
    }
}

#[tauri::command]
fn poc_path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

/// Why the cap here too: the renderer validates first, but the native boundary
/// refuses oversized batches itself, exactly like main's validatePathExistenceBatch.
const PATH_EXISTENCE_BATCH_MAX: usize = 128;

#[tauri::command]
fn poc_paths_exist(paths: Vec<String>) -> Result<Vec<bool>, String> {
    if paths.len() > PATH_EXISTENCE_BATCH_MAX {
        return Err("Invalid path existence batch".to_string());
    }
    Ok(paths.iter().map(|path| Path::new(path).exists()).collect())
}

#[tauri::command]
fn poc_copy_file(src_path: String, dest_path: String) -> Result<(), String> {
    let source = Path::new(&src_path);
    let destination = Path::new(&dest_path);
    if !source.is_absolute() || !destination.is_absolute() {
        return Err("Both source and destination must be absolute paths".to_string());
    }
    // Why create_new: claim the destination atomically like COPYFILE_EXCL, so a
    // concurrent creation fails instead of being silently overwritten.
    let mut staged = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                return "Destination file already exists.".to_string();
            }
            error.to_string()
        })?;
    let outcome: Result<(), String> = (|| {
        // Why the cleanup below: a failed copy must not leave a half-written file.
        let mut origin = fs::File::open(source).map_err(|error| error.to_string())?;
        std::io::copy(&mut origin, &mut staged).map_err(|error| error.to_string())?;
        let permissions = origin
            .metadata()
            .map_err(|error| error.to_string())?
            .permissions();
        fs::set_permissions(destination, permissions).map_err(|error| error.to_string())?;
        Ok(())
    })();
    drop(staged);
    if outcome.is_err() {
        let _ = fs::remove_file(destination);
    }
    outcome
}

#[tauri::command]
fn poc_read_file_data_url(path: String) -> Result<FileDataUrl, String> {
    const MAX_ICON_BYTES: u64 = 256 * 1024;
    let source = Path::new(&path);
    if source
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| !extension.eq_ignore_ascii_case("png"))
        .unwrap_or(true)
    {
        return Err("Repo icons must be PNG files.".to_string());
    }
    let metadata = fs::metadata(source).map_err(|error| error.to_string())?;
    // Why no is_file gate: Electron stats the size and lets readFile fail on a
    // directory, so a crafted invoke surfaces the OS error instead of the size message.
    if metadata.len() > MAX_ICON_BYTES {
        return Err("Repo icon image must be 256KB or smaller.".to_string());
    }
    let bytes = fs::read(source).map_err(|error| error.to_string())?;
    let file_name = source
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| "Selected file has no file name.".to_string())?;
    Ok(FileDataUrl {
        data_url: format!("data:image/png;base64,{}", BASE64.encode(bytes)),
        file_name,
    })
}

#[tauri::command]
fn poc_is_maximized(window: WebviewWindow) -> Result<bool, String> {
    window.is_maximized().map_err(|error| error.to_string())
}

/// Distinguishes hide-to-tray from taskbar minimize in live checks: hide
/// leaves the window unminimized while minimize sets the flag.
#[tauri::command]
fn poc_is_minimized(window: WebviewWindow) -> Result<bool, String> {
    window.is_minimized().map_err(|error| error.to_string())
}

#[tauri::command]
fn poc_minimize(window: WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())
}

/// Native OS close path consults this before prompting, mirroring the Electron
/// hideToTrayIfEnabled guard: Windows only, setting pushed from the renderer,
/// and no confirmed close pending.
#[allow(dead_code)]
fn close_should_hide_to_tray(state: &NativeWindowState) -> bool {
    // Tray removed: never hide on close. Kept so the CloseRequested branch and
    // unit tests keep compiling — just returns false.
    let _ = state;
    false
}

#[tauri::command]
fn poc_toggle_maximize(window: WebviewWindow) -> Result<(), String> {
    let maximized = window.is_maximized().map_err(|error| error.to_string())?;
    if maximized {
        window.unmaximize()
    } else {
        window.maximize()
    }
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn poc_set_zoom(
    window: WebviewWindow,
    scale_factor: f64,
    zoom_level: Option<f64>,
) -> Result<(), String> {
    if !scale_factor.is_finite() || !(0.1..=10.0).contains(&scale_factor) {
        return Err("Zoom scale factor is outside the supported range.".to_string());
    }
    // Why: the renderer knows the log-scale level it just applied; tracking it
    // here keeps the per-window map in step with explicit
    // `window.api.ui.setZoomLevel` calls from secondary windows. A bare factor
    // still records its derived level so `poc_get_zoom` round-trips.
    let tracked = match zoom_level {
        Some(level) if level.is_finite() => Some(level),
        _ => zoom_level_for_factor(scale_factor),
    };
    if let Some(level) = tracked {
        if let Ok(mut levels) = window_zoom_levels().lock() {
            levels.insert(window.label().to_string(), level);
        }
    }
    window
        .set_zoom(scale_factor)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn poc_get_zoom(window: WebviewWindow) -> Result<f64, String> {
    // Why: Tauri exposes no webview zoom getter and `scale_factor()` reports
    // the monitor DPI, not the zoom `set_zoom` applied — so the command
    // answers from the per-window level both setters keep current, defaulting
    // to 100% like Electron's `webFrame.getZoomFactor()`.
    let level = window_zoom_levels()
        .lock()
        .ok()
        .and_then(|levels| levels.get(window.label()).copied())
        .unwrap_or(0.0);
    Ok(zoom_factor_for_level(level))
}

/// Matches Electron's `ui:window-revealed`: repaint the webview without
/// activating the window, which keeps background validation off screen.
#[tauri::command]
fn poc_set_focus(window: WebviewWindow) {
    let _ = window.eval("window.dispatchEvent(new Event('resize'));");
}

#[tauri::command]
fn poc_request_close(window: WebviewWindow, state: State<Arc<NativeWindowState>>) {
    // Why: the renderer-drawn X never reaches the native close event, so the
    // handshake starts here exactly as Electron's `window:request-close` does.
    emit_close_request(&window, &state, false);
}

#[tauri::command]
fn poc_confirm_close(window: WebviewWindow, state: State<Arc<NativeWindowState>>) {
    state.inner().confirm_close();
    let _ = window.destroy();
}

fn emit_close_request(window: &WebviewWindow, state: &NativeWindowState, is_quitting: bool) {
    let request_id = state.close_request_sequence.fetch_add(1, Ordering::SeqCst) + 1;
    let _ = window.emit(
        EVENT_WINDOW_CLOSE_REQUESTED,
        CloseRequestedPayload {
            is_quitting,
            request_id,
        },
    );
}

#[tauri::command]
fn poc_popup_menu(window: WebviewWindow) -> Result<(), String> {
    // Why: Electron's `popupMenu` command pops the *application* menu
    // (`Menu.getApplicationMenu().popup({ window })`), not a context menu.
    // Reusing the installed bar keeps accelerators, hints, locale labels and
    // Appearance checkmarks identical between the two entry points.
    let app = window.app_handle();
    let menu = app
        .menu()
        .ok_or_else(|| "application menu is unavailable".to_string())?;
    menu.popup(window.as_ref().window())
        .map_err(|error| error.to_string())
}

/// Mirrors `validateNativeFileDropPaths` in the shared renderer contract: a
/// bounded count and byte budget, no filesystem ownership widening. The native
/// boundary is strict on top: relative paths are refused, and empties and
/// duplicates never seen in real OS drops are normalized instead of forwarded.
#[tauri::command]
fn poc_validate_dropped_paths(paths: Vec<String>) -> Result<Vec<String>, String> {
    const MAX_PATHS: usize = 256;
    const MAX_PATH_BYTES: usize = 256 * 1024;
    if paths.len() > MAX_PATHS {
        return Err("too-many-paths".to_string());
    }
    let mut byte_length = 0usize;
    let mut seen = HashSet::with_capacity(paths.len());
    let mut accepted = Vec::with_capacity(paths.len());
    for path in paths {
        if path.is_empty() {
            continue;
        }
        let normalized = PathBuf::from(&path);
        if !normalized.is_absolute() {
            return Err("invalid-path".to_string());
        }
        byte_length += path.len();
        if byte_length > MAX_PATH_BYTES {
            return Err("paths-too-large".to_string());
        }
        let key = normalized.to_string_lossy().into_owned();
        if seen.insert(key) {
            accepted.push(path);
        }
    }
    Ok(accepted)
}

fn apply_background_launch_visibility(app: &AppHandle) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };

    if std::env::var("ORCA_BACKGROUND_LAUNCH").as_deref() == Ok("1") {
        window.hide()?;
    }

    Ok(())
}

fn install_window_state_bridge(
    window: &WebviewWindow,
    state: Arc<NativeWindowState>,
    saver: Arc<WindowStateSaver>,
) {
    let window_handle = window.clone();
    let saver_handle = Arc::clone(&saver);
    window.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            if state.close_confirmed.swap(false, Ordering::SeqCst) {
                return;
            }
            // Why: Electron lets the renderer protect running terminals and
            // unsaved editors; Alt+F4 and OS close must go through the same gate.
            api.prevent_close();
            emit_close_request(&window_handle, &state, false);
        }
        WindowEvent::Resized(_) => {
            let Ok(maximized) = window_handle.is_maximized() else {
                return;
            };
            if state.last_maximized.swap(maximized, Ordering::SeqCst) != maximized {
                let _ = window_handle.emit(EVENT_MAXIMIZE_CHANGED, maximized);
            }
            let Ok(fullscreen) = window_handle.is_fullscreen() else {
                return;
            };
            if state.last_fullscreen.swap(fullscreen, Ordering::SeqCst) != fullscreen {
                let _ = window_handle.emit(EVENT_FULLSCREEN_CHANGED, fullscreen);
            }
            let closing = state.close_confirmed.load(Ordering::SeqCst)
                || state.window_closed.load(Ordering::SeqCst);
            window_state::note_window_moved_or_resized(&saver_handle, &window_handle, closing);
        }
        WindowEvent::Moved(_) => {
            // Why: Electron persists bounds on move and resize through a 500ms
            // debounce, so the check command only observes a settled save.
            let closing = state.close_confirmed.load(Ordering::SeqCst)
                || state.window_closed.load(Ordering::SeqCst);
            window_state::note_window_moved_or_resized(&saver_handle, &window_handle, closing);
        }
        WindowEvent::Destroyed => {
            state.window_closed.store(true, Ordering::SeqCst);
            saver_handle.mark_closed();
        }
        _ => {}
    });
}

/// Second-launch argv delivered while this process owns the single-instance
/// lock. The renderer pulls them through `poc_consume_second_instance_events`
/// and resolves OS-opened documents through `poc_resolve_opened_documents`.
const EVENT_SECOND_INSTANCE: &str = "app:second-instance";

/// Exit code the development supervisor treats as "rebuild and restart"
/// instead of a shutdown, keeping Vite alive across the relaunch.
const DEV_RESTART_EXIT_CODE: i32 = 75;

#[derive(Default)]
struct PendingOpenSettingsState {
    pending: Mutex<bool>,
}

impl PendingOpenSettingsState {
    fn mark(&self) {
        if let Ok(mut pending) = self.pending.lock() {
            *pending = true;
        }
    }

    fn consume(&self) -> bool {
        self.pending
            .lock()
            .map(|mut pending| std::mem::replace(&mut *pending, false))
            .unwrap_or(false)
    }
}

fn reveal_main_window(app: &AppHandle) {
    // Why: notifications, second launches and the tray surface the running
    // window instead of booting a second process against the same profile.
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

#[tauri::command]
fn poc_reveal_window(app: AppHandle) {
    reveal_main_window(&app);
}

#[tauri::command]
fn poc_relaunch(_app: AppHandle, runtime: State<Arc<OrcadRuntime>>) {
    // Why: relaunch must not orphan the owned Node runtime, so it waits for
    // the graceful shutdown first. Exiting with the restart code (instead of
    // an in-place restart) lets the development supervisor rebuild before
    // the new process starts and keeps Vite alive across the relaunch.
    let runtime = Arc::clone(runtime.inner());
    let _ = runtime.close_owner_and_wait(Duration::from_secs(10));
    std::process::exit(DEV_RESTART_EXIT_CODE);
}

// Why: Electron's Force Reload bypasses the HTTP cache
// (webContents.reloadIgnoringCache); WebView2 exposes no such call, so drive
// CDP Page.reload with ignoreCache — the same mechanism the guest
// reloadIgnoringCache path already uses. Non-Windows reports unsupported and
// the menu falls back to a plain reload.
const MAIN_FORCE_RELOAD_CDP_METHOD: &str = "Page.reload";
const MAIN_FORCE_RELOAD_CDP_PARAMS: &str = r#"{"ignoreCache":true}"#;

#[tauri::command]
async fn poc_main_force_reload(app: AppHandle) -> Result<serde_json::Value, String> {
    let Some(webview) = app.get_webview("main") else {
        return Err("main webview is no longer available".to_string());
    };
    browser_webview::call_browser_devtools_protocol(
        webview,
        MAIN_FORCE_RELOAD_CDP_METHOD,
        MAIN_FORCE_RELOAD_CDP_PARAMS.to_string(),
    )
    .await
}

#[tauri::command]
fn poc_consume_second_instance_events(
    state: State<SecondInstanceState>,
) -> Vec<SecondInstancePayload> {
    state.consume()
}

#[tauri::command]
fn poc_resolve_opened_documents(paths: Vec<String>) -> Vec<OpenedDocument> {
    resolve_opened_documents(paths)
}

#[tauri::command]
fn poc_consume_pending_open_settings(state: State<PendingOpenSettingsState>) -> bool {
    state.consume()
}

fn handle_second_instance_launch(app: &AppHandle, argv: &[String], cwd: &str) {
    // Why: a second OS launch reuses this process so it cannot clobber the
    // stores owned by the running runtime; its argv still reaches the
    // renderer for skill-share links and OS-opened documents.
    if let Some(state) = app.try_state::<SecondInstanceState>() {
        let payload = state.record(argv.to_vec(), cwd.to_owned());
        let _ = app.emit(EVENT_SECOND_INSTANCE, &payload);
    }
    if argv.iter().any(|arg| arg == "--open-settings") {
        if let Some(pending) = app.try_state::<PendingOpenSettingsState>() {
            pending.mark();
        }
    }
    if std::env::var("ORCA_BACKGROUND_LAUNCH").as_deref() != Ok("1") {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

fn emit_menu_event(app: &AppHandle, channel: &str, payload: impl Serialize + Clone) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit(channel, payload);
    } else {
        let _ = app.emit(channel, payload);
    }
}

/// Route a renderer-bound menu event to whichever window is focused, falling
/// back to the main window. Mirrors Electron's `resolveMenuTargetRenderer` —
/// the popup window the user was looking at gets Setup/Feature-Tour/Crash
/// Report/Check-For-Updates, not whichever window happened to be created first.
fn emit_menu_event_focused(app: &AppHandle, channel: &str, payload: impl Serialize + Clone) {
    for (_label, window) in app.webview_windows() {
        if window.is_focused().unwrap_or(false) {
            let _ = window.emit(channel, payload);
            return;
        }
    }
    emit_menu_event(app, channel, payload);
}

/// Route a menu edit action (copy/selectAll/paste) into the focused browser
/// guest when one holds DOM focus, matching Electron's
/// `webContents.getFocusedWebContents()` → `contents.copy()/selectAll()/paste()`
/// branch. Falls back to the shared renderer event when no guest claims focus.
fn route_browser_guest_edit(app: &AppHandle, command: &str) -> bool {
    let state = match app.try_state::<browser_webview::BrowserWebviewState>() {
        Some(state) => state,
        None => return false,
    };
    browser_webview::route_guest_edit(app, &state, command)
}

/// Modifier state at the instant a "Check for Updates" menu item fires.
/// `MenuEvent` carries no modifier bits, so Windows reads them out of
/// `GetAsyncKeyState`; other platforms report none. Mirrors Electron's
/// hidden modifier-click affordances in `checkForUpdatesClick`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckForUpdatesMenuOptions {
    include_prerelease: bool,
    include_perf_prerelease: bool,
    local_build: bool,
}

fn check_for_updates_menu_options() -> CheckForUpdatesMenuOptions {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
            GetAsyncKeyState, VK_CONTROL, VK_SHIFT,
        };
        let down = |key: u16| unsafe { GetAsyncKeyState(key as i32) } & (0x8000u16 as i16) != 0;
        // Why no Alt on Windows: Electron only gives Alt the local-build
        // meaning on macOS; off macOS it is not a modifier-click variant.
        return CheckForUpdatesMenuOptions {
            include_prerelease: down(VK_SHIFT),
            include_perf_prerelease: down(VK_CONTROL),
            local_build: false,
        };
    }
    #[cfg(not(windows))]
    {
        // Why none here: on macOS the AppKit menu action can read
        // `NSEvent::modifierFlags`, but no Cocoa binding exists in this shell
        // yet; Linux has no standard modifier query at menu-click time.
        CheckForUpdatesMenuOptions {
            include_prerelease: false,
            include_perf_prerelease: false,
            local_build: false,
        }
    }
}

fn handle_menu_event(app: &AppHandle, event: &tauri::menu::MenuEvent) {
    // Why: every spec entry either acts on the window directly or forwards to
    // the renderer event the Tauri preload bridge already listens for.
    let id = event.id();
    if id == ids::FILE_SETTINGS {
        if let Some(pending) = app.try_state::<PendingOpenSettingsState>() {
            pending.mark();
        }
        emit_menu_event(app, "orca:tauri-ui:openSettings", ());
    } else if id == ids::FILE_QUIT {
        if let Some(runtime) = app.try_state::<Arc<OrcadRuntime>>() {
            runtime.close_owner();
        }
        app.exit(0);
    } else if id == ids::EDIT_PASTE {
        if !route_browser_guest_edit(app, "paste") {
            emit_menu_event(app, "orca:tauri-ui:appMenuPaste", ());
        }
    } else if id == ids::EDIT_SELECT_ALL {
        if !route_browser_guest_edit(app, "selectAll") {
            emit_menu_event(app, "orca:tauri-ui:appMenuSelectionAction", "select-all");
        }
    } else if id == ids::EDIT_COPY {
        if !route_browser_guest_edit(app, "copy") {
            emit_menu_event(app, "orca:tauri-ui:appMenuSelectionAction", "copy");
        }
    } else if id == ids::EDIT_UNDO {
        emit_menu_event(app, "orca:tauri-ui:appMenuEditAction", "undo");
    } else if id == ids::EDIT_REDO {
        emit_menu_event(app, "orca:tauri-ui:appMenuEditAction", "redo");
    } else if id == ids::VIEW_RELOAD {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.eval("window.location.reload();");
        }
    } else if id == ids::VIEW_FORCE_RELOAD {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if poc_main_force_reload(app.clone()).await.is_err() {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.eval("window.location.reload();");
                }
            }
        });
    } else if id == ids::VIEW_TOGGLE_DEVTOOLS {
        #[cfg(any(debug_assertions, feature = "devtools"))]
        if let Some(window) = app.get_webview_window("main") {
            window.open_devtools();
        }
    } else if id == ids::VIEW_ZOOM_IN {
        route_menu_zoom(app, "in");
    } else if id == ids::VIEW_ZOOM_OUT {
        route_menu_zoom(app, "out");
    } else if id == ids::VIEW_ZOOM_RESET {
        route_menu_zoom(app, "reset");
    } else if id == ids::VIEW_TOGGLE_LEFT_SIDEBAR {
        emit_menu_event(app, "orca:tauri-ui:toggleLeftSidebar", ());
    } else if id == ids::VIEW_TOGGLE_RIGHT_SIDEBAR {
        emit_menu_event(app, "orca:tauri-ui:toggleRightSidebar", ());
    } else if id == ids::VIEW_TOGGLE_WORKTREE_PALETTE {
        emit_menu_event(app, "orca:tauri-ui:toggleWorktreePalette", ());
    } else if id == ids::VIEW_TOGGLE_STATUS_BAR {
        emit_menu_event(app, "orca:tauri-ui:toggleStatusBar", ());
    } else if id == ids::VIEW_APPEARANCE_TASKS {
        emit_menu_event(app, "orca:tauri-ui:toggleAppearance", "showTasksButton");
    } else if id == ids::VIEW_APPEARANCE_AUTOMATIONS {
        emit_menu_event(
            app,
            "orca:tauri-ui:toggleAppearance",
            "showAutomationsButton",
        );
    } else if id == ids::VIEW_APPEARANCE_MOBILE {
        emit_menu_event(app, "orca:tauri-ui:toggleAppearance", "showMobileButton");
    } else if id == ids::VIEW_APPEARANCE_TITLEBAR {
        emit_menu_event(app, "orca:tauri-ui:toggleAppearance", "showTitlebarAppName");
    } else if id == ids::VIEW_TOGGLE_FULLSCREEN {
        if let Some(window) = app.get_webview_window("main") {
            if let Ok(fullscreen) = window.is_fullscreen() {
                let _ = window.set_fullscreen(!fullscreen);
            }
        }
    } else if id == ids::WINDOW_MINIMIZE {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.minimize();
        }
    } else if id == ids::WINDOW_ZOOM {
        if let Some(window) = app.get_webview_window("main") {
            // Why: macOS `zoom` toggles the window's user zoom state, which is
            // the same "maximize/restore" pair Tauri exposes through
            // maximize/unmaximize on other platforms.
            if let Ok(maximized) = window.is_maximized() {
                if maximized {
                    let _ = window.unmaximize();
                } else {
                    let _ = window.maximize();
                }
            }
        }
    } else if id == ids::HELP_CRASH_REPORT {
        emit_menu_event_focused(app, "orca:tauri-ui:openCrashReport", ());
    } else if id == ids::HELP_FEATURE_TOUR {
        emit_menu_event_focused(app, "orca:tauri-ui:openFeatureTour", ());
    } else if id == ids::HELP_SETUP_GUIDE {
        emit_menu_event_focused(app, "orca:tauri-ui:openSetupGuide", ());
    } else if id == ids::HELP_CHECK_FOR_UPDATES {
        emit_menu_event_focused(
            app,
            "orca:tauri-ui:checkForUpdates",
            check_for_updates_menu_options(),
        );
    }
    // HELP_ABOUT is a predefined about item and needs no forwarding.
}
fn install_application_menu(app: &AppHandle) -> tauri::Result<()> {
    // Why: the spec is the single source of truth; main only materializes it.
    // Hints stay display-only so chords keep reaching the terminal or DOM.
    use tauri::menu::{MenuBuilder, SubmenuBuilder};
    let platform = MenuPlatform::current();
    let mut builder = MenuBuilder::new(app);
    for section in application_menu_bar() {
        let mut submenu = SubmenuBuilder::new(app, section.label).id(section.id);
        for entry in &section.entries {
            submenu = append_menu_entry(app, submenu, entry, platform)?;
        }
        builder = builder.item(&submenu.build()?);
    }
    app.set_menu(builder.build()?)?;
    Ok(())
}

/// Gives macOS the native traffic lights Electron has. The shared config
/// window stays frameless for the Windows/Linux custom titlebar, so macOS
/// restores decorations here; Overlay style and the (16, 12) inset ship in
/// tauri.conf (both are mac-only there) and tao re-applies the stored inset
/// on every redraw. Zoom-level repositioning has no Tauri runtime setter, so
/// the lights stay at the 1x spot until creation-time wiring lands.
fn apply_macos_window_chrome(window: &WebviewWindow) {
    if !cfg!(target_os = "macos") {
        return;
    }
    let _ = window.set_decorations(true);
}

#[allow(clippy::needless_lifetimes)]
fn append_menu_entry<'a>(
    app: &'a AppHandle,
    builder: tauri::menu::SubmenuBuilder<'a, tauri::Wry, AppHandle>,
    entry: &MenuEntry,
    platform: MenuPlatform,
) -> tauri::Result<tauri::menu::SubmenuBuilder<'a, tauri::Wry, AppHandle>> {
    use tauri::menu::{CheckMenuItemBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
    match entry {
        MenuEntry::Separator => Ok(builder.separator()),
        MenuEntry::Undo => Ok(builder.item(&PredefinedMenuItem::undo(app, None)?)),
        MenuEntry::Redo => Ok(builder.item(&PredefinedMenuItem::redo(app, None)?)),
        MenuEntry::Cut => Ok(builder.item(&PredefinedMenuItem::cut(app, None)?)),
        MenuEntry::Copy => Ok(builder.item(&PredefinedMenuItem::copy(app, None)?)),
        MenuEntry::Services => Ok(builder.item(&PredefinedMenuItem::services(app, None)?)),
        MenuEntry::Hide => Ok(builder.item(&PredefinedMenuItem::hide(app, None)?)),
        MenuEntry::HideOthers => Ok(builder.item(&PredefinedMenuItem::hide_others(app, None)?)),
        MenuEntry::ShowAll => Ok(builder.item(&PredefinedMenuItem::show_all(app, None)?)),
        MenuEntry::Submenu { id, label, entries } => {
            let mut nested = SubmenuBuilder::new(app, *label).id(*id);
            for nested_entry in entries {
                nested = append_menu_entry(app, nested, nested_entry, platform)?;
            }
            Ok(builder.item(&nested.build()?))
        }
        MenuEntry::Custom(item) => {
            if item.id == ids::HELP_ABOUT {
                return Ok(builder.item(&PredefinedMenuItem::about(
                    app,
                    Some("About Orca"),
                    None,
                )?));
            }
            if let Some(checked) = item.checked {
                // Why: the spec marks appearance toggles checked; the menu
                // owns this visual while the renderer owns the live state.
                let mut check = CheckMenuItemBuilder::with_id(item.id, item.display_text(platform))
                    .checked(checked);
                if let Some(accelerator) = item.accelerator(platform) {
                    check = check.accelerator(accelerator);
                }
                return Ok(builder.item(&check.build(app)?));
            }
            let mut custom = MenuItemBuilder::with_id(item.id, item.display_text(platform));
            if let Some(accelerator) = item.accelerator(platform) {
                custom = custom.accelerator(accelerator);
            }
            Ok(builder.item(&custom.build(app)?))
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            handle_second_instance_launch(app, &argv, &cwd);
        }))
        .on_menu_event(|app, event| {
            handle_menu_event(app, &event);
        })
        .on_window_event(|window, event| {
            // Why: the owned Node runtime shuts down gracefully on stdin EOF,
            // so closing its owner here keeps a window close from orphaning it.
            if matches!(event, WindowEvent::Destroyed) && window.label() == "main" {
                // Why: temp-file downloads must not outlive the window that
                // started them; the runtime gets the same graceful EOF close.
                if let Some(sessions) = window
                    .app_handle()
                    .try_state::<filesystem_download::DownloadSessions>()
                {
                    sessions.cancel_all();
                }
                if let Some(sessions) = window
                    .app_handle()
                    .try_state::<filesystem_download::FolderDownloadSessions>()
                {
                    sessions.cancel_all();
                }
                if let Some(runtime) = window.app_handle().try_state::<Arc<OrcadRuntime>>() {
                    runtime.close_owner();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            poc_host_info,
            poc_path_exists,
            poc_paths_exist,
            poc_copy_file,
            poc_read_file_data_url,
            poc_platform_info,
            poc_app_identity,
            // Removed for this single-developer fork: feature wall, Windows
            // admin elevation, elevation restart.
            // feature_wall::poc_get_feature_wall_asset_base_url,
            // windows_admin::poc_get_windows_administrator_status,
            // windows_admin::poc_restart_as_administrator,
            // windows_admin::poc_take_elevation_restart_request,
            poc_is_maximized,
            poc_is_minimized,
            poc_minimize,
            // Tray removed: no hide-to-tray, no tray commands.
            // poc_hide_to_tray,
            poc_toggle_maximize,
            window_state::poc_window_get_bounds,
            window_state::poc_window_set_bounds,
            poc_set_zoom,
            poc_get_zoom,
            poc_set_focus,
            poc_reveal_window,
            poc_relaunch,
            poc_main_force_reload,
            poc_consume_second_instance_events,
            poc_consume_pending_open_settings,
            poc_resolve_opened_documents,
            poc_request_close,
            poc_confirm_close,
            // Tray removed: no minimize-to-tray setting.
            // poc_set_minimize_to_tray,
            poc_popup_menu,
            // Notifications removed.
            // poc_notification_sound_path,
            poc_validate_dropped_paths,
            menu_appearance::poc_menu_set_appearance_checks,
            menu_hints::poc_menu_set_hints,
            // Tray, AI-vault delete removed.
            // system_tray::poc_tray_ensure,
            // system_tray::poc_tray_set_attention,
            // system_tray::poc_tray_rebuild,
            // system_tray::poc_tray_set_visible,
            // ai_vault_delete::poc_trash_ai_vault_session,
            browser_cdp_events::poc_browser_cdp_subscribe,
            browser_cdp_events::poc_browser_cdp_unsubscribe,
            browser_identity::poc_browser_identity_get,
            browser_identity::poc_browser_identity_set,
            browser_identity::poc_browser_identity_set_renderer_user_agent,
            // Browser cookie profiles, client-route authority/partitions, and
            // upload staging/relay removed. Cross-partition isolation is
            // Windows-blocked anyway; client-hosted remote pages not needed.
            // browser_session::poc_browser_session_list_profiles,
            // browser_session::poc_browser_session_create_profile,
            // browser_session::poc_browser_session_delete_profile,
            // browser_session::poc_browser_session_resolve_partition,
            // browser_session::poc_browser_session_detect_browsers,
            // browser_session::poc_browser_session_import_cookies,
            // browser_session::poc_browser_session_import_from_browser,
            // browser_session::poc_browser_session_clear_default_cookies,
            // browser_client_route_sources::poc_browser_client_route_list_sources,
            // browser_client_route_sources::poc_browser_client_route_record_source,
            // browser_client_route_authority::poc_browser_client_route_close_authority,
            // browser_client_route_authority::poc_browser_client_route_note_authority,
            // browser_client_route_partitions::poc_browser_client_route_resolve_partition,
            // browser_client_route_partitions::poc_browser_client_route_import_from_browser,
            // browser_upload_staging::poc_browser_stage_upload_chunk,
            // browser_upload_staging::poc_browser_discard_staged_upload,
            // browser_upload_staging::poc_browser_relay_download_chunk,
            // browser_upload_staging::poc_browser_cleanup_relayed_download,
            browser_webview::poc_browser_create,
            browser_webview::poc_browser_close,
            browser_webview::poc_browser_proceed_certificate,
            browser_webview::poc_browser_cancel_download,
            browser_webview::poc_browser_download_blob,
            browser_webview::poc_browser_open_devtools,
            browser_webview::poc_browser_set_viewport_override,
            browser_webview::poc_browser_set_bounds,
            browser_webview::poc_browser_set_visible,
            browser_webview::poc_browser_navigate,
            browser_webview::poc_browser_go_back,
            browser_webview::poc_browser_go_forward,
            browser_webview::poc_browser_reload,
            browser_webview::poc_browser_stop,
            browser_webview::poc_browser_focus,
            browser_webview::poc_browser_guest_edit,
            browser_webview::poc_browser_set_zoom,
            browser_webview::poc_browser_set_handled_shortcuts,
            // Agent-input automation marking removed.
            // browser_webview::poc_browser_agent_input_begin,
            // browser_webview::poc_browser_agent_input_end,
            browser_webview::poc_browser_get_handled_shortcuts,
            browser_webview::poc_browser_cdp,
            browser_webview::poc_browser_cdp_session,
            browser_webview::poc_browser_set_grab_mode,
            browser_webview::poc_browser_await_grab_selection,
            browser_webview::poc_browser_cancel_grab,
            browser_webview::poc_browser_extract_hover_payload,
            browser_webview::poc_browser_capture_selection_screenshot,
            browser_webview::poc_browser_set_annotation_viewport_bridge,
            clipboard_files::poc_clipboard_read_file_paths,
            clipboard_files::poc_clipboard_write_file,
            clipboard_files::poc_clipboard_restore_native_chat_pastes,
            // Keep-awake, crash reports + minidump, diagnostics bundle, and
            // desktop-away removed.
            // agent_awake::poc_agent_awake_set_active,
            // agent_awake::poc_agent_awake_status,
            // crash_reports::poc_crash_reports_get_latest_pending,
            // crash_reports::poc_crash_reports_get_latest,
            // crash_reports::poc_crash_reports_get_requested,
            // crash_reports::poc_crash_reports_dismiss,
            // crash_reports::poc_crash_reports_record_breadcrumb,
            // crash_reports::poc_crash_reports_record_renderer_error,
            // crash_reports::poc_crash_reports_submit,
            // crash_reports::poc_crash_reports_capture_minidump,
            // diagnostics::poc_diagnostics_get_status,
            // diagnostics::poc_diagnostics_collect_bundle,
            // diagnostics::poc_diagnostics_open_bundle_preview,
            // diagnostics::poc_diagnostics_upload_bundle,
            // diagnostics::poc_diagnostics_delete_bundle,
            // diagnostics::poc_diagnostics_discard_bundle_preview,
            // desktop_away_state::poc_desktop_away_state,
            shell_availability::poc_shell_availability,
            system_fonts::poc_list_system_fonts,
            // Theme-import directory listing removed (Ghostty/Warp scanners
            // were deleted; the command is unused by this renderer build).
            // settings_theme_directories::poc_list_directory,
            // Keybindings file, host-memory snapshot, terminal desync
            // evidence, and doc preview removed.
            // keybindings_file::poc_read_keybindings_file,
            // keybindings_file::poc_write_keybindings_file,
            // host_memory::poc_memory_snapshot,
            // terminal_desync::poc_write_terminal_render_desync_evidence,
            // doc_preview::poc_doc_preview_mint_grant,
            // doc_preview::poc_doc_preview_revoke_grant,
            // doc_preview::poc_doc_preview_authorize_directory,
            // doc_preview::poc_doc_preview_cache_file,
            external_editor::poc_open_external_editor,
            filesystem_download::poc_start_downloaded_folder,
            filesystem_download::poc_finish_downloaded_folder,
            filesystem_download::poc_cancel_downloaded_folder,
            filesystem_download::poc_save_downloaded_file,
            filesystem_download::poc_start_downloaded_file,
            filesystem_download::poc_append_downloaded_file_chunk,
            filesystem_download::poc_finish_downloaded_file,
            filesystem_download::poc_cancel_downloaded_file,
            filesystem_import::poc_import_external_paths,
            filesystem_io::poc_read_file,
            filesystem_io::poc_read_file_chunk,
            filesystem_io::poc_stat,
            filesystem_io::poc_watch_worktree,
            filesystem_io::poc_unwatch_worktree,
            filesystem_search::poc_read_dir,
            filesystem_search::poc_list_files,
            filesystem_search::poc_search_files,
            filesystem_upload::poc_stage_external_paths,
            filesystem_upload::poc_read_external_file_chunk,
            git_inspection::poc_git_status,
            git_inspection::poc_git_diff,
            git_inspection::poc_git_check_ignored,
            // Local log tail removed.
            // local_log_tail::poc_read_local_log_tail,
            // local_log_tail::poc_read_local_log_snapshot,
            // local_log_tail::poc_start_local_log_tail,
            // local_log_tail::poc_stop_local_log_tail,
            runtime_process::poc_runtime_pairing,
            runtime_process::poc_runtime_status,
            workflow_command::poc_run_workflow_command,
            debug_dap::poc_debug_start,
            debug_dap::poc_debug_set_breakpoints,
            debug_dap::poc_debug_breakpoint_states,
            debug_dap::poc_debug_sessions,
            debug_dap::poc_debug_threads,
            debug_dap::poc_debug_stack_trace,
            debug_dap::poc_debug_scopes,
            debug_dap::poc_debug_variables,
            debug_dap::poc_debug_evaluate,
            debug_dap::poc_debug_evaluate_in,
            debug_dap::poc_debug_set_variable,
            debug_dap::poc_debug_resume,
            debug_dap::poc_debug_pause,
            debug_dap::poc_debug_step_over,
            debug_dap::poc_debug_step_into,
            debug_dap::poc_debug_step_out,
            debug_dap::poc_debug_force_step_over,
            debug_dap::poc_debug_run_to,
            debug_dap::poc_debug_step_in_targets,
            debug_dap::poc_debug_step_in_target,
            debug_dap::poc_debug_exception_filters,
            debug_dap::poc_debug_set_exception_breakpoints,
            debug_dap::poc_debug_set_function_breakpoints,
            debug_dap::poc_debug_send_input,
            debug_dap::poc_debug_capabilities,
            debug_dap::poc_debug_attachable_processes,
            debug_dap::poc_debug_stop,
            debug_dap::poc_debug_discover_launch_configs,
            debug_dap::poc_debug_adapter_statuses,
            debug_dap::poc_debug_install_adapter,
            code_lsp::poc_lsp_did_open,
            code_lsp::poc_lsp_did_change,
            code_lsp::poc_lsp_did_save,
            code_lsp::poc_lsp_did_close,
            code_lsp::poc_lsp_definition,
            code_lsp::poc_lsp_references,
            code_lsp::poc_lsp_hover,
            code_lsp::poc_lsp_completion,
            code_lsp::poc_lsp_signature_help,
            code_lsp::poc_lsp_document_symbols,
            code_lsp::poc_lsp_prepare_rename,
            code_lsp::poc_lsp_rename,
            code_lsp::poc_lsp_apply_workspace_edit,
            code_lsp::poc_lsp_server_statuses,
            code_lsp::poc_lsp_install_server,
            // Updater and Workspace Space window removed.
            // updater::poc_updater_get_version,
            // updater::poc_updater_get_status,
            // updater::poc_updater_check,
            // updater::poc_updater_list_builds,
            // updater::poc_updater_download,
            // updater::poc_updater_quit_and_install,
            // updater::poc_updater_dismiss_nudge,
            // updater::poc_updater_dismiss_available_update,
            // workspace_space::poc_workspace_space_open,
            // workspace_space::poc_workspace_space_close,
            // workspace_space::poc_workspace_space_publish_window_state,
            // workspace_space::poc_workspace_space_request_window_state,
            // workspace_space::poc_workspace_space_reveal_worktree,
            // workspace_space::poc_workspace_space_request_worktree_refresh,
            // workspace_space::poc_workspace_space_publish_window_analysis,
            // workspace_space::poc_workspace_space_analyze,
            // workspace_space::poc_workspace_space_cancel,
            // workspace_space::poc_workspace_space_get_cached_analysis
        ])
        .setup(|app| {
            app.manage(browser_webview::BrowserWebviewState::default());
            app.manage(browser_cdp_events::BrowserCdpEventState::default());
            // Browser identity is still registered: webview.rs needs the
            // state to answer `poc_browser_identity_*` and to stamp the
            // renderer user agent on every page load.
            app.manage(browser_identity::BrowserIdentityState::from_app(
                app.handle(),
            ));
            app.manage(SecondInstanceState::default());
            app.manage(PendingOpenSettingsState::default());
            app.manage(filesystem_download::DownloadSessions::default());
            app.manage(filesystem_download::FolderDownloadSessions::default());
            app.manage(filesystem_io::FsWatcherState::default());
            if let Ok(local_data_dir) = app.path().app_local_data_dir() {
                ide_dap::adapter::set_tools_root(local_data_dir.join("debug-tools"));
                code_lsp_servers::set_lsp_tools_root(local_data_dir.join("lsp-tools"));
            }
            app.manage(debug_dap::DebugDapState::new(app.handle().clone()));
            app.manage(code_lsp::CodeLspState::new(app.handle().clone()));
            let resource_root = app.path().resource_dir().ok();
            app.manage(Arc::new(OrcadRuntime::new(resource_root)));

            let window = app
                .get_webview_window("main")
                .ok_or_else(|| tauri::Error::AssetNotFound("main window".to_string()))?;
            apply_macos_window_chrome(&window);
            let state = Arc::new(NativeWindowState::default());
            app.manage(Arc::clone(&state));
            let saver = Arc::new(WindowStateSaver::new(
                window_state::state_file_path(&app.handle())
                    .unwrap_or_else(|_| PathBuf::from("window-state.json")),
            ));
            install_window_state_bridge(&window, state, saver);
            // Why: Electron creates hidden and reveals after applying saved bounds,
            // so restore before the first show and keep background runs hidden.
            window_state::restore_main_window(&window);
            if std::env::var("ORCA_BACKGROUND_LAUNCH").as_deref() != Ok("1") {
                let _ = window.show();
            }
            install_application_menu(app.handle())?;
            apply_background_launch_visibility(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Orca Tauri PoC");
}

#[cfg(test)]
mod tests {
    use super::{
        close_should_hide_to_tray, poc_copy_file, poc_host_info,
        poc_paths_exist, poc_read_file_data_url, poc_validate_dropped_paths, step_ui_zoom_level,
        zoom_factor_for_level, zoom_level_for_factor, NativeWindowState,
        PATH_EXISTENCE_BATCH_MAX, UI_ZOOM_MAX, UI_ZOOM_MIN,
    };
    use std::sync::atomic::Ordering;

    #[test]
    fn host_info_identifies_the_tauri_transport() {
        let info = poc_host_info();

        assert_eq!(info.host, "tauri");
        assert_eq!(info.transport, "rust-command");
        assert_eq!(info.runtime, "Tauri 2");
    }

    #[test]
    fn main_force_reload_bypasses_the_http_cache() {
        assert_eq!(super::MAIN_FORCE_RELOAD_CDP_METHOD, "Page.reload");
        let params: serde_json::Value = serde_json::from_str(super::MAIN_FORCE_RELOAD_CDP_PARAMS)
            .expect("force-reload params are static JSON");
        assert_eq!(
            params.get("ignoreCache"),
            Some(&serde_json::Value::Bool(true))
        );
    }

    #[test]
    fn tauri_conf_pins_macos_traffic_light_chrome() {
        // Why: Overlay + inset are mac-only in the Tauri runtime but live in
        // the shared config, so this locks the Electron-mirrored values
        // (hiddenInset-equivalent chrome, x16/y12 at 1x zoom) in place.
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json parses");
        let main = &conf["app"]["windows"][0];
        assert_eq!(main["decorations"], false);
        assert_eq!(main["titleBarStyle"], "Overlay");
        assert_eq!(
            main["trafficLightPosition"],
            serde_json::json!({ "x": 16, "y": 12 })
        );
    }

    #[test]
    fn menu_zoom_steps_clamp_to_the_shared_ui_range() {
        assert_eq!(step_ui_zoom_level(0.0, "in"), 0.5);
        assert_eq!(step_ui_zoom_level(0.0, "out"), -0.5);
        assert_eq!(step_ui_zoom_level(1.5, "reset"), 0.0);
        assert_eq!(step_ui_zoom_level(UI_ZOOM_MAX, "in"), UI_ZOOM_MAX);
        assert_eq!(step_ui_zoom_level(UI_ZOOM_MIN, "out"), UI_ZOOM_MIN);
    }

    #[test]
    fn zoom_factor_round_trips_through_the_shared_base() {
        assert_eq!(zoom_factor_for_level(0.0), 1.0);
        assert!((zoom_factor_for_level(1.0) - 1.2).abs() < 1e-12);
        for level in [-3.0, -0.5, 0.5, 2.0, 5.0] {
            let back =
                zoom_level_for_factor(zoom_factor_for_level(level)).expect("factor maps back");
            assert!((back - level).abs() < 1e-12);
        }
    }

    #[test]
    fn zoom_level_rejects_non_positive_factors() {
        assert!(zoom_level_for_factor(0.0).is_none());
        assert!(zoom_level_for_factor(-1.2).is_none());
        assert!(zoom_level_for_factor(f64::NAN).is_none());
        assert!(zoom_level_for_factor(f64::INFINITY).is_none());
    }

    #[test]
    fn close_tray_guard_always_false_after_removal() {
        // Tray is removed: the guard is a compile-time stub returning false.
        let state = NativeWindowState::default();
        assert!(!close_should_hide_to_tray(&state));
    }

    #[test]
    fn shell_copy_rejects_relative_paths() {
        let error = poc_copy_file("relative-src.txt".to_string(), "C:\\dest.txt".to_string())
            .expect_err("relative source must be refused");
        assert_eq!(error, "Both source and destination must be absolute paths");
    }

    #[test]
    fn shell_copy_claims_destination_atomically() {
        let dir =
            std::env::temp_dir().join(format!("orca-tauri-shell-copy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        let src = dir.join("src.txt");
        let dest = dir.join("dest.txt");
        std::fs::write(&src, b"shell-copy-bytes").expect("seed source");
        poc_copy_file(
            src.to_string_lossy().into_owned(),
            dest.to_string_lossy().into_owned(),
        )
        .expect("first copy lands");
        assert_eq!(
            std::fs::read(&dest).expect("read copy"),
            b"shell-copy-bytes"
        );
        let clash = poc_copy_file(
            src.to_string_lossy().into_owned(),
            dest.to_string_lossy().into_owned(),
        )
        .expect_err("second copy must not overwrite");
        assert_eq!(clash, "Destination file already exists.");
        assert_eq!(
            std::fs::read(&dest).expect("read after clash"),
            b"shell-copy-bytes"
        );
        // Why: a failed source read must not leave a half-written destination.
        let missing_dest = dir.join("missing-dest.txt");
        let missing_error = poc_copy_file(
            dir.join("no-such-src.txt").to_string_lossy().into_owned(),
            missing_dest.to_string_lossy().into_owned(),
        )
        .expect_err("missing source must fail");
        assert!(!missing_error.is_empty());
        assert!(!missing_dest.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn shell_paths_exist_caps_batches_like_main() {
        assert_eq!(PATH_EXISTENCE_BATCH_MAX, 128);
        let oversized = vec!["C:\\a".to_string(); 129];
        assert_eq!(
            poc_paths_exist(oversized).expect_err("oversized batch must be refused"),
            "Invalid path existence batch"
        );
        let verdicts = poc_paths_exist(vec!["C:\\definitely-missing-orca-probe".to_string()])
            .expect("small batch answers");
        assert_eq!(verdicts, vec![false]);
    }

    #[test]
    fn shell_repo_icon_pins_extension_and_size_like_main() {
        let dir =
            std::env::temp_dir().join(format!("orca-tauri-icon-probe-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        let refused = poc_read_file_data_url(dir.join("icon.jpg").to_string_lossy().into_owned())
            .expect_err("non-png must be refused");
        assert_eq!(refused, "Repo icons must be PNG files.");
        let no_ext = poc_read_file_data_url(dir.join("icon").to_string_lossy().into_owned())
            .expect_err("extensionless must be refused");
        assert_eq!(no_ext, "Repo icons must be PNG files.");
        let big = dir.join("big.png");
        std::fs::write(&big, vec![0u8; 257 * 1024]).expect("seed oversize icon");
        let oversize = poc_read_file_data_url(big.to_string_lossy().into_owned())
            .expect_err("oversize must be refused");
        assert_eq!(oversize, "Repo icon image must be 256KB or smaller.");
        let ok_path = dir.join("ICON.PNG");
        std::fs::write(&ok_path, vec![1u8, 2u8, 3u8]).expect("seed tiny icon");
        let loaded =
            poc_read_file_data_url(ok_path.to_string_lossy().into_owned()).expect("tiny png loads");
        assert_eq!(loaded.file_name, "ICON.PNG");
        assert_eq!(loaded.data_url, "data:image/png;base64,AQID");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn shell_repo_icon_directory_surfaces_os_error_like_main() {
        let dir = std::env::temp_dir().join(format!("orca-tauri-icon-dir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let picked = dir.join("picked.png");
        std::fs::create_dir_all(&picked).expect("scratch picked dir");
        // Why: Electron lets readFile fail on a directory, so the OS error —
        // not the size message — is what a crafted invoke observes.
        let error = poc_read_file_data_url(picked.to_string_lossy().into_owned())
            .expect_err("directory must fail");
        assert_ne!(error, "Repo icon image must be 256KB or smaller.");
        assert!(!error.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn shell_dropped_paths_gate_bounds() {
        // Why the cap counts every entry: the shared validator rejects on
        // paths.length before the native boundary ever sees the batch.
        let oversized = vec!["C:/a".to_string(); 257];
        assert_eq!(
            poc_validate_dropped_paths(oversized).expect_err("oversized drop must be refused"),
            "too-many-paths"
        );
        assert_eq!(
            poc_validate_dropped_paths(vec!["relative.txt".to_string()])
                .expect_err("relative drop must be refused"),
            "invalid-path"
        );
        // Why multibyte: the budget counts UTF-8 bytes like
        // measureClipboardTextByteLength, so one wide char costs two.
        let big = "C:/".to_string() + &"\u{00e9}".repeat(200 * 1024);
        assert_eq!(
            poc_validate_dropped_paths(vec![big]).expect_err("oversize drop must be refused"),
            "paths-too-large"
        );
        let accepted = poc_validate_dropped_paths(vec![
            "C:/b.txt".to_string(),
            String::new(),
            "C:/b.txt".to_string(),
        ])
        .expect("well-formed drop lands");
        assert_eq!(accepted, vec!["C:/b.txt".to_string()]);
    }
}
