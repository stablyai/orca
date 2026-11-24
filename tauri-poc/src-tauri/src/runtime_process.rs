use crate::crash_reports::RuntimeUncapturedExit;
use crate::runtime_readiness::drain_readiness;
use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::State;

#[derive(Default)]
struct RuntimeSlot {
    child: Option<Child>,
    pairing: Option<String>,
    error: Option<String>,
    closed: bool,
    uncaptured_exit: Option<RuntimeUncapturedExit>,
}

pub struct OrcadRuntime {
    slot: Mutex<RuntimeSlot>,
    resource_root: Option<PathBuf>,
}

#[derive(Serialize)]
pub struct RuntimeStatus {
    state: &'static str,
    error: Option<String>,
}

impl RuntimeSlot {
    fn refresh(&mut self) -> Result<(), String> {
        if let Some(child) = &mut self.child {
            if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
                let had_pairing = self.pairing.is_some();
                let expected = self.closed;
                self.child = None;
                self.pairing = None;
                self.error = Some(format!("Node runtime exited: {status}"));
                // Why: an owner-signalled shutdown is expected teardown; any
                // other exit is an uncaptured process crash, converted into a
                // pending crash report on the next status poll.
                if !expected {
                    self.uncaptured_exit = Some(RuntimeUncapturedExit {
                        exit_code: status.code(),
                        had_pairing,
                    });
                }
            }
        }
        Ok(())
    }

    fn signal_owner_close(&mut self) {
        self.closed = true;
        self.pairing = None;
        if let Some(child) = &mut self.child {
            // EOF lets orcad finish durable shutdown without stopping persistent PTYs.
            drop(child.stdin.take());
        }
    }

    fn close_owner(&mut self) {
        self.signal_owner_close();
        if let Some(mut child) = self.child.take() {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
    }
}

impl OrcadRuntime {
    pub fn new(resource_root: Option<PathBuf>) -> Self {
        Self {
            slot: Mutex::new(RuntimeSlot::default()),
            resource_root,
        }
    }

    pub fn close_owner(&self) {
        if let Ok(mut slot) = self.slot.lock() {
            slot.close_owner();
        }
    }

    #[allow(dead_code)]
    fn take_uncaptured_exit(&self) -> Option<RuntimeUncapturedExit> {
        self.slot.lock().ok()?.uncaptured_exit.take()
    }

    pub fn close_owner_and_wait(&self, timeout: Duration) -> Result<(), String> {
        {
            let mut slot = self
                .slot
                .lock()
                .map_err(|_| "Runtime lifecycle lock unavailable.")?;
            slot.signal_owner_close();
        }
        let deadline = Instant::now() + timeout;
        loop {
            {
                let mut slot = self
                    .slot
                    .lock()
                    .map_err(|_| "Runtime lifecycle lock unavailable.")?;
                slot.refresh()?;
                if slot.child.is_none() {
                    return Ok(());
                }
            }
            if Instant::now() >= deadline {
                return Err(
                    "The local runtime is still saving state. Wait and retry restarting Orca."
                        .into(),
                );
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    fn pairing(&self) -> Result<String, String> {
        // One lifecycle lock serializes concurrent renderer startup/reload requests.
        let mut slot = self
            .slot
            .lock()
            .map_err(|_| "Runtime lifecycle lock unavailable.")?;
        if slot.closed {
            return Err("Runtime owner is closing.".into());
        }
        slot.refresh()?;
        if let Some(pairing) = &slot.pairing {
            return Ok(pairing.clone());
        }
        if slot.child.is_some() {
            return Err(slot
                .error
                .clone()
                .unwrap_or_else(|| "Previous runtime is still stopping.".into()));
        }
        let mut child = launch_runtime(self.resource_root.as_deref())?;
        let stdout = child.stdout.take().ok_or("Runtime stdout unavailable.")?;
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || drain_readiness(stdout, sender));
        slot.child = Some(child);
        let deadline = Instant::now() + Duration::from_secs(60);
        let result = loop {
            match receiver.recv_timeout(Duration::from_millis(100)) {
                Ok(result) => break result,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    break Err("Runtime output closed.".into())
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    slot.refresh()?;
                    if slot.child.is_none() {
                        break Err(slot.error.clone().unwrap_or_default());
                    }
                    if Instant::now() >= deadline {
                        break Err("Node runtime readiness timed out.".into());
                    }
                }
            }
        };
        match result {
            Ok(pairing) => {
                slot.pairing = Some(pairing.clone());
                slot.error = None;
                Ok(pairing)
            }
            Err(error) => {
                if let Some(child) = &mut slot.child {
                    if let Some(mut input) = child.stdin.take() {
                        let _ = input.write_all(b"stop\n");
                    }
                }
                slot.error = Some(error.clone());
                Err(error)
            }
        }
    }
}

fn launch_runtime(resource_root: Option<&Path>) -> Result<Child, String> {
    // Tauri's resource_dir() returns a canonicalized `\\?\` verbatim path on
    // Windows; Node.exe and CreateProcess handle plain drive paths more
    // reliably for cwd/argv, so strip the prefix.
    fn strip_verbatim(path: &Path) -> PathBuf {
        let s = path.as_os_str().to_string_lossy();
        s.strip_prefix(r"\\?\")
            .map(PathBuf::from)
            .unwrap_or_else(|| path.to_path_buf())
    }
    let (root, entry, supervisor, node, profile) = if cfg!(debug_assertions) {
        let root = std::env::var_os("ORCA_DEV_REPO_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."));
        let entry = root.join(".cache/orcad-dev/orcad-server.js");
        let supervisor = root.join("tauri-poc/scripts/runtime-supervisor.mjs");
        let node = std::env::var_os("ORCA_TAURI_NODE")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "node.exe" } else { "node" }));
        let profile = runtime_profile(root.join(".cache/tauri-orcad-profile"));
        (root, entry, supervisor, node, profile)
    } else {
        let root = resource_root.ok_or("Tauri resource directory is unavailable.")?;
        let bundle = root.join("orcad");
        let entry = bundle.join("orcad.js");
        let supervisor = bundle.join("tauri-runtime-supervisor.mjs");
        let node = resolve_bundled_node(root, &bundle)?;
        let profile = runtime_profile(default_packaged_profile());
        (root.to_path_buf(), entry, supervisor, node, profile)
    };
    let root = strip_verbatim(&root);
    let entry = strip_verbatim(&entry);
    let supervisor = strip_verbatim(&supervisor);
    let node = strip_verbatim(&node);
    if !entry.is_file() || !supervisor.is_file() {
        return Err(format!(
            "Tauri runtime bundle is incomplete: {} or {} is missing.",
            entry.display(),
            supervisor.display()
        ));
    }
    if cfg!(debug_assertions) {
        if node.is_absolute() && !node.is_file() {
            return Err(format!("Node runtime is missing at {}.", node.display()));
        }
    } else if !node.is_absolute() || !node.is_file() {
        return Err(format!(
            "Bundled Node runtime is missing at {}.",
            node.display()
        ));
    }
    let mut command = Command::new(&node);
    command
        .args([&supervisor, &entry])
        .current_dir(root)
        .env("ORCA_USER_DATA", &profile)
        .env("ORCA_BACKGROUND_LAUNCH", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    let stderr_target = profile
        .join("orcad-supervisor-stderr.log")
        .into_os_string();
    let _ = std::fs::create_dir_all(&profile);
    match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&stderr_target)
    {
        Ok(file) => {
            command.stderr(Stdio::from(file));
        }
        Err(_) => {
            command.stderr(Stdio::null());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let diag_path = profile.join("orcad-launch-diag.log");
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start Node supervisor: {error}"))?;
    {
        let pid = child.id();
        let alive = matches!(child.try_wait(), Ok(None));
        let _ = std::fs::create_dir_all(&profile);
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&diag_path)
        {
            use std::io::Write as _;
            let _ = writeln!(
                f,
                "[launch] pid={} alive_after_spawn={} node={} supervisor={} entry={}",
                pid,
                alive,
                node.display(),
                supervisor.display(),
                entry.display()
            );
        }
    }
    Ok(child)
}

fn resolve_bundled_node(resource_root: &Path, bundle: &Path) -> Result<PathBuf, String> {
    let marker = std::fs::read_to_string(bundle.join(".runtime-node"))
        .map_err(|error| format!("Could not read the bundled Node marker: {error}"))?;
    let hash = marker.trim();
    if hash.is_empty() || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("The bundled Node marker is invalid.".into());
    }
    let executable = if cfg!(windows) {
        "node.exe"
    } else {
        "bin/node"
    };
    Ok(resource_root
        .join("runtimes")
        .join(format!("node-{hash}"))
        .join(executable))
}

fn default_packaged_profile() -> PathBuf {
    if cfg!(windows) {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir())
            .join("Orca")
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir())
            .join("Library/Application Support/Orca")
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                std::env::var_os("HOME")
                    .map(|home| PathBuf::from(home).join(".config"))
                    .unwrap_or_else(|| std::env::temp_dir())
            })
            .join("Orca")
    }
}

fn runtime_profile(default: PathBuf) -> PathBuf {
    std::env::var_os("ORCA_TAURI_RUNTIME_PROFILE")
        .or_else(|| std::env::var_os("ORCA_USER_DATA"))
        .or_else(|| std::env::var_os("ORCA_USER_DATA_PATH"))
        .map(PathBuf::from)
        .unwrap_or(default)
}

/// The userData directory orcad resolves `getPath('userData')` against — the
/// same profile the runtime launch env pins, so host-side features (native
/// chat pastes) look in the folder the runtime actually wrote to.
pub fn user_data_dir() -> PathBuf {
    runtime_profile(default_packaged_profile())
}

#[tauri::command]
pub async fn poc_runtime_pairing(runtime: State<'_, Arc<OrcadRuntime>>) -> Result<String, String> {
    let runtime = Arc::clone(runtime.inner());
    tauri::async_runtime::spawn_blocking(move || runtime.pairing())
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn poc_runtime_status(
    runtime: State<'_, Arc<OrcadRuntime>>,
) -> Result<RuntimeStatus, String> {
    let runtime = Arc::clone(runtime.inner());
    let status = {
        let Ok(mut slot) = runtime.slot.try_lock() else {
            return Ok(RuntimeStatus {
                state: "starting",
                error: None,
            });
        };
        slot.refresh()?;
        RuntimeStatus {
            state: if slot.closed {
                "stopped"
            } else if slot.pairing.is_some() {
                "ready"
            } else if slot.error.is_some() {
                "failed"
            } else {
                "idle"
            },
            error: slot.error.clone(),
        }
    };
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closing_an_idle_owner_prevents_future_launches() {
        let runtime = OrcadRuntime::new(None);
        runtime.close_owner();
        assert!(runtime.pairing().unwrap_err().contains("closing"));
        runtime.close_owner();
    }

    #[test]
    fn waits_for_the_owned_runtime_to_finish_after_eof() {
        let runtime = runtime_with_shutdown_child();
        runtime
            .close_owner_and_wait(Duration::from_secs(10))
            .unwrap();
        let slot = runtime.slot.lock().unwrap();
        assert!(slot.closed);
        assert!(slot.child.is_none());
        assert!(slot.pairing.is_none());
        drop(slot);
        assert!(runtime.pairing().unwrap_err().contains("closing"));
        runtime.close_owner_and_wait(Duration::ZERO).unwrap();
    }

    #[test]
    fn a_shutdown_timeout_retains_the_child_for_a_later_retry() {
        let runtime = runtime_with_shutdown_child();
        assert!(runtime
            .close_owner_and_wait(Duration::ZERO)
            .unwrap_err()
            .contains("still saving state"));
        assert!(runtime.slot.lock().unwrap().child.is_some());
        runtime
            .close_owner_and_wait(Duration::from_secs(10))
            .unwrap();
        assert!(runtime.slot.lock().unwrap().child.is_none());
    }

    fn runtime_with_shutdown_child() -> OrcadRuntime {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "runtime_process::tests::runtime_shutdown_child",
                "--ignored",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let runtime = OrcadRuntime::new(None);
        {
            let mut slot = runtime.slot.lock().unwrap();
            slot.child = Some(command.spawn().unwrap());
            slot.pairing = Some("test-pairing".into());
        }
        runtime
    }

    #[test]
    #[ignore = "Child fixture used by the runtime shutdown tests"]
    fn runtime_shutdown_child() {
        use std::io::Read;
        let mut input = Vec::new();
        std::io::stdin().read_to_end(&mut input).unwrap();
        std::thread::sleep(Duration::from_millis(250));
    }

    #[test]
    #[ignore = "Child fixture used by the runtime exit-capture tests"]
    fn runtime_exit_child() {
        let code = std::env::var("ORCA_TEST_EXIT_CODE")
            .ok()
            .and_then(|value| value.parse::<i32>().ok())
            .unwrap_or(3);
        std::process::exit(code);
    }

    fn runtime_with_exit_child(code: &str) -> OrcadRuntime {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "runtime_process::tests::runtime_exit_child",
                "--ignored",
            ])
            .env("ORCA_TEST_EXIT_CODE", code)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let runtime = OrcadRuntime::new(None);
        {
            let mut slot = runtime.slot.lock().unwrap();
            slot.child = Some(command.spawn().unwrap());
            slot.pairing = Some("test-pairing".into());
        }
        runtime
    }

    #[test]
    fn unexpected_child_exit_is_captured_for_crash_reporting() {
        let runtime = runtime_with_exit_child("3");
        let deadline = Instant::now() + Duration::from_secs(10);
        let exit = loop {
            {
                let mut slot = runtime.slot.lock().unwrap();
                slot.refresh().unwrap();
            }
            if let Some(exit) = runtime.take_uncaptured_exit() {
                break exit;
            }
            if Instant::now() >= deadline {
                panic!("child exit was not observed");
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        assert_eq!(exit.exit_code, Some(3));
        assert!(exit.had_pairing);
        // Why: latest-wins dedupe; the drain is one-shot.
        assert!(runtime.take_uncaptured_exit().is_none());
    }

    #[test]
    fn expected_shutdown_exit_is_not_captured() {
        let runtime = runtime_with_shutdown_child();
        runtime.close_owner();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            {
                let mut slot = runtime.slot.lock().unwrap();
                slot.refresh().unwrap();
                if slot.child.is_none() {
                    break;
                }
            }
            if Instant::now() >= deadline {
                panic!("shutdown child did not exit");
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(runtime.take_uncaptured_exit().is_none());
    }
}
