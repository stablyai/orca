//! `cargo` launch integration (what the CodeLLDB VS Code extension does):
//! a launch request may carry `"cargo": {"args": ["build", …], "filter": {…}}`
//! instead of `program`; we run the build with JSON messages and launch the
//! produced executable.

use crate::adapter::find_binary;
use ide_core::{IdeError, IdeResult};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};

#[derive(Debug, Default, Clone)]
pub struct CargoFilter {
    pub name: Option<String>,
    pub kind: Option<String>,
}

impl CargoFilter {
    pub fn from_json(v: Option<&Value>) -> Self {
        let get = |k: &str| v.and_then(|v| v.get(k)).and_then(Value::as_str).map(str::to_owned);
        Self { name: get("name"), kind: get("kind") }
    }
}

/// Picks the executable from one `cargo --message-format=json` stdout line.
pub fn artifact_executable(line: &str, filter: &CargoFilter) -> Option<PathBuf> {
    let msg: Value = serde_json::from_str(line).ok()?;
    if msg.get("reason")?.as_str()? != "compiler-artifact" {
        return None;
    }
    let exe = msg.get("executable")?.as_str()?;
    let target = msg.get("target");
    if let Some(name) = &filter.name
        && target.and_then(|t| t.get("name")).and_then(Value::as_str) != Some(name.as_str())
    {
        return None;
    }
    if let Some(kind) = &filter.kind {
        let kinds = target.and_then(|t| t.get("kind")).and_then(Value::as_array);
        if !kinds.is_some_and(|k| k.iter().any(|x| x.as_str() == Some(kind.as_str()))) {
            return None;
        }
    }
    Some(PathBuf::from(exe))
}

/// Runs cargo and returns the (last matching) executable artifact. Human
/// readable compiler output is passed to `on_output` line by line.
pub async fn build(
    cwd: &Path,
    args: &[String],
    filter: &CargoFilter,
    on_output: impl Fn(String) + Send + Sync + 'static,
) -> IdeResult<PathBuf> {
    let cargo = find_binary("cargo", cwd).ok_or_else(|| IdeError::unavailable("`cargo` not found on PATH"))?;
    let mut cmd = tokio::process::Command::new(cargo);
    ide_core::process::prepare(cmd.as_std_mut());
    cmd.args(args)
        .arg("--message-format=json-render-diagnostics")
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    on_output(format!("> cargo {}\n", args.join(" ")));
    let mut child = cmd.spawn().map_err(|e| IdeError::unavailable(format!("failed to run cargo: {e}")))?;
    let stderr = child.stderr.take().ok_or_else(|| IdeError::internal("cargo stderr unavailable"))?;
    let stdout = child.stdout.take().ok_or_else(|| IdeError::internal("cargo stdout unavailable"))?;
    let on_output = std::sync::Arc::new(on_output);
    let err_out = on_output.clone();
    let err_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).split(b'\n');
        while let Ok(Some(line)) = lines.next_segment().await {
            let line = ide_core::output_encoding::decode_tool_output(&line);
            let line = line.trim_end_matches('\r');
            err_out(format!("{line}\n"));
        }
    });
    let mut found = None;
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if let Some(exe) = artifact_executable(&line, filter) {
            found = Some(exe);
        }
    }
    let _ = err_task.await;
    let status = child.wait().await?;
    if !status.success() {
        return Err(IdeError::invalid(format!("cargo {} failed ({status})", args.first().map_or("", |s| s))));
    }
    found.ok_or_else(|| IdeError::invalid("cargo produced no executable to debug"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_executables_with_filters() {
        let line =
            r#"{"reason":"compiler-artifact","target":{"name":"app","kind":["bin"]},"executable":"/t/debug/app"}"#;
        let lib = r#"{"reason":"compiler-artifact","target":{"name":"core","kind":["lib"]},"executable":null}"#;
        let any = CargoFilter::default();
        assert_eq!(artifact_executable(line, &any), Some(PathBuf::from("/t/debug/app")));
        assert_eq!(artifact_executable(lib, &any), None);
        assert_eq!(artifact_executable("not json", &any), None);
        let other = CargoFilter { name: Some("other".into()), kind: None };
        assert_eq!(artifact_executable(line, &other), None);
        let bin = CargoFilter { name: None, kind: Some("bin".into()) };
        assert!(artifact_executable(line, &bin).is_some());
    }
}
