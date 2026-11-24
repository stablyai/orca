//! One debug session: the adapter connection, its capabilities, the event
//! loop translating DAP events into `IdeEvent::Debug`, and reverse requests.

use crate::adapter::AdapterSpec;
use crate::connection::{Connection, DapError, Incoming};
use crate::{Breakpoint, BreakpointState, DataBreakpoint, DebugManager, FunctionBreakpoint, SessionOwner};
use ide_core::event::DebugEvent;
use ide_core::{DebugSessionId, IdeEvent, TaskId};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Weak;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Child;
use tokio::sync::{mpsc, watch};

/// What has to be re-sent on the next stop.
#[derive(Default)]
pub(crate) struct PendingRestore {
    pub files: BTreeSet<PathBuf>,
    pub functions: bool,
    pub data: bool,
}

pub(crate) struct Session {
    pub id: DebugSessionId,
    /// Who started the session (inherited by child sessions); all its events go to the owner's sink.
    pub owner: SessionOwner,
    pub name: String,
    pub adapter: String,
    pub parent: Option<DebugSessionId>,
    pub request: String,
    pub conn: Connection,
    pub spec: AdapterSpec,
    /// TCP port of a server-mode adapter (for `startDebugging` child sessions).
    pub port: Option<u16>,
    pub caps: Mutex<Value>,
    pub adapter_process: Mutex<Option<Child>>,
    /// Processes started for `runInTerminal`.
    pub debuggees: Mutex<Vec<Child>>,
    /// The terminal a `runInTerminal` program runs in: typed input goes to it.
    pub program: Mutex<Option<ProgramTerminal>>,
    /// Set once `configurationDone` was sent; breakpoint updates go out live after that.
    pub configured: AtomicBool,
    pub initialized: watch::Sender<bool>,
    pub startup_cancel: ide_core::CancellationToken,
    pub output_drained: watch::Sender<bool>,
    pub terminated: AtomicBool,
    /// Set by a second Stop: the one waiting for the program kills it instead.
    pub stop_force: AtomicBool,
    /// `systemProcessId` from the adapter's `process` event: the program being debugged.
    pub debuggee_pid: AtomicI64,
    /// Pids signalled for the current stop: the reported pid and everything it started (an
    /// adapter may report the launcher shell, whose child is the program).
    #[cfg_attr(not(unix), allow(dead_code))]
    pub stop_pids: parking_lot::Mutex<Vec<i32>>,
    /// Breakpoints replaced for run to cursor / force stepping, restored on the next stop.
    pub pending_restore: Mutex<PendingRestore>,
    /// Adapter breakpoint id → (file, index in the stored list).
    pub breakpoint_ids: Mutex<HashMap<i64, (PathBuf, usize)>>,
    /// Resolved path → the path as the IDE knows it, for adapters given resolved paths.
    resolved_paths: Mutex<HashMap<PathBuf, PathBuf>>,
    progress: Mutex<HashMap<String, TaskId>>,
    pub kotlin_relay: Mutex<Option<crate::kotlin_jdwp::StartupRelay>>,
    pub kotlin_mirror: Mutex<Option<crate::kotlin::SourceMirror>>,
}

/// Adapters that only match files by their resolved path: Godot maps a script to
/// `res://` by prefix and silently never stops at a breakpoint set through a
/// symlinked path (`/tmp/game` while the editor has `/private/tmp/game`).
const RESOLVES_PATHS: &[&str] = &["godot"];

impl Session {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        id: DebugSessionId,
        owner: SessionOwner,
        name: String,
        adapter: String,
        parent: Option<DebugSessionId>,
        request: String,
        conn: Connection,
        spec: AdapterSpec,
        port: Option<u16>,
        child: Option<Child>,
    ) -> Self {
        Self {
            id,
            owner,
            name,
            adapter,
            parent,
            request,
            conn,
            spec,
            port,
            caps: Mutex::new(Value::Null),
            adapter_process: Mutex::new(child),
            debuggees: Mutex::new(Vec::new()),
            program: Mutex::new(None),
            configured: AtomicBool::new(false),
            initialized: watch::channel(false).0,
            startup_cancel: ide_core::CancellationToken::new(),
            output_drained: watch::channel(true).0,
            terminated: AtomicBool::new(false),
            stop_force: AtomicBool::new(false),
            debuggee_pid: AtomicI64::new(0),
            stop_pids: parking_lot::Mutex::new(Vec::new()),
            pending_restore: Mutex::default(),
            breakpoint_ids: Mutex::new(HashMap::new()),
            resolved_paths: Mutex::new(HashMap::new()),
            progress: Mutex::new(HashMap::new()),
            kotlin_relay: Mutex::new(None),
            kotlin_mirror: Mutex::new(None),
        }
    }

    pub fn emit(&self, event: DebugEvent) {
        self.owner.sink.emit(IdeEvent::Debug { session: self.id, event });
    }

    /// `path` as sent to the adapter (resolved for [`RESOLVES_PATHS`] adapters).
    pub fn adapter_path(&self, path: &Path) -> PathBuf {
        if let Some(path) = self.kotlin_mirror.lock().as_ref().and_then(|m| m.adapter_path(path)) {
            return path;
        }
        if self.adapter == "java-debug" || (cfg!(windows) && self.adapter == "netcoredbg") {
            let native = windows_source_path(&path.to_string_lossy());
            self.resolved_paths.lock().insert(native.clone(), path.to_path_buf());
            return native;
        }
        if !RESOLVES_PATHS.contains(&self.adapter.as_str()) {
            return path.to_path_buf();
        }
        match std::fs::canonicalize(path) {
            Ok(real) if real != path => {
                self.resolved_paths.lock().insert(real.clone(), path.to_path_buf());
                real
            }
            _ => path.to_path_buf(),
        }
    }

    /// A path from the adapter as the IDE knows it (undoes [`Session::adapter_path`]).
    pub fn client_path(&self, path: &str) -> Option<PathBuf> {
        if let Some(real) = self.kotlin_mirror.lock().as_ref().and_then(|m| m.client_path(Path::new(path))) {
            return Some(real);
        }
        let key = if self.adapter == "java-debug" || (cfg!(windows) && self.adapter == "netcoredbg") {
            windows_source_path(path)
        } else {
            PathBuf::from(path)
        };
        self.resolved_paths.lock().get(&key).cloned().or_else(|| {
            (self.adapter == "java-debug" && is_windows_source_path(path))
                .then(|| PathBuf::from(path.replace('\\', "/")))
        })
    }

    pub fn supports(&self, cap: &str) -> bool {
        self.caps.lock().get(cap).and_then(Value::as_bool).unwrap_or(false)
    }

    /// Sends the breakpoints of one file (disabled ones omitted, plus an optional
    /// temporary line) and returns verification states aligned with `breakpoints`.
    pub async fn send_breakpoints(
        &self,
        path: &Path,
        breakpoints: &[Breakpoint],
        temp_line: Option<u32>,
    ) -> Result<Vec<BreakpointState>, DapError> {
        let enabled: Vec<usize> = (0..breakpoints.len()).filter(|&i| breakpoints[i].enabled).collect();
        let mut source_bps: Vec<Value> = enabled
            .iter()
            .map(|&i| {
                let b = &breakpoints[i];
                let mut v = json!({ "line": b.line + 1 });
                if let Some(c) = b.condition.as_deref().filter(|c| !c.trim().is_empty()) {
                    v["condition"] = c.into();
                }
                if let Some(c) = b.hit_condition.as_deref().filter(|c| !c.trim().is_empty()) {
                    v["hitCondition"] = c.into();
                }
                if let Some(m) = b.log_message.as_deref().filter(|m| !m.is_empty()) {
                    v["logMessage"] = m.into();
                }
                v
            })
            .collect();
        if let Some(line) = temp_line
            && !enabled.iter().any(|&i| breakpoints[i].line == line)
        {
            source_bps.push(json!({ "line": line + 1 }));
        }
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned());
        let body = self
            .conn
            .request_timeout(
                "setBreakpoints",
                json!({
                    "source": { "path": self.adapter_path(path), "name": name },
                    "breakpoints": source_bps,
                    "sourceModified": false,
                }),
                Duration::from_secs(10),
            )
            .await?;
        let returned = body.get("breakpoints").and_then(Value::as_array).cloned().unwrap_or_default();
        let mut ids = self.breakpoint_ids.lock();
        ids.retain(|_, (p, _)| p != path);
        let mut states: Vec<BreakpointState> = breakpoints
            .iter()
            .map(|b| BreakpointState {
                line: b.line,
                verified: false,
                message: (!b.enabled).then(|| "Disabled".to_owned()),
            })
            .collect();
        for (k, &i) in enabled.iter().enumerate() {
            let Some(r) = returned.get(k) else { continue };
            if let Some(id) = r.get("id").and_then(Value::as_i64) {
                ids.insert(id, (path.to_path_buf(), i));
            }
            states[i] = state_from(r, breakpoints[i].line);
        }
        Ok(states)
    }

    /// Sends method breakpoints (disabled ones omitted); states aligned with `list`.
    pub async fn send_function_breakpoints(
        &self,
        list: &[FunctionBreakpoint],
    ) -> Result<Vec<BreakpointState>, DapError> {
        let enabled: Vec<usize> = (0..list.len()).filter(|&i| list[i].enabled).collect();
        let sent: Vec<Value> = enabled
            .iter()
            .map(|&i| {
                let b = &list[i];
                let mut v = json!({ "name": b.name });
                with_conditions(&mut v, b.condition.as_deref(), b.hit_condition.as_deref());
                v
            })
            .collect();
        let body = self
            .conn
            .request_timeout("setFunctionBreakpoints", json!({ "breakpoints": sent }), Duration::from_secs(10))
            .await?;
        Ok(align_states(list.iter().map(|b| b.enabled), &enabled, &body))
    }

    /// Sends field watchpoints (disabled ones omitted); states aligned with `list`.
    pub async fn send_data_breakpoints(&self, list: &[DataBreakpoint]) -> Result<Vec<BreakpointState>, DapError> {
        let enabled: Vec<usize> = (0..list.len()).filter(|&i| list[i].enabled).collect();
        let sent: Vec<Value> = enabled
            .iter()
            .map(|&i| {
                let b = &list[i];
                let mut v = json!({ "dataId": b.data_id });
                if let Some(a) = b.access_type.as_deref().filter(|a| !a.is_empty()) {
                    v["accessType"] = a.into();
                }
                with_conditions(&mut v, b.condition.as_deref(), b.hit_condition.as_deref());
                v
            })
            .collect();
        let body = self
            .conn
            .request_timeout("setDataBreakpoints", json!({ "breakpoints": sent }), Duration::from_secs(10))
            .await?;
        Ok(align_states(list.iter().map(|b| b.enabled), &enabled, &body))
    }

    /// Kills the adapter and every debuggee we started.
    pub fn kill_processes(&self) {
        self.kotlin_relay.lock().take();
        if let Some(mut c) = self.adapter_process.lock().take() {
            if self.adapter == "rdbg"
                && let Some(pid) = c.id()
            {
                ide_core::process::kill_tree_of(pid);
            }
            let _ = c.start_kill();
        }
        for mut c in std::mem::take(&mut *self.debuggees.lock()) {
            let _ = c.start_kill();
        }
        if let Some(mut program) = self.program.lock().take() {
            let _ = program.child.kill();
        }
    }
}

/// How long Stop waits for a launched program to exit before reporting the session ended.
pub(crate) const DEBUGGEE_EXIT_WAIT: Duration = Duration::from_secs(10);

/// The program and everything it started: an adapter may report the launcher shell, whose
/// child is the debugged program, so stopping only the reported pid leaves the program alive.
#[cfg(unix)]
fn process_tree(pid: i32) -> Vec<i32> {
    use std::collections::HashMap;
    let Ok(out) = std::process::Command::new("ps").args(["-A", "-o", "pid=,ppid="]).output() else {
        return vec![pid];
    };
    let mut children: HashMap<i32, Vec<i32>> = HashMap::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let mut it = line.split_whitespace();
        let (Some(p), Some(parent)) = (it.next(), it.next()) else { continue };
        let (Ok(p), Ok(parent)) = (p.parse::<i32>(), parent.parse::<i32>()) else { continue };
        children.entry(parent).or_default().push(p);
    }
    let mut tree = vec![pid];
    let mut at = 0;
    while at < tree.len() {
        if let Some(kids) = children.get(&tree[at]) {
            tree.extend(kids.iter().copied());
        }
        at += 1;
    }
    tree
}

/// Asks the program itself to exit (`force` = SIGKILL) without ending the adapter session:
/// its output keeps flowing over DAP while it shuts down. The first call remembers the pid
/// tree, because the reported pid may die before its program does.
pub(crate) fn signal_debuggee(s: &Arc<Session>, force: bool) {
    let pid = s.debuggee_pid.load(Ordering::Acquire);
    if pid <= 0 {
        return;
    }
    #[cfg(unix)]
    {
        let mut known = s.stop_pids.lock();
        if known.is_empty() {
            *known = process_tree(pid as i32);
        }
        let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
        // Children first: the shell that started the program would otherwise reparent it.
        for p in known.iter().rev() {
            // SAFETY: plain syscall on the processes this session started.
            unsafe {
                libc::kill(*p, signal);
            }
        }
    }
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T"]);
        if force {
            cmd.arg("/F");
        }
        let _ = cmd.status();
    }
    #[cfg(not(any(unix, windows)))]
    let _ = (pid, force);
}

/// Waits until the program a `launch` session started is gone; a second Stop kills it.
pub(crate) async fn wait_for_debuggee(s: &Arc<Session>, terminate: bool) {
    if !terminate || s.request != "launch" {
        return;
    }
    let pid = s.debuggee_pid.load(Ordering::Acquire);
    if pid <= 0 {
        return;
    }
    tracing::info!(session = s.id.0, pid, "stop: waiting for the debugged program to exit");
    #[cfg(unix)]
    {
        use std::time::Instant;
        let targets = {
            let known = s.stop_pids.lock();
            if known.is_empty() { process_tree(pid as i32) } else { known.clone() }
        };
        let alive = || targets.iter().any(|p| unsafe { libc::kill(*p, 0) } == 0);
        let deadline = Instant::now() + DEBUGGEE_EXIT_WAIT;
        while alive() {
            if s.stop_force.swap(false, Ordering::AcqRel) {
                signal_debuggee(s, true);
            }
            if Instant::now() >= deadline {
                // The program ignored the terminate: do not leave it running.
                signal_debuggee(s, true);
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
    }
}

// java-debug and Windows netcoredbg need native separators for source lookup.
// Keep DAP path mode, but normalize Windows drive and UNC paths.
fn is_windows_source_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    (bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'/' | b'\\'))
        || path.starts_with("//")
        || path.starts_with(r"\\")
}

fn windows_source_path(path: &str) -> PathBuf {
    if is_windows_source_path(path) { PathBuf::from(path.replace('/', r"\")) } else { PathBuf::from(path) }
}

fn with_conditions(v: &mut Value, condition: Option<&str>, hit_condition: Option<&str>) {
    if let Some(c) = condition.filter(|c| !c.trim().is_empty()) {
        v["condition"] = c.into();
    }
    if let Some(c) = hit_condition.filter(|c| !c.trim().is_empty()) {
        v["hitCondition"] = c.into();
    }
}

/// States for a list whose enabled entries (`sent`, by index) went out in order.
fn align_states(all: impl Iterator<Item = bool>, sent: &[usize], body: &Value) -> Vec<BreakpointState> {
    let returned = body.get("breakpoints").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut states: Vec<BreakpointState> = all
        .map(|e| BreakpointState { line: 0, verified: false, message: (!e).then(|| "Disabled".to_owned()) })
        .collect();
    for (k, &i) in sent.iter().enumerate() {
        if let Some(r) = returned.get(k) {
            states[i] = state_from(r, 0);
        }
    }
    states
}

pub(crate) fn state_from(r: &Value, fallback_line: u32) -> BreakpointState {
    BreakpointState {
        line: r.get("line").and_then(Value::as_u64).map(|l| (l as u32).saturating_sub(1)).unwrap_or(fallback_line),
        verified: r.get("verified").and_then(Value::as_bool).unwrap_or(false),
        message: r.get("message").and_then(Value::as_str).map(str::to_owned),
    }
}

/// Processes adapter traffic until the connection closes.
pub(crate) async fn event_loop(
    manager: Weak<DebugManager>,
    session: Arc<Session>,
    mut incoming: mpsc::UnboundedReceiver<Incoming>,
) {
    while let Some(msg) = incoming.recv().await {
        let Some(mgr) = manager.upgrade() else { break };
        match msg {
            Incoming::Event { event, body } => on_event(&mgr, &session, &event, body).await,
            Incoming::Request { seq, command, arguments } => {
                on_reverse_request(&mgr, &session, seq, &command, arguments)
            }
            Incoming::Closed => break,
        }
    }
    // rdbg closes DAP before Ruby's remaining at_exit handlers print the test summary.
    if session.adapter == "rdbg" && session.request == "launch" {
        let mut drained = session.output_drained.subscribe();
        let _ = tokio::time::timeout(DEBUGGEE_EXIT_WAIT, drained.wait_for(|done| *done)).await;
    }
    if let Some(mgr) = manager.upgrade() {
        mgr.session_closed(&session);
    }
}

async fn on_event(mgr: &Arc<DebugManager>, s: &Arc<Session>, event: &str, mut body: Value) {
    if let Some(mirror) = s.kotlin_mirror.lock().as_ref() {
        mirror.translate(&mut body);
    }
    let int = |k: &str| body.get(k).and_then(Value::as_i64);
    let str_ = |k: &str| body.get(k).and_then(Value::as_str).map(str::to_owned);
    match event {
        "initialized" => {
            s.initialized.send_replace(true);
            s.emit(DebugEvent::Initialized);
        }
        "stopped" => {
            mgr.restore_breakpoints(s).await;
            s.emit(DebugEvent::Stopped {
                thread_id: int("threadId").unwrap_or(0),
                reason: str_("reason").unwrap_or_else(|| "pause".into()),
                description: str_("description").or_else(|| str_("text")),
                all_threads_stopped: body.get("allThreadsStopped").and_then(Value::as_bool).unwrap_or(false),
            });
        }
        "continued" => s.emit(DebugEvent::Continued {
            thread_id: int("threadId").unwrap_or(0),
            all_threads_continued: body.get("allThreadsContinued").and_then(Value::as_bool).unwrap_or(true),
        }),
        "output" => {
            let category = str_("category").unwrap_or_else(|| "console".into());
            if category == "telemetry" {
                return;
            }
            let output = str_("output").unwrap_or_default();
            if tracing::enabled!(tracing::Level::DEBUG) && mgr.stopping.lock().contains_key(&s.id) {
                tracing::debug!(session = ?s.id, bytes = output.len(), "output during stop");
            }
            s.emit(DebugEvent::Output { category, output });
        }
        // The program the adapter started: Stop must wait for it, not for the adapter's reply.
        // `process` is the DAP event; java-debug announces the same thing as `processid`.
        "process" | "processid" => {
            if let Some(pid) = int("systemProcessId").or_else(|| int("processId")).filter(|p| *p > 0) {
                s.debuggee_pid.store(pid, Ordering::Release);
            }
        }
        "thread" => s.emit(DebugEvent::Thread {
            thread_id: int("threadId").unwrap_or(0),
            started: body.get("reason").and_then(Value::as_str) != Some("exited"),
        }),
        "breakpoint" => {
            let Some(bp) = body.get("breakpoint") else { return };
            let Some(id) = bp.get("id").and_then(Value::as_i64) else { return };
            let Some((path, index)) = s.breakpoint_ids.lock().get(&id).cloned() else { return };
            if mgr.update_breakpoint_state(&path, index, bp) {
                s.emit(DebugEvent::BreakpointsChanged { path: path.into() });
            }
        }
        // Godot repeats `exited` / `terminated` when the client disconnects afterwards.
        "exited" if !s.terminated.load(Ordering::Acquire) => {
            s.emit(DebugEvent::Exited { code: int("exitCode").unwrap_or(0) as i32 })
        }
        "exited" => {}
        "terminated" => {
            let first = !s.terminated.swap(true, Ordering::AcqRel);
            let mgr = mgr.clone();
            let s = s.clone();
            // Waiting here would stop reading the adapter: it keeps sending the program's last
            // output while the program exits. Wait off the reader task, then report the end.
            tokio::spawn(async move {
                if first {
                    wait_for_debuggee(&s, true).await;
                    s.emit(DebugEvent::Terminated);
                }
                mgr.shutdown(&s, false).await;
            });
        }
        "capabilities" => {
            if let Some(new) = body.get("capabilities").and_then(Value::as_object) {
                let mut caps = s.caps.lock();
                if !caps.is_object() {
                    *caps = json!({});
                }
                if let Some(obj) = caps.as_object_mut() {
                    obj.extend(new.clone());
                }
            }
        }
        "progressStart" | "progressUpdate" | "progressEnd" => {
            let Some(pid) = str_("progressId") else { return };
            let done = event == "progressEnd";
            let (id, title) = {
                let mut progress = s.progress.lock();
                let id =
                    if done { progress.remove(&pid) } else { Some(*progress.entry(pid).or_insert_with(TaskId::next)) };
                (id, str_("title").map(|t| ide_core::task::display_title(&t)).unwrap_or_else(|| s.name.clone()))
            };
            let Some(id) = id else { return };
            s.owner.sink.emit(IdeEvent::Task {
                id,
                title,
                message: str_("message"),
                fraction: body.get("percentage").and_then(Value::as_f64).map(|p| (p / 100.0) as f32),
                done,
                cancellable: false,
            });
        }
        "hotcodereplace" => s.emit(DebugEvent::HotCodeReplace {
            change_type: crate::hot_code_replace_type(body.get("changeType")),
            message: str_("message").unwrap_or_default(),
        }),
        _ => tracing::trace!("dap: ignored event {event}"),
    }
}

fn on_reverse_request(mgr: &Arc<DebugManager>, s: &Arc<Session>, seq: i64, command: &str, args: Value) {
    if s.spec.target.is_some() {
        let _ = s.conn.respond(seq, command, Err("This debugger does not support plugin run targets".into()));
        return;
    }
    match command {
        "runInTerminal" => {
            let result = run_in_terminal(s, &args);
            let _ = s.conn.respond(seq, command, result);
        }
        "startDebugging" => {
            let mgr = mgr.clone();
            let s = s.clone();
            tokio::spawn(async move {
                let request = args.get("request").and_then(Value::as_str).unwrap_or("launch").to_owned();
                let configuration = args.get("configuration").cloned().unwrap_or_else(|| json!({}));
                let result = mgr.start_child(&s, request, configuration).await;
                let _ = s.conn.respond(seq, "startDebugging", result.map(|_| Value::Null).map_err(|e| e.message));
            });
        }
        _ => {
            let _ = s.conn.respond(seq, command, Err(format!("unsupported reverse request {command}")));
        }
    }
}

/// A `runInTerminal` program and the pseudo-terminal it runs in.
pub(crate) struct ProgramTerminal {
    writer: ide_core::input::InputWriter,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    _master: Box<dyn portable_pty::MasterPty + Send>,
}

impl ProgramTerminal {
    pub(crate) fn write(&mut self, text: &str) -> std::io::Result<()> {
        self.writer.write(text.as_bytes())
    }
}

/// `runInTerminal`: starts the debuggee on a pseudo-terminal, as an IDE terminal would (CodeLLDB
/// starts a launcher that gives the program its terminal, and the program reads input only from
/// a terminal), forwards its output to the console, and keeps the terminal for typed input.
pub(crate) fn run_in_terminal(s: &Arc<Session>, args: &Value) -> Result<Value, String> {
    use portable_pty::{CommandBuilder, PtySize, native_pty_system};
    let argv: Vec<String> = args
        .get("args")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
        .unwrap_or_default();
    let Some((program, rest)) = argv.split_first() else {
        return Err("runInTerminal without args".into());
    };
    let pair = native_pty_system()
        .openpty(PtySize { rows: 24, cols: 200, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("cannot open a terminal for {program}: {e}"))?;
    #[cfg(unix)]
    let wait_writable = ide_core::input::nonblocking(
        pair.master.as_raw_fd().ok_or_else(|| format!("terminal of {program}: PTY has no file descriptor"))?,
    )
    .map_err(|e| format!("terminal of {program}: {e}"))?;
    #[cfg(unix)]
    let wait_readable = ide_core::input::readable(
        pair.master.as_raw_fd().ok_or_else(|| format!("terminal of {program}: PTY has no file descriptor"))?,
    )
    .map_err(|e| format!("terminal of {program}: {e}"))?;
    let mut cmd = CommandBuilder::new(program);
    // CodeLLDB's launcher clears the terminal first; the console keeps the session's earlier output.
    cmd.args(rest.iter().filter(|a| *a != "--clear-screen"));
    for (k, v) in ide_core::process::host_env_fixes() {
        match v {
            Some(v) => cmd.env(k, v),
            None => cmd.env_remove(k),
        }
    }
    for (k, v) in ide_core::process::shell_env() {
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");
    match args.get("cwd").and_then(Value::as_str).filter(|c| !c.is_empty()) {
        Some(cwd) => cmd.cwd(cwd),
        None => cmd.cwd(&s.spec.cwd),
    }
    if let Some(env) = args.get("env").and_then(Value::as_object) {
        for (k, v) in env {
            match v.as_str() {
                Some(v) => cmd.env(k, v),
                None => cmd.env_remove(k),
            };
        }
    }
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| format!("failed to start {program}: {e}"))?;
    drop(pair.slave);
    let reader = pair.master.try_clone_reader().map_err(|e| format!("terminal of {program}: {e}"))?;
    let writer = pair.master.take_writer().map_err(|e| format!("terminal of {program}: {e}"))?;
    let writer = ide_core::input::InputWriter::new(
        format!("openidea-debug-input-{}", s.id.0),
        writer,
        #[cfg(unix)]
        wait_writable,
        |e| {
            tracing::warn!("debug input: {e}");
        },
    )
    .inspect_err(|_| {
        let _ = child.kill();
        let _ = child.wait();
    })
    .map_err(|e| format!("terminal input worker: {e}"))?;
    let pid = child.process_id();
    forward_terminal_output(
        s,
        reader,
        #[cfg(unix)]
        wait_readable,
    );
    if let Some(mut previous) = s.program.lock().replace(ProgramTerminal { writer, child, _master: pair.master }) {
        let _ = previous.child.kill();
    }
    s.owner.sink.emit(IdeEvent::Debug { session: s.id, event: DebugEvent::ProgramInput });
    Ok(json!({ "processId": pid }))
}

/// The program's terminal output, as stdout lines (`\r\n` as `\n`; colours are kept).
fn forward_terminal_output(
    s: &Session,
    mut reader: Box<dyn std::io::Read + Send>,
    #[cfg(unix)] mut wait_readable: impl FnMut() -> std::io::Result<()> + Send + 'static,
) {
    let session = s.id;
    let sink = s.owner.sink.clone();
    let _ = std::thread::Builder::new().name(format!("openidea-debuggee-{}", session.0)).spawn(move || {
        let mut buf = vec![0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => pending.extend_from_slice(&buf[..n]),
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    #[cfg(unix)]
                    if let Err(e) = wait_readable()
                        && e.kind() != std::io::ErrorKind::Interrupted
                    {
                        tracing::warn!(%session, "debug terminal read: {e}");
                        break;
                    }
                    #[cfg(not(unix))]
                    std::thread::sleep(std::time::Duration::from_millis(4));
                    continue;
                }
                #[cfg(unix)]
                Err(e) if e.raw_os_error() == Some(libc::EIO) => break,
                Err(e) => {
                    tracing::warn!(%session, "debug terminal read: {e}");
                    break;
                }
            }
            // Keep incomplete UTF-8 sequences, and a `\r` that may start a `\r\n`, for the next chunk.
            let mut valid = match std::str::from_utf8(&pending) {
                Ok(_) => pending.len(),
                Err(e) if e.error_len().is_none() => e.valid_up_to(),
                Err(_) => pending.len(),
            };
            if valid > 0 && pending[valid - 1] == b'\r' {
                valid -= 1;
            }
            let output = String::from_utf8_lossy(&pending[..valid]).replace("\r\n", "\n");
            pending.drain(..valid);
            if !output.is_empty() {
                sink.emit(IdeEvent::Debug { session, event: DebugEvent::Output { category: "stdout".into(), output } });
            }
        }
        if !pending.is_empty() {
            let output = String::from_utf8_lossy(&pending).replace("\r\n", "\n");
            sink.emit(IdeEvent::Debug { session, event: DebugEvent::Output { category: "stdout".into(), output } });
        }
    });
}

fn forward_output<R: AsyncRead + Unpin + Send + 'static>(s: &Session, mut stream: R, category: &'static str) {
    let session = s.id;
    let sink = s.owner.sink.clone();
    tokio::spawn(async move {
        let mut buf = vec![0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match stream.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    // Keep incomplete UTF-8 sequences for the next chunk.
                    let valid = match std::str::from_utf8(&pending) {
                        Ok(_) => pending.len(),
                        Err(e) if e.error_len().is_none() => e.valid_up_to(),
                        Err(_) => pending.len(),
                    };
                    let text = String::from_utf8_lossy(&pending[..valid]).into_owned();
                    pending.drain(..valid);
                    if !text.is_empty() {
                        sink.emit(IdeEvent::Debug {
                            session,
                            event: DebugEvent::Output { category: category.into(), output: text },
                        });
                    }
                }
            }
        }
        if !pending.is_empty() {
            let output = String::from_utf8_lossy(&pending).into_owned();
            sink.emit(IdeEvent::Debug { session, event: DebugEvent::Output { category: category.into(), output } });
        }
    });
}

/// Launch with the IDE's resolved runtime and classpath; the adapter only attaches.
pub(crate) async fn start_kotlin_debuggee(s: &Arc<Session>, args: &mut Value) -> ide_core::IdeResult<()> {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let java = args.get("javaExec").and_then(Value::as_str).unwrap_or("java");
    let strings = |key: &str| -> Vec<String> {
        args.get(key)
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect())
            .unwrap_or_default()
    };
    let classpath =
        std::env::join_paths(strings("classPaths")).map_err(|e| ide_core::IdeError::invalid(e.to_string()))?;
    let mut cmd = tokio::process::Command::new(java);
    ide_core::process::prepare(cmd.as_std_mut());
    cmd.args(strings("vmArguments"))
        // Let the JVM pick its own port (`:0`) and report it below: pre-picking a free
        // port here races with other processes that may take it before the JVM binds.
        .arg("-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:0")
        .arg("-cp")
        .arg(classpath);
    let modules = strings("modulePaths");
    if !modules.is_empty() {
        cmd.arg("--module-path")
            .arg(std::env::join_paths(modules).map_err(|e| ide_core::IdeError::invalid(e.to_string()))?);
    }
    cmd.arg(
        args.get("mainClass")
            .and_then(Value::as_str)
            .ok_or_else(|| ide_core::IdeError::invalid("Missing Kotlin main class"))?,
    )
    .args(strings("programArgs"))
    .current_dir(&s.spec.cwd)
    .envs(ide_core::process::shell_env())
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true);
    if let Some(env) = args.get("env").and_then(Value::as_object) {
        for (k, v) in env {
            if let Some(v) = v.as_str() {
                cmd.env(k, v);
            }
        }
    }
    let mut child = cmd.spawn()?;
    if let Some(err) = child.stderr.take() {
        forward_output(s, err, "stderr");
    }
    let mut stdout =
        BufReader::new(child.stdout.take().ok_or_else(|| ide_core::IdeError::internal("Missing JVM stdout"))?);
    // The JVM chose the port (`:0` above) and reports it here; reading it back removes
    // the free-port race window entirely.
    let port = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let mut line = String::new();
            if stdout.read_line(&mut line).await? == 0 {
                return Err(ide_core::IdeError::unavailable("JVM exited before starting its debug listener"));
            }
            if line.contains("Listening for transport dt_socket") {
                return parse_jdwp_port(&line).ok_or_else(|| {
                    ide_core::IdeError::unavailable(format!("JVM reported an unreadable debug port: {}", line.trim()))
                });
            }
            s.emit(DebugEvent::Output { category: "stdout".into(), output: line });
        }
    })
    .await
    .map_err(|_| ide_core::IdeError::unavailable("JVM did not start its debug listener"))??;
    forward_output(s, stdout, "stdout");
    s.debuggees.lock().push(child);
    args["hostName"] = json!("127.0.0.1");
    args["port"] = json!(port);
    args["timeout"] = json!(10000);
    Ok(())
}

/// The port a JVM chose, from `Listening for transport dt_socket at address: <port>`
/// (some JVMs print `host:port` or `[::1]:port`, so take what follows the last colon).
fn parse_jdwp_port(line: &str) -> Option<u16> {
    line.rsplit_once("address:")?.1.trim().rsplit(':').next()?.trim().parse().ok()
}

#[cfg(test)]
mod tests {
    use super::parse_jdwp_port;

    #[test]
    fn reads_the_port_the_jvm_chose() {
        assert_eq!(parse_jdwp_port("Listening for transport dt_socket at address: 51234"), Some(51234));
        assert_eq!(parse_jdwp_port("Listening for transport dt_socket at address: 127.0.0.1:51234"), Some(51234));
        assert_eq!(parse_jdwp_port("Listening for transport dt_socket at address: [::1]:51234"), Some(51234));
        assert_eq!(parse_jdwp_port("unrelated output"), None);
    }
}
