//! Language server registry, binary resolution, project-root detection, and auto-install.

use ide_core::process::{executable_names, find_executable, host_var_os, prepare, shell_env};
use serde::Serialize;
use std::collections::HashSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tokio::process::Command;

static LSP_TOOLS_ROOT: OnceLock<PathBuf> = OnceLock::new();

pub fn set_lsp_tools_root(root: PathBuf) {
    let _ = LSP_TOOLS_ROOT.set(root);
}

pub fn lsp_tools_root() -> Option<&'static PathBuf> {
    LSP_TOOLS_ROOT.get()
}

#[derive(Clone, Copy, Debug)]
pub enum InstallStrategy {
    Npm { packages: &'static [&'static str] },
    Rustup { component: &'static str },
    GoInstall { module: &'static str },
    PythonVenv { package: &'static str },
    Manual,
}

#[derive(Clone, Copy, Debug)]
pub struct LspServerSpec {
    pub id: &'static str,
    pub display_name: &'static str,
    pub command: &'static str,
    pub args: &'static [&'static str],
    pub languages: &'static [&'static str],
    pub root_markers: &'static [&'static str],
    pub fallback: bool,
    pub install_strategy: InstallStrategy,
    pub install_method: &'static str,
    pub install_hint: &'static str,
    pub homepage: &'static str,
}

pub static LSP_SERVERS: &[LspServerSpec] = &[
    LspServerSpec {
        id: "vtsls",
        display_name: "TypeScript / JS (vtsls)",
        command: "vtsls",
        args: &["--stdio"],
        languages: &[
            "typescript",
            "typescriptreact",
            "javascript",
            "javascriptreact",
        ],
        root_markers: &["tsconfig.json", "jsconfig.json", "package.json"],
        fallback: false,
        install_strategy: InstallStrategy::Npm {
            packages: &["@vtsls/language-server"],
        },
        install_method: "npm (private)",
        install_hint: "Install @vtsls/language-server via npm",
        homepage: "https://github.com/yioneko/vtsls",
    },
    LspServerSpec {
        id: "typescript-language-server",
        display_name: "TypeScript / JS (ts-language-server)",
        command: "typescript-language-server",
        args: &["--stdio"],
        languages: &[
            "typescript",
            "typescriptreact",
            "javascript",
            "javascriptreact",
        ],
        root_markers: &["tsconfig.json", "jsconfig.json", "package.json"],
        fallback: true,
        install_strategy: InstallStrategy::Npm {
            packages: &["typescript-language-server", "typescript@6"],
        },
        install_method: "npm (private)",
        install_hint: "npm install typescript-language-server typescript",
        homepage: "https://github.com/typescript-language-server/typescript-language-server",
    },
    LspServerSpec {
        id: "rust-analyzer",
        display_name: "Rust (rust-analyzer)",
        command: "rust-analyzer",
        args: &[],
        languages: &["rust"],
        root_markers: &["Cargo.toml", "rust-project.json"],
        fallback: false,
        install_strategy: InstallStrategy::Rustup {
            component: "rust-analyzer",
        },
        install_method: "rustup",
        install_hint: "rustup component add rust-analyzer",
        homepage: "https://rust-analyzer.github.io",
    },
    LspServerSpec {
        id: "gopls",
        display_name: "Go (gopls)",
        command: "gopls",
        args: &["serve"],
        languages: &["go"],
        root_markers: &["go.work", "go.mod"],
        fallback: false,
        install_strategy: InstallStrategy::GoInstall {
            module: "golang.org/x/tools/gopls@latest",
        },
        install_method: "go install",
        install_hint: "go install golang.org/x/tools/gopls@latest",
        homepage: "https://pkg.go.dev/golang.org/x/tools/gopls",
    },
    LspServerSpec {
        id: "basedpyright",
        display_name: "Python (basedpyright)",
        command: "basedpyright-langserver",
        args: &["--stdio"],
        languages: &["python"],
        root_markers: &[
            "pyproject.toml",
            "pyrightconfig.json",
            "setup.py",
            "requirements.txt",
        ],
        fallback: false,
        install_strategy: InstallStrategy::PythonVenv {
            package: "basedpyright",
        },
        install_method: "pip (private venv)",
        install_hint: "pip install basedpyright",
        homepage: "https://docs.basedpyright.com",
    },
    LspServerSpec {
        id: "pyright",
        display_name: "Python (pyright)",
        command: "pyright-langserver",
        args: &["--stdio"],
        languages: &["python"],
        root_markers: &["pyrightconfig.json", "pyproject.toml"],
        fallback: true,
        install_strategy: InstallStrategy::Manual,
        install_method: "npm",
        install_hint: "npm i -g pyright",
        homepage: "https://github.com/microsoft/pyright",
    },
    LspServerSpec {
        id: "clangd",
        display_name: "C / C++ (clangd)",
        command: "clangd",
        args: &[],
        languages: &["c", "cpp"],
        root_markers: &["compile_commands.json", "CMakeLists.txt", "Makefile"],
        fallback: false,
        install_strategy: InstallStrategy::Manual,
        install_method: "System package",
        install_hint: "Install LLVM clangd (`winget install LLVM.LLVM` / `brew install llvm`)",
        homepage: "https://clangd.llvm.org",
    },
];

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspServerStatusDto {
    pub id: String,
    pub display_name: String,
    pub command: String,
    pub languages: Vec<String>,
    pub status: String,
    pub path: Option<String>,
    pub can_install: bool,
    pub install_method: String,
    pub install_hint: String,
    pub homepage: String,
}

pub fn spec_by_id(id: &str) -> Option<&'static LspServerSpec> {
    LSP_SERVERS.iter().find(|spec| spec.id == id)
}

pub fn canonical_language_id(language: &str, file_path: &Path) -> String {
    let ext = file_path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let lang = language.trim().to_ascii_lowercase();
    match (lang.as_str(), ext.as_str()) {
        ("tsx", _) | (_, "tsx") => "typescriptreact".to_string(),
        ("typescriptreact", _) => "typescriptreact".to_string(),
        ("typescript", _) | ("ts", _) | (_, "ts" | "mts" | "cts") => "typescript".to_string(),
        ("jsx", _) | (_, "jsx") => "javascriptreact".to_string(),
        ("javascriptreact", _) => "javascriptreact".to_string(),
        ("javascript", _) | ("js", _) | (_, "js" | "mjs" | "cjs") => "javascript".to_string(),
        ("rust", _) | ("rs", _) | (_, "rs") => "rust".to_string(),
        ("go", _) | (_, "go") => "go".to_string(),
        ("python", _) | ("py", _) | (_, "py" | "pyi" | "pyw") => "python".to_string(),
        ("c", _) | (_, "c") => "c".to_string(),
        ("cpp", _) | ("c++", _) | (_, "cc" | "cpp" | "cxx" | "hpp" | "hh" | "hxx") => {
            "cpp".to_string()
        }
        (_, "h") => "cpp".to_string(),
        _ if !lang.is_empty() => lang,
        _ => "plaintext".to_string(),
    }
}

fn find_in_dir(dir: &Path, command: &str) -> Option<PathBuf> {
    if !dir.is_dir() {
        return None;
    }
    let pathext = host_var_os("PATHEXT").and_then(|s| s.into_string().ok());
    for name in executable_names(command, cfg!(windows), pathext.as_deref()) {
        let candidate = dir.join(&name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn host_search_path() -> OsString {
    shell_env()
        .find(|(k, _)| k.eq_ignore_ascii_case("PATH"))
        .map(|(_, v)| v)
        .or_else(|| host_var_os("PATH"))
        .unwrap_or_default()
}

pub fn resolve_server_binary(
    spec: &LspServerSpec,
    workspace_root: Option<&Path>,
) -> Option<(PathBuf, &'static str)> {
    if let Some(root) = workspace_root {
        let local_bin = root.join("node_modules").join(".bin");
        if let Some(found) = find_in_dir(&local_bin, spec.command) {
            return Some((found, "installed"));
        }
    }

    if let Some(tools) = lsp_tools_root() {
        let npm_bin = tools.join("npm").join("node_modules").join(".bin");
        if let Some(found) = find_in_dir(&npm_bin, spec.command) {
            return Some((found, "installed"));
        }
        let go_bin = tools.join(spec.id).join("bin");
        if let Some(found) = find_in_dir(&go_bin, spec.command) {
            return Some((found, "installed"));
        }
        let venv_scripts = if cfg!(windows) {
            tools.join(spec.id).join("venv").join("Scripts")
        } else {
            tools.join(spec.id).join("venv").join("bin")
        };
        if let Some(found) = find_in_dir(&venv_scripts, spec.command) {
            return Some((found, "installed"));
        }
    }

    let search = host_search_path();
    find_executable(spec.command, &search).map(|found| (found, "onPath"))
}

pub fn select_server_for_language(
    language_id: &str,
    workspace_root: Option<&Path>,
) -> Option<(&'static LspServerSpec, PathBuf)> {
    let mut matching: Vec<&'static LspServerSpec> = LSP_SERVERS
        .iter()
        .filter(|spec| spec.languages.contains(&language_id))
        .collect();
    matching.sort_by_key(|spec| spec.fallback);
    for spec in matching {
        if let Some((path, _)) = resolve_server_binary(spec, workspace_root) {
            return Some((spec, path));
        }
    }
    None
}

pub fn detect_project_root(
    file_path: &Path,
    workspace_root: Option<&Path>,
    markers: &[&str],
) -> PathBuf {
    let stop_at = workspace_root.and_then(|root| {
        if file_path.starts_with(root) {
            Some(root)
        } else {
            None
        }
    });
    let mut dir = file_path.parent();
    while let Some(cur) = dir {
        if markers.iter().any(|marker| cur.join(marker).exists()) {
            return cur.to_path_buf();
        }
        if let Some(limit) = stop_at {
            if cur == limit {
                break;
            }
        }
        dir = cur.parent();
    }
    workspace_root
        .filter(|p| p.is_dir())
        .map(Path::to_path_buf)
        .or_else(|| file_path.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn collect_server_statuses(
    workspace_root: Option<&Path>,
    running_ids: &HashSet<String>,
) -> Vec<LspServerStatusDto> {
    LSP_SERVERS
        .iter()
        .map(|spec| {
            let resolved = resolve_server_binary(spec, workspace_root);
            let status = if running_ids.contains(spec.id) {
                "running"
            } else if let Some((_, kind)) = resolved.as_ref() {
                kind
            } else {
                "missing"
            };
            LspServerStatusDto {
                id: spec.id.to_string(),
                display_name: spec.display_name.to_string(),
                command: spec.command.to_string(),
                languages: spec.languages.iter().map(|s| (*s).to_string()).collect(),
                status: status.to_string(),
                path: resolved.map(|(p, _)| p.to_string_lossy().into_owned()),
                can_install: !matches!(spec.install_strategy, InstallStrategy::Manual),
                install_method: spec.install_method.to_string(),
                install_hint: spec.install_hint.to_string(),
                homepage: spec.homepage.to_string(),
            }
        })
        .collect()
}

pub fn build_spawn_env_with_tools() -> Vec<(String, String)> {
    let mut env_pairs: Vec<(String, String)> = Vec::new();
    let mut extra_dirs: Vec<PathBuf> = Vec::new();
    if let Some(tools) = lsp_tools_root() {
        extra_dirs.push(tools.join("npm").join("node_modules").join(".bin"));
        for spec in LSP_SERVERS {
            extra_dirs.push(tools.join(spec.id).join("bin"));
            extra_dirs.push(tools.join(spec.id).join("venv").join(if cfg!(windows) {
                "Scripts"
            } else {
                "bin"
            }));
        }
    }
    let existing = host_search_path();
    let mut parts: Vec<PathBuf> = extra_dirs.into_iter().filter(|d| d.is_dir()).collect();
    parts.extend(std::env::split_paths(&existing));
    if let Ok(joined) = std::env::join_paths(parts) {
        env_pairs.push(("PATH".to_string(), joined.to_string_lossy().into_owned()));
    }
    env_pairs
}

pub async fn install_server(
    server_id: &str,
    workspace_root: Option<&Path>,
) -> Result<LspServerStatusDto, String> {
    let spec = spec_by_id(server_id)
        .ok_or_else(|| format!("Unknown language server id: {server_id}"))?;
    let tools_root = lsp_tools_root()
        .cloned()
        .ok_or_else(|| "LSP tools storage directory is unavailable".to_string())?;
    tokio::fs::create_dir_all(&tools_root)
        .await
        .map_err(|e| format!("Failed to create LSP tools directory: {e}"))?;

    let search = host_search_path();
    match spec.install_strategy {
        InstallStrategy::Npm { packages } => {
            let npm = find_executable("npm", &search)
                .ok_or_else(|| "npm is required on PATH to install this server.".to_string())?;
            let prefix = tools_root.join("npm");
            tokio::fs::create_dir_all(&prefix)
                .await
                .map_err(|e| format!("Failed to create npm prefix: {e}"))?;
            let mut cmd = Command::new(npm);
            prepare(cmd.as_std_mut());
            cmd.arg("install")
                .arg("--prefix")
                .arg(&prefix)
                .arg("--no-audit")
                .arg("--no-fund")
                .args(packages);
            run_install_command(cmd, spec.display_name).await?;
        }
        InstallStrategy::Rustup { component } => {
            let rustup = find_executable("rustup", &search)
                .ok_or_else(|| "rustup is required on PATH to install rust-analyzer.".to_string())?;
            let mut cmd = Command::new(rustup);
            prepare(cmd.as_std_mut());
            cmd.args(["component", "add", component]);
            run_install_command(cmd, spec.display_name).await?;
        }
        InstallStrategy::GoInstall { module } => {
            let go_bin = find_executable("go", &search)
                .ok_or_else(|| "Go toolchain is required on PATH to install gopls.".to_string())?;
            let gobin = tools_root.join(spec.id).join("bin");
            tokio::fs::create_dir_all(&gobin)
                .await
                .map_err(|e| format!("Failed to create gopls bin dir: {e}"))?;
            let mut cmd = Command::new(go_bin);
            prepare(cmd.as_std_mut());
            cmd.arg("install").arg(module).env("GOBIN", &gobin);
            run_install_command(cmd, spec.display_name).await?;
        }
        InstallStrategy::PythonVenv { package, .. } => {
            let python = ["python", "python3", "py"]
                .iter()
                .find_map(|c| find_executable(c, &search))
                .ok_or_else(|| "Python 3 is required on PATH to install basedpyright.".to_string())?;
            let venv_dir = tools_root.join(spec.id).join("venv");
            let mut venv_cmd = Command::new(&python);
            prepare(venv_cmd.as_std_mut());
            venv_cmd.args(["-m", "venv"]).arg(&venv_dir);
            run_install_command(venv_cmd, "Python virtualenv").await?;

            let venv_python = if cfg!(windows) {
                venv_dir.join("Scripts").join("python.exe")
            } else {
                venv_dir.join("bin").join("python")
            };
            let mut pip_cmd = Command::new(&venv_python);
            prepare(pip_cmd.as_std_mut());
            pip_cmd.args([
                "-m",
                "pip",
                "install",
                "--disable-pip-version-check",
                package,
            ]);
            run_install_command(pip_cmd, spec.display_name).await?;
        }
        InstallStrategy::Manual => {
            return Err(format!("Automatic installation is unavailable: {}", spec.install_hint));
        }
    }

    collect_server_statuses(workspace_root, &HashSet::new())
        .into_iter()
        .find(|item| item.id == server_id)
        .ok_or_else(|| format!("Installed {server_id}, but could not refresh status"))
}

async fn run_install_command(mut cmd: Command, label: &str) -> Result<(), String> {
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to launch installer for {label}: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let stdout = String::from_utf8_lossy(&out.stdout);
    let detail = if !stderr.trim().is_empty() {
        stderr.trim()
    } else {
        stdout.trim()
    };
    let tail: String = detail.chars().rev().take(400).collect::<Vec<_>>().into_iter().rev().collect();
    Err(format!("Failed to install {label}: {tail}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_extensions_to_canonical_lsp_language_ids() {
        assert_eq!(
            canonical_language_id("javascript", Path::new("foo.ts")),
            "typescript"
        );
        assert_eq!(
            canonical_language_id("", Path::new("Button.tsx")),
            "typescriptreact"
        );
        assert_eq!(
            canonical_language_id("mjs", Path::new("a.mjs")),
            "javascript"
        );
        assert_eq!(canonical_language_id("", Path::new("main.rs")), "rust");
        assert_eq!(canonical_language_id("", Path::new("main.go")), "go");
        assert_eq!(canonical_language_id("", Path::new("app.py")), "python");
    }

    #[test]
    fn detects_project_root_with_markers() {
        let dir = std::env::temp_dir().join(format!("orca-lsp-root-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let nested = dir.join("packages").join("app").join("src");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(dir.join("packages").join("app").join("tsconfig.json"), "{}").unwrap();
        let file = nested.join("index.ts");
        std::fs::write(&file, "").unwrap();

        let detected = detect_project_root(&file, Some(&dir), &["tsconfig.json", "package.json"]);
        assert_eq!(detected, dir.join("packages").join("app"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
