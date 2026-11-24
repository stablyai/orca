//! Attach to Process: the current user's processes, grouped by the debugger that can
//! attach to them (IDEA's `XAttachDebuggerProvider`s): JVMs with a JDWP agent, Node,
//! Python (debugpy injection), Go binaries (Delve) and anything else natively (LLDB).

use crate::adapter;
use ide_core::{IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AttachKind {
    Java,
    Node,
    Python,
    Go,
    Native,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachableProcess {
    pub pid: u32,
    /// Executable name.
    pub name: String,
    pub command_line: String,
    pub kind: AttachKind,
    /// Debug adapter that attaches to it.
    pub adapter: String,
    /// Debug port the process listens on (JDWP, `--inspect`, `debugpy --listen`).
    pub host: Option<String>,
    pub port: Option<u16>,
}

/// One row of the process table.
#[derive(Clone, Debug)]
pub struct RawProcess {
    pub pid: u32,
    pub exe: String,
    pub args: String,
}

/// `[host:]port` of a debug agent address (`*` and empty hosts mean loopback).
fn host_port(addr: &str) -> Option<(Option<String>, u16)> {
    let addr = addr.trim();
    let (host, port) = match addr.rsplit_once(':') {
        Some((h, p)) => (Some(h), p),
        None => (None, addr),
    };
    let port: u16 = port.parse().ok()?;
    let host = host.filter(|h| !h.is_empty() && *h != "*" && *h != "0.0.0.0").map(str::to_owned);
    Some((host, port))
}

/// `-agentlib:jdwp=transport=dt_socket,server=y,address=*:5005` (or `-Xrunjdwp:`).
pub fn jdwp_address(args: &str) -> Option<(Option<String>, u16)> {
    let opts = args
        .split_whitespace()
        .find_map(|a| a.strip_prefix("-agentlib:jdwp=").or_else(|| a.strip_prefix("-Xrunjdwp:")))?;
    let mut server = false;
    let mut address = None;
    for kv in opts.split(',') {
        match kv.split_once('=') {
            Some(("server", v)) => server = v == "y",
            Some(("address", v)) => address = Some(v),
            _ => {}
        }
    }
    if !server {
        return None;
    }
    host_port(address?)
}

/// `--inspect`, `--inspect-brk=9230`, `--inspect=127.0.0.1:9230` (default port 9229).
fn inspect_address(args: &str) -> Option<(Option<String>, u16)> {
    args.split_whitespace().find_map(|a| {
        let rest = a.strip_prefix("--inspect-brk").or_else(|| a.strip_prefix("--inspect"))?;
        if rest.is_empty() { Some((None, 9229)) } else { host_port(rest.strip_prefix('=')?) }
    })
}

/// `-m debugpy --listen [host:]port`.
fn debugpy_listen(args: &str) -> Option<(Option<String>, u16)> {
    let words: Vec<&str> = args.split_whitespace().collect();
    if !words.contains(&"debugpy") {
        return None;
    }
    let i = words.iter().position(|w| *w == "--listen")?;
    host_port(words.get(i + 1)?)
}

fn file_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

fn strip_exe_suffix(name: &str) -> &str {
    if name.len() > 4 && name[name.len() - 4..].eq_ignore_ascii_case(".exe") {
        &name[..name.len() - 4]
    } else {
        name
    }
}

fn is_python(name: &str) -> bool {
    let n = strip_exe_suffix(name);
    n.len() >= 6
        && n[..6].eq_ignore_ascii_case("python")
        && n[6..].chars().all(|c| c.is_ascii_digit() || c == '.')
}

/// Classifies a process; `is_go` is asked only for processes no interpreter claims.
pub fn classify(p: &RawProcess, is_go: impl Fn(&str) -> bool, native_adapter: &str) -> Option<AttachableProcess> {
    let name = file_name(&p.exe).to_owned();
    let make = |kind, adapter: &str, addr: Option<(Option<String>, u16)>| {
        let (host, port) = match addr {
            Some((h, p)) => (h, Some(p)),
            None => (None, None),
        };
        Some(AttachableProcess {
            pid: p.pid,
            name: name.clone(),
            command_line: p.args.clone(),
            kind,
            adapter: adapter.to_owned(),
            host,
            port,
        })
    };
    let base = strip_exe_suffix(&name);
    if base.eq_ignore_ascii_case("java") || base.eq_ignore_ascii_case("javaw") {
        // Only JVMs started with a JDWP agent can be attached to.
        return jdwp_address(&p.args).and_then(|a| make(AttachKind::Java, "java-debug", Some(a)));
    }
    if base.eq_ignore_ascii_case("node") || base.eq_ignore_ascii_case("nodejs") {
        return make(AttachKind::Node, "js-debug", inspect_address(&p.args));
    }
    if is_python(&name) {
        return make(AttachKind::Python, "debugpy", debugpy_listen(&p.args));
    }
    if is_go(&p.exe) {
        return make(AttachKind::Go, "delve", None);
    }
    make(AttachKind::Native, native_adapter, None)
}

const GO_BUILDINFO_MAGIC: &[u8] = b"\xff Go buildinf:";
/// Go binaries carry their build info near the start of the data segment.
const GO_SCAN_LIMIT: u64 = 96 << 20;

/// Whether `exe` is a Go binary (has a `Go buildinf:` header). System locations are skipped.
pub fn is_go_binary(exe: &str) -> bool {
    use std::io::Read;
    let skip = ["/System/", "/usr/", "/bin/", "/sbin/", "/Library/Apple/", "/Applications/"];
    let lower = exe.to_ascii_lowercase();
    let skip_windows = lower.starts_with("c:\\windows\\")
        || lower.starts_with("c:/windows/")
        || lower.contains("\\windowsapps\\")
        || lower.contains("/windowsapps/");
    if skip.iter().any(|p| exe.starts_with(p)) || skip_windows || !Path::new(exe).is_absolute() {
        return false;
    }
    let Ok(file) = std::fs::File::open(exe) else { return false };
    let mut reader = std::io::BufReader::with_capacity(1 << 20, file.take(GO_SCAN_LIMIT));
    let finder = memchr::memmem::Finder::new(GO_BUILDINFO_MAGIC);
    let mut buf = vec![0u8; 1 << 20];
    let mut carry = Vec::new();
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) | Err(_) => return false,
            Ok(n) => n,
        };
        carry.extend_from_slice(&buf[..n]);
        if finder.find(&carry).is_some() {
            return true;
        }
        let keep = carry.len().min(GO_BUILDINFO_MAGIC.len() - 1);
        carry.drain(..carry.len() - keep);
    }
}

/// The current user's processes (without this one).
#[cfg(unix)]
pub fn list_processes() -> IdeResult<Vec<RawProcess>> {
    use std::collections::HashMap;
    let ps = |fields: &str| -> IdeResult<String> {
        let out = ide_core::process::prepare(&mut std::process::Command::new("ps"))
            .args(["-x", "-ww", "-o", fields])
            .output()
            .map_err(|e| IdeError::unavailable(format!("cannot list processes: {e}")))?;
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    };
    let split = |line: &str| -> Option<(u32, String)> {
        let line = line.trim_start();
        let (pid, rest) = line.split_once(char::is_whitespace)?;
        Some((pid.parse().ok()?, rest.trim().to_owned()))
    };
    // `comm` is the executable path on macOS; on Linux it is truncated, so read /proc.
    let exes: HashMap<u32, String> =
        if cfg!(target_os = "linux") { HashMap::new() } else { ps("pid=,comm=")?.lines().filter_map(split).collect() };
    let me = std::process::id();
    Ok(ps("pid=,args=")?
        .lines()
        .filter_map(split)
        .filter(|(pid, _)| *pid != me)
        .map(|(pid, args)| {
            let exe = exes
                .get(&pid)
                .cloned()
                .or_else(|| std::fs::read_link(format!("/proc/{pid}/exe")).ok().map(|p| p.display().to_string()))
                .unwrap_or_else(|| args.split_whitespace().next().unwrap_or_default().to_owned());
            RawProcess { pid, exe, args }
        })
        .collect())
}

pub fn parse_windows_process_table(stdout: &str, self_pid: u32) -> Vec<RawProcess> {
    stdout
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim_end_matches('\r');
            let mut parts = trimmed.splitn(3, '\t');
            let pid_str = parts.next()?.trim();
            let exe = parts.next()?.trim();
            let args = parts.next().unwrap_or(exe).trim();
            let pid: u32 = pid_str.parse().ok()?;
            if pid == 0 || pid == self_pid || exe.is_empty() {
                return None;
            }
            Some(RawProcess {
                pid,
                exe: exe.to_owned(),
                args: if args.is_empty() { exe.to_owned() } else { args.to_owned() },
            })
        })
        .collect()
}

#[cfg(windows)]
pub fn list_processes() -> IdeResult<Vec<RawProcess>> {
    const SCRIPT: &str = "Get-CimInstance Win32_Process | ForEach-Object { $e = if ($_.ExecutablePath) { $_.ExecutablePath } else { $_.Name }; $c = if ($_.CommandLine) { $_.CommandLine } else { $_.Name }; \"$($_.ProcessId)`t$e`t$c\" }";
    let mut cmd = std::process::Command::new("powershell.exe");
    ide_core::process::prepare(&mut cmd);
    let out = cmd
        .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .output()
        .map_err(|e| IdeError::unavailable(format!("cannot list processes: {e}")))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(IdeError::unavailable(format!("cannot list processes: {}", stderr.trim())));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    Ok(parse_windows_process_table(&stdout, std::process::id()))
}

#[cfg(not(any(unix, windows)))]
pub fn list_processes() -> IdeResult<Vec<RawProcess>> {
    Err(IdeError::unavailable("Attach to Process is not supported on this platform yet"))
}

/// Node's default inspector port, which `SIGUSR1` opens.
pub const NODE_INSPECTOR_PORT: u16 = 9229;

/// Turns on the inspector of a running Node process (`SIGUSR1`, as js-debug's process
/// picker does) and waits until it listens. Returns the inspector port.
#[cfg(unix)]
pub async fn enable_node_inspector(pid: u32) -> IdeResult<u16> {
    let mut kill = tokio::process::Command::new("kill");
    ide_core::process::prepare(kill.as_std_mut());
    let status = kill
        .args(["-USR1", &pid.to_string()])
        .status()
        .await
        .map_err(|e| IdeError::unavailable(format!("cannot signal process {pid}: {e}")))?;
    if !status.success() {
        return Err(IdeError::unavailable(format!("cannot signal process {pid}")));
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        if tokio::net::TcpStream::connect(("127.0.0.1", NODE_INSPECTOR_PORT)).await.is_ok() {
            return Ok(NODE_INSPECTOR_PORT);
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    Err(IdeError::unavailable(format!(
        "process {pid} did not open its inspector on port {NODE_INSPECTOR_PORT} (is the port taken?)"
    )))
}

#[cfg(not(unix))]
pub async fn enable_node_inspector(pid: u32) -> IdeResult<u16> {
    Err(IdeError::unavailable(format!("start process {pid} with --inspect to attach to it")))
}

/// Attachable processes, sorted by kind then name. Blocking (runs `ps`, reads binaries).
pub fn attachable_processes() -> IdeResult<Vec<AttachableProcess>> {
    let cwd = std::env::temp_dir();
    let native = if adapter::resolve_binary("codelldb", &cwd).is_some() { "codelldb" } else { "lldb-dap" };
    let mut out: Vec<AttachableProcess> =
        list_processes()?.iter().filter_map(|p| classify(p, is_go_binary, native)).collect();
    out.sort_by(|a, b| a.kind.cmp(&b.kind).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(exe: &str, args: &str) -> RawProcess {
        RawProcess { pid: 7, exe: exe.into(), args: args.into() }
    }

    fn kind(exe: &str, args: &str) -> Option<(AttachKind, Option<u16>)> {
        classify(&raw(exe, args), |e| e.ends_with("/gosrv"), "codelldb").map(|p| (p.kind, p.port))
    }

    #[test]
    fn parses_jdwp_agents() {
        let a = "java -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005 -jar app.jar";
        assert_eq!(jdwp_address(a), Some((None, 5005)));
        assert_eq!(
            jdwp_address("java -Xrunjdwp:transport=dt_socket,server=y,address=10.0.0.2:8000 X"),
            Some((Some("10.0.0.2".into()), 8000))
        );
        // A client-mode agent connects out; nothing to attach to.
        assert_eq!(jdwp_address("java -agentlib:jdwp=transport=dt_socket,server=n,address=5005 X"), None);
        assert_eq!(kind("/jdk/bin/java", a), Some((AttachKind::Java, Some(5005))));
        assert_eq!(kind("/jdk/bin/java", "java -jar app.jar"), None);
    }

    #[test]
    fn classifies_interpreters() {
        assert_eq!(kind("/usr/local/bin/node", "node --inspect server.js"), Some((AttachKind::Node, Some(9229))));
        assert_eq!(
            kind("/usr/local/bin/node", "node --inspect-brk=127.0.0.1:9333 a.js"),
            Some((AttachKind::Node, Some(9333)))
        );
        assert_eq!(kind("/usr/local/bin/node", "node a.js"), Some((AttachKind::Node, None)));
        assert_eq!(kind("/usr/bin/python3.12", "python3.12 app.py"), Some((AttachKind::Python, None)));
        assert_eq!(
            kind("/usr/bin/python3", "python3 -m debugpy --listen 5678 --wait-for-client app.py"),
            Some((AttachKind::Python, Some(5678)))
        );
        assert_eq!(
            kind("/Library/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python", "x"),
            Some((AttachKind::Python, None))
        );
        assert_eq!(kind("/home/me/gosrv", "./gosrv"), Some((AttachKind::Go, None)));
        assert_eq!(kind("/home/me/a.out", "./a.out"), Some((AttachKind::Native, None)));
        assert!(!is_python("pythonista"));
        assert!(is_python("PYTHON.EXE"));
    }

    #[test]
    fn parses_windows_process_table_and_skips_self() {
        let self_pid = 4242;
        let sample = concat!(
            "101\tC:\\Program Files\\nodejs\\node.EXE\tnode.EXE --inspect=9231 app.js\r\n",
            "202\tC:\\Python312\\python.exe\tpython.exe -m debugpy --listen 5678 app.py\r\n",
            "303\tC:\\jdk\\bin\\java.exe\tjava.exe -agentlib:jdwp=transport=dt_socket,server=y,address=5005 -jar app.jar\r\n",
            "4242\tC:\\orca.exe\torca.exe\r\n",
            "invalid\tbad\tline\r\n",
        );
        let raw_list = parse_windows_process_table(sample, self_pid);
        assert_eq!(raw_list.len(), 3);
        let classified: Vec<_> = raw_list
            .iter()
            .filter_map(|p| classify(p, |_| false, "codelldb"))
            .collect();
        assert_eq!(classified[0].kind, AttachKind::Node);
        assert_eq!(classified[0].port, Some(9231));
        assert_eq!(classified[1].kind, AttachKind::Python);
        assert_eq!(classified[1].port, Some(5678));
        assert_eq!(classified[2].kind, AttachKind::Java);
        assert_eq!(classified[2].port, Some(5005));
    }

    #[test]
    fn detects_go_binaries_by_buildinfo() {
        let dir = std::env::temp_dir().join(format!("openidea-attach-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let go = dir.join("gobin");
        let mut bytes = vec![0u8; (1 << 20) - 5];
        bytes.extend_from_slice(GO_BUILDINFO_MAGIC);
        std::fs::write(&go, &bytes).unwrap();
        let other = dir.join("cbin");
        std::fs::write(&other, vec![0u8; 4096]).unwrap();
        assert!(is_go_binary(go.to_str().unwrap()));
        assert!(!is_go_binary(other.to_str().unwrap()));
        assert!(!is_go_binary("/usr/bin/true"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn lists_own_processes() {
        let mut child = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        let list = list_processes().unwrap();
        let _ = child.kill();
        let _ = child.wait();
        let found = list.iter().find(|p| p.pid == child.id()).expect("sleep is listed");
        assert!(found.args.contains("sleep 30"));
        assert!(found.exe.ends_with("sleep"));
        assert!(list.iter().all(|p| p.pid != std::process::id()));
    }
}
