//! Discover debug launch configurations from `.vscode/launch.json` and active workspace files.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredLaunchConfig {
    pub id: String,
    pub name: String,
    pub source: String,
    pub adapter: String,
    pub request: String,
    pub program: Option<String>,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: BTreeMap<String, String>,
    pub extra_json: Option<String>,
}

fn to_slash_string(path: &Path) -> String {
    ide_core::ipc_path::to_ipc(path)
}

fn find_workspace_root(workspace_root: Option<&Path>, active_file: Option<&Path>) -> Option<PathBuf> {
    if let Some(root) = workspace_root.filter(|p| !p.as_os_str().is_empty() && p.exists()) {
        return Some(root.to_path_buf());
    }
    let start = active_file.and_then(|f| if f.is_dir() { Some(f) } else { f.parent() })?;
    for dir in start.ancestors().take(8) {
        if dir.join(".vscode").join("launch.json").is_file()
            || dir.join("Cargo.toml").is_file()
            || dir.join("package.json").is_file()
            || dir.join("go.mod").is_file()
            || dir.join("pyproject.toml").is_file()
            || dir.join(".git").exists()
        {
            return Some(dir.to_path_buf());
        }
    }
    Some(start.to_path_buf())
}

fn map_vscode_type(vs_type: &str) -> Option<(&'static str, Option<&'static str>)> {
    match vs_type.trim().to_ascii_lowercase().as_str() {
        "python" | "debugpy" => Some(("debugpy", None)),
        "node" | "pwa-node" | "node2" => Some(("js-debug", Some("pwa-node"))),
        "chrome" | "pwa-chrome" => Some(("js-debug", Some("pwa-chrome"))),
        "msedge" | "pwa-msedge" => Some(("js-debug", Some("pwa-msedge"))),
        "lldb" | "codelldb" => Some(("codelldb", None)),
        "lldb-dap" => Some(("lldb-dap", None)),
        "go" => Some(("delve", None)),
        "coreclr" => Some(("netcoredbg", None)),
        "rdbg" | "ruby" => Some(("rdbg", None)),
        "java" => Some(("java-debug", None)),
        "kotlin" => Some(("kotlin-debug-adapter", None)),
        _ => None,
    }
}

fn expand_placeholders(value: &mut Value, workspace_root: Option<&Path>, active_file: Option<&Path>) {
    let ws = workspace_root.map(to_slash_string).unwrap_or_default();
    let ws_base = workspace_root
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let file = active_file.map(to_slash_string).unwrap_or_default();
    let file_dir = active_file
        .and_then(|p| p.parent())
        .map(to_slash_string)
        .unwrap_or_else(|| ws.clone());
    let file_base = active_file
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let file_stem = active_file
        .and_then(|p| p.file_stem())
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();

    let replace_str = |s: &str| -> String {
        s.replace("${workspaceFolder}", &ws)
            .replace("${workspaceRoot}", &ws)
            .replace("${workspaceFolderBasename}", &ws_base)
            .replace("${file}", &file)
            .replace("${fileDirname}", &file_dir)
            .replace("${fileBasename}", &file_base)
            .replace("${fileBasenameNoExtension}", &file_stem)
    };

    match value {
        Value::String(s) => *s = replace_str(s),
        Value::Array(items) => {
            for item in items {
                expand_placeholders(item, workspace_root, active_file);
            }
        }
        Value::Object(obj) => {
            for v in obj.values_mut() {
                expand_placeholders(v, workspace_root, active_file);
            }
        }
        _ => {}
    }
}

fn find_launch_json(workspace_root: Option<&Path>, active_file: Option<&Path>) -> Option<(PathBuf, PathBuf)> {
    if let Some(ws) = workspace_root {
        let candidate = ws.join(".vscode").join("launch.json");
        if candidate.is_file() {
            return Some((ws.to_path_buf(), candidate));
        }
    }
    if let Some(dir) = active_file.and_then(|f| if f.is_dir() { Some(f) } else { f.parent() }) {
        for anc in dir.ancestors().take(8) {
            let candidate = anc.join(".vscode").join("launch.json");
            if candidate.is_file() {
                return Some((anc.to_path_buf(), candidate));
            }
        }
    }
    None
}

fn parse_launch_json(
    ws_root: &Path,
    launch_path: &Path,
    active_file: Option<&Path>,
) -> Vec<DiscoveredLaunchConfig> {
    let Ok(raw) = std::fs::read_to_string(launch_path) else {
        return Vec::new();
    };
    let stripped = ide_core::jsonc::strip(&raw);
    let Ok(mut root) = serde_json::from_str::<Value>(&stripped) else {
        return Vec::new();
    };
    expand_placeholders(&mut root, Some(ws_root), active_file);
    let Some(configs) = root.get("configurations").and_then(Value::as_array) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for (idx, item) in configs.iter().enumerate() {
        let Some(obj) = item.as_object() else {
            continue;
        };
        let Some(vs_type) = obj.get("type").and_then(Value::as_str) else {
            continue;
        };
        let Some((adapter, explicit_dap_type)) = map_vscode_type(vs_type) else {
            continue;
        };
        let name = obj
            .get("name")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(vs_type)
            .to_string();
        let request = match obj.get("request").and_then(Value::as_str) {
            Some("attach") => "attach".to_string(),
            _ => "launch".to_string(),
        };
        let program = obj
            .get("program")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let args = obj
            .get("args")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        let cwd = obj
            .get("cwd")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or_else(|| Some(to_slash_string(ws_root)));
        let env = obj
            .get("env")
            .and_then(Value::as_object)
            .map(|m| {
                m.iter()
                    .filter_map(|(k, v)| match v {
                        Value::String(s) => Some((k.clone(), s.clone())),
                        Value::Number(n) => Some((k.clone(), n.to_string())),
                        Value::Bool(b) => Some((k.clone(), b.to_string())),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default();

        let mut extra = Map::new();
        for (k, v) in obj {
            if matches!(k.as_str(), "name" | "type" | "request" | "program" | "args" | "cwd" | "env") {
                continue;
            }
            extra.insert(k.clone(), v.clone());
        }
        if let Some(dap_type) = explicit_dap_type {
            extra.insert("type".to_string(), Value::String(dap_type.to_string()));
        }
        let extra_json = (!extra.is_empty())
            .then(|| serde_json::to_string(&Value::Object(extra)).ok())
            .flatten();

        out.push(DiscoveredLaunchConfig {
            id: format!("launch-json:{idx}:{name}"),
            name,
            source: "launch.json".to_string(),
            adapter: adapter.to_string(),
            request,
            program,
            args,
            cwd,
            env,
            extra_json,
        });
    }
    out
}

fn find_cargo_root(workspace_root: Option<&Path>, active_file: Option<&Path>) -> Option<PathBuf> {
    if let Some(file) = active_file {
        for anc in file.ancestors().skip(1).take(8) {
            if anc.join("Cargo.toml").is_file() {
                return Some(anc.to_path_buf());
            }
        }
    }
    workspace_root
        .filter(|r| r.join("Cargo.toml").is_file())
        .map(Path::to_path_buf)
}

fn read_cargo_package_name(cargo_toml: &Path) -> Option<String> {
    let text = std::fs::read_to_string(cargo_toml).ok()?;
    let mut in_package = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_package = trimmed == "[package]";
            continue;
        }
        if in_package {
            if let Some(rest) = trimmed.strip_prefix("name") {
                if let Some(val) = rest.trim_start().strip_prefix('=') {
                    let cleaned = val.trim().trim_matches('"').trim_matches('\'');
                    if !cleaned.is_empty() {
                        return Some(cleaned.to_string());
                    }
                }
            }
        }
    }
    None
}

fn discover_rust_presets(
    workspace_root: Option<&Path>,
    active_file: Option<&Path>,
    out: &mut Vec<DiscoveredLaunchConfig>,
) {
    let is_rs = active_file
        .and_then(|p| p.extension())
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("rs"));
    let Some(cargo_dir) = find_cargo_root(workspace_root, active_file) else {
        return;
    };
    if !is_rs && active_file.is_some() {
        return;
    }

    let pkg_name = read_cargo_package_name(&cargo_dir.join("Cargo.toml"))
        .unwrap_or_else(|| "rust-app".to_string());
    let cwd = to_slash_string(&cargo_dir);

    let mut build_args = vec!["build".to_string()];
    let mut bin_filter = serde_json::json!({ "kind": "bin" });
    if let Some(file) = active_file {
        if let Ok(rel) = file.strip_prefix(&cargo_dir) {
            let rel_str = to_slash_string(rel);
            if let Some(stem) = rel_str
                .strip_prefix("src/bin/")
                .and_then(|s| s.strip_suffix(".rs"))
            {
                build_args.push("--bin".to_string());
                build_args.push(stem.to_string());
                bin_filter = serde_json::json!({ "name": stem, "kind": "bin" });
            }
        }
    }

    let build_extra = serde_json::json!({
        "cargo": {
            "args": build_args,
            "filter": bin_filter,
        }
    });
    out.push(DiscoveredLaunchConfig {
        id: format!("cargo:build:{pkg_name}"),
        name: format!("Cargo Build & Debug ({pkg_name})"),
        source: "cargo".to_string(),
        adapter: "codelldb".to_string(),
        request: "launch".to_string(),
        program: None,
        args: Vec::new(),
        cwd: Some(cwd.clone()),
        env: BTreeMap::new(),
        extra_json: serde_json::to_string(&build_extra).ok(),
    });

    let has_test = active_file.is_some_and(|f| {
        f.file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.ends_with("_test.rs") || n.starts_with("test_"))
            || f.components()
                .any(|c| c.as_os_str() == "tests")
            || std::fs::read(f)
                .map(|b| {
                    let slice = &b[..b.len().min(64 * 1024)];
                    String::from_utf8_lossy(slice).contains("#[test]")
                })
                .unwrap_or(false)
    });

    if has_test {
        let mut test_args = vec!["test".to_string(), "--no-run".to_string()];
        let mut test_filter = serde_json::json!({ "kind": "test" });
        if let Some(file) = active_file {
            if let Ok(rel) = file.strip_prefix(&cargo_dir) {
                if let Some(stem) = to_slash_string(rel)
                    .strip_prefix("tests/")
                    .and_then(|s| s.strip_suffix(".rs"))
                {
                    test_args.push("--test".to_string());
                    test_args.push(stem.to_string());
                    test_filter = serde_json::json!({ "name": stem, "kind": "test" });
                }
            }
        }
        let test_extra = serde_json::json!({
            "cargo": {
                "args": test_args,
                "filter": test_filter,
            }
        });
        out.push(DiscoveredLaunchConfig {
            id: format!("cargo:test:{pkg_name}"),
            name: format!("Cargo Test & Debug ({pkg_name})"),
            source: "cargo".to_string(),
            adapter: "codelldb".to_string(),
            request: "launch".to_string(),
            program: None,
            args: Vec::new(),
            cwd: Some(cwd),
            env: BTreeMap::new(),
            extra_json: serde_json::to_string(&test_extra).ok(),
        });
    }
}

fn find_python_venv(start: Option<&Path>) -> Option<PathBuf> {
    let base = start?;
    let rels: &[&[&str]] = if cfg!(windows) {
        &[
            &[".venv", "Scripts", "python.exe"],
            &["venv", "Scripts", "python.exe"],
        ]
    } else {
        &[&[".venv", "bin", "python"], &["venv", "bin", "python"]]
    };
    for anc in base.ancestors().take(6) {
        for rel in rels {
            let mut candidate = anc.to_path_buf();
            for part in *rel {
                candidate.push(part);
            }
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn discover_python_presets(
    workspace_root: Option<&Path>,
    active_file: Option<&Path>,
    out: &mut Vec<DiscoveredLaunchConfig>,
) {
    let Some(file) = active_file else {
        return;
    };
    if !file
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("py"))
    {
        return;
    }
    let cwd = workspace_root
        .map(to_slash_string)
        .or_else(|| file.parent().map(to_slash_string));
    let venv = find_python_venv(workspace_root.or_else(|| file.parent()));
    let mut extra = serde_json::json!({ "justMyCode": true });
    if let Some(py) = &venv {
        extra["python"] = Value::String(to_slash_string(py));
    }
    let file_name = file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "script.py".to_string());
    out.push(DiscoveredLaunchConfig {
        id: format!("python:file:{file_name}"),
        name: if venv.is_some() {
            format!("Python File (.venv): {file_name}")
        } else {
            format!("Python File: {file_name}")
        },
        source: "python".to_string(),
        adapter: "debugpy".to_string(),
        request: "launch".to_string(),
        program: Some(to_slash_string(file)),
        args: Vec::new(),
        cwd,
        env: BTreeMap::new(),
        extra_json: serde_json::to_string(&extra).ok(),
    });
}

fn find_local_bin(start: Option<&Path>, bin_name: &str) -> Option<PathBuf> {
    let base = start?;
    for anc in base.ancestors().take(6) {
        let bin_dir = anc.join("node_modules").join(".bin");
        if cfg!(windows) {
            for ext in ["cmd", "exe"] {
                let cand = bin_dir.join(format!("{bin_name}.{ext}"));
                if cand.is_file() {
                    return Some(cand);
                }
            }
        } else {
            let cand = bin_dir.join(bin_name);
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    None
}

fn discover_node_presets(
    workspace_root: Option<&Path>,
    active_file: Option<&Path>,
    out: &mut Vec<DiscoveredLaunchConfig>,
) {
    let ext = active_file
        .and_then(|p| p.extension())
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    let is_ts = matches!(ext.as_deref(), Some("ts" | "tsx" | "mts" | "cts"));
    let is_js = matches!(ext.as_deref(), Some("js" | "jsx" | "mjs" | "cjs"));
    if let (Some(file), true) = (active_file, is_ts || is_js) {
        let cwd = workspace_root
            .map(to_slash_string)
            .or_else(|| file.parent().map(to_slash_string));
        let file_name = file
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "index.js".to_string());
        if is_ts {
            if let Some(tsx) = find_local_bin(workspace_root.or_else(|| file.parent()), "tsx") {
                let extra = serde_json::json!({
                    "runtimeExecutable": to_slash_string(&tsx),
                    "sourceMaps": true,
                    "resolveSourceMapLocations": ["**", "!**/node_modules/**"],
                });
                out.push(DiscoveredLaunchConfig {
                    id: format!("node:tsx:{file_name}"),
                    name: format!("TypeScript (tsx): {file_name}"),
                    source: "node".to_string(),
                    adapter: "js-debug".to_string(),
                    request: "launch".to_string(),
                    program: Some(to_slash_string(file)),
                    args: Vec::new(),
                    cwd: cwd.clone(),
                    env: BTreeMap::new(),
                    extra_json: serde_json::to_string(&extra).ok(),
                });
            }
        }
        let extra = serde_json::json!({
            "sourceMaps": true,
            "resolveSourceMapLocations": ["**", "!**/node_modules/**"],
        });
        out.push(DiscoveredLaunchConfig {
            id: format!("node:file:{file_name}"),
            name: format!("Node.js: {file_name}"),
            source: "node".to_string(),
            adapter: "js-debug".to_string(),
            request: "launch".to_string(),
            program: Some(to_slash_string(file)),
            args: Vec::new(),
            cwd,
            env: BTreeMap::new(),
            extra_json: serde_json::to_string(&extra).ok(),
        });
    }
}

fn discover_go_presets(
    workspace_root: Option<&Path>,
    active_file: Option<&Path>,
    out: &mut Vec<DiscoveredLaunchConfig>,
) {
    let Some(file) = active_file else {
        return;
    };
    if !file
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("go"))
    {
        return;
    }
    let pkg_dir = file.parent().unwrap_or(file);
    let cwd = workspace_root
        .map(to_slash_string)
        .unwrap_or_else(|| to_slash_string(pkg_dir));
    let is_test = file
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.ends_with("_test.go"));
    let extra = serde_json::json!({
        "mode": if is_test { "test" } else { "debug" },
    });
    out.push(DiscoveredLaunchConfig {
        id: format!("go:{}", if is_test { "test" } else { "debug" }),
        name: if is_test {
            "Go: Debug Package Tests".to_string()
        } else {
            "Go: Debug Package".to_string()
        },
        source: "go".to_string(),
        adapter: "delve".to_string(),
        request: "launch".to_string(),
        program: Some(to_slash_string(pkg_dir)),
        args: Vec::new(),
        cwd: Some(cwd),
        env: BTreeMap::new(),
        extra_json: serde_json::to_string(&extra).ok(),
    });
}

pub fn discover_launch_configs(
    workspace_root: Option<&Path>,
    active_file: Option<&Path>,
) -> Vec<DiscoveredLaunchConfig> {
    let resolved_root = find_workspace_root(workspace_root, active_file);
    let root_ref = resolved_root.as_deref();
    let mut out = Vec::new();

    if let Some((ws, launch_json)) = find_launch_json(root_ref, active_file) {
        out.extend(parse_launch_json(&ws, &launch_json, active_file));
    }
    discover_rust_presets(root_ref, active_file, &mut out);
    discover_python_presets(root_ref, active_file, &mut out);
    discover_node_presets(root_ref, active_file, &mut out);
    discover_go_presets(root_ref, active_file, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_vscode_launch_json_with_comments_and_placeholders() {
        let dir = tempfile::tempdir().unwrap();
        let vscode = dir.path().join(".vscode");
        std::fs::create_dir_all(&vscode).unwrap();
        let active = dir.path().join("src").join("app.ts");
        std::fs::create_dir_all(active.parent().unwrap()).unwrap();
        std::fs::write(&active, "console.log(1)\n").unwrap();
        std::fs::write(
            vscode.join("launch.json"),
            r#"{
  // JSONC comment
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Current TS",
      "type": "pwa-node",
      "request": "launch",
      "program": "${file}",
      "cwd": "${workspaceFolder}",
      "args": ["--watch",],
      "env": { "NODE_ENV": "development" },
      "sourceMaps": true,
    },
  ]
}"#,
        )
        .unwrap();

        let configs = discover_launch_configs(Some(dir.path()), Some(&active));
        assert!(!configs.is_empty());
        let first = &configs[0];
        assert_eq!(first.source, "launch.json");
        assert_eq!(first.adapter, "js-debug");
        assert_eq!(first.program.as_deref(), Some(to_slash_string(&active).as_str()));
        assert_eq!(first.cwd.as_deref(), Some(to_slash_string(dir.path()).as_str()));
        assert_eq!(first.args, vec!["--watch"]);
        assert_eq!(first.env.get("NODE_ENV").map(String::as_str), Some("development"));
        let extra: Value = serde_json::from_str(first.extra_json.as_deref().unwrap()).unwrap();
        assert_eq!(extra["sourceMaps"], true);
        assert_eq!(extra["type"], "pwa-node");
    }

    #[test]
    fn discovers_rust_cargo_and_test_presets() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("Cargo.toml"),
            "[package]\nname = \"demo-cli\"\nversion = \"0.1.0\"\n",
        )
        .unwrap();
        let src = dir.path().join("src");
        std::fs::create_dir_all(&src).unwrap();
        let main_rs = src.join("main.rs");
        std::fs::write(&main_rs, "fn main() {}\n#[test]\nfn it_works() {}\n").unwrap();

        let configs = discover_launch_configs(Some(dir.path()), Some(&main_rs));
        assert_eq!(configs.len(), 2);
        assert_eq!(configs[0].adapter, "codelldb");
        assert_eq!(configs[0].source, "cargo");
        let extra0: Value = serde_json::from_str(configs[0].extra_json.as_deref().unwrap()).unwrap();
        assert_eq!(extra0["cargo"]["args"], serde_json::json!(["build"]));
        let extra1: Value = serde_json::from_str(configs[1].extra_json.as_deref().unwrap()).unwrap();
        assert_eq!(extra1["cargo"]["args"], serde_json::json!(["test", "--no-run"]));
    }

    #[test]
    fn discovers_python_venv_and_go_presets() {
        let dir = tempfile::tempdir().unwrap();
        let venv_py = if cfg!(windows) {
            dir.path().join(".venv").join("Scripts").join("python.exe")
        } else {
            dir.path().join(".venv").join("bin").join("python")
        };
        std::fs::create_dir_all(venv_py.parent().unwrap()).unwrap();
        std::fs::write(&venv_py, "").unwrap();
        let py_file = dir.path().join("main.py");
        std::fs::write(&py_file, "print(1)\n").unwrap();

        let py_configs = discover_launch_configs(Some(dir.path()), Some(&py_file));
        assert_eq!(py_configs.len(), 1);
        assert_eq!(py_configs[0].adapter, "debugpy");
        let extra: Value = serde_json::from_str(py_configs[0].extra_json.as_deref().unwrap()).unwrap();
        assert_eq!(extra["python"], to_slash_string(&venv_py));

        let go_test = dir.path().join("pkg").join("foo_test.go");
        std::fs::create_dir_all(go_test.parent().unwrap()).unwrap();
        std::fs::write(&go_test, "package pkg\n").unwrap();
        let go_configs = discover_launch_configs(Some(dir.path()), Some(&go_test));
        assert_eq!(go_configs.len(), 1);
        assert_eq!(go_configs[0].adapter, "delve");
        let go_extra: Value = serde_json::from_str(go_configs[0].extra_json.as_deref().unwrap()).unwrap();
        assert_eq!(go_extra["mode"], "test");
    }
}
