//! Debug Adapter Protocol client.
//!
//! [`DebugManager`] owns every debug session plus the per-file breakpoint
//! store (independent of sessions; sent to each session during configuration
//! and updated live). Sessions emit `IdeEvent::Debug`; the UI then pulls
//! threads, frames, scopes and variables on demand.
//!
//! All lines and columns in this API are 0-based; the client tells adapters
//! `linesStartAt1`/`columnsStartAt1` and converts at this edge.

pub mod adapter;
pub mod adapter_config;
pub mod attach;
mod cargo;
pub mod connection;
pub mod jdwp;
pub mod kotlin;
mod kotlin_jdwp;
mod session;
pub mod target;

use adapter::{AdapterLauncher, AdapterSpec, ProcessLauncher};
use adapter_config::AdapterRegistry;
use connection::{Connection, DapError};
use futures::future::join_all;
use ide_core::{DebugSessionId, IdeError, IdeResult, SharedSink};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use session::Session;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Weak};
use std::time::Duration;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchConfig {
    pub name: String,
    /// DAP adapter name from `languages/*.toml` (or a built-in: codelldb, debugpy, js-debug, delve, netcoredbg).
    pub adapter: String,
    /// `launch` or `attach`.
    pub request: String,
    pub program: Option<String>,
    pub args: Vec<String>,
    pub cwd: Option<ide_core::IpcPath>,
    pub env: BTreeMap<String, String>,
    /// Adapter specific extra arguments as JSON text, merged into the launch request.
    /// A `"cargo": {"args": [...], "filter": {"name", "kind"}}` entry builds with cargo
    /// and launches the produced executable; `"debugServer": <port>` connects to an
    /// adapter already listening on that local port (e.g. java-debug inside jdtls)
    /// instead of starting one, `"debugServer": "host:port"` to one on another machine
    /// (`dlv --headless`, `debugpy --listen`).
    pub extra_json: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Breakpoint {
    pub line: u32,
    pub condition: Option<String>,
    pub hit_condition: Option<String>,
    /// Logpoint message; when set the breakpoint logs instead of suspending.
    pub log_message: Option<String>,
    pub enabled: bool,
}

/// A method breakpoint (DAP function breakpoint). `name` uses the adapter's syntax:
/// `pkg.Class#method` for java-debug, `pkg.Func` / `pkg.(*T).Method` for Delve, a plain
/// function name for debugpy and LLDB.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionBreakpoint {
    pub name: String,
    pub condition: Option<String>,
    pub hit_condition: Option<String>,
    pub enabled: bool,
}

/// A field watchpoint (DAP data breakpoint) on a `dataId` from [`DebugManager::data_breakpoint_info`]
/// (java-debug ids, `Class#field`, stay valid across sessions).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataBreakpoint {
    pub data_id: String,
    /// `read`, `write` or `readWrite` (adapter default when unset).
    pub access_type: Option<String>,
    pub condition: Option<String>,
    pub hit_condition: Option<String>,
    pub enabled: bool,
}

/// Answer of `dataBreakpointInfo`: `data_id` is `None` when the value cannot be watched.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataBreakpointInfo {
    pub data_id: Option<String>,
    pub description: String,
    pub access_types: Vec<String>,
}

/// A call on the current line that Smart Step Into can enter (`stepInTargets`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepInTarget {
    pub id: i64,
    pub label: String,
    /// 0-based, when the adapter reports where the call is.
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub end_column: Option<u32>,
}

/// What a session's adapter supports, for enabling actions.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugCapabilities {
    pub restart_frame: bool,
    pub step_in_targets: bool,
    pub function_breakpoints: bool,
    pub data_breakpoints: bool,
    /// `setVariable` or `setExpression`.
    pub set_value: bool,
    pub conditional_breakpoints: bool,
    pub hit_conditional_breakpoints: bool,
    pub log_points: bool,
    /// HotSwap ("Reload Changed Classes"): java-debug's `redefineClasses` request.
    pub hot_code_replace: bool,
}

/// Result of [`DebugManager::redefine_classes`].
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HotSwapResult {
    /// Fully qualified names of the classes reloaded (empty: nothing had changed).
    pub changed_classes: Vec<String>,
    pub error_message: Option<String>,
}

/// Adapters that implement java-debug's hot code replace protocol.
pub const HOT_CODE_REPLACE_ADAPTERS: &[&str] = &["java-debug"];

/// java-debug's `HotCodeReplaceEvent.changeType` (an enum name, or its numeric code).
pub(crate) fn hot_code_replace_type(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => match n.as_i64() {
            Some(-1) => "ERROR",
            Some(-2) => "WARNING",
            Some(1) => "STARTING",
            Some(2) => "END",
            Some(3) => "BUILD_COMPLETE",
            _ => "UNKNOWN",
        }
        .to_owned(),
        _ => "UNKNOWN".to_owned(),
    }
}

pub(crate) fn hot_swap_result(body: &Value) -> HotSwapResult {
    HotSwapResult {
        changed_classes: body
            .get("changedClasses")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|c| c.as_str().map(str::to_owned)).collect())
            .unwrap_or_default(),
        error_message: body.get("errorMessage").and_then(Value::as_str).filter(|m| !m.is_empty()).map(str::to_owned),
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakpointState {
    pub line: u32,
    pub verified: bool,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ThreadInfo {
    pub id: i64,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StackFrame {
    pub id: i64,
    pub name: String,
    pub path: Option<ide_core::IpcPath>,
    pub line: u32,
    pub column: u32,
    /// `subtle` frames (library/generated) are collapsed in the UI.
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
    /// > 0 when expandable.
    pub variables_reference: i64,
    pub evaluate_name: Option<String>,
}

/// A completion the adapter offers for an expression (DAP `completions`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugCompletion {
    pub label: String,
    /// What to insert, when it differs from `label`.
    pub text: Option<String>,
    /// DAP item type: `method`, `field`, `variable`, `class`, `keyword`, …
    pub kind: Option<String>,
    pub detail: Option<String>,
    pub sort_text: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StepKind {
    Over,
    Into,
    Out,
}

/// An exception breakpoint filter offered by an adapter (`exceptionBreakpointFilters`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExceptionFilter {
    pub filter: String,
    pub label: String,
    pub description: Option<String>,
    /// Enabled unless the user chose otherwise.
    pub default: bool,
    pub supports_condition: bool,
}

/// Exception filters of one session (see [`DebugManager::exception_filters`]).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionExceptionFilters {
    pub session: DebugSessionId,
    pub adapter: String,
    pub filters: Vec<ExceptionFilter>,
}

/// A live session, as listed by [`DebugManager::sessions`].
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: DebugSessionId,
    pub name: String,
    pub adapter: String,
    /// Set for child sessions started by the adapter (`startDebugging`).
    pub parent: Option<DebugSessionId>,
}

/// Who started a session. Every event of the session, and of the child sessions
/// its adapter starts, goes to `sink` only; `key` (e.g. a window label) scopes
/// listings such as [`DebugManager::sessions`].
#[derive(Clone)]
pub struct SessionOwner {
    pub key: String,
    pub sink: SharedSink,
}

impl SessionOwner {
    pub fn new(key: impl Into<String>, sink: SharedSink) -> Self {
        Self { key: key.into(), sink }
    }
}

const INIT_TIMEOUT: Duration = Duration::from_secs(20);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);
/// Redefining many classes in a large JVM can take a while.
const HOT_SWAP_TIMEOUT: Duration = Duration::from_secs(120);

pub struct DebugManager {
    languages: Arc<AdapterRegistry>,
    launcher: Arc<dyn AdapterLauncher>,
    me: Weak<DebugManager>,
    sessions: Mutex<HashMap<DebugSessionId, Arc<Session>>>,
    /// Session start order, for "the first session" semantics.
    order: Mutex<Vec<DebugSessionId>>,
    breakpoints: Mutex<BTreeMap<PathBuf, Vec<Breakpoint>>>,
    states: Mutex<HashMap<PathBuf, Vec<BreakpointState>>>,
    /// Explicit exception filter choices (filter id → enabled); unset filters use the adapter default.
    exception_choices: Mutex<BTreeMap<String, bool>>,
    function_breakpoints: Mutex<Vec<FunctionBreakpoint>>,
    data_breakpoints: Mutex<Vec<DataBreakpoint>>,
    /// In-flight stops, by session: a second Stop sets `stop_force`, the waiting one kills.
    stopping: Mutex<HashMap<DebugSessionId, Arc<Session>>>,
}

/// rdbg (Ruby's debug gem) starts the debuggee itself and ignores `launch`'s program,
/// arguments and environment: they go on its command line after `--` and into its process.
/// In a Bundler project it runs from the bundle, which must have `debug`: the debuggee then
/// loads that version, and the gems rdbg needs (irb is not a default gem from Ruby 3.5).
fn rdbg_command_line(spec: &mut AdapterSpec, config: &LaunchConfig, cwd: &Path) -> IdeResult<()> {
    if config.request != "launch" {
        return Ok(());
    }
    if spec.command == "rdbg"
        && let Some(gemfile) = bundler_gemfile(cwd, &config.env)
    {
        if !bundles_debug(&gemfile) {
            return Err(IdeError::unavailable(format!(
                "the bundle of {} has no `debug` gem. Add `gem \"debug\"` to the Gemfile and run `bundle install`",
                gemfile.display()
            )));
        }
        spec.args.splice(0..0, ["exec".to_owned(), "rdbg".to_owned()]);
        spec.command = "bundle".into();
    }
    spec.env.extend(config.env.iter().map(|(k, v)| (k.clone(), v.clone())));
    spec.args.push("--".into());
    // With only a command, Ruby's exec treats it as shell text. Ruby entry points
    // without arguments go through -S so spaces and metacharacters stay literal.
    if config.program.is_some() && config.args.is_empty() {
        spec.args.extend(["ruby", "-S", "--"].map(str::to_owned));
    }
    spec.args.extend(config.program.iter().cloned());
    spec.args.extend(config.args.iter().cloned());
    Ok(())
}

/// The Gemfile Bundler uses in `dir`: `BUNDLE_GEMFILE`, else the closest `Gemfile` / `gems.rb` from `dir` up.
fn bundler_gemfile(dir: &Path, env: &BTreeMap<String, String>) -> Option<PathBuf> {
    let gemfile = env
        .get("BUNDLE_GEMFILE")
        .cloned()
        .or_else(|| ide_core::process::host_var_os("BUNDLE_GEMFILE").map(|v| v.to_string_lossy().into_owned()));
    match gemfile.filter(|g| !g.is_empty()) {
        Some(gemfile) => Some(dir.join(gemfile)),
        None => dir.ancestors().flat_map(|d| [d.join("gems.rb"), d.join("Gemfile")]).find(|g| g.is_file()),
    }
}

/// Whether the lockfile of `gemfile` lists the `debug` gem.
fn bundles_debug(gemfile: &Path) -> bool {
    let lockfile = if gemfile.file_name().is_some_and(|n| n == "gems.rb") {
        gemfile.with_file_name("gems.locked")
    } else {
        let mut name = gemfile.as_os_str().to_owned();
        name.push(".lock");
        PathBuf::from(name)
    };
    // The bundle's gems are the lines indented by four spaces: `    debug (1.9.2)`.
    std::fs::read_to_string(lockfile).is_ok_and(|text| text.lines().any(|l| l.starts_with("    debug (")))
}

/// Whether the debugged project depends on the Flutter SDK, so it must go
/// through `flutter debug_adapter` instead of the plain Dart one.
///
/// `dart debug_adapter` cannot start a program that imports `dart:ui`, and only
/// the Flutter adapter answers `hotReload` / `hotRestart`. `dir` is the launch
/// `cwd`; the program's own directory is tried first because a module inside a
/// larger repository has its `pubspec.yaml` above the program, not above `cwd`.
fn is_flutter_project(dir: &Path, program: Option<&Path>) -> bool {
    let mut start: Vec<&Path> = program.and_then(Path::parent).into_iter().collect();
    start.push(dir);
    start
        .iter()
        .filter_map(|d| d.ancestors().take(6).find(|a| a.join("pubspec.yaml").is_file()))
        .filter_map(|root| std::fs::read_to_string(root.join("pubspec.yaml")).ok())
        .any(|s| s.contains("sdk: flutter"))
}

fn no_session(s: DebugSessionId) -> IdeError {
    IdeError::not_found(format!("no debug session {}", s.0))
}

/// Builds the `launch`/`attach` arguments: our fields first, then `extra_json` merged on top.
pub fn launch_arguments(config: &LaunchConfig) -> IdeResult<Value> {
    // VS Code puts `type`, `request` and `name` in the arguments; js-debug picks launch
    // or attach from `request` there, not from the DAP command.
    let mut args = json!({ "name": config.name, "request": config.request });
    if let Some(t) = adapter::default_type(&config.adapter) {
        args["type"] = t.into();
    }
    if let Some(p) = &config.program {
        args["program"] = p.as_str().into();
    }
    if !config.args.is_empty() {
        args["args"] = json!(config.args);
    }
    if let Some(cwd) = &config.cwd {
        args["cwd"] = json!(cwd);
    }
    if !config.env.is_empty() {
        args["env"] = json!(config.env);
    }
    if let Some(extra) = config.extra_json.as_deref().filter(|e| !e.trim().is_empty()) {
        let extra: Value =
            serde_json::from_str(extra).map_err(|e| IdeError::invalid(format!("invalid launch JSON: {e}")))?;
        let Value::Object(extra) = extra else {
            return Err(IdeError::invalid("launch JSON must be an object"));
        };
        if let Some(obj) = args.as_object_mut() {
            obj.extend(extra);
        }
    }
    Ok(args)
}

/// Placeholder in launch arguments for a free local port, the same one everywhere in a
/// launch: Deno's `--inspect-wait=127.0.0.1:${freePort}` and js-debug's
/// `"attachSimplePort": "${freePort}"` (a `port` / `…Port` attribute that is only the
/// placeholder becomes a number; everything else stays a string, e.g. `env` values).
pub const FREE_PORT_PLACEHOLDER: &str = "${freePort}";

/// Replaces [`FREE_PORT_PLACEHOLDER`] in every string of `value` with `port()` (called once, if used).
pub(crate) fn substitute_free_port(value: &mut Value, port: &mut impl FnMut() -> IdeResult<u16>) -> IdeResult<()> {
    fn walk(v: &mut Value, key: &str, port: &mut dyn FnMut() -> IdeResult<u16>) -> IdeResult<()> {
        match v {
            Value::String(s) if s.contains(FREE_PORT_PLACEHOLDER) => {
                let p = port()?;
                *v = if s == FREE_PORT_PLACEHOLDER && (key == "port" || key.ends_with("Port")) {
                    p.into()
                } else {
                    s.replace(FREE_PORT_PLACEHOLDER, &p.to_string()).into()
                };
            }
            Value::Array(a) => a.iter_mut().try_for_each(|x| walk(x, key, port))?,
            Value::Object(o) => o.iter_mut().try_for_each(|(k, x)| walk(x, k, port))?,
            _ => {}
        }
        Ok(())
    }
    let mut chosen = None;
    walk(value, "", &mut || match chosen {
        Some(p) => Ok(p),
        None => {
            let p = port()?;
            chosen = Some(p);
            Ok(p)
        }
    })
}

/// Where a running adapter listens: `debugServer` of the launch arguments.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DebugServer {
    /// `None` for the loopback interface (an adapter inside a local process such as jdtls).
    pub host: Option<String>,
    pub port: u16,
}

/// Removes `debugServer` (VS Code's "connect to a running adapter" attribute) from the
/// launch arguments: a port (`4711`, `"4711"`) on this machine, or `"host:port"` /
/// `"[v6]:port"` of a remote one (`dlv --headless`, `debugpy --listen`).
pub(crate) fn take_debug_server(arguments: &mut Value) -> IdeResult<Option<DebugServer>> {
    let Some(v) = arguments.as_object_mut().and_then(|o| o.remove("debugServer")) else { return Ok(None) };
    let invalid = || IdeError::invalid(format!("invalid debugServer address: {v}"));
    let port_of = |p: u64| u16::try_from(p).ok().filter(|p| *p != 0);
    if let Some(p) = v.as_u64() {
        return port_of(p).map(|port| Some(DebugServer { host: None, port })).ok_or_else(invalid);
    }
    let s = v.as_str().map(str::trim).ok_or_else(invalid)?;
    let (host, port) = match s.rsplit_once(':') {
        Some((host, port)) => {
            let host = host.trim().trim_start_matches('[').trim_end_matches(']');
            (Some(host).filter(|h| !h.is_empty()).map(str::to_owned), port)
        }
        None => (None, s),
    };
    let port = port.trim().parse::<u64>().ok().and_then(port_of).ok_or_else(invalid)?;
    Ok(Some(DebugServer { host, port }))
}

/// DAP stack frame → [`StackFrame`] (1-based → 0-based).
pub(crate) fn frame_from(f: &Value) -> StackFrame {
    let source = f.get("source");
    let source_hint = source.and_then(|s| s.get("presentationHint")).and_then(Value::as_str);
    let hint = f
        .get("presentationHint")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| (source_hint == Some("deemphasize")).then(|| "subtle".to_owned()));
    StackFrame {
        id: f.get("id").and_then(Value::as_i64).unwrap_or_default(),
        name: f.get("name").and_then(Value::as_str).unwrap_or_default().to_owned(),
        path: source.and_then(|s| s.get("path")).and_then(Value::as_str).map(Into::into),
        line: (f.get("line").and_then(Value::as_u64).unwrap_or(0) as u32).saturating_sub(1),
        column: (f.get("column").and_then(Value::as_u64).unwrap_or(0) as u32).saturating_sub(1),
        presentation_hint: hint,
    }
}

pub(crate) fn exception_filters_from(caps: &Value) -> Vec<ExceptionFilter> {
    caps.get("exceptionBreakpointFilters")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|f| {
                    let filter = f.get("filter").and_then(Value::as_str)?.to_owned();
                    Some(ExceptionFilter {
                        label: f
                            .get("label")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                            .unwrap_or_else(|| filter.clone()),
                        description: f.get("description").and_then(Value::as_str).map(str::to_owned),
                        default: f.get("default").and_then(Value::as_bool).unwrap_or(false),
                        supports_condition: f.get("supportsCondition").and_then(Value::as_bool).unwrap_or(false),
                        filter,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Filter ids to enable: explicit choices win (`adapter:filter`, then the bare filter id,
/// since adapters reuse ids such as `uncaught`), otherwise the adapter's default.
pub(crate) fn enabled_filters(
    filters: &[ExceptionFilter],
    choices: &BTreeMap<String, bool>,
    adapter: &str,
) -> Vec<String> {
    filters
        .iter()
        .filter(|f| {
            choices
                .get(&format!("{adapter}:{}", f.filter))
                .or_else(|| choices.get(&f.filter))
                .copied()
                .unwrap_or(f.default)
        })
        .map(|f| f.filter.clone())
        .collect()
}

pub(crate) fn step_in_target_from(t: &Value) -> StepInTarget {
    let num = |k: &str| t.get(k).and_then(Value::as_u64).map(|n| (n as u32).saturating_sub(1));
    StepInTarget {
        id: t.get("id").and_then(Value::as_i64).unwrap_or_default(),
        label: t.get("label").and_then(Value::as_str).unwrap_or_default().to_owned(),
        line: num("line"),
        column: num("column"),
        end_column: num("endColumn"),
    }
}

pub(crate) fn capabilities_from(caps: &Value) -> DebugCapabilities {
    let has = |k: &str| caps.get(k).and_then(Value::as_bool).unwrap_or(false);
    DebugCapabilities {
        restart_frame: has("supportsRestartFrame"),
        step_in_targets: has("supportsStepInTargetsRequest"),
        function_breakpoints: has("supportsFunctionBreakpoints"),
        data_breakpoints: has("supportsDataBreakpoints"),
        set_value: has("supportsSetVariable") || has("supportsSetExpression"),
        conditional_breakpoints: has("supportsConditionalBreakpoints"),
        hit_conditional_breakpoints: has("supportsHitConditionalBreakpoints"),
        log_points: has("supportsLogPoints"),
        hot_code_replace: false,
    }
}

/// States of a file's line breakpoints that no session has been sent.
fn unsent(breakpoints: &[Breakpoint]) -> Vec<BreakpointState> {
    breakpoints
        .iter()
        .map(|b| BreakpointState {
            line: b.line,
            verified: false,
            message: (!b.enabled).then(|| "Disabled".to_owned()),
        })
        .collect()
}

/// States for breakpoints no session has verified yet.
fn unverified(enabled: impl Iterator<Item = bool>) -> Vec<BreakpointState> {
    enabled
        .map(|e| BreakpointState { line: 0, verified: false, message: (!e).then(|| "Disabled".to_owned()) })
        .collect()
}

/// Delve compiles the debuggee to `__debug_bin` in the session's cwd (on Windows
/// `__debug_bin.exe` plus `__debug_bin.exe<digits>` in DAP mode) and removes it on a
/// graceful exit — a shutdown it doesn't always reach, so the files pile up. Sweep
/// the leftovers once the session is down. Runs after `session_closed`, so Delve
/// has already exited or been killed and holds no file locks; a leftover of a
/// still-building run is removed on that run's own shutdown.
fn remove_delve_binaries(cwd: &Path) {
    let Ok(entries) = std::fs::read_dir(cwd) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        // Windows writes `__debug_bin.exe` (and `.exe<digits>` in DAP mode); other
        // platforms keep the bare name. Suffixes like `.go` are user files.
        let suffix = name.strip_prefix("__debug_bin");
        let leftover = suffix.is_some_and(|s| {
            s.is_empty()
                || s == ".exe"
                || (s.starts_with(".exe") && s[".exe".len()..].chars().all(|c| c.is_ascii_digit()))
        });
        if !leftover || entry.file_type().is_ok_and(|t| !t.is_file()) {
            continue;
        }
        // Windows: a just-killed dlv / debuggee can still hold this session's
        // binary while the previous one's lock is already gone, so one try
        // leaves exactly the current leftover behind. Retry on a short back-off
        // to outlast the handle release; a truly busy file is retried into the
        // next run's sweep anyway.
        for attempt in 0..5 {
            match std::fs::remove_file(entry.path()) {
                Ok(()) => break,
                Err(e) if attempt == 4 => {
                    tracing::debug!("could not remove Delve leftover {}: {e}", entry.path().display());
                }
                Err(_) => std::thread::sleep(std::time::Duration::from_millis(50 * (attempt as u64 + 1))),
            }
        }
    }
}

pub(crate) fn variable_from(v: &Value) -> Variable {
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
    Variable {
        name: s("name").unwrap_or_default(),
        value: s("value").unwrap_or_default(),
        type_name: s("type").filter(|t| !t.is_empty()),
        variables_reference: v.get("variablesReference").and_then(Value::as_i64).unwrap_or(0),
        evaluate_name: s("evaluateName"),
    }
}

impl DebugManager {
    pub fn new(languages: Arc<AdapterRegistry>) -> Arc<Self> {
        Self::with_launcher(languages, Arc::new(ProcessLauncher))
    }

    /// Like [`new`](Self::new) with a custom way to start adapters (tests use in-memory adapters).
    pub fn with_launcher(languages: Arc<AdapterRegistry>, launcher: Arc<dyn AdapterLauncher>) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            languages,
            launcher,
            me: me.clone(),
            sessions: Mutex::default(),
            order: Mutex::default(),
            breakpoints: Mutex::default(),
            states: Mutex::default(),
            exception_choices: Mutex::default(),
            function_breakpoints: Mutex::default(),
            data_breakpoints: Mutex::default(),
            stopping: Mutex::default(),
        })
    }

    fn session(&self, s: DebugSessionId) -> IdeResult<Arc<Session>> {
        self.sessions.lock().get(&s).cloned().ok_or_else(|| no_session(s))
    }

    fn live_sessions(&self) -> Vec<Arc<Session>> {
        let sessions = self.sessions.lock();
        self.order.lock().iter().filter_map(|id| sessions.get(id).cloned()).collect()
    }

    pub(crate) fn stored_breakpoints(&self, path: &Path) -> Vec<Breakpoint> {
        self.breakpoints.lock().get(path).cloned().unwrap_or_default()
    }

    /// Live sessions of `owner` (all owners when `None`).
    pub fn sessions(&self, owner: Option<&str>) -> Vec<SessionInfo> {
        self.live_sessions()
            .iter()
            .filter(|s| owner.is_none_or(|o| s.owner.key == o))
            .map(|s| SessionInfo { id: s.id, name: s.name.clone(), adapter: s.adapter.clone(), parent: s.parent })
            .collect()
    }

    /// Starts a session: spawns the adapter, `initialize`, `launch`/`attach`,
    /// waits for `initialized`, sends breakpoints, then `configurationDone`.
    /// Events of the session (including cargo build output) go to `owner` only.
    pub async fn start(&self, config: LaunchConfig, owner: SessionOwner) -> IdeResult<DebugSessionId> {
        self.start_with(config, owner, |_| None).await
    }

    /// [`start`](Self::start) with the adapter executable chosen by `custom_command`
    /// (the configured command → a user-chosen executable, from settings).
    pub async fn start_with(
        &self,
        config: LaunchConfig,
        owner: SessionOwner,
        custom_command: impl FnOnce(&str) -> Option<String>,
    ) -> IdeResult<DebugSessionId> {
        self.start_prepared(config, owner, custom_command, |_, _| Ok(())).await
    }

    /// Configure a target adapter before any host tool resolution or launch.
    pub async fn start_prepared(
        &self,
        config: LaunchConfig,
        owner: SessionOwner,
        custom_command: impl FnOnce(&str) -> Option<String>,
        prepare: impl FnOnce(&mut AdapterSpec, &mut Value) -> IdeResult<()>,
    ) -> IdeResult<DebugSessionId> {
        let mut arguments = launch_arguments(&config)?;
        // An IDE-side marker (never sent to the adapter): the session is a Flutter
        // one regardless of what the working directory holds.
        let force_flutter =
            arguments.as_object_mut().and_then(|o| o.remove("__flutter")).and_then(|v| v.as_bool()).unwrap_or(false);
        let cwd = config
            .cwd
            .clone()
            .map(Into::into)
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| "/".into()));
        let dbg = adapter::find_config(&self.languages, &config.adapter)
            .ok_or_else(|| IdeError::unavailable(format!("unknown debug adapter `{}`", config.adapter)))?;
        let mut spec = adapter::resolve(&dbg, cwd.clone());
        prepare(&mut spec, &mut arguments)?;
        if spec.target.is_some() {
            return self
                .start_session(
                    DebugSessionId::next(),
                    owner,
                    config.name,
                    config.adapter,
                    None,
                    config.request,
                    arguments,
                    spec,
                    None,
                )
                .await;
        }
        if config.adapter == kotlin::ADAPTER
            && let Some(home) = arguments
                .as_object_mut()
                .and_then(|o| o.remove("__adapterJavaHome"))
                .and_then(|v| v.as_str().map(str::to_owned))
        {
            spec.env.push(("JAVA_HOME".into(), home));
        }
        if config.adapter == "rdbg" {
            rdbg_command_line(&mut spec, &config, &cwd)?;
        }
        if let Some(command) = custom_command(&spec.command) {
            spec.command = command;
        }
        // debugpy: run the adapter with the debuggee's interpreter (venvs carry their own debugpy),
        // or with the launcher's when the debuggee runs through a manager (`uv run python`).
        if config.adapter == "debugpy" {
            let python = match (arguments.get("debugLauncherPython"), arguments.get("python")) {
                (Some(Value::String(p)), _) | (_, Some(Value::String(p))) => Some(p.clone()),
                (_, Some(Value::Array(a))) => a.first().and_then(Value::as_str).map(str::to_owned),
                _ => None,
            };
            if let Some(python) = python {
                spec.command = python;
            }
        }
        // Flutter: a project depending on the Flutter SDK needs `flutter debug_adapter`
        // (the Dart adapter cannot start a program importing `dart:ui`, and hot reload
        // is Flutter-only). Plain Dart projects keep the configured `dart`.
        if config.adapter == "dart" && spec.command == "dart" {
            let program = arguments.get("program").and_then(Value::as_str).map(Path::new);
            if force_flutter || is_flutter_project(&cwd, program) {
                spec.command = "flutter".into();
            }
        }
        let id = DebugSessionId::next();
        let debug_server = take_debug_server(&mut arguments)?;
        if let Some(server) = &debug_server {
            spec.server_host = server.host.clone();
        }
        if let Some(cargo) = arguments.as_object_mut().and_then(|o| o.remove("cargo")) {
            let cargo_args: Vec<String> = cargo
                .get("args")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
                .unwrap_or_else(|| vec!["build".into()]);
            let filter = cargo::CargoFilter::from_json(cargo.get("filter"));
            let sink = owner.sink.clone();
            let program = cargo::build(&cwd, &cargo_args, &filter, move |line| {
                sink.emit(ide_core::IdeEvent::Debug {
                    session: id,
                    event: ide_core::event::DebugEvent::Output { category: "console".into(), output: line },
                });
            })
            .await?;
            arguments["program"] = json!(program);
        }
        // Attach to a Node process started without `--inspect`: open its inspector first.
        if config.adapter == "js-debug" && config.request == "attach" && arguments.get("port").is_none() {
            let pid = arguments.get("processId").and_then(|p| match p {
                Value::String(s) => s.split(':').next().and_then(|p| p.trim().parse::<u32>().ok()),
                other => other.as_u64().and_then(|p| u32::try_from(p).ok()),
            });
            if let Some(pid) = pid {
                let port = attach::enable_node_inspector(pid).await?;
                if let Some(obj) = arguments.as_object_mut() {
                    obj.remove("processId");
                    obj.insert("port".into(), port.into());
                    obj.entry("address").or_insert_with(|| "127.0.0.1".into());
                }
            }
        }
        substitute_free_port(&mut arguments, &mut || adapter::free_port().map_err(IdeError::from))?;
        // VS Code passes the workspace folder: js-debug's default `outFiles` (where it looks
        // for compiled code of a TypeScript breakpoint before it loads) is relative to it.
        if config.adapter == "js-debug" && arguments.get("__workspaceFolder").is_none() {
            arguments["__workspaceFolder"] = json!(cwd);
        }
        // Godot compares `project` with its own (resolved) project path: `/tmp/game` is
        // rejected by an editor that opened `/private/tmp/game`.
        if config.adapter == "godot"
            && let Some(project) = arguments.get("project").and_then(Value::as_str)
            && let Ok(real) = std::fs::canonicalize(project)
        {
            arguments["project"] = json!(real);
        }
        if config.adapter == "codelldb" {
            if arguments.get("sourceLanguages").is_none() {
                arguments["sourceLanguages"] = json!(["rust"]);
            }
            // The Debug Console and Evaluate Expression take expressions, as with every other
            // debugger; LLDB commands still run with a leading backtick.
            match arguments.get_mut("_adapterSettings") {
                None => arguments["_adapterSettings"] = json!({"consoleMode": "evaluate"}),
                Some(Value::Object(settings)) => {
                    settings.entry("consoleMode").or_insert_with(|| json!("evaluate"));
                }
                Some(_) => {}
            }
        }
        let port = debug_server.map(|s| s.port);
        self.start_session(id, owner, config.name, config.adapter, None, config.request, arguments, spec, port).await
    }

    /// `startDebugging` reverse request: a child session on the same adapter.
    pub(crate) async fn start_child(
        &self,
        parent: &Arc<Session>,
        request: String,
        configuration: Value,
    ) -> IdeResult<()> {
        let name =
            configuration.get("name").and_then(Value::as_str).map(str::to_owned).unwrap_or_else(|| parent.name.clone());
        let mut configuration = configuration;
        if let Some(obj) = configuration.as_object_mut() {
            obj.entry("request").or_insert_with(|| request.clone().into());
        }
        self.start_session(
            DebugSessionId::next(),
            parent.owner.clone(),
            name,
            parent.adapter.clone(),
            Some(parent.id),
            request,
            configuration,
            parent.spec.clone(),
            parent.port,
        )
        .await
        .map(|_| ())
    }

    #[allow(clippy::too_many_arguments)]
    async fn start_session(
        &self,
        id: DebugSessionId,
        owner: SessionOwner,
        name: String,
        adapter_name: String,
        parent: Option<DebugSessionId>,
        request: String,
        arguments: Value,
        spec: AdapterSpec,
        reuse_port: Option<u16>,
    ) -> IdeResult<DebugSessionId> {
        if request != "launch" && request != "attach" {
            return Err(IdeError::invalid(format!("request must be `launch` or `attach`, got `{request}`")));
        }
        let io = self.launcher.launch(spec.clone(), reuse_port).await.map_err(|e| {
            if spec.target.is_some() {
                IdeError::new(e.kind, format!("{}\nargv: {:?} {:?}", e.message, spec.command, spec.args))
            } else {
                e
            }
        })?;
        let stderr = io.stderr.clone();
        let (conn, incoming) = {
            let stderr = stderr.clone();
            Connection::start_with_target(
                io.reader,
                io.writer,
                Box::new(move |line| adapter::push_line(&stderr, line)),
                spec.target.clone(),
            )
        };
        let rdbg_pid = (adapter_name == "rdbg" && request == "launch")
            .then(|| io.child.as_ref().and_then(tokio::process::Child::id))
            .flatten();
        let session =
            Arc::new(Session::new(id, owner, name, adapter_name, parent, request, conn, spec, io.port, io.child));
        // rdbg execs the debuggee in its own process and sends no DAP process event.
        if let Some(pid) = rdbg_pid {
            session.debuggee_pid.store(i64::from(pid), Ordering::Release);
        }
        if let Some(mut output) = io.program_output {
            session.output_drained.send_replace(false);
            let session = session.clone();
            tokio::spawn(async move {
                while let Some((category, output)) = output.recv().await {
                    session.emit(ide_core::event::DebugEvent::Output { category: category.into(), output });
                }
                session.output_drained.send_replace(true);
            });
        }
        self.sessions.lock().insert(id, session.clone());
        self.order.lock().push(id);
        // Announced before the event loop runs, so it precedes every adapter event.
        session.emit(ide_core::event::DebugEvent::Started {
            name: session.name.clone(),
            adapter: session.adapter.clone(),
            parent,
        });
        tokio::spawn(session::event_loop(self.me.clone(), session.clone(), incoming));

        let configured = tokio::select! {
            biased;
            _ = session.startup_cancel.cancelled() => return Err(IdeError::cancelled()),
            result = self.configure(&session, arguments) => result,
        };
        match configured {
            Ok(()) => Ok(id),
            Err(e) => {
                let e = if session.conn.is_closed() {
                    let mut msg = format!("debug adapter `{}` exited during startup", session.adapter);
                    if session.spec.target.is_some() {
                        msg.push_str(&format!("\nargv: {:?} {:?}", session.spec.command, session.spec.args));
                    }
                    let tail = stderr.lock().join("\n");
                    if !tail.is_empty() {
                        msg.push_str(":\n");
                        msg.push_str(&tail);
                    }
                    if let Some(hint) = &session.spec.install_hint {
                        msg.push('\n');
                        msg.push_str(hint);
                    }
                    IdeError::unavailable(msg)
                } else if session.spec.target.is_some() {
                    IdeError::new(
                        e.kind,
                        format!(
                            "{}\nargv: {:?} {:?}\n{}",
                            e.message,
                            session.spec.command,
                            session.spec.args,
                            stderr.lock().join("\n")
                        ),
                    )
                } else {
                    e
                };
                session.terminated.store(true, Ordering::Release);
                self.shutdown(&session, true).await;
                Err(e)
            }
        }
    }

    async fn configure(&self, s: &Arc<Session>, mut arguments: Value) -> IdeResult<()> {
        if s.adapter == kotlin::ADAPTER {
            let project = arguments
                .get("projectRoot")
                .and_then(Value::as_str)
                .map(PathBuf::from)
                .unwrap_or_else(|| s.spec.cwd.clone());
            let mirror = tokio::task::spawn_blocking(move || kotlin::SourceMirror::create(&project))
                .await
                .map_err(|e| IdeError::internal(e.to_string()))??;
            arguments["projectRoot"] = json!(mirror.root());
            *s.kotlin_mirror.lock() = Some(mirror);
        }
        let caps = s
            .conn
            .request_timeout(
                "initialize",
                json!({
                    "clientID": "openidea",
                    "clientName": "OpenIDEA",
                    "adapterID": s.adapter,
                    "locale": "en",
                    "linesStartAt1": true,
                    "columnsStartAt1": true,
                    "pathFormat": "path",
                    "supportsVariableType": true,
                    "supportsVariablePaging": false,
                    "supportsRunInTerminalRequest": s.spec.target.is_none(),
                    "supportsStartDebuggingRequest": s.spec.target.is_none(),
                    "supportsProgressReporting": true,
                    "supportsInvalidatedEvent": false,
                    "supportsMemoryReferences": false,
                    "supportsArgsCanBeInterpretedByShell": false,
                }),
                INIT_TIMEOUT,
            )
            .await?;
        *s.caps.lock() = if caps.is_object() { caps } else { json!({}) };

        // The Kotlin adapter ignores the resolved classpath and project runtime on launch.
        let request = if s.adapter == kotlin::ADAPTER && s.request == "launch" {
            session::start_kotlin_debuggee(s, &mut arguments).await?;
            "attach"
        } else {
            &s.request
        };
        if s.adapter == kotlin::ADAPTER {
            let host = arguments
                .get("hostName")
                .and_then(Value::as_str)
                .ok_or_else(|| IdeError::invalid("Missing Kotlin JDWP host"))?
                .to_owned();
            let port = arguments
                .get("port")
                .and_then(Value::as_u64)
                .and_then(|p| u16::try_from(p).ok())
                .filter(|p| *p != 0)
                .ok_or_else(|| IdeError::invalid("Invalid Kotlin JDWP port"))?;
            let (relay, port) = kotlin_jdwp::StartupRelay::start(host, port).await?;
            *s.kotlin_relay.lock() = Some(relay);
            arguments["hostName"] = json!("127.0.0.1");
            arguments["port"] = json!(port);
        }
        // Launch/attach may wait for a slow runtime or a remote target. Let the adapter report
        // failure; Stop cancels configuration and a closed connection fails the pending reply.
        // Many adapters answer only after `configurationDone`, so don't wait for the reply yet.
        let launch = s.conn.send_request(request, arguments)?;
        let mut launch = Box::pin(async move { launch.await.unwrap_or(Err(DapError::Closed)) });
        let mut initialized = s.initialized.subscribe();
        let mut launch_result = None;
        let got_initialized = tokio::select! {
            r = initialized.wait_for(|v| *v) => { r.map_err(|_| DapError::Closed)?; true }
            r = &mut launch => {
                r?;
                launch_result = Some(());
                false
            }
        };
        if !got_initialized {
            // Launched before `initialized`; give the adapter a moment to send it.
            let _ = tokio::time::timeout(INIT_TIMEOUT, initialized.wait_for(|v| *v)).await;
        }

        // A fresh adapter has no breakpoints, so a file with none enabled needs no request; the
        // others go out together, as VS Code sends them, instead of one round trip per file.
        let (files, idle): (Vec<_>, Vec<_>) = self
            .breakpoints
            .lock()
            .iter()
            .map(|(p, b)| (p.clone(), b.clone()))
            .partition(|(_, b)| b.iter().any(|b| b.enabled));
        let sent = join_all(files.iter().map(|(path, bps)| s.send_breakpoints(path, bps, None))).await;
        // Breakpoint states follow the owner's first session.
        let first = self.live_sessions().into_iter().find(|f| f.owner.key == s.owner.key).map(|f| f.id) == Some(s.id);
        let idle = idle.into_iter().map(|(path, bps)| (path, Ok(unsent(&bps))));
        for (path, result) in files.into_iter().map(|(path, _)| path).zip(sent).chain(idle) {
            match result {
                Ok(states) => {
                    if first {
                        self.states.lock().insert(path.clone(), states);
                        s.emit(ide_core::event::DebugEvent::BreakpointsChanged { path: path.into() });
                    }
                }
                Err(e) if s.adapter == kotlin::ADAPTER => return Err(e.into()),
                Err(e) => tracing::debug!("setBreakpoints for {} failed: {e}", path.display()),
            }
        }
        let functions = self.function_breakpoints.lock().clone();
        if !functions.is_empty()
            && s.supports("supportsFunctionBreakpoints")
            && let Err(e) = s.send_function_breakpoints(&functions).await
        {
            tracing::debug!("setFunctionBreakpoints failed: {e}");
        }
        let data = self.data_breakpoints.lock().clone();
        if !data.is_empty()
            && s.supports("supportsDataBreakpoints")
            && let Err(e) = s.send_data_breakpoints(&data).await
        {
            tracing::debug!("setDataBreakpoints failed: {e}");
        }
        let has_filters = s.caps.lock().get("exceptionBreakpointFilters").and_then(Value::as_array).is_some();
        if has_filters {
            let _ = self.send_exception_breakpoints(s).await;
        }
        if s.supports("supportsConfigurationDoneRequest") {
            if s.adapter == kotlin::ADAPTER {
                drop(s.conn.send_request("configurationDone", json!({}))?);
            } else {
                s.conn.request_timeout("configurationDone", Value::Null, REQUEST_TIMEOUT).await?;
            }
        }
        s.configured.store(true, Ordering::Release);
        if launch_result.is_none() {
            launch.await?;
        }
        if let Some(relay) = s.kotlin_relay.lock().as_mut() {
            relay.release();
        }
        Ok(())
    }

    /// The connection dropped (adapter exited or `shutdown` finished).
    pub(crate) fn session_closed(&self, s: &Arc<Session>) {
        s.kill_processes();
        let removed = self.sessions.lock().remove(&s.id).is_some();
        self.order.lock().retain(|id| *id != s.id);
        if removed && !s.terminated.swap(true, Ordering::AcqRel) {
            s.emit(ide_core::event::DebugEvent::Terminated);
        }
    }

    /// Ends a session: `terminate` (when asked and supported) → `disconnect` → kill.
    pub(crate) async fn shutdown(&self, s: &Arc<Session>, terminate: bool) {
        // java-debug runs the program itself and pipes its stdout over DAP. A `disconnect`
        // ends that DAP session, so every line the program writes while shutting down is lost.
        // Ask the program to exit ourselves and keep the adapter attached until it has drained
        // the console (`terminated`), as IDEA does with the process it owns.
        let pid = s.debuggee_pid.load(Ordering::Acquire);
        let own_terminate = terminate && s.request == "launch" && pid > 0;
        // rdbg's terminate exits the Ruby process without terminating its children.
        let graceful =
            terminate && s.request == "launch" && s.adapter != "rdbg" && s.supports("supportsTerminateRequest");
        if !s.conn.is_closed() {
            if graceful {
                let _ = s.conn.request_timeout("terminate", json!({ "restart": false }), SHUTDOWN_TIMEOUT).await;
            }
            if !graceful && !own_terminate {
                let _ = s
                    .conn
                    .request_timeout(
                        "disconnect",
                        json!({ "restart": false, "terminateDebuggee": s.request == "launch" }),
                        SHUTDOWN_TIMEOUT,
                    )
                    .await;
            }
        }
        if own_terminate && !graceful {
            // Signal before anything else: waiting on a request the adapter may not answer
            // would delay the shutdown the console is supposed to show.
            crate::session::signal_debuggee(s, false);
        }
        if graceful {
            // java-debug sends `terminated` only after it has drained the program's console
            // (it waits up to 5 s for the output pump). Close on the process id alone and the
            // last shutdown lines are dropped, so wait for that event here.
            let deadline = std::time::Instant::now() + crate::session::DEBUGGEE_EXIT_WAIT;
            while !s.terminated.load(Ordering::Acquire) && std::time::Instant::now() < deadline {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        }
        // An adapter answers `disconnect` before the program it launched has exited, and that
        // program keeps its port until it is gone. Reporting the session as terminated then
        // lets Run start again into an occupied port, so wait for the program first — with the
        // connection still open, so a second Stop can find the session and kill it.
        crate::session::wait_for_debuggee(s, terminate).await;
        if terminate && s.request == "launch" {
            // The adapter reports `terminated` only after it has drained the program's console
            // (java-debug waits up to 5 s for the pump): closing before that drops the last
            // shutdown lines from the console.
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(6);
            while !s.terminated.load(Ordering::Acquire) && !s.conn.is_closed() && std::time::Instant::now() < deadline {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        }
        if graceful && !s.conn.is_closed() {
            let _ = s
                .conn
                .request_timeout(
                    "disconnect",
                    json!({ "restart": false, "terminateDebuggee": false }),
                    SHUTDOWN_TIMEOUT,
                )
                .await;
        }
        s.conn.close();
        self.session_closed(s);
        if s.adapter == "delve" && s.spec.server_host.is_none() {
            let cwd = s.spec.cwd.clone();
            tokio::task::spawn_blocking(move || remove_delve_binaries(&cwd));
        }
    }

    /// Breakpoints are kept per file even without a session and sent on start.
    /// Returns states from the first live session, or unverified states when none.
    pub async fn set_breakpoints(
        &self,
        path: PathBuf,
        breakpoints: Vec<Breakpoint>,
    ) -> IdeResult<Vec<BreakpointState>> {
        {
            let mut store = self.breakpoints.lock();
            if breakpoints.is_empty() {
                store.remove(&path);
            } else {
                store.insert(path.clone(), breakpoints.clone());
            }
        }
        let mut result: Option<Vec<BreakpointState>> = None;
        for s in self.live_sessions() {
            if !s.configured.load(Ordering::Acquire) || s.conn.is_closed() {
                continue;
            }
            match s.send_breakpoints(&path, &breakpoints, None).await {
                Ok(states) => {
                    result.get_or_insert(states);
                }
                Err(e) if s.adapter == kotlin::ADAPTER => return Err(e.into()),
                Err(e) => tracing::debug!("setBreakpoints on session {} failed: {e}", s.id.0),
            }
        }
        let states = result.unwrap_or_else(|| unsent(&breakpoints));
        self.states.lock().insert(path, states.clone());
        Ok(states)
    }

    /// Refresh fallback copies after an editor save.
    pub async fn refresh_source_mirrors(&self, owner: &str) -> IdeResult<()> {
        let sessions: Vec<_> = self.sessions.lock().values().filter(|s| s.owner.key == owner).cloned().collect();
        tokio::task::spawn_blocking(move || {
            for s in sessions {
                if let Some(mirror) = s.kotlin_mirror.lock().as_mut()
                    && let Err(e) = mirror.refresh()
                {
                    tracing::warn!("Could not refresh Kotlin debug sources: {e}");
                }
            }
            Ok(())
        })
        .await
        .map_err(|e| IdeError::internal(e.to_string()))?
    }

    /// Last known verification states of a file's breakpoints (after `BreakpointsChanged`).
    pub fn breakpoint_states(&self, path: &Path) -> Vec<BreakpointState> {
        self.states.lock().get(path).cloned().unwrap_or_default()
    }

    pub(crate) fn update_breakpoint_state(&self, path: &Path, index: usize, bp: &Value) -> bool {
        let mut states = self.states.lock();
        let Some(slot) = states.get_mut(path).and_then(|v| v.get_mut(index)) else { return false };
        let next = session::state_from(bp, slot.line);
        let next = BreakpointState { message: next.message.or_else(|| slot.message.clone()), ..next };
        let changed = *slot != next;
        *slot = next;
        changed
    }

    async fn send_exception_breakpoints(&self, s: &Arc<Session>) -> IdeResult<()> {
        let filters = exception_filters_from(&s.caps.lock());
        let enabled = enabled_filters(&filters, &self.exception_choices.lock(), &s.adapter);
        s.conn.request_timeout("setExceptionBreakpoints", json!({ "filters": enabled }), REQUEST_TIMEOUT).await?;
        Ok(())
    }

    /// Exception filters offered by the adapter of each live session of `owner` (all when `None`).
    pub fn exception_filters(&self, owner: Option<&str>) -> Vec<SessionExceptionFilters> {
        self.live_sessions()
            .iter()
            .filter(|s| owner.is_none_or(|o| s.owner.key == o))
            .map(|s| SessionExceptionFilters {
                session: s.id,
                adapter: s.adapter.clone(),
                filters: exception_filters_from(&s.caps.lock()),
            })
            .collect()
    }

    /// Stores exception filter choices (filter id → enabled; kept without a session, applied on
    /// start) and sends them to every configured session that offers exception filters.
    pub async fn set_exception_breakpoints(&self, choices: BTreeMap<String, bool>) -> IdeResult<()> {
        *self.exception_choices.lock() = choices;
        for s in self.live_sessions() {
            if !s.configured.load(Ordering::Acquire) || s.conn.is_closed() {
                continue;
            }
            if exception_filters_from(&s.caps.lock()).is_empty() {
                continue;
            }
            if let Err(e) = self.send_exception_breakpoints(&s).await {
                tracing::debug!("setExceptionBreakpoints on session {} failed: {e}", s.id.0);
            }
        }
        Ok(())
    }

    /// Changes a variable's value: `setVariable` in its container, or `setExpression`
    /// on its evaluate name when the adapter only supports that. Returns the new value.
    pub async fn set_variable(
        &self,
        s: DebugSessionId,
        container: i64,
        name: String,
        evaluate_name: Option<String>,
        frame_id: Option<i64>,
        value: String,
    ) -> IdeResult<Variable> {
        let session = self.session(s)?;
        let body = if container > 0 && session.supports("supportsSetVariable") {
            session
                .conn
                .request_timeout(
                    "setVariable",
                    json!({ "variablesReference": container, "name": name, "value": value }),
                    REQUEST_TIMEOUT,
                )
                .await?
        } else if let (Some(expr), true) = (evaluate_name.as_ref(), session.supports("supportsSetExpression")) {
            let mut args = json!({ "expression": expr, "value": value });
            if let Some(f) = frame_id {
                args["frameId"] = f.into();
            }
            session.conn.request_timeout("setExpression", args, REQUEST_TIMEOUT).await?
        } else {
            return Err(IdeError::unavailable(format!("debug adapter `{}` cannot change values", session.adapter)));
        };
        Ok(Variable {
            name: name.clone(),
            value: body.get("value").and_then(Value::as_str).unwrap_or(&value).to_owned(),
            type_name: body.get("type").and_then(Value::as_str).filter(|t| !t.is_empty()).map(str::to_owned),
            variables_reference: body.get("variablesReference").and_then(Value::as_i64).unwrap_or(0),
            evaluate_name: evaluate_name.or(Some(name)),
        })
    }

    pub async fn threads(&self, s: DebugSessionId) -> IdeResult<Vec<ThreadInfo>> {
        let body = self.session(s)?.conn.request_timeout("threads", Value::Null, REQUEST_TIMEOUT).await?;
        Ok(body
            .get("threads")
            .and_then(Value::as_array)
            .map(|t| {
                t.iter()
                    .map(|t| ThreadInfo {
                        id: t.get("id").and_then(Value::as_i64).unwrap_or_default(),
                        name: t.get("name").and_then(Value::as_str).unwrap_or_default().to_owned(),
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    pub async fn stack_trace(&self, s: DebugSessionId, thread_id: i64) -> IdeResult<Vec<StackFrame>> {
        let session = self.session(s)?;
        let body = session
            .conn
            .request_timeout(
                "stackTrace",
                json!({ "threadId": thread_id, "startFrame": 0, "levels": 400 }),
                REQUEST_TIMEOUT,
            )
            .await?;
        let frame = |f: &Value| {
            let mut frame = frame_from(f);
            if let Some(client) = frame.path.as_deref().and_then(|p| session.client_path(&p.to_string_lossy())) {
                frame.path = Some(client.into());
            }
            frame
        };
        Ok(body.get("stackFrames").and_then(Value::as_array).map(|f| f.iter().map(frame).collect()).unwrap_or_default())
    }

    pub async fn scopes(&self, s: DebugSessionId, frame_id: i64) -> IdeResult<Vec<Scope>> {
        let body =
            self.session(s)?.conn.request_timeout("scopes", json!({ "frameId": frame_id }), REQUEST_TIMEOUT).await?;
        Ok(body
            .get("scopes")
            .and_then(Value::as_array)
            .map(|sc| {
                sc.iter()
                    .map(|sc| Scope {
                        name: sc.get("name").and_then(Value::as_str).unwrap_or_default().to_owned(),
                        variables_reference: sc.get("variablesReference").and_then(Value::as_i64).unwrap_or(0),
                        expensive: sc.get("expensive").and_then(Value::as_bool).unwrap_or(false),
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    pub async fn variables(&self, s: DebugSessionId, reference: i64) -> IdeResult<Vec<Variable>> {
        let body = self
            .session(s)?
            .conn
            .request_timeout("variables", json!({ "variablesReference": reference }), REQUEST_TIMEOUT)
            .await?;
        Ok(body
            .get("variables")
            .and_then(Value::as_array)
            .map(|v| v.iter().map(variable_from).collect())
            .unwrap_or_default())
    }

    /// Evaluates in the `repl` context.
    pub async fn evaluate(&self, s: DebugSessionId, frame_id: Option<i64>, expression: String) -> IdeResult<Variable> {
        self.evaluate_in(s, frame_id, expression, None).await
    }

    /// Evaluates with an explicit DAP context: `repl` (default), `watch`, `hover`, `clipboard`.
    pub async fn evaluate_in(
        &self,
        s: DebugSessionId,
        frame_id: Option<i64>,
        expression: String,
        context: Option<String>,
    ) -> IdeResult<Variable> {
        let session = self.session(s)?;
        let mut context = context.unwrap_or_else(|| "repl".into());
        if context == "hover" && !session.supports("supportsEvaluateForHovers") {
            context = "watch".into();
        }
        let mut args = json!({ "expression": expression, "context": context });
        if let Some(f) = frame_id {
            args["frameId"] = f.into();
        }
        let body = session.conn.request_timeout("evaluate", args, REQUEST_TIMEOUT).await?;
        Ok(Variable {
            name: expression.clone(),
            value: body.get("result").and_then(Value::as_str).unwrap_or_default().to_owned(),
            type_name: body.get("type").and_then(Value::as_str).filter(|t| !t.is_empty()).map(str::to_owned),
            variables_reference: body.get("variablesReference").and_then(Value::as_i64).unwrap_or(0),
            evaluate_name: Some(expression),
        })
    }

    /// Completions for `text` at `line` / `column` (0-based, UTF-16) in the frame's scope; none
    /// when the adapter doesn't offer them.
    pub async fn completions(
        &self,
        s: DebugSessionId,
        frame_id: Option<i64>,
        text: String,
        line: u32,
        column: u32,
    ) -> IdeResult<Vec<DebugCompletion>> {
        let session = self.session(s)?;
        if !session.supports("supportsCompletionsRequest") {
            return Ok(Vec::new());
        }
        let mut args = json!({ "text": text, "line": line + 1, "column": column + 1 });
        if let Some(f) = frame_id {
            args["frameId"] = f.into();
        }
        let body = session.conn.request_timeout("completions", args, REQUEST_TIMEOUT).await?;
        let text =
            |v: &Value, key: &str| v.get(key).and_then(Value::as_str).filter(|t| !t.is_empty()).map(str::to_owned);
        Ok(body
            .get("targets")
            .and_then(Value::as_array)
            .map(|targets| {
                targets
                    .iter()
                    .filter_map(|t| {
                        Some(DebugCompletion {
                            label: text(t, "label")?,
                            text: text(t, "text"),
                            kind: text(t, "type"),
                            detail: text(t, "detail"),
                            sort_text: text(t, "sortText"),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    pub async fn resume(&self, s: DebugSessionId, thread_id: i64) -> IdeResult<()> {
        let session = self.session(s)?;
        let body = session.conn.request_timeout("continue", json!({ "threadId": thread_id }), REQUEST_TIMEOUT).await?;
        let all = body.get("allThreadsContinued").and_then(Value::as_bool).unwrap_or(true);
        session.emit(ide_core::event::DebugEvent::Continued { thread_id, all_threads_continued: all });
        Ok(())
    }

    pub async fn pause(&self, s: DebugSessionId, thread_id: i64) -> IdeResult<()> {
        self.session(s)?.conn.request_timeout("pause", json!({ "threadId": thread_id }), REQUEST_TIMEOUT).await?;
        Ok(())
    }

    /// Types `text` into the terminal the session's program runs in (see [`ide_core::event::DebugEvent::ProgramInput`]).
    pub fn send_input(&self, s: DebugSessionId, text: &str) -> IdeResult<()> {
        let session = self.session(s)?;
        let mut program = session.program.lock();
        let program = program
            .as_mut()
            .ok_or_else(|| IdeError::invalid("The program doesn't read input from the debug console"))?;
        program.write(text).map_err(|e| IdeError::internal(format!("cannot write to the program: {e}")))
    }

    /// Flutter's DAP adapter: injects the changed sources into the running app.
    /// Not part of the DAP standard; adapters that do not know the request reject it.
    pub async fn hot_reload(&self, s: DebugSessionId) -> IdeResult<()> {
        self.session(s)?.conn.request_timeout("hotReload", json!({ "reason": "manual" }), REQUEST_TIMEOUT).await?;
        Ok(())
    }

    /// Flutter's DAP adapter: restarts the app without preserving state.
    pub async fn hot_restart(&self, s: DebugSessionId) -> IdeResult<()> {
        self.session(s)?.conn.request_timeout("hotRestart", json!({ "reason": "manual" }), REQUEST_TIMEOUT).await?;
        Ok(())
    }

    pub async fn step(&self, s: DebugSessionId, thread_id: i64, kind: StepKind) -> IdeResult<()> {
        let command = match kind {
            StepKind::Over => "next",
            StepKind::Into => "stepIn",
            StepKind::Out => "stepOut",
        };
        let session = self.session(s)?;
        session.conn.request_timeout(command, json!({ "threadId": thread_id }), REQUEST_TIMEOUT).await?;
        session.emit(ide_core::event::DebugEvent::Continued { thread_id, all_threads_continued: true });
        Ok(())
    }

    /// Run to cursor: a temporary breakpoint at `line` (0-based) plus `continue`;
    /// the file's real breakpoints are restored on the next stop. `force` (Force Run
    /// to Cursor) also suspends every other breakpoint until then.
    pub async fn run_to(
        &self,
        s: DebugSessionId,
        thread_id: i64,
        path: PathBuf,
        line: u32,
        force: bool,
    ) -> IdeResult<()> {
        let session = self.session(s)?;
        if force {
            self.suspend_breakpoints(&session, Some(&path)).await?;
        }
        let stored = self.stored_breakpoints(&path);
        let sent: Vec<Breakpoint> =
            if force { stored.iter().map(|b| Breakpoint { enabled: false, ..b.clone() }).collect() } else { stored };
        session.send_breakpoints(&path, &sent, Some(line)).await?;
        session.pending_restore.lock().files.insert(path);
        self.resume(s, thread_id).await
    }

    /// Sends empty breakpoint lists (line, function, data) to `session` until its next
    /// stop, when the stored ones are restored. `except` is left to the caller.
    async fn suspend_breakpoints(&self, session: &Arc<Session>, except: Option<&Path>) -> IdeResult<()> {
        // While paused the adapter holds the stored lists: only files with something enabled change.
        let files: Vec<PathBuf> = self
            .breakpoints
            .lock()
            .iter()
            .filter(|(path, bps)| Some(path.as_path()) != except && bps.iter().any(|b| b.enabled))
            .map(|(path, _)| path.clone())
            .collect();
        let sent = join_all(files.iter().map(|path| session.send_breakpoints(path, &[], None))).await;
        let mut failed = None;
        for (path, result) in files.into_iter().zip(sent) {
            match result {
                Ok(_) => {
                    session.pending_restore.lock().files.insert(path);
                }
                Err(e) => failed = failed.or(Some(e)),
            }
        }
        if let Some(e) = failed {
            return Err(e.into());
        }
        if !self.function_breakpoints.lock().is_empty() && session.supports("supportsFunctionBreakpoints") {
            session.send_function_breakpoints(&[]).await?;
            session.pending_restore.lock().functions = true;
        }
        if !self.data_breakpoints.lock().is_empty() && session.supports("supportsDataBreakpoints") {
            session.send_data_breakpoints(&[]).await?;
            session.pending_restore.lock().data = true;
        }
        Ok(())
    }

    /// Re-sends what [`suspend_breakpoints`](Self::suspend_breakpoints) / run to cursor replaced.
    pub(crate) async fn restore_breakpoints(&self, session: &Arc<Session>) {
        let pending = std::mem::take(&mut *session.pending_restore.lock());
        let files: Vec<(PathBuf, Vec<Breakpoint>)> =
            pending.files.into_iter().map(|path| (path.clone(), self.stored_breakpoints(&path))).collect();
        let sent = join_all(files.iter().map(|(path, bps)| session.send_breakpoints(path, bps, None))).await;
        for ((path, _), result) in files.iter().zip(sent) {
            if let Err(e) = result {
                tracing::debug!("restoring breakpoints of {} failed: {e}", path.display());
            }
        }
        if pending.functions {
            let functions = self.function_breakpoints.lock().clone();
            if let Err(e) = session.send_function_breakpoints(&functions).await {
                tracing::debug!("restoring function breakpoints failed: {e}");
            }
        }
        if pending.data {
            let data = self.data_breakpoints.lock().clone();
            if let Err(e) = session.send_data_breakpoints(&data).await {
                tracing::debug!("restoring data breakpoints failed: {e}");
            }
        }
    }

    /// Force Step Over: `next` with every breakpoint suspended until the step ends.
    pub async fn force_step_over(&self, s: DebugSessionId, thread_id: i64) -> IdeResult<()> {
        let session = self.session(s)?;
        self.suspend_breakpoints(&session, None).await?;
        self.step(s, thread_id, StepKind::Over).await
    }

    /// Step into a specific call of the current line (Smart Step Into).
    pub async fn step_in_target(&self, s: DebugSessionId, thread_id: i64, target_id: i64) -> IdeResult<()> {
        let session = self.session(s)?;
        session
            .conn
            .request_timeout("stepIn", json!({ "threadId": thread_id, "targetId": target_id }), REQUEST_TIMEOUT)
            .await?;
        session.emit(ide_core::event::DebugEvent::Continued { thread_id, all_threads_continued: true });
        Ok(())
    }

    /// Calls on the current line of `frame_id` that can be stepped into.
    pub async fn step_in_targets(&self, s: DebugSessionId, frame_id: i64) -> IdeResult<Vec<StepInTarget>> {
        let session = self.session(s)?;
        if !session.supports("supportsStepInTargetsRequest") {
            return Err(IdeError::unavailable(format!(
                "debug adapter `{}` does not support Smart Step Into",
                session.adapter
            )));
        }
        let body =
            session.conn.request_timeout("stepInTargets", json!({ "frameId": frame_id }), REQUEST_TIMEOUT).await?;
        Ok(body
            .get("targets")
            .and_then(Value::as_array)
            .map(|t| t.iter().map(step_in_target_from).collect())
            .unwrap_or_default())
    }

    /// Reset Frame (IDEA's Drop Frame): `restartFrame`, so execution re-enters the frame.
    pub async fn restart_frame(&self, s: DebugSessionId, frame_id: i64) -> IdeResult<()> {
        let session = self.session(s)?;
        if !session.supports("supportsRestartFrame") {
            return Err(IdeError::unavailable(format!("debug adapter `{}` cannot reset frames", session.adapter)));
        }
        session.conn.request_timeout("restartFrame", json!({ "frameId": frame_id }), REQUEST_TIMEOUT).await?;
        Ok(())
    }

    pub fn capabilities(&self, s: DebugSessionId) -> IdeResult<DebugCapabilities> {
        let session = self.session(s)?;
        let mut caps = capabilities_from(&session.caps.lock());
        caps.hot_code_replace = HOT_CODE_REPLACE_ADAPTERS.contains(&session.adapter.as_str());
        Ok(caps)
    }

    /// HotSwap: reloads the classes compiled since the session started (or since the
    /// last reload) into the debuggee (java-debug `redefineClasses`).
    pub async fn redefine_classes(&self, s: DebugSessionId) -> IdeResult<HotSwapResult> {
        let session = self.session(s)?;
        if !HOT_CODE_REPLACE_ADAPTERS.contains(&session.adapter.as_str()) {
            return Err(IdeError::unavailable(format!(
                "debug adapter `{}` cannot reload changed classes",
                session.adapter
            )));
        }
        let body = session.conn.request_timeout("redefineClasses", json!({}), HOT_SWAP_TIMEOUT).await?;
        Ok(hot_swap_result(&body))
    }

    /// Stores method breakpoints (kept without a session, sent on start) and sends them to
    /// every configured session whose adapter supports them. States from the first one.
    pub async fn set_function_breakpoints(&self, list: Vec<FunctionBreakpoint>) -> IdeResult<Vec<BreakpointState>> {
        *self.function_breakpoints.lock() = list.clone();
        let mut result = None;
        for s in self.live_sessions() {
            if !s.configured.load(Ordering::Acquire) || s.conn.is_closed() || !s.supports("supportsFunctionBreakpoints")
            {
                continue;
            }
            match s.send_function_breakpoints(&list).await {
                Ok(states) => {
                    result.get_or_insert(states);
                }
                Err(e) => tracing::debug!("setFunctionBreakpoints on session {} failed: {e}", s.id.0),
            }
        }
        Ok(result.unwrap_or_else(|| unverified(list.iter().map(|b| b.enabled))))
    }

    /// Stores field watchpoints and sends them to every configured session that supports them.
    pub async fn set_data_breakpoints(&self, list: Vec<DataBreakpoint>) -> IdeResult<Vec<BreakpointState>> {
        *self.data_breakpoints.lock() = list.clone();
        let mut result = None;
        for s in self.live_sessions() {
            if !s.configured.load(Ordering::Acquire) || s.conn.is_closed() || !s.supports("supportsDataBreakpoints") {
                continue;
            }
            match s.send_data_breakpoints(&list).await {
                Ok(states) => {
                    result.get_or_insert(states);
                }
                Err(e) => tracing::debug!("setDataBreakpoints on session {} failed: {e}", s.id.0),
            }
        }
        Ok(result.unwrap_or_else(|| unverified(list.iter().map(|b| b.enabled))))
    }

    /// Whether (and how) `name` in the variables container `container` can be watched.
    pub async fn data_breakpoint_info(
        &self,
        s: DebugSessionId,
        container: i64,
        name: String,
        frame_id: Option<i64>,
    ) -> IdeResult<DataBreakpointInfo> {
        let session = self.session(s)?;
        if !session.supports("supportsDataBreakpoints") {
            return Err(IdeError::unavailable(format!(
                "debug adapter `{}` does not support field watchpoints",
                session.adapter
            )));
        }
        let mut args = json!({ "name": name });
        if container > 0 {
            args["variablesReference"] = container.into();
        }
        if let Some(f) = frame_id {
            args["frameId"] = f.into();
        }
        let body = session.conn.request_timeout("dataBreakpointInfo", args, REQUEST_TIMEOUT).await?;
        Ok(DataBreakpointInfo {
            data_id: body.get("dataId").and_then(Value::as_str).map(str::to_owned),
            description: body.get("description").and_then(Value::as_str).unwrap_or_default().to_owned(),
            access_types: body
                .get("accessTypes")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
                .unwrap_or_default(),
        })
    }

    /// Stops every session `key` started: the window that opened the project is closing.
    pub async fn stop_key(&self, key: &str) {
        let ids: Vec<DebugSessionId> = self.sessions(Some(key)).into_iter().map(|s| s.id).collect();
        for id in ids {
            if let Err(e) = self.stop(id).await {
                tracing::debug!("debug session {id:?} did not stop: {e}");
            }
        }
    }

    /// Stops every debug session started from `root` or below — closing a project stops the
    /// programs it launched even when the session's owner key does not name the window doing
    /// the closing (window groups, auxiliary windows).
    pub async fn stop_under(&self, root: &Path) {
        let ids: Vec<DebugSessionId> =
            self.live_sessions().into_iter().filter(|s| s.spec.cwd.starts_with(root)).map(|s| s.id).collect();
        tracing::info!(root = %root.display(), sessions = ids.len(), "closing project: stopping debug sessions");
        for id in ids {
            if let Err(e) = self.stop(id).await {
                tracing::debug!("debug session {id:?} did not stop: {e}");
            }
        }
    }

    /// Stops a session and its child sessions. A second Stop while the first one waits kills
    /// the program instead of waiting for it — even after the adapter dropped the session.
    pub async fn stop(&self, s: DebugSessionId) -> IdeResult<()> {
        {
            let in_flight = self.stopping.lock();
            if let Some(session) = in_flight.get(&s) {
                session.stop_force.store(true, Ordering::Release);
                return Ok(());
            }
        }
        let session = self.session(s)?;
        self.stopping.lock().insert(s, session.clone());
        let result = self.stop_tree(session).await;
        self.stopping.lock().remove(&s);
        result
    }

    async fn stop_tree(&self, session: Arc<Session>) -> IdeResult<()> {
        session.startup_cancel.cancel();
        let children: Vec<Arc<Session>> =
            self.live_sessions().into_iter().filter(|c| c.parent == Some(session.id)).collect();
        for child in children {
            child.startup_cancel.cancel();
            self.shutdown(&child, true).await;
        }
        self.shutdown(&session, true).await;
        Ok(())
    }
}

#[cfg(test)]
mod tests;
