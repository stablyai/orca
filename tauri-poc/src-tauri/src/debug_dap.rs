//! OpenIDEA `ide-dap` adapter for Orca's Tauri host.
//!
//! Coordinates crossing the IPC boundary with Orca's frontend are 1-based to
//! match CodeMirror `Text.line(n)` and existing `debug-session-types.ts`.
//! `ide-dap` uses 0-based lines and columns internally, so every boundary helper
//! converts explicitly.

use crate::debug_launch_discovery::{discover_launch_configs, DiscoveredLaunchConfig};
use ide_core::{DebugSessionId, EventSink, IdeError, IdeEvent, IdeResult, SharedSink};
use ide_dap::adapter_config::AdapterRegistry;
use ide_dap::attach::AttachableProcess;
use ide_dap::{DebugCapabilities, DebugManager, SessionOwner};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Emitter, State};

pub const EVENT_DEBUG: &str = "debug:event";
const OWNER_KEY: &str = "main";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchConfig {
    pub name: String,
    pub adapter: String,
    pub request: String,
    pub program: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub extra_json: Option<String>,
}

/// 1-based breakpoint line matching CodeMirror `doc.line(n)`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Breakpoint {
    pub line: u32,
    pub condition: Option<String>,
    pub hit_condition: Option<String>,
    pub log_message: Option<String>,
    pub enabled: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakpointState {
    pub line: u32,
    pub verified: bool,
    pub message: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionBreakpoint {
    pub name: String,
    pub condition: Option<String>,
    pub hit_condition: Option<String>,
    pub enabled: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: u64,
    pub name: String,
    pub adapter: String,
    pub parent: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadInfo {
    pub id: i64,
    pub name: String,
}

/// Stack frame with 1-based line and column coordinates.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StackFrame {
    pub id: i64,
    pub name: String,
    pub path: Option<String>,
    pub line: u32,
    pub column: u32,
    pub presentation_hint: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    pub name: String,
    pub variables_reference: i64,
    pub expensive: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Variable {
    pub name: String,
    pub value: String,
    pub type_name: Option<String>,
    pub variables_reference: i64,
    pub evaluate_name: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepInTarget {
    pub id: i64,
    pub label: String,
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub end_column: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExceptionFilter {
    pub filter: String,
    pub label: String,
    pub description: Option<String>,
    pub default: bool,
    pub supports_condition: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionExceptionFilters {
    pub session: u64,
    pub adapter: String,
    pub filters: Vec<ExceptionFilter>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DebugEvent {
    Started {
        name: String,
        adapter: String,
        parent: Option<u64>,
    },
    Initialized,
    Stopped {
        thread_id: i64,
        reason: String,
        description: Option<String>,
        all_threads_stopped: bool,
    },
    Continued {
        thread_id: i64,
        all_threads_continued: bool,
    },
    Output {
        category: String,
        output: String,
    },
    Thread {
        thread_id: i64,
        started: bool,
    },
    ProgramInput,
    BreakpointsChanged {
        path: String,
    },
    Terminated,
    Exited {
        code: i32,
    },
    HotCodeReplace {
        change_type: String,
        message: String,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DebugEventEnvelope {
    session: u64,
    event: DebugEvent,
}

#[inline]
pub fn to_zero_based(one_based: u32) -> u32 {
    one_based.saturating_sub(1)
}

#[inline]
pub fn to_one_based(zero_based: u32) -> u32 {
    zero_based.saturating_add(1)
}

fn to_ide_launch_config(config: LaunchConfig) -> ide_dap::LaunchConfig {
    ide_dap::LaunchConfig {
        name: config.name,
        adapter: config.adapter,
        request: config.request,
        program: config.program,
        args: config.args,
        cwd: config
            .cwd
            .filter(|c| !c.trim().is_empty())
            .map(PathBuf::from)
            .map(Into::into),
        env: config.env,
        extra_json: config.extra_json,
    }
}

fn map_debug_event(event: ide_core::event::DebugEvent) -> DebugEvent {
    use ide_core::event::DebugEvent as CoreEvent;
    match event {
        CoreEvent::Started {
            name,
            adapter,
            parent,
        } => DebugEvent::Started {
            name,
            adapter,
            parent: parent.map(|p| u64::from(p.0)),
        },
        CoreEvent::Initialized => DebugEvent::Initialized,
        CoreEvent::Stopped {
            thread_id,
            reason,
            description,
            all_threads_stopped,
        } => DebugEvent::Stopped {
            thread_id,
            reason,
            description,
            all_threads_stopped,
        },
        CoreEvent::Continued {
            thread_id,
            all_threads_continued,
        } => DebugEvent::Continued {
            thread_id,
            all_threads_continued,
        },
        CoreEvent::Output { category, output } => DebugEvent::Output { category, output },
        CoreEvent::Thread { thread_id, started } => DebugEvent::Thread { thread_id, started },
        CoreEvent::ProgramInput => DebugEvent::ProgramInput,
        CoreEvent::BreakpointsChanged { path } => DebugEvent::BreakpointsChanged {
            path: ide_core::ipc_path::to_ipc(&path),
        },
        CoreEvent::Terminated => DebugEvent::Terminated,
        CoreEvent::Exited { code } => DebugEvent::Exited { code },
        CoreEvent::HotCodeReplace {
            change_type,
            message,
        } => DebugEvent::HotCodeReplace {
            change_type,
            message,
        },
    }
}

struct TauriDebugEventSink {
    app: Arc<OnceLock<AppHandle>>,
}

impl EventSink for TauriDebugEventSink {
    fn emit(&self, event: IdeEvent) {
        let IdeEvent::Debug { session, event } = event else {
            return;
        };
        let Some(app) = self.app.get() else {
            return;
        };
        let envelope = DebugEventEnvelope {
            session: u64::from(session.0),
            event: map_debug_event(event),
        };
        let _ = app.emit(EVENT_DEBUG, envelope);
    }
}

pub struct DebugDapState {
    manager: Arc<DebugManager>,
    app_handle: Arc<OnceLock<AppHandle>>,
    sink: SharedSink,
}

impl Default for DebugDapState {
    fn default() -> Self {
        let app_handle = Arc::new(OnceLock::new());
        let sink: SharedSink = Arc::new(TauriDebugEventSink {
            app: Arc::clone(&app_handle),
        });
        let manager = DebugManager::new(Arc::new(AdapterRegistry::empty()));
        Self {
            manager,
            app_handle,
            sink,
        }
    }
}

impl DebugDapState {
    pub fn new(app: AppHandle) -> Self {
        let state = Self::default();
        let _ = state.app_handle.set(app);
        state
    }

    fn bind_app(&self, app: &AppHandle) {
        let _ = self.app_handle.set(app.clone());
    }

    fn owner(&self) -> SessionOwner {
        SessionOwner::new(OWNER_KEY, Arc::clone(&self.sink))
    }
}

fn session_id(raw: u64) -> Result<DebugSessionId, String> {
    u32::try_from(raw)
        .map(DebugSessionId)
        .map_err(|_| format!("Invalid debug session id {raw}"))
}

fn map_err<T>(res: IdeResult<T>) -> Result<T, String> {
    res.map_err(|e| e.message)
}

fn map_var(v: ide_dap::Variable) -> Variable {
    Variable {
        name: v.name,
        value: v.value,
        type_name: v.type_name,
        variables_reference: v.variables_reference,
        evaluate_name: v.evaluate_name,
    }
}

fn map_bp_state(s: ide_dap::BreakpointState) -> BreakpointState {
    BreakpointState {
        line: to_one_based(s.line),
        verified: s.verified,
        message: s.message,
    }
}

#[tauri::command]
pub async fn poc_debug_start(
    app: AppHandle,
    state: State<'_, DebugDapState>,
    config: LaunchConfig,
) -> Result<u64, String> {
    state.bind_app(&app);
    let id = map_err(
        state
            .manager
            .start(to_ide_launch_config(config), state.owner())
            .await,
    )?;
    Ok(u64::from(id.0))
}

#[tauri::command]
pub async fn poc_debug_set_breakpoints(
    app: AppHandle,
    state: State<'_, DebugDapState>,
    path: String,
    breakpoints: Vec<Breakpoint>,
) -> Result<Vec<BreakpointState>, String> {
    state.bind_app(&app);
    let ide_bps: Vec<ide_dap::Breakpoint> = breakpoints
        .into_iter()
        .map(|b| ide_dap::Breakpoint {
            line: to_zero_based(b.line),
            condition: b.condition,
            hit_condition: b.hit_condition,
            log_message: b.log_message,
            enabled: b.enabled,
        })
        .collect();
    let states = map_err(
        state
            .manager
            .set_breakpoints(PathBuf::from(path), ide_bps)
            .await,
    )?;
    Ok(states.into_iter().map(map_bp_state).collect())
}

#[tauri::command]
pub fn poc_debug_breakpoint_states(
    state: State<'_, DebugDapState>,
    path: String,
) -> Result<Vec<BreakpointState>, String> {
    Ok(state
        .manager
        .breakpoint_states(Path::new(&path))
        .into_iter()
        .map(map_bp_state)
        .collect())
}

#[tauri::command]
pub fn poc_debug_sessions(state: State<'_, DebugDapState>) -> Result<Vec<SessionInfo>, String> {
    Ok(state
        .manager
        .sessions(Some(OWNER_KEY))
        .into_iter()
        .map(|s| SessionInfo {
            id: u64::from(s.id.0),
            name: s.name,
            adapter: s.adapter,
            parent: s.parent.map(|p| u64::from(p.0)),
        })
        .collect())
}

#[tauri::command]
pub async fn poc_debug_threads(
    state: State<'_, DebugDapState>,
    session: u64,
) -> Result<Vec<ThreadInfo>, String> {
    let sid = session_id(session)?;
    let threads = map_err(state.manager.threads(sid).await)?;
    Ok(threads
        .into_iter()
        .map(|t| ThreadInfo {
            id: t.id,
            name: t.name,
        })
        .collect())
}

#[tauri::command]
pub async fn poc_debug_stack_trace(
    state: State<'_, DebugDapState>,
    session: u64,
    thread_id: i64,
) -> Result<Vec<StackFrame>, String> {
    let sid = session_id(session)?;
    let frames = map_err(state.manager.stack_trace(sid, thread_id).await)?;
    Ok(frames
        .into_iter()
        .map(|f| StackFrame {
            id: f.id,
            name: f.name,
            path: f.path.map(|p| ide_core::ipc_path::to_ipc(&p)),
            line: to_one_based(f.line),
            column: to_one_based(f.column),
            presentation_hint: f.presentation_hint,
        })
        .collect())
}

#[tauri::command]
pub async fn poc_debug_scopes(
    state: State<'_, DebugDapState>,
    session: u64,
    frame_id: i64,
) -> Result<Vec<Scope>, String> {
    let sid = session_id(session)?;
    let scopes = map_err(state.manager.scopes(sid, frame_id).await)?;
    Ok(scopes
        .into_iter()
        .map(|s| Scope {
            name: s.name,
            variables_reference: s.variables_reference,
            expensive: s.expensive,
        })
        .collect())
}

#[tauri::command]
pub async fn poc_debug_variables(
    state: State<'_, DebugDapState>,
    session: u64,
    reference: i64,
) -> Result<Vec<Variable>, String> {
    let sid = session_id(session)?;
    let vars = map_err(state.manager.variables(sid, reference).await)?;
    Ok(vars.into_iter().map(map_var).collect())
}

#[tauri::command]
pub async fn poc_debug_evaluate(
    state: State<'_, DebugDapState>,
    session: u64,
    frame_id: Option<i64>,
    expression: String,
) -> Result<Variable, String> {
    let sid = session_id(session)?;
    let var = map_err(state.manager.evaluate(sid, frame_id, expression).await)?;
    Ok(map_var(var))
}

#[tauri::command]
pub async fn poc_debug_evaluate_in(
    state: State<'_, DebugDapState>,
    session: u64,
    frame_id: Option<i64>,
    expression: String,
    context: Option<String>,
) -> Result<Variable, String> {
    let sid = session_id(session)?;
    let var = map_err(
        state
            .manager
            .evaluate_in(sid, frame_id, expression, context)
            .await,
    )?;
    Ok(map_var(var))
}

#[tauri::command]
pub async fn poc_debug_set_variable(
    state: State<'_, DebugDapState>,
    session: u64,
    container: i64,
    name: String,
    evaluate_name: Option<String>,
    frame_id: Option<i64>,
    value: String,
) -> Result<Variable, String> {
    let sid = session_id(session)?;
    let var = map_err(
        state
            .manager
            .set_variable(sid, container, name, evaluate_name, frame_id, value)
            .await,
    )?;
    Ok(map_var(var))
}

#[tauri::command]
pub async fn poc_debug_resume(
    state: State<'_, DebugDapState>,
    session: u64,
    thread_id: i64,
) -> Result<(), String> {
    map_err(state.manager.resume(session_id(session)?, thread_id).await)
}

#[tauri::command]
pub async fn poc_debug_pause(
    state: State<'_, DebugDapState>,
    session: u64,
    thread_id: i64,
) -> Result<(), String> {
    map_err(state.manager.pause(session_id(session)?, thread_id).await)
}

#[tauri::command]
pub async fn poc_debug_step_over(
    state: State<'_, DebugDapState>,
    session: u64,
    thread_id: i64,
) -> Result<(), String> {
    map_err(
        state
            .manager
            .step(session_id(session)?, thread_id, ide_dap::StepKind::Over)
            .await,
    )
}

#[tauri::command]
pub async fn poc_debug_step_into(
    state: State<'_, DebugDapState>,
    session: u64,
    thread_id: i64,
) -> Result<(), String> {
    map_err(
        state
            .manager
            .step(session_id(session)?, thread_id, ide_dap::StepKind::Into)
            .await,
    )
}

#[tauri::command]
pub async fn poc_debug_step_out(
    state: State<'_, DebugDapState>,
    session: u64,
    thread_id: i64,
) -> Result<(), String> {
    map_err(
        state
            .manager
            .step(session_id(session)?, thread_id, ide_dap::StepKind::Out)
            .await,
    )
}

#[tauri::command]
pub async fn poc_debug_force_step_over(
    state: State<'_, DebugDapState>,
    session: u64,
    thread_id: i64,
) -> Result<(), String> {
    map_err(
        state
            .manager
            .force_step_over(session_id(session)?, thread_id)
            .await,
    )
}

#[tauri::command]
pub async fn poc_debug_run_to(
    state: State<'_, DebugDapState>,
    session: u64,
    thread_id: i64,
    path: String,
    line: u32,
    force: bool,
) -> Result<(), String> {
    map_err(
        state
            .manager
            .run_to(
                session_id(session)?,
                thread_id,
                PathBuf::from(path),
                to_zero_based(line),
                force,
            )
            .await,
    )
}

#[tauri::command]
pub async fn poc_debug_step_in_targets(
    state: State<'_, DebugDapState>,
    session: u64,
    frame_id: i64,
) -> Result<Vec<StepInTarget>, String> {
    let targets = map_err(
        state
            .manager
            .step_in_targets(session_id(session)?, frame_id)
            .await,
    )?;
    Ok(targets
        .into_iter()
        .map(|t| StepInTarget {
            id: t.id,
            label: t.label,
            line: t.line.map(to_one_based),
            column: t.column.map(to_one_based),
            end_column: t.end_column.map(to_one_based),
        })
        .collect())
}

#[tauri::command]
pub async fn poc_debug_step_in_target(
    state: State<'_, DebugDapState>,
    session: u64,
    thread_id: i64,
    target_id: i64,
) -> Result<(), String> {
    map_err(
        state
            .manager
            .step_in_target(session_id(session)?, thread_id, target_id)
            .await,
    )
}

#[tauri::command]
pub fn poc_debug_exception_filters(
    state: State<'_, DebugDapState>,
) -> Result<Vec<SessionExceptionFilters>, String> {
    Ok(state
        .manager
        .exception_filters(Some(OWNER_KEY))
        .into_iter()
        .map(|sf| SessionExceptionFilters {
            session: u64::from(sf.session.0),
            adapter: sf.adapter,
            filters: sf
                .filters
                .into_iter()
                .map(|f| ExceptionFilter {
                    filter: f.filter,
                    label: f.label,
                    description: f.description,
                    default: f.default,
                    supports_condition: f.supports_condition,
                })
                .collect(),
        })
        .collect())
}

#[tauri::command]
pub async fn poc_debug_set_exception_breakpoints(
    state: State<'_, DebugDapState>,
    choices: BTreeMap<String, bool>,
) -> Result<(), String> {
    map_err(state.manager.set_exception_breakpoints(choices).await)
}

#[tauri::command]
pub async fn poc_debug_set_function_breakpoints(
    state: State<'_, DebugDapState>,
    breakpoints: Vec<FunctionBreakpoint>,
) -> Result<Vec<BreakpointState>, String> {
    let list: Vec<ide_dap::FunctionBreakpoint> = breakpoints
        .into_iter()
        .map(|b| ide_dap::FunctionBreakpoint {
            name: b.name,
            condition: b.condition,
            hit_condition: b.hit_condition,
            enabled: b.enabled,
        })
        .collect();
    let states = map_err(state.manager.set_function_breakpoints(list).await)?;
    Ok(states.into_iter().map(map_bp_state).collect())
}

#[tauri::command]
pub fn poc_debug_send_input(
    state: State<'_, DebugDapState>,
    session: u64,
    text: String,
) -> Result<(), String> {
    map_err(state.manager.send_input(session_id(session)?, &text))
}

#[tauri::command]
pub fn poc_debug_capabilities(
    state: State<'_, DebugDapState>,
    session: u64,
) -> Result<DebugCapabilities, String> {
    map_err(state.manager.capabilities(session_id(session)?))
}

#[tauri::command]
pub async fn poc_debug_attachable_processes() -> Result<Vec<AttachableProcess>, String> {
    tokio::task::spawn_blocking(ide_dap::attach::attachable_processes)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.message)
}

#[tauri::command]
pub async fn poc_debug_stop(state: State<'_, DebugDapState>, session: u64) -> Result<(), String> {
    let sid = session_id(session)?;
    match state.manager.stop(sid).await {
        Ok(()) => Ok(()),
        Err(IdeError {
            kind: ide_core::error::ErrorKind::NotFound,
            ..
        }) => Ok(()),
        Err(e) => Err(e.message),
    }
}

#[tauri::command]
pub fn poc_debug_discover_launch_configs(
    workspace_root: Option<String>,
    active_file: Option<String>,
) -> Vec<DiscoveredLaunchConfig> {
    let ws = workspace_root
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(Path::new);
    let file = active_file
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(Path::new);
    discover_launch_configs(ws, file)
}

#[tauri::command]
pub async fn poc_debug_adapter_statuses(
    cwd: Option<String>,
) -> Result<Vec<crate::debug_adapters::DebugAdapterStatus>, String> {
    tokio::task::spawn_blocking(move || {
        let dir = cwd
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(PathBuf::from);
        crate::debug_adapters::probe_all_adapters(dir.as_deref())
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn poc_debug_install_adapter(
    adapter: String,
) -> Result<crate::debug_adapters::DebugAdapterStatus, String> {
    crate::debug_adapters::install_adapter(adapter.trim()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_lines_between_one_based_and_zero_based() {
        assert_eq!(to_zero_based(1), 0);
        assert_eq!(to_zero_based(0), 0);
        assert_eq!(to_zero_based(42), 41);
        assert_eq!(to_one_based(0), 1);
        assert_eq!(to_one_based(41), 42);
    }

    #[test]
    fn converts_launch_config_and_merges_arguments() {
        let mut env = BTreeMap::new();
        env.insert("NODE_ENV".to_string(), "development".to_string());
        let cfg = LaunchConfig {
            name: "Debug App".to_string(),
            adapter: "js-debug".to_string(),
            request: "launch".to_string(),
            program: Some("index.js".to_string()),
            args: vec!["--flag".to_string()],
            cwd: Some("D:/code/app".to_string()),
            env,
            extra_json: Some(r#"{"stopOnEntry": true}"#.to_string()),
        };
        let args = ide_dap::launch_arguments(&to_ide_launch_config(cfg)).expect("launch args");
        assert_eq!(args["type"], "pwa-node");
        assert_eq!(args["program"], "index.js");
        assert_eq!(args["stopOnEntry"], true);
        assert_eq!(args["env"]["NODE_ENV"], "development");
    }

    #[test]
    fn maps_started_parent_and_ipc_paths_in_debug_events() {
        let ev = map_debug_event(ide_core::event::DebugEvent::Started {
            name: "Child".into(),
            adapter: "js-debug".into(),
            parent: Some(DebugSessionId(7)),
        });
        let val = serde_json::to_value(ev).unwrap();
        assert_eq!(val["kind"], "started");
        assert_eq!(val["parent"], 7);

        let bp = map_debug_event(ide_core::event::DebugEvent::BreakpointsChanged {
            path: PathBuf::from(r"C:\repo\src\main.rs").into(),
        });
        let bp_val = serde_json::to_value(bp).unwrap();
        assert_eq!(bp_val["kind"], "breakpointsChanged");
        assert_eq!(bp_val["path"], "C:/repo/src/main.rs");
    }
}
