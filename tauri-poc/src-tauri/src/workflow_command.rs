use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunWorkflowCommandArgs {
    pub workdir: String,
    pub command: String,
    #[serde(default)]
    pub shell: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunWorkflowCommandResult {
    pub passed: bool,
    pub exit_code: i32,
    pub output: String,
}

fn build_shell_command(shell: Option<&str>, trimmed: &str) -> Command {
    match shell.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("powershell") => {
            let mut cmd = Command::new("powershell");
            cmd.args(["-NoProfile", "-Command", trimmed]);
            cmd
        }
        Some("pwsh") => {
            let mut cmd = Command::new("pwsh");
            cmd.args(["-NoProfile", "-Command", trimmed]);
            cmd
        }
        Some("cmd") => {
            let mut cmd = Command::new("cmd");
            cmd.args(["/C", trimmed]);
            cmd
        }
        Some("bash") => {
            let mut cmd = Command::new("bash");
            cmd.args(["-lc", trimmed]);
            cmd
        }
        Some("zsh") => {
            let mut cmd = Command::new("zsh");
            cmd.args(["-lc", trimmed]);
            cmd
        }
        Some("sh") => {
            let mut cmd = Command::new("sh");
            cmd.args(["-c", trimmed]);
            cmd
        }
        Some("wsl") => {
            let mut cmd = Command::new("wsl");
            cmd.args(["sh", "-lc", trimmed]);
            cmd
        }
        _ if cfg!(windows) => {
            let mut cmd = Command::new("cmd");
            cmd.args(["/C", trimmed]);
            cmd
        }
        _ => {
            let mut cmd = Command::new("sh");
            cmd.args(["-c", trimmed]);
            cmd
        }
    }
}

fn run_workflow_command_sync(
    workdir: &str,
    command: &str,
    shell: Option<&str>,
) -> Result<RunWorkflowCommandResult, String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("Workflow CLI command is empty.".to_string());
    }
    let dir = Path::new(workdir);
    if !dir.exists() {
        return Err(format!("Working directory does not exist: {workdir}"));
    }

    let output = build_shell_command(shell, trimmed)
        .current_dir(dir)
        .output()
        .map_err(|err| format!("Failed to execute '{trimmed}': {err}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = match (stdout.trim().is_empty(), stderr.trim().is_empty()) {
        (false, false) => format!("{}\n{}", stdout.trim_end(), stderr.trim_end()),
        (false, true) => stdout.trim_end().to_string(),
        (true, false) => stderr.trim_end().to_string(),
        (true, true) => String::new(),
    };

    let exit_code = output.status.code().unwrap_or(-1);
    Ok(RunWorkflowCommandResult {
        passed: output.status.success(),
        exit_code,
        output: combined,
    })
}

#[tauri::command]
pub async fn poc_run_workflow_command(
    args: RunWorkflowCommandArgs,
) -> Result<RunWorkflowCommandResult, String> {
    tokio::task::spawn_blocking(move || {
        run_workflow_command_sync(&args.workdir, &args.command, args.shell.as_deref())
    })
    .await
    .map_err(|err| format!("workflow_command task failed: {err}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_simple_echo_command_in_temp_dir() {
        let dir = std::env::temp_dir();
        let res = run_workflow_command_sync(dir.to_str().unwrap(), "echo orca-cli-ok", None)
            .unwrap();
        assert!(res.passed);
        assert_eq!(res.exit_code, 0);
        assert!(res.output.contains("orca-cli-ok"));
    }
}
