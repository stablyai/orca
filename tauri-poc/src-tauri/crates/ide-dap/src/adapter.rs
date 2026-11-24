//! Resolving and starting debug adapters.
//!
//! Adapters come from `languages/*.toml` `[debugger]` tables, with built-in
//! fallbacks for the common ones. `${port}` in the arguments of a `tcp`
//! adapter is replaced by a free local port; the client then connects to it.
//! Adapters that run inside another process (java-debug inside jdtls) are
//! reached through a `debugServer` port in the launch arguments instead.

use ide_core::process::executable_names;
use ide_core::{IdeError, IdeResult};
use crate::adapter_config::{AdapterRegistry, DebuggerConfig, ProgramPin};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::process::{Child, Command};

pub const PORT_PLACEHOLDER: &str = "${port}";
/// Replaced by the session's working directory (the project) in adapter arguments.
pub const ROOT_PLACEHOLDER: &str = "${root}";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Transport {
    Stdio,
    Tcp,
}

/// A fully resolved adapter command line.
#[derive(Clone, Debug)]
pub struct AdapterSpec {
    pub target: Option<crate::target::TargetMapping>,
    pub adapter: String,
    pub command: String,
    pub args: Vec<String>,
    pub transport: Transport,
    pub install_hint: Option<String>,
    pub cwd: PathBuf,
    /// Extra environment of the adapter process (debugpy's private copy on `PYTHONPATH`).
    pub env: Vec<(String, String)>,
    /// Host of an adapter that is already running (`debugServer`); `None` is the loopback interface.
    pub server_host: Option<String>,
    /// `host:port` of an adapter inside another program (the Godot editor): connected to
    /// when it accepts, else `command` is started.
    pub connect: Option<String>,
    /// A plugin language's adapter: start exactly this approved program.
    pub pinned: Option<ProgramPin>,
}

/// Built-in adapters used when no language definition names `adapter`.
fn builtin(adapter: &str) -> Option<DebuggerConfig> {
    let cfg = |command: &str, args: &[&str], transport: &str, hint: &str| DebuggerConfig {
        target_placement: None,
        adapter: adapter.to_owned(),
        command: command.to_owned(),
        args: args.iter().map(|a| (*a).to_owned()).collect(),
        transport: transport.to_owned(),
        connect: None,
        install_hint: Some(hint.to_owned()),
        pinned: None,
    };
    Some(match adapter {
        "codelldb" => cfg(
            "codelldb",
            &["--port", PORT_PLACEHOLDER],
            "tcp",
            "Install CodeLLDB in Settings › Languages & Frameworks › Language Servers",
        ),
        "kotlin-debug-adapter" => cfg(
            "kotlin-debug-adapter",
            &[],
            "stdio",
            "Install Kotlin Debug Adapter in Settings › Languages & Frameworks › Language Servers",
        ),
        // Windows installs `python.exe`; `python3.exe` there is at most a Store alias.
        "debugpy" => cfg(
            if cfg!(windows) { "python" } else { "python3" },
            &["-m", "debugpy.adapter"],
            "stdio",
            "pip install debugpy",
        ),
        "js-debug" => cfg(
            "js-debug-adapter",
            // Without a host it listens on `localhost`, which may resolve to ::1 only.
            &[PORT_PLACEHOLDER, "127.0.0.1"],
            "tcp",
            "Install JavaScript Debugger (vscode-js-debug) in Settings › Languages & Frameworks › Language Servers",
        ),
        "delve" => cfg(
            "dlv",
            &["dap", "--listen", "127.0.0.1:${port}"],
            "tcp",
            "go install github.com/go-delve/delve/cmd/dlv@latest",
        ),
        "netcoredbg" => cfg(
            "netcoredbg",
            &["--interpreter=vscode"],
            "stdio",
            "Install netcoredbg (.NET debugger) in Settings › Languages & Frameworks › Language Servers",
        ),
        "lldb-dap" => {
            cfg("lldb-dap", &[], "stdio", "Install LLVM's lldb-dap (brew install llvm; on macOS `xcrun -f lldb-dap`)")
        }
        "rdbg" => cfg("rdbg", &["-O", "--port", PORT_PLACEHOLDER, "-c"], "tcp", "gem install debug"),
        // A jdtls bundle: the session is started through jdtls and reached via `debugServer`.
        "java-debug" => cfg(
            "com.microsoft.java.debug.plugin.jar",
            &[],
            "tcp",
            "Install Microsoft java-debug (Settings › Languages & Frameworks › Language Servers)",
        ),
        _ => return None,
    })
}

/// The adapter definition for `adapter`: registry override first, then built-ins.
pub fn find_config(languages: &AdapterRegistry, adapter: &str) -> Option<DebuggerConfig> {
    languages.find(adapter).or_else(|| builtin(adapter))
}

/// Default DAP `type` attribute per adapter (some adapters dispatch on it).
pub fn default_type(adapter: &str) -> Option<&'static str> {
    Some(match adapter {
        "codelldb" => "lldb",
        "debugpy" => "debugpy",
        "js-debug" => "pwa-node",
        "delve" => "go",
        "netcoredbg" => "coreclr",
        "lldb-dap" => "lldb-dap",
        "java-debug" => "java",
        _ => return None,
    })
}

pub fn resolve(config: &DebuggerConfig, cwd: PathBuf) -> AdapterSpec {
    AdapterSpec {
        target: None,
        adapter: config.adapter.clone(),
        command: config.command.clone(),
        args: config.args.clone(),
        transport: if config.transport.eq_ignore_ascii_case("tcp") { Transport::Tcp } else { Transport::Stdio },
        install_hint: config.install_hint.clone(),
        cwd,
        env: Vec::new(),
        server_host: None,
        connect: config.connect.clone(),
        pinned: config.pinned.clone(),
    }
}

/// Replaces every `${port}` occurrence (also inside larger arguments like `127.0.0.1:${port}`).
pub fn substitute_port(args: &[String], port: u16) -> Vec<String> {
    args.iter().map(|a| a.replace(PORT_PLACEHOLDER, &port.to_string())).collect()
}

/// Replaces every `${root}` occurrence with `root`.
pub fn substitute_root(args: &[String], root: &Path) -> Vec<String> {
    let root = root.to_string_lossy();
    args.iter().map(|a| a.replace(ROOT_PLACEHOLDER, &root)).collect()
}

/// Splits `host:port` (`[v6]:port`).
pub fn parse_address(addr: &str) -> Option<(String, u16)> {
    let (host, port) = addr.trim().rsplit_once(':')?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    Some((host.to_owned(), port.parse().ok().filter(|p| *p != 0)?))
}

/// A port that was free a moment ago on the loopback interface.
///
/// Inherently racy: another process can bind the port between the listener being
/// dropped here and the adapter binding it. Callers that hand the port to a child
/// retry on a bind conflict (see [`ProcessLauncher`]), or — better — let the child
/// pick `:0` and report the actual port back (as the Kotlin JDWP debuggee does).
pub fn free_port() -> std::io::Result<u16> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

static TOOLS_ROOT: parking_lot::RwLock<Option<PathBuf>> = parking_lot::RwLock::new(None);

/// The IDE's managed tools directory (ide-tools); adapters installed there win over `PATH`.
pub fn set_tools_root(root: PathBuf) {
    *TOOLS_ROOT.write() = Some(root);
}

pub fn tools_root() -> Option<PathBuf> {
    TOOLS_ROOT.read().clone()
}

/// Executable directories of managed installs, read at lookup time so tools installed
/// after startup are found without a restart: `<tool>/bin`, `<tool>/venv/bin`, npm's `.bin`.
fn managed_dirs(root: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![root.join("node_modules").join(".bin")];
    if let Ok(entries) = std::fs::read_dir(root) {
        let mut tools: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        tools.sort();
        for t in tools {
            dirs.push(t.join("bin"));
            dirs.push(t.join("venv").join(if cfg!(windows) { "Scripts" } else { "bin" }));
        }
    }
    dirs
}

/// The `PATH` an adapter runs with, unless its launch sets one: the search path language servers
/// get, so what it starts in turn (js-debug's wrapper runs `node`, Delve runs `go build`) is
/// found like Run finds it, even when the login shell's `PATH` didn't reach the app.
fn adapter_path(env: &[(String, String)]) -> Option<std::ffi::OsString> {
    let own = env.iter().any(|(k, _)| if cfg!(windows) { k.eq_ignore_ascii_case("PATH") } else { k == "PATH" });
    (!own).then(ide_core::tool_path::search_path)
}

/// Directories searched for adapter binaries: managed tools first, then `PATH` and the usual install spots.
fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = tools_root().map(|r| managed_dirs(&r)).unwrap_or_default();
    dirs.extend(std::env::split_paths(&ide_core::tool_path::search_path()));
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for rel in [".cargo/bin", ".local/bin", "go/bin", ".dotnet/tools", ".bun/bin", ".npm-global/bin", ".volta/bin"]
        {
            dirs.push(home.join(rel));
        }
    }
    for d in ["/opt/homebrew/bin", "/opt/homebrew/opt/llvm/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
        dirs.push(PathBuf::from(d));
    }
    dirs
}

fn is_executable(path: &Path, windows: bool) -> bool {
    #[cfg(unix)]
    if !windows {
        use std::os::unix::fs::PermissionsExt;
        return path.metadata().map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false);
    }
    #[cfg(not(unix))]
    let _ = windows;
    path.is_file()
}

/// Resolves `command` to an executable: paths are taken as-is (relative to `cwd`), bare names are looked up on PATH.
/// On Windows only `PATHEXT` files count (`foo` → `foo.exe` / `foo.cmd`), so a `.jar` or an
/// extensionless script next to a shim is never started as a program.
pub fn find_binary(command: &str, cwd: &Path) -> Option<PathBuf> {
    let pathext = std::env::var("PATHEXT").ok();
    find_binary_in(command, cwd, &search_dirs(), cfg!(windows), pathext.as_deref())
}

fn find_binary_in(
    command: &str,
    cwd: &Path,
    dirs: &[PathBuf],
    windows: bool,
    pathext: Option<&str>,
) -> Option<PathBuf> {
    let p = Path::new(command);
    if p.components().count() > 1 || p.is_absolute() {
        let full = if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) };
        let (dir, name) = (full.parent()?, full.file_name()?.to_str()?);
        return executable_names(name, windows, pathext)
            .into_iter()
            .map(|n| dir.join(n))
            .find(|c| is_executable(c, windows));
    }
    let names = executable_names(command, windows, pathext);
    dirs.iter().flat_map(|d| names.iter().map(move |n| d.join(n))).find(|c| is_executable(c, windows))
}

/// [`find_binary`], plus Xcode's toolchain on macOS (`xcrun -f lldb-dap`): Xcode ships
/// lldb-dap without putting it on `PATH`.
pub fn resolve_binary(command: &str, cwd: &Path) -> Option<PathBuf> {
    find_binary(command, cwd).or_else(|| xcrun_tool(command))
}

#[cfg(target_os = "macos")]
fn xcrun_tool(command: &str) -> Option<PathBuf> {
    if command != "lldb-dap" {
        return None;
    }
    let out = std::process::Command::new("/usr/bin/xcrun").args(["-f", command]).stderr(Stdio::null()).output().ok()?;
    let path = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
    (out.status.success() && is_executable(&path, false)).then_some(path)
}

#[cfg(not(target_os = "macos"))]
fn xcrun_tool(_command: &str) -> Option<PathBuf> {
    None
}

/// Name of the managed debugpy install (ide-tools `PipTarget`, unpacked into `<tools>/debugpy/lib`).
pub const DEBUGPY_TOOL: &str = "debugpy";

/// Message prefix of the "debugpy missing" error; the UI offers the one-click install on it.
pub const DEBUGPY_MISSING: &str = "debugpy is not installed";

/// Makes `spec` (`<python> -m debugpy.adapter`) runnable like PyCharm's bundled debugger:
/// the interpreter's own debugpy when it has one (venvs), else OpenIDEA's private copy on
/// `PYTHONPATH`. Neither: an `unavailable` error naming the interpreter.
pub async fn prepare_debugpy(spec: &mut AdapterSpec) -> IdeResult<()> {
    let (command, cwd) = (spec.command.clone(), spec.cwd.clone());
    let Some(python) = tokio::task::spawn_blocking(move || resolve_binary(&command, &cwd)).await.ok().flatten() else {
        return Ok(()); // Reported as a missing adapter when it is started.
    };
    let mut probe = Command::new(&python);
    ide_core::process::prepare(probe.as_std_mut());
    let probe = probe
        .args(["-c", "import debugpy.adapter"])
        .current_dir(&spec.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .status();
    if let Ok(Ok(status)) = tokio::time::timeout(Duration::from_secs(15), probe).await
        && status.success()
    {
        return Ok(());
    }
    let lib = tools_root().map(|r| r.join(DEBUGPY_TOOL).join("lib"));
    if let Some(lib) = lib.filter(|l| l.join("debugpy").join("__init__.py").is_file()) {
        let mut paths = vec![lib];
        paths.extend(
            std::env::var_os("PYTHONPATH").map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).unwrap_or_default(),
        );
        let joined = std::env::join_paths(paths).map_err(|e| IdeError::internal(e.to_string()))?;
        spec.env.push(("PYTHONPATH".into(), joined.to_string_lossy().into_owned()));
        return Ok(());
    }
    Err(IdeError::unavailable(format!(
        "{DEBUGPY_MISSING} for {}. Install OpenIDEA's copy (works with every interpreter) or run `{} -m pip install debugpy`",
        python.display(),
        python.display()
    )))
}

/// An adapter that is a plugin of another program (java-debug, a jdtls bundle) rather
/// than a program: it has no process of its own and is reached through `debugServer`.
pub fn is_plugin_bundle(command: &str) -> bool {
    Path::new(command).extension().is_some_and(|e| e.eq_ignore_ascii_case("jar"))
}

/// A launch of a plugin adapter without the `debugServer` of its host program.
pub fn not_standalone(spec: &AdapterSpec) -> IdeError {
    IdeError::unavailable(format!(
        "debug adapter `{}` runs inside the Java language server and can't be started on its own. \
         Debug an Application, Spring Boot, JUnit, Maven or Gradle configuration, or start the JVM \
         with a JDWP agent and attach with a Remote JVM Debug configuration",
        spec.adapter
    ))
}

pub fn missing(spec: &AdapterSpec) -> IdeError {
    let mut msg = format!(
        "debug adapter `{}` not found (`{}` is neither installed by OpenIDEA nor on PATH)",
        spec.adapter, spec.command
    );
    if let Some(hint) = &spec.install_hint {
        msg.push_str(". ");
        msg.push_str(hint);
    }
    IdeError::unavailable(msg)
}

pub type BoxReader = Box<dyn AsyncRead + Unpin + Send>;
pub type BoxWriter = Box<dyn AsyncWrite + Unpin + Send>;

/// A connected adapter: byte streams plus the process (if we spawned one).
pub struct AdapterIo {
    pub reader: BoxReader,
    pub writer: BoxWriter,
    pub child: Option<Child>,
    /// TCP port of a server-mode adapter; child sessions (`startDebugging`) connect to it again.
    pub port: Option<u16>,
    /// Recent stderr lines of the adapter process, for error messages.
    pub stderr: Arc<parking_lot::Mutex<Vec<String>>>,
    /// (category, line) printed by the debuggee when it shares the adapter's stdio.
    pub program_output: Option<ProgramOutput>,
}

pub type ProgramOutput = tokio::sync::mpsc::UnboundedReceiver<(&'static str, String)>;
type ProgramSink = tokio::sync::mpsc::UnboundedSender<(&'static str, String)>;

/// These debuggees inherit adapter stdio; no DAP event carries their output.
const SHARES_STDIO: &[&str] = &["delve", "rdbg"];
const DELVE_BANNER: &str = "DAP server listening at:";

pub type LaunchFuture = Pin<Box<dyn Future<Output = IdeResult<AdapterIo>> + Send>>;

/// Starts adapters. Tests substitute in-memory adapters.
pub trait AdapterLauncher: Send + Sync + 'static {
    /// Starts `spec`, or, when `reuse_port` is set, opens another connection to
    /// an already running server-mode adapter.
    fn launch(&self, spec: AdapterSpec, reuse_port: Option<u16>) -> LaunchFuture;
}

pub struct ProcessLauncher;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// How long an adapter inside another program (a headless Godot editor) may take to listen.
const EMBEDDED_START_TIMEOUT: Duration = Duration::from_secs(120);
/// Probe of a `connect` address before starting the command.
const PROBE_TIMEOUT: Duration = Duration::from_millis(500);
/// Attempts at a fresh port for a TCP adapter: the one `free_port` hands out can be
/// claimed by another process before the adapter binds it, so a new one usually wins.
const PORT_ATTEMPTS: u32 = 3;

impl AdapterLauncher for ProcessLauncher {
    fn launch(&self, mut spec: AdapterSpec, reuse_port: Option<u16>) -> LaunchFuture {
        Box::pin(async move {
            let stderr = Arc::new(parking_lot::Mutex::new(Vec::new()));
            if let Some(port) = reuse_port {
                // A remote adapter (`dlv --headless` on another machine) may answer slowly.
                let (host, timeout) = match spec.server_host.as_deref() {
                    Some(host) => (host, CONNECT_TIMEOUT),
                    None => (LOOPBACK, Duration::from_secs(5)),
                };
                let stream = connect_with_retries(host, port, None, timeout).await?;
                let (r, w) = stream.into_split();
                return Ok(AdapterIo {
                    reader: Box::new(r),
                    writer: Box::new(w),
                    child: None,
                    port: Some(port),
                    stderr,
                    program_output: None,
                });
            }
            let embedded = match spec.connect.as_deref().filter(|_| spec.transport == Transport::Tcp) {
                Some(addr) => Some(
                    parse_address(addr)
                        .ok_or_else(|| IdeError::invalid(format!("invalid debug adapter address `{addr}`")))?,
                ),
                None => None,
            };
            // An adapter inside a program the user runs (the Godot editor): use it, never stop it.
            if let Some((host, port)) = &embedded
                && let Ok(Ok(stream)) =
                    tokio::time::timeout(PROBE_TIMEOUT, tokio::net::TcpStream::connect((host.as_str(), *port))).await
            {
                let _ = stream.set_nodelay(true);
                let (r, w) = stream.into_split();
                return Ok(AdapterIo {
                    reader: Box::new(r),
                    writer: Box::new(w),
                    child: None,
                    port: Some(*port),
                    stderr,
                    program_output: None,
                });
            }
            if spec.adapter == DEBUGPY_TOOL && spec.target.is_none() {
                prepare_debugpy(&mut spec).await?;
            }
            if is_plugin_bundle(&spec.command) {
                return Err(not_standalone(&spec));
            }
            let binary = match spec.pinned.clone() {
                Some(pin) => tokio::task::spawn_blocking(move || pin.verify().map(Path::to_path_buf))
                    .await
                    .map_err(|e| IdeError::internal(e.to_string()))?
                    .map_err(|e| IdeError::new(ide_core::error::ErrorKind::PermissionDenied, e))?,
                None => {
                    let (command, cwd) = (spec.command.clone(), spec.cwd.clone());
                    tokio::task::spawn_blocking(move || resolve_binary(&command, &cwd))
                        .await
                        .ok()
                        .flatten()
                        .ok_or_else(|| missing(&spec))?
                }
            };
            let base_args = substitute_root(&spec.args, &spec.cwd);
            match spec.transport {
                Transport::Stdio => spawn_adapter(&spec, &binary, &base_args, None, CONNECT_TIMEOUT).await,
                Transport::Tcp => {
                    // An embedded adapter started without `${port}` listens on its usual
                    // address; every other TCP adapter gets a port chosen here so it can be
                    // retried if another process takes it before the adapter binds.
                    let fixed = match &embedded {
                        Some((_, port)) if !spec.args.iter().any(|a| a.contains(PORT_PLACEHOLDER)) => Some(*port),
                        _ => None,
                    };
                    let start_timeout = if embedded.is_some() { EMBEDDED_START_TIMEOUT } else { CONNECT_TIMEOUT };
                    for attempt in 1..=PORT_ATTEMPTS {
                        let port = match fixed {
                            Some(port) => port,
                            None => free_port()?,
                        };
                        let args = substitute_port(&base_args, port);
                        match spawn_adapter(&spec, &binary, &args, Some(port), start_timeout).await {
                            Ok(io) => return Ok(io),
                            Err(e) => {
                                if fixed.is_none() && attempt < PORT_ATTEMPTS && is_port_race(&e) {
                                    tracing::warn!(
                                        target: "ide_dap::adapter",
                                        "debug adapter failed to start on port {port}: {}; retrying",
                                        e.message
                                    );
                                    continue;
                                }
                                return Err(e);
                            }
                        }
                    }
                    unreachable!("the retry loop returns on its last attempt")
                }
            }
        })
    }
}

/// Starts `binary` with `args`, then connects to it when `port` is set (a TCP adapter)
/// or hands back its stdio when it is not. The child is stopped if it never accepts.
async fn spawn_adapter(
    spec: &AdapterSpec,
    binary: &Path,
    args: &[String],
    port: Option<u16>,
    start_timeout: Duration,
) -> IdeResult<AdapterIo> {
    let stderr = Arc::new(parking_lot::Mutex::new(Vec::new()));
    let mut cmd = Command::new(binary);
    if let Some(path) = adapter_path(&spec.env) {
        cmd.env("PATH", path);
    }
    ide_core::process::prepare(cmd.as_std_mut());
    if spec.adapter == "rdbg" {
        ide_core::process::own_group(cmd.as_std_mut());
    }
    cmd.args(args)
        .envs(spec.env.iter().map(|(k, v)| (k, v)))
        .current_dir(&spec.cwd)
        .stdin(if port.is_some() { Stdio::null() } else { Stdio::piped() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child =
        cmd.spawn().map_err(|e| IdeError::unavailable(format!("failed to start {}: {e}", binary.display())))?;
    let (program_sink, program_output) = if SHARES_STDIO.contains(&spec.adapter.as_str()) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        (Some(tx), Some(rx))
    } else {
        (None, None)
    };
    if let Some(err) = child.stderr.take() {
        pump_lines(err, spec.adapter.clone(), stderr.clone(), program_sink.clone().map(|tx| (tx, "stderr")));
    }
    match port {
        None => {
            let stdin = child.stdin.take().ok_or_else(|| IdeError::internal("adapter stdin unavailable"))?;
            let stdout = child.stdout.take().ok_or_else(|| IdeError::internal("adapter stdout unavailable"))?;
            Ok(AdapterIo {
                reader: Box::new(stdout),
                writer: Box::new(stdin),
                child: Some(child),
                port: None,
                stderr,
                program_output,
            })
        }
        Some(port) => {
            if let Some(out) = child.stdout.take() {
                pump_lines(out, spec.adapter.clone(), stderr.clone(), program_sink.map(|tx| (tx, "stdout")));
            }
            let stream = match connect_with_retries(LOOPBACK, port, Some(&mut child), start_timeout).await {
                Ok(s) => s,
                Err(e) => {
                    if spec.adapter == "rdbg"
                        && let Some(pid) = child.id()
                    {
                        ide_core::process::kill_tree_of(pid);
                    }
                    let _ = child.start_kill();
                    let tail = stderr.lock().join("\n");
                    return Err(if tail.is_empty() {
                        e
                    } else {
                        IdeError::unavailable(format!("{}\n{tail}", e.message))
                    });
                }
            };
            let (r, w) = stream.into_split();
            Ok(AdapterIo {
                reader: Box::new(r),
                writer: Box::new(w),
                child: Some(child),
                port: Some(port),
                stderr,
                program_output,
            })
        }
    }
}

/// A failed adapter start that another process grabbing the free port can explain
/// (POSIX and Windows "address already in use" texts, or the adapter exiting because
/// it could not bind). Anything else is a real start failure and is not retried.
fn is_port_race(err: &IdeError) -> bool {
    let message = err.message.to_ascii_lowercase();
    message.contains("address already in use")
        || message.contains("addrinuse")
        || message.contains("only one usage of each socket address")
        || message.contains("exited before accepting connections")
}

fn pump_lines<R: AsyncRead + Unpin + Send + 'static>(
    stream: R,
    name: String,
    sink: Arc<parking_lot::Mutex<Vec<String>>>,
    program: Option<(ProgramSink, &'static str)>,
) {
    tokio::spawn(ide_jsonrpc::output::read_lines(stream, move |line| {
        tracing::debug!(target: "ide_dap::adapter", "[{name}] {line}");
        if let Some((tx, category)) = &program
            && !line.starts_with(DELVE_BANNER)
        {
            let _ = tx.send((category, format!("{line}\n")));
        }
        push_line(&sink, line);
    }));
}

/// Appends to the recent-output buffer of an adapter (the last 40 lines).
pub(crate) fn push_line(sink: &parking_lot::Mutex<Vec<String>>, line: String) {
    let mut buf = sink.lock();
    if buf.len() >= 40 {
        buf.remove(0);
    }
    buf.push(line);
}

const LOOPBACK: &str = "127.0.0.1";

async fn connect_with_retries(
    host: &str,
    port: u16,
    mut child: Option<&mut Child>,
    timeout: Duration,
) -> IdeResult<tokio::net::TcpStream> {
    let deadline = Instant::now() + timeout;
    loop {
        match tokio::net::TcpStream::connect((host, port)).await {
            Ok(s) => {
                let _ = s.set_nodelay(true);
                return Ok(s);
            }
            Err(e) => {
                if let Some(child) = child.as_deref_mut()
                    && let Ok(Some(status)) = child.try_wait()
                {
                    return Err(IdeError::unavailable(format!(
                        "debug adapter exited before accepting connections ({status})"
                    )));
                }
                if Instant::now() >= deadline {
                    return Err(IdeError::unavailable(format!(
                        "could not connect to debug adapter at {host}:{port}: {e}"
                    )));
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adapters_run_on_the_tool_search_path() {
        let search = ide_core::tool_path::search_path();
        assert_eq!(adapter_path(&[]), Some(search.clone()));
        assert_eq!(adapter_path(&[("GOFLAGS".into(), "-mod=mod".into())]), Some(search));
        // A launch that sets its own (a selected Go SDK's bin first) keeps it.
        assert_eq!(adapter_path(&[("PATH".into(), "/sdk/go/bin:/usr/bin".into())]), None);
        // The search path reaches the usual install spots even when this process's `PATH` doesn't.
        #[cfg(unix)]
        {
            let dirs: Vec<PathBuf> = std::env::split_paths(&ide_core::tool_path::search_path()).collect();
            assert!(dirs.contains(&PathBuf::from("/usr/local/bin")), "{dirs:?}");
        }
    }

    #[tokio::test]
    async fn program_output_is_forwarded_without_the_adapter_banner() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let sink = Arc::default();
        let text: &[u8] = b"DAP server listening at: 127.0.0.1:1\n[hello two words]\nno newline";
        pump_lines(text, "delve".into(), Arc::clone(&sink), Some((tx, "stdout")));
        assert_eq!(rx.recv().await, Some(("stdout", "[hello two words]\n".into())));
        assert_eq!(rx.recv().await, Some(("stdout", "no newline\n".into())));
        assert_eq!(rx.recv().await, None);
        assert_eq!(sink.lock().len(), 3);
    }

    /// Managed tools win over `PATH`, and debugpy falls back to the private copy.
    #[cfg(unix)]
    #[tokio::test]
    async fn managed_tools_and_private_debugpy() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("openidea-dap-tools-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let exe = |p: &Path, body: &str| {
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, body).unwrap();
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        let adapter = root.join("js-debug").join("bin").join("openidea-test-js-debug-adapter");
        exe(&adapter, "#!/bin/sh\n");
        // An interpreter without debugpy.
        let python = root.join("fake-python");
        exe(&python, "#!/bin/sh\nexit 1\n");
        set_tools_root(root.clone());
        assert_eq!(find_binary("openidea-test-js-debug-adapter", &root), Some(adapter));

        let mut spec = resolve(&builtin("debugpy").unwrap(), root.clone());
        spec.command = python.to_string_lossy().into_owned();
        let err = prepare_debugpy(&mut spec).await.unwrap_err();
        assert!(err.message.starts_with(DEBUGPY_MISSING), "{}", err.message);

        let lib = root.join(DEBUGPY_TOOL).join("lib");
        std::fs::create_dir_all(lib.join("debugpy")).unwrap();
        std::fs::write(lib.join("debugpy").join("__init__.py"), "").unwrap();
        prepare_debugpy(&mut spec).await.unwrap();
        let (k, v) = &spec.env[0];
        assert_eq!(k, "PYTHONPATH");
        assert!(v.starts_with(&*lib.to_string_lossy()), "{v}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn substitutes_port_everywhere() {
        let args: Vec<String> = ["dap", "--listen", "127.0.0.1:${port}", "${port}"].map(String::from).into();
        assert_eq!(substitute_port(&args, 4711), ["dap", "--listen", "127.0.0.1:4711", "4711"]);
        assert_eq!(substitute_port(&["--x".into()], 1), ["--x"]);
    }

    #[test]
    fn builtins_cover_common_adapters() {
        for name in ["codelldb", "debugpy", "js-debug", "delve", "netcoredbg", "java-debug"] {
            let cfg = builtin(name).unwrap();
            assert!(cfg.install_hint.is_some());
        }
        let delve = resolve(&builtin("delve").unwrap(), PathBuf::from("/"));
        assert_eq!(delve.transport, Transport::Tcp);
        assert!(builtin("nope").is_none());
    }

    #[test]
    fn free_port_is_nonzero() {
        assert_ne!(free_port().unwrap(), 0);
    }

    #[test]
    fn missing_binary_reports_hint() {
        let spec = resolve(&builtin("netcoredbg").unwrap(), std::env::temp_dir());
        assert!(find_binary("definitely-not-a-real-binary-openidea", &spec.cwd).is_none());
        let err = missing(&spec);
        assert_eq!(err.kind, ide_core::error::ErrorKind::Unavailable);
        assert!(err.message.contains("Settings › Languages & Frameworks › Language Servers"));
    }

    #[tokio::test]
    async fn process_launcher_reports_missing_binary() {
        let mut spec = resolve(&builtin("netcoredbg").unwrap(), std::env::temp_dir());
        spec.command = "definitely-not-a-real-binary-openidea".into();
        let err = ProcessLauncher.launch(spec, None).await.err().unwrap();
        assert_eq!(err.kind, ide_core::error::ErrorKind::Unavailable);
    }

    /// The managed tools layout (`<tools>/<tool>/bin`) as Windows sees it: only `PATHEXT`
    /// files run, so the java-debug bundle jar and POSIX shims are never adapter programs.
    #[test]
    fn windows_resolution_only_takes_pathext_files() {
        let dir = std::env::temp_dir().join(format!("openidea-dap-win-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let java_debug = dir.join("java-debug").join("bin");
        let js_debug = dir.join("js-debug").join("bin");
        let codelldb = dir.join("codelldb").join("bin");
        for d in [&java_debug, &js_debug, &codelldb] {
            std::fs::create_dir_all(d).unwrap();
        }
        let jar = "com.microsoft.java.debug.plugin.jar";
        std::fs::write(java_debug.join(jar), "PK").unwrap();
        std::fs::write(js_debug.join("js-debug-adapter"), "#!/bin/sh\n").unwrap();
        std::fs::write(js_debug.join("js-debug-adapter.cmd"), "@echo off\r\n").unwrap();
        std::fs::write(codelldb.join("codelldb.exe"), "MZ").unwrap();
        let dirs = [java_debug.clone(), js_debug.clone(), codelldb.clone()];
        let cwd = dir.clone();
        let win = |cmd: &str| find_binary_in(cmd, &cwd, &dirs, true, Some(".COM;.EXE;.BAT;.CMD"));
        assert_eq!(win(jar), None);
        assert_eq!(win(&java_debug.join(jar).to_string_lossy()), None);
        assert_eq!(win("js-debug-adapter"), Some(js_debug.join("js-debug-adapter.cmd")));
        assert_eq!(win("codelldb"), Some(codelldb.join("codelldb.exe")));
        assert_eq!(win(&codelldb.join("codelldb").to_string_lossy()), Some(codelldb.join("codelldb.exe")));
        assert_eq!(win(&codelldb.join("codelldb.exe").to_string_lossy()), Some(codelldb.join("codelldb.exe")));
        assert_eq!(win("netcoredbg"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Unix needs the executable bit: a plain file (the bundle jar) is not a program.
    #[cfg(unix)]
    #[test]
    fn unix_resolution_needs_the_executable_bit() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("openidea-dap-unix-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("plugin.jar"), "PK").unwrap();
        std::fs::write(dir.join("adapter"), "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(dir.join("adapter"), std::fs::Permissions::from_mode(0o755)).unwrap();
        let dirs = [dir.clone()];
        assert_eq!(find_binary_in("plugin.jar", &dir, &dirs, false, None), None);
        assert_eq!(find_binary_in("adapter", &dir, &dirs, false, None), Some(dir.join("adapter")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// java-debug (from `languages/java.toml` or the built-in) is only reachable through
    /// jdtls: a launch without `debugServer` is refused instead of starting the jar.
    #[tokio::test]
    async fn plugin_adapters_are_never_started_as_processes() {
        assert!(is_plugin_bundle("com.microsoft.java.debug.plugin.jar"));
        assert!(is_plugin_bundle("C:\\tools\\java-debug\\bin\\Plugin.JAR"));
        for cmd in ["codelldb", "python3", "js-debug-adapter", "dlv", "netcoredbg.exe", "lldb-dap"] {
            assert!(!is_plugin_bundle(cmd), "{cmd}");
        }
        let spec = resolve(&builtin("java-debug").unwrap(), std::env::temp_dir());
        let err = ProcessLauncher.launch(spec, None).await.err().unwrap();
        assert_eq!(err.kind, ide_core::error::ErrorKind::Unavailable);
        assert!(err.message.contains("runs inside the Java language server"), "{}", err.message);
    }

    #[test]
    fn port_conflicts_are_recognised_for_retry() {
        let in_use = IdeError::unavailable(
            "debug adapter exited before accepting connections (exit status: 1)\nbind: address already in use",
        );
        assert!(is_port_race(&in_use));
        assert!(is_port_race(&IdeError::unavailable(
            "Only one usage of each socket address (protocol/network address/port) is normally permitted."
        )));
        assert!(!is_port_race(&IdeError::unavailable("failed to start codelldb: file not found")));
    }
}
