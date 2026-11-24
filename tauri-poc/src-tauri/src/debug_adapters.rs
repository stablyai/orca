//! Debug adapter status probing and auto-installation into Orca's managed
//! `<local_data_dir>/debug-tools` directory.

use ide_dap::adapter::{self, DEBUGPY_TOOL};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tokio::process::Command;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugAdapterStatus {
    pub id: String,
    pub display_name: String,
    pub command: String,
    pub status: String,
    pub path: Option<String>,
    pub can_install: bool,
    pub install_method: String,
    pub install_hint: String,
    pub homepage: String,
}

struct AdapterDescriptor {
    id: &'static str,
    display_name: &'static str,
    command: &'static str,
    can_install: bool,
    install_method: &'static str,
    install_hint: &'static str,
    homepage: &'static str,
}

const ADAPTER_DESCRIPTORS: &[AdapterDescriptor] = &[
    AdapterDescriptor {
        id: "debugpy",
        display_name: "Python (debugpy)",
        command: if cfg!(windows) { "python" } else { "python3" },
        can_install: true,
        install_method: "pip (private copy)",
        install_hint: "Install private debugpy copy or run `python -m pip install debugpy`",
        homepage: "https://github.com/microsoft/debugpy",
    },
    AdapterDescriptor {
        id: "js-debug",
        display_name: "Node / TS (js-debug)",
        command: "js-debug-adapter",
        can_install: true,
        install_method: "GitHub release",
        install_hint: "Download vscode-js-debug release (requires Node.js)",
        homepage: "https://github.com/microsoft/vscode-js-debug",
    },
    AdapterDescriptor {
        id: "codelldb",
        display_name: "Rust / C++ (codelldb)",
        command: "codelldb",
        can_install: true,
        install_method: "GitHub release",
        install_hint: "Download vadimcn/codelldb release",
        homepage: "https://github.com/vadimcn/codelldb",
    },
    AdapterDescriptor {
        id: "delve",
        display_name: "Go (delve)",
        command: "dlv",
        can_install: true,
        install_method: "go install",
        install_hint: "go install github.com/go-delve/delve/cmd/dlv@latest",
        homepage: "https://github.com/go-delve/delve",
    },
    AdapterDescriptor {
        id: "netcoredbg",
        display_name: ".NET (netcoredbg)",
        command: "netcoredbg",
        can_install: true,
        install_method: "GitHub release",
        install_hint: "Download Samsung/netcoredbg release",
        homepage: "https://github.com/Samsung/netcoredbg",
    },
    AdapterDescriptor {
        id: "lldb-dap",
        display_name: "LLDB (lldb-dap)",
        command: "lldb-dap",
        can_install: false,
        install_method: "System package",
        install_hint: if cfg!(target_os = "macos") {
            "Install Xcode Command Line Tools (`xcrun -f lldb-dap`) or `brew install llvm`"
        } else {
            "Install LLVM lldb-dap (`winget install LLVM.LLVM` / package manager)"
        },
        homepage: "https://lldb.llvm.org",
    },
    AdapterDescriptor {
        id: "rdbg",
        display_name: "Ruby (rdbg)",
        command: "rdbg",
        can_install: false,
        install_method: "gem install debug",
        install_hint: "gem install debug",
        homepage: "https://github.com/ruby/debug",
    },
];

fn descriptor_for(id: &str) -> Option<&'static AdapterDescriptor> {
    ADAPTER_DESCRIPTORS.iter().find(|d| d.id == id)
}

pub fn glob_match(pattern: &str, text: &str) -> bool {
    let p = pattern.as_bytes();
    let t = text.as_bytes();
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut retry_ti) = (None::<usize>, 0usize);

    while ti < t.len() {
        if pi < p.len() && (p[pi] == b'?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == b'*' {
            star = Some(pi);
            pi += 1;
            retry_ti = ti;
        } else if let Some(star_pos) = star {
            retry_ti += 1;
            ti = retry_ti;
            pi = star_pos + 1;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == b'*' {
        pi += 1;
    }
    pi == p.len()
}

fn find_python(cwd: &Path) -> Option<PathBuf> {
    let candidates: &[&str] = if cfg!(windows) {
        &["python", "py", "python3"]
    } else {
        &["python3", "python"]
    };
    candidates
        .iter()
        .find_map(|cmd| adapter::resolve_binary(cmd, cwd))
}

fn probe_python_debugpy(python: &Path, cwd: &Path) -> bool {
    let mut cmd = std::process::Command::new(python);
    ide_core::process::prepare(&mut cmd);
    let out = cmd
        .args(["-c", "import debugpy.adapter"])
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    matches!(out, Ok(status) if status.success())
}

fn has_managed_debugpy(tools_root: Option<&Path>) -> Option<PathBuf> {
    let root = tools_root?;
    let lib = root.join(DEBUGPY_TOOL).join("lib");
    if lib.join("debugpy").join("__init__.py").is_file() {
        Some(lib)
    } else {
        None
    }
}

fn probe_descriptor(
    desc: &AdapterDescriptor,
    tools_root: Option<&Path>,
    cwd: &Path,
) -> DebugAdapterStatus {
    let mut status = "missing".to_string();
    let mut path = None;

    if desc.id == DEBUGPY_TOOL {
        if let Some(lib) = has_managed_debugpy(tools_root) {
            status = "installed".to_string();
            path = Some(lib.display().to_string());
        } else if let Some(python) = find_python(cwd) {
            if probe_python_debugpy(&python, cwd) {
                status = "onPath".to_string();
                path = Some(python.display().to_string());
            }
        }
    } else if let Some(bin) = adapter::resolve_binary(desc.command, cwd) {
        let managed = tools_root.is_some_and(|root| bin.starts_with(root));
        status = if managed { "installed" } else { "onPath" }.to_string();
        path = Some(bin.display().to_string());
    }

    DebugAdapterStatus {
        id: desc.id.to_string(),
        display_name: desc.display_name.to_string(),
        command: desc.command.to_string(),
        status,
        path,
        can_install: desc.can_install,
        install_method: desc.install_method.to_string(),
        install_hint: desc.install_hint.to_string(),
        homepage: desc.homepage.to_string(),
    }
}

pub fn probe_all_adapters(cwd: Option<&Path>) -> Vec<DebugAdapterStatus> {
    let tools_root = adapter::tools_root();
    let temp = std::env::temp_dir();
    let effective_cwd = cwd.unwrap_or(&temp);
    ADAPTER_DESCRIPTORS
        .iter()
        .map(|desc| probe_descriptor(desc, tools_root.as_deref(), effective_cwd))
        .collect()
}

pub fn locate_binary(root: &Path, target_names: &[&str]) -> Option<PathBuf> {
    let mut best: Option<(usize, usize, PathBuf)> = None;
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let entry_path = entry.path();
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            if ft.is_dir() {
                if depth < 6 {
                    stack.push((entry_path, depth + 1));
                }
                continue;
            }
            let file_name = entry.file_name().to_string_lossy().into_owned();
            let rank = target_names.iter().position(|n| *n == file_name);
            let Some(rank) = rank else {
                continue;
            };
            let in_bin = dir.file_name().is_some_and(|n| n == "bin");
            let score = (rank, depth + usize::from(!in_bin));
            if best.as_ref().is_none_or(|(r, d, _)| score < (*r, *d)) {
                best = Some((score.0, score.1, entry_path));
            }
        }
    }
    best.map(|(_, _, p)| p)
}

pub fn write_wrapper_shim(
    bin_dir: &Path,
    command: &str,
    target: &Path,
) -> Result<PathBuf, String> {
    std::fs::create_dir_all(bin_dir).map_err(|e| format!("failed to create bin dir: {e}"))?;
    let is_js = target.extension().is_some_and(|ext| ext == "js");
    if cfg!(windows) {
        let link = bin_dir.join(format!("{command}.cmd"));
        let runner = if is_js { "node " } else { "" };
        let content = format!("@echo off\r\n{runner}\"{}\" %*\r\n", target.display());
        std::fs::write(&link, content).map_err(|e| format!("failed to write shim: {e}"))?;
        Ok(link)
    } else {
        let link = bin_dir.join(command);
        let quoted = target.to_string_lossy().replace('\'', r"'\''");
        let runner = if is_js { "node " } else { "" };
        let content = format!("#!/bin/sh\nexec {runner}'{quoted}' \"$@\"\n");
        std::fs::write(&link, content).map_err(|e| format!("failed to write shim: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for item in [&link, target] {
                if let Ok(meta) = std::fs::metadata(item) {
                    let mut perms = meta.permissions();
                    perms.set_mode((perms.mode() & 0o777) | 0o755);
                    let _ = std::fs::set_permissions(item, perms);
                }
            }
        }
        Ok(link)
    }
}

async fn install_debugpy(tools_root: &Path) -> Result<(), String> {
    let temp = std::env::temp_dir();
    let python = find_python(&temp)
        .ok_or_else(|| "Python 3 is required to install debugpy (https://www.python.org)".to_string())?;
    let lib = tools_root.join(DEBUGPY_TOOL).join("lib");
    std::fs::create_dir_all(&lib).map_err(|e| format!("failed to create debugpy dir: {e}"))?;

    let mut cmd = Command::new(&python);
    ide_core::process::prepare(cmd.as_std_mut());
    let output = cmd
        .args([
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "--no-warn-script-location",
            "--upgrade",
            "--target",
        ])
        .arg(&lib)
        .arg("debugpy")
        .output()
        .await
        .map_err(|e| format!("failed to run pip install debugpy: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "pip install debugpy failed: {}",
            stderr.trim().lines().last().unwrap_or(stdout.trim())
        ));
    }
    Ok(())
}

async fn install_delve(tools_root: &Path) -> Result<(), String> {
    let temp = std::env::temp_dir();
    let go = adapter::resolve_binary("go", &temp)
        .ok_or_else(|| "Go toolchain is required to install Delve (https://go.dev/dl)".to_string())?;
    let bin = tools_root.join("delve").join("bin");
    std::fs::create_dir_all(&bin).map_err(|e| format!("failed to create delve dir: {e}"))?;

    let mut cmd = Command::new(&go);
    ide_core::process::prepare(cmd.as_std_mut());
    let output = cmd
        .args(["install", "github.com/go-delve/delve/cmd/dlv@latest"])
        .env("GOBIN", &bin)
        .output()
        .await
        .map_err(|e| format!("failed to run `go install`: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("`go install` delve failed: {}", stderr.trim()));
    }
    Ok(())
}

fn github_release_patterns(adapter_id: &str) -> Result<(&'static str, &'static [&'static str], &'static [&'static str], &'static str), String> {
    match adapter_id {
        "js-debug" => Ok((
            "microsoft/vscode-js-debug",
            &["js-debug-dap-*.tar.gz"],
            &["dapDebugServer.js"],
            "js-debug-adapter",
        )),
        "codelldb" => {
            let assets: &'static [&'static str] = if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
                &["codelldb-win32-x64.vsix", "codelldb-x86_64-windows.vsix"]
            } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
                &["codelldb-darwin-arm64.vsix", "codelldb-aarch64-darwin.vsix"]
            } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
                &["codelldb-darwin-x64.vsix", "codelldb-x86_64-darwin.vsix"]
            } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
                &["codelldb-linux-arm64.vsix", "codelldb-aarch64-linux.vsix"]
            } else {
                &["codelldb-linux-x64.vsix", "codelldb-x86_64-linux.vsix"]
            };
            let targets: &'static [&'static str] = if cfg!(windows) {
                &["codelldb.exe"]
            } else {
                &["codelldb"]
            };
            Ok(("vadimcn/codelldb", assets, targets, "codelldb"))
        }
        "netcoredbg" => {
            let assets: &'static [&'static str] = if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
                &["netcoredbg-win64.zip"]
            } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
                &["netcoredbg-osx-arm64.zip"]
            } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
                &["netcoredbg-linux-arm64.tar.gz"]
            } else {
                &["netcoredbg-linux-amd64.tar.gz"]
            };
            let targets: &'static [&'static str] = if cfg!(windows) {
                &["netcoredbg.exe"]
            } else {
                &["netcoredbg"]
            };
            Ok(("Samsung/netcoredbg", assets, targets, "netcoredbg"))
        }
        other => Err(format!("Automatic install is not supported for `{other}`")),
    }
}

async fn extract_archive(archive: &Path, dest: &Path) -> Result<(), String> {
    let lower = archive.to_string_lossy().to_ascii_lowercase();
    let is_zip = lower.ends_with(".zip") || lower.ends_with(".vsix");
    if is_zip && cfg!(target_os = "linux") {
        if let Some(unzip) = adapter::resolve_binary("unzip", dest) {
            let mut cmd = Command::new(unzip);
            ide_core::process::prepare(cmd.as_std_mut());
            let out = cmd
                .arg("-qo")
                .arg(archive)
                .arg("-d")
                .arg(dest)
                .output()
                .await
                .map_err(|e| format!("failed to run unzip: {e}"))?;
            if out.status.success() {
                return Ok(());
            }
        }
    }

    let tar = adapter::resolve_binary("tar", dest)
        .ok_or_else(|| "`tar` executable is required to extract adapter archives".to_string())?;
    let flag = if is_zip { "-xf" } else { "-xzf" };
    let mut cmd = Command::new(tar);
    ide_core::process::prepare(cmd.as_std_mut());
    let out = cmd
        .arg(flag)
        .arg(archive)
        .arg("-C")
        .arg(dest)
        .output()
        .await
        .map_err(|e| format!("failed to run tar: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("failed to extract archive: {}", stderr.trim()));
    }
    Ok(())
}

async fn install_github_release(tools_root: &Path, adapter_id: &str) -> Result<(), String> {
    let (repo, patterns, targets, command) = github_release_patterns(adapter_id)?;
    let client = reqwest::Client::builder()
        .user_agent("Orca-Debugger")
        .build()
        .map_err(|e| format!("failed to create HTTP client: {e}"))?;

    let url = format!("https://api.github.com/repos/{repo}/releases/latest");
    let mut req = client.get(&url).header("Accept", "application/vnd.github+json");
    if let Ok(token) = std::env::var("GITHUB_TOKEN").or_else(|_| std::env::var("GH_TOKEN")) {
        if !token.trim().is_empty() {
            req = req.bearer_auth(token.trim());
        }
    }

    let release: serde_json::Value = req
        .send()
        .await
        .map_err(|e| format!("failed to query GitHub release for {repo}: {e}"))?
        .error_for_status()
        .map_err(|e| format!("GitHub release lookup failed for {repo}: {e}"))?
        .json()
        .await
        .map_err(|e| format!("invalid GitHub release JSON: {e}"))?;

    let assets = release
        .get("assets")
        .and_then(|v| v.as_array())
        .ok_or_else(|| format!("no release assets found for {repo}"))?;

    let mut matched: Option<(String, String)> = None;
    for pattern in patterns {
        for asset in assets {
            let name = asset.get("name").and_then(|v| v.as_str()).unwrap_or_default();
            let dl = asset
                .get("browser_download_url")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if glob_match(pattern, name) && !dl.is_empty() {
                matched = Some((name.to_string(), dl.to_string()));
                break;
            }
        }
        if matched.is_some() {
            break;
        }
    }

    let (asset_name, download_url) =
        matched.ok_or_else(|| format!("no compatible release asset found in {repo} for this platform"))?;

    let tool_dir = tools_root.join(adapter_id);
    let dist_dir = tool_dir.join("dist");
    if dist_dir.exists() {
        let _ = std::fs::remove_dir_all(&dist_dir);
    }
    std::fs::create_dir_all(&dist_dir).map_err(|e| format!("failed to create dist dir: {e}"))?;

    let bytes = client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| format!("failed to download {asset_name}: {e}"))?
        .error_for_status()
        .map_err(|e| format!("download failed for {asset_name}: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("failed to read download body: {e}"))?;

    let archive_path = tool_dir.join(&asset_name);
    std::fs::write(&archive_path, &bytes).map_err(|e| format!("failed to save archive: {e}"))?;
    let extract_res = extract_archive(&archive_path, &dist_dir).await;
    let _ = std::fs::remove_file(&archive_path);
    extract_res?;

    let binary = locate_binary(&dist_dir, targets)
        .ok_or_else(|| format!("extracted {asset_name}, but executable was not found"))?;
    write_wrapper_shim(&tool_dir.join("bin"), command, &binary)?;
    Ok(())
}

pub async fn install_adapter(adapter_id: &str) -> Result<DebugAdapterStatus, String> {
    let desc = descriptor_for(adapter_id)
        .ok_or_else(|| format!("Unknown debug adapter `{adapter_id}`"))?;
    if !desc.can_install {
        return Err(format!(
            "`{adapter_id}` cannot be auto-installed. {}",
            desc.install_hint
        ));
    }
    let tools_root = adapter::tools_root()
        .ok_or_else(|| "Debug tools directory is not initialized".to_string())?;

    match adapter_id {
        "debugpy" => install_debugpy(&tools_root).await?,
        "delve" => install_delve(&tools_root).await?,
        _ => install_github_release(&tools_root, adapter_id).await?,
    }

    let temp = std::env::temp_dir();
    Ok(probe_descriptor(desc, Some(&tools_root), &temp))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_matches_release_asset_names() {
        assert!(glob_match("js-debug-dap-*.tar.gz", "js-debug-dap-v1.96.0.tar.gz"));
        assert!(!glob_match("js-debug-dap-*.tar.gz", "js-debug-v1.96.0.zip"));
        assert!(glob_match("codelldb-win32-x64.vsix", "codelldb-win32-x64.vsix"));
    }

    #[test]
    fn locates_nested_target_and_writes_wrapper_shim() {
        let dir = tempfile::tempdir().unwrap();
        let dist = dir.path().join("dist");
        let nested = dist.join("js-debug").join("src").join("dapDebugServer.js");
        std::fs::create_dir_all(nested.parent().unwrap()).unwrap();
        std::fs::write(&nested, "console.log('dap');").unwrap();

        let found = locate_binary(&dist, &["dapDebugServer.js"]).unwrap();
        assert_eq!(found, nested);

        let shim = write_wrapper_shim(&dir.path().join("bin"), "js-debug-adapter", &found).unwrap();
        let shim_text = std::fs::read_to_string(&shim).unwrap();
        assert!(shim_text.contains("node "));
        assert!(shim_text.contains("dapDebugServer.js"));
    }

    #[test]
    fn detects_managed_debugpy_lib_directory() {
        let dir = tempfile::tempdir().unwrap();
        assert!(has_managed_debugpy(Some(dir.path())).is_none());
        let pkg = dir.path().join("debugpy").join("lib").join("debugpy");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(pkg.join("__init__.py"), "").unwrap();
        let detected = has_managed_debugpy(Some(dir.path())).unwrap();
        assert_eq!(detected, dir.path().join("debugpy").join("lib"));
    }
}
