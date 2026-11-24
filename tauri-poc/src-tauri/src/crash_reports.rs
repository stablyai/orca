#![allow(dead_code)]
use getrandom::fill as fill_random;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};
use url::Url;

use crate::diagnostics::{collect_diagnostic_bundle, diagnostics_bundle_enabled};
use crate::minidump;

const MAX_REPORTS: usize = 5;
const MAX_BREADCRUMBS: usize = 30;
const MAX_STRING_LENGTH: usize = 8_000;
const MAX_DETAIL_STRING_LENGTH: usize = 240;
const RENDERER_ERROR_DEDUPE_MS: u128 = 10 * 60 * 1_000;
const MAX_RENDERER_ERROR_KEYS: usize = 256;
const MAX_NOTES_LENGTH: usize = 8_000;
const FEEDBACK_TIMEOUT_SECONDS: u64 = 60;
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const DEFAULT_FEEDBACK_ENDPOINT: &str = "https://www.onorca.dev/v1/feedback";
const FEEDBACK_ENDPOINT_ENV: &str = "ORCA_TAURI_FEEDBACK_ENDPOINT";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashReportBreadcrumb {
    pub created_at: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashReportRecord {
    pub id: String,
    pub created_at: String,
    pub status: String,
    pub source: String,
    pub process_type: String,
    pub reason: String,
    pub exit_code: Option<i32>,
    pub app_version: String,
    pub platform: String,
    pub os_release: String,
    pub arch: String,
    pub electron_version: String,
    pub chrome_version: String,
    pub details: Map<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub breadcrumbs: Option<Vec<CrashReportBreadcrumb>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashReportBreadcrumbArgs {
    pub name: String,
    #[serde(default)]
    pub data: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashReportRendererErrorArgs {
    pub boundary_id: String,
    pub surface: String,
    pub error_name: String,
    pub error_message: String,
    #[serde(default)]
    pub error_stack: Option<String>,
    #[serde(default)]
    pub component_stack: Option<String>,
    #[serde(default)]
    pub active_view: Option<String>,
    #[serde(default)]
    pub active_modal: Option<String>,
    #[serde(default)]
    pub active_tab_type: Option<String>,
    #[serde(default)]
    pub active_right_sidebar_tab: Option<String>,
    #[serde(default)]
    pub has_active_worktree: Option<bool>,
    #[serde(default)]
    pub attribution: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashReportSubmitArgs {
    #[serde(default)]
    pub report_id: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub include_diagnostic_logs: Option<bool>,
    #[serde(default)]
    pub submit_anonymously: Option<bool>,
    pub github_login: Option<String>,
    pub github_email: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashReportLookupArgs {
    #[serde(default)]
    pub report_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashReportMinidumpArgs {
    pub report_id: String,
    #[serde(default)]
    pub crashed_at_ms: Option<u128>,
    #[serde(default)]
    pub expected_process_type: Option<String>,
    /// Test seam mirroring the TS injectable capture: a temp dir standing in
    /// for the WebView2 Crashpad reports directory.
    #[serde(default)]
    pub dump_directory: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct CrashReportFile {
    reports: Vec<CrashReportRecord>,
}

#[derive(Default)]
pub struct CrashReportState {
    io: Mutex<()>,
    breadcrumbs: Mutex<Vec<CrashReportBreadcrumb>>,
    renderer_error_keys: Mutex<HashMap<String, u128>>,
    in_flight_submissions: Mutex<HashSet<String>>,
    minidump_claims: Mutex<HashMap<PathBuf, u128>>,
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn now_iso() -> String {
    let milliseconds = now_ms();
    let seconds = milliseconds / 1_000;
    let days = (seconds / 86_400) as i64;
    let day_seconds = seconds % 86_400;

    // Convert Unix days to a proleptic Gregorian date without another runtime dependency.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_part = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_part + 2) / 5 + 1;
    let month = month_part + if month_part < 10 { 3 } else { -9 };
    let year = year + if month <= 2 { 1 } else { 0 };
    let hours = day_seconds / 3_600;
    let minutes = (day_seconds % 3_600) / 60;
    let seconds = day_seconds % 60;

    format!(
        "{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}.{:03}Z",
        milliseconds % 1_000
    )
}

fn report_id() -> String {
    let mut bytes = [0_u8; 16];
    if fill_random(&mut bytes).is_err() {
        return format!("tauri-{}", now_ms());
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        "linux" => "linux",
        other => other,
    }
}

fn app_data_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("crash-reports.json"))
        .map_err(|error| format!("failed to resolve crash report directory: {error}"))
}

fn string_value(value: &str, max_length: usize) -> String {
    value.trim().chars().take(max_length).collect()
}

fn optional_string(value: Option<&str>, max_length: usize) -> Option<String> {
    value
        .map(|value| string_value(value, max_length))
        .filter(|value| !value.is_empty())
}

fn primitive_value(value: &Value) -> Option<Value> {
    match value {
        Value::Null => Some(Value::Null),
        Value::Bool(value) => Some(Value::Bool(*value)),
        Value::Number(value) => Some(Value::Number(value.clone())),
        Value::String(value) => Some(Value::String(string_value(value, MAX_DETAIL_STRING_LENGTH))),
        Value::Array(_) | Value::Object(_) => None,
    }
}

fn sanitize_details(details: impl IntoIterator<Item = (String, Value)>) -> Map<String, Value> {
    details
        .into_iter()
        .filter_map(|(key, value)| {
            let key = string_value(&key, 120);
            if key.is_empty() {
                return None;
            }
            let value = primitive_value(&value)?;
            let lower = key.to_ascii_lowercase();
            let value = if ["token", "secret", "password", "cookie", "authorization"]
                .iter()
                .any(|part| lower == *part || lower.contains(part))
            {
                Value::String("[REDACTED]".to_string())
            } else {
                value
            };
            Some((key, value))
        })
        .collect()
}

fn sanitize_breadcrumb_data(value: Option<&Value>) -> Option<Map<String, Value>> {
    let Value::Object(object) = value? else {
        return None;
    };
    let data = sanitize_details(
        object
            .iter()
            .map(|(key, value)| (key.clone(), value.clone())),
    );
    (!data.is_empty()).then_some(data)
}

fn snapshot_breadcrumbs(state: &CrashReportState) -> Option<Vec<CrashReportBreadcrumb>> {
    let breadcrumbs = state.breadcrumbs.lock().ok()?.clone();
    (!breadcrumbs.is_empty()).then_some(breadcrumbs)
}

fn read_reports(path: &Path) -> Vec<CrashReportRecord> {
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str::<CrashReportFile>(&raw)
        .map(|file| file.reports.into_iter().take(MAX_REPORTS).collect())
        .unwrap_or_default()
}

fn write_reports(path: &Path, reports: &[CrashReportRecord]) -> Result<(), String> {
    let directory = path
        .parent()
        .ok_or_else(|| "crash report path has no parent directory".to_string())?;
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let temp_path = path.with_extension(format!("json.{}.tmp", now_ms()));
    let payload = serde_json::to_vec_pretty(&CrashReportFile {
        reports: reports.to_vec(),
    })
    .map_err(|error| error.to_string())?;
    let result = (|| {
        fs::write(&temp_path, payload).map_err(|error| error.to_string())?;
        #[cfg(windows)]
        if path.exists() {
            fs::remove_file(path).map_err(|error| error.to_string())?;
        }
        fs::rename(&temp_path, path).map_err(|error| error.to_string())
    })();
    let _ = fs::remove_file(&temp_path);
    result
}

fn feedback_endpoint() -> Result<Url, String> {
    let raw = if cfg!(debug_assertions) {
        std::env::var(FEEDBACK_ENDPOINT_ENV)
            .unwrap_or_else(|_| DEFAULT_FEEDBACK_ENDPOINT.to_string())
    } else {
        DEFAULT_FEEDBACK_ENDPOINT.to_string()
    };
    let endpoint =
        Url::parse(&raw).map_err(|_| "invalid feedback endpoint configuration".to_string())?;
    if endpoint.scheme() != "https" && !(cfg!(debug_assertions) && endpoint.scheme() == "http") {
        return Err("feedback endpoint must use https".to_string());
    }
    if endpoint.host_str().is_none() {
        return Err("feedback endpoint has no host".to_string());
    }
    Ok(endpoint)
}

fn sanitize_submit_text(value: Option<&str>, max_length: usize) -> Option<String> {
    let text: String = value?
        .chars()
        .filter(|character| !character.is_control() || *character == '\n' || *character == '\t')
        .take(max_length)
        .collect();
    let text = text.trim().to_string();
    (!text.is_empty()).then_some(text)
}

fn format_diagnostic_lines(lines: &mut Vec<String>, diagnostic: &Value) {
    let Some(object) = diagnostic.as_object() else {
        return;
    };
    lines.push(String::new());
    lines.push("Diagnostic log:".to_string());
    match object.get("status").and_then(Value::as_str) {
        Some("attached") => {
            lines.push("- Status: attached".to_string());
            if let Some(id) = object.get("bundleSubmissionId").and_then(Value::as_str) {
                lines.push(format!("- Bundle submission ID: {id}"));
            }
            if let Some(spans) = object.get("spanCount").and_then(Value::as_u64) {
                lines.push(format!("- Spans: {spans}"));
            }
            if let Some(bytes) = object.get("bytes").and_then(Value::as_u64) {
                lines.push(format!("- Bytes: {bytes}"));
            }
        }
        Some("not_uploaded") => {
            lines.push("- Status: not uploaded".to_string());
            if let Some(reason) = object.get("reason").and_then(Value::as_str) {
                lines.push(format!("- Reason: {reason}"));
            }
        }
        _ => {}
    }
}

fn format_crash_report_text(
    report: Option<&CrashReportRecord>,
    app: &AppHandle,
    notes: Option<&str>,
    diagnostic: &Value,
) -> String {
    let mut lines = vec!["[Crash Report]".to_string(), String::new()];
    if let Some(report) = report {
        lines.extend([
            format!("Report ID: {}", report.id),
            format!("Created: {}", report.created_at),
            format!("Status: {}", report.status),
            format!("Source: {}", report.source),
            format!("Process: {}", report.process_type),
            format!("Reason: {}", report.reason),
            format!(
                "Exit code: {}",
                report
                    .exit_code
                    .map_or_else(|| "unknown".to_string(), |code| code.to_string())
            ),
            format!("App version: {}", report.app_version),
            format!(
                "Platform: {} {} {}",
                report.platform, report.os_release, report.arch
            ),
            format!("Electron: {}", report.electron_version),
            format!("Chrome: {}", report.chrome_version),
        ]);
        if !report.details.is_empty() {
            lines.push(String::new());
            lines.push("Details:".to_string());
            for (key, value) in &report.details {
                lines.push(format!("- {key}: {value}"));
            }
        }
        if let Some(breadcrumbs) = &report.breadcrumbs {
            if !breadcrumbs.is_empty() {
                lines.push(String::new());
                lines.push("Recent activity:".to_string());
                for breadcrumb in breadcrumbs {
                    let suffix = breadcrumb
                        .data
                        .as_ref()
                        .filter(|data| !data.is_empty())
                        .map(|data| {
                            let entries = data
                                .iter()
                                .map(|(key, value)| format!("{key}={value}"))
                                .collect::<Vec<_>>()
                                .join(", ");
                            format!(" ({entries})")
                        })
                        .unwrap_or_default();
                    lines.push(format!(
                        "- {}: {}{}",
                        breadcrumb.created_at, breadcrumb.name, suffix
                    ));
                }
            }
        }
    } else {
        lines.extend([
            "Report ID: not captured".to_string(),
            format!("Created: {}", now_iso()),
            "Status: uncaptured".to_string(),
            "Source: user-reported".to_string(),
            "Process: unknown".to_string(),
            "Reason: no captured crash report".to_string(),
            "Exit code: unknown".to_string(),
            format!("App version: {}", app.package_info().version),
            format!(
                "Platform: {} {} {}",
                node_platform(),
                std::env::var("OS").unwrap_or_default(),
                std::env::consts::ARCH
            ),
            "Electron: tauri".to_string(),
            "Chrome: webview".to_string(),
            String::new(),
            "Details:".to_string(),
            "- captured_crash_report: false".to_string(),
            "- report_source: help_menu".to_string(),
        ]);
    }
    if let Some(notes) = sanitize_submit_text(notes, MAX_NOTES_LENGTH) {
        lines.extend([
            String::new(),
            "User notes:".to_string(),
            "--- begin user notes ---".to_string(),
        ]);
        lines.extend(notes.lines().map(|line| format!("  {line}")));
        lines.push("--- end user notes ---".to_string());
    }
    format_diagnostic_lines(&mut lines, diagnostic);
    lines.join("\n")
}

fn failure_message(error: &str) -> Value {
    serde_json::json!({ "ok": false, "status": Value::Null, "error": error })
}

async fn post_feedback(
    endpoint: Url,
    report_text: &str,
    args: &CrashReportSubmitArgs,
    metadata: &FeedbackMetadata,
    bundle: Option<&crate::diagnostics::CollectedDiagnosticBundle>,
) -> Result<(), (Option<u16>, String)> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(FEEDBACK_TIMEOUT_SECONDS))
        .build()
        .map_err(|_| (None, "feedback network request failed".to_string()))?;
    let anonymous = args.submit_anonymously.unwrap_or(false);
    let login = (!anonymous)
        .then(|| sanitize_submit_text(args.github_login.as_deref(), 240))
        .flatten();
    let email = (!anonymous)
        .then(|| sanitize_submit_text(args.github_email.as_deref(), 320))
        .flatten();
    let app_version = metadata.app_version.clone();
    let builder = if let Some(bundle) = bundle {
        let file = reqwest::multipart::Part::bytes(bundle.payload.as_bytes().to_vec())
            .file_name(format!(
                "orca-diagnostics-{}.ndjson",
                bundle.bundle_submission_id
            ))
            .mime_str("application/x-ndjson")
            .map_err(|_| (None, "feedback request could not be prepared".to_string()))?;
        let form = reqwest::multipart::Form::new()
            .text("feedback", report_text.to_string())
            .text("submissionType", "crash")
            .text("githubLogin", login.clone().unwrap_or_default())
            .text("githubEmail", email.clone().unwrap_or_default())
            .text("appVersion", app_version.clone())
            .text("platform", metadata.platform.clone())
            .text("osRelease", metadata.os_release.clone())
            .text("arch", metadata.arch.clone())
            .text(
                "diagnosticBundleSubmissionId",
                bundle.bundle_submission_id.clone(),
            )
            .text("diagnosticBundleBytes", bundle.bytes.to_string())
            .text("diagnosticBundleSpanCount", bundle.span_count.to_string())
            .part("diagnosticBundleFile", file);
        client.post(endpoint).multipart(form)
    } else {
        client.post(endpoint).json(&serde_json::json!({
            "feedback": report_text,
            "submissionType": "crash",
            "githubLogin": login,
            "githubEmail": email,
            "appVersion": app_version,
            "platform": metadata.platform,
            "osRelease": metadata.os_release,
            "arch": metadata.arch,
        }))
    };
    let response = builder
        .send()
        .await
        .map_err(|_| (None, "feedback network request failed".to_string()))?;
    let status = response.status();
    let body = response.bytes().await.map_err(|_| {
        (
            Some(status.as_u16()),
            "feedback response could not be read".to_string(),
        )
    })?;
    if body.len() > MAX_RESPONSE_BYTES {
        return Err((
            Some(status.as_u16()),
            "feedback response exceeded size limit".to_string(),
        ));
    }
    if status.is_success() {
        Ok(())
    } else {
        Err((Some(status.as_u16()), format!("status {}", status.as_u16())))
    }
}

#[derive(Debug, Clone)]
pub(crate) struct FeedbackMetadata {
    app_version: String,
    platform: String,
    os_release: String,
    arch: String,
}

pub(crate) fn feedback_metadata(app: &AppHandle) -> FeedbackMetadata {
    FeedbackMetadata {
        app_version: app.package_info().version.to_string(),
        platform: node_platform().to_string(),
        os_release: std::env::var("OS").unwrap_or_default(),
        arch: std::env::consts::ARCH.to_string(),
    }
}

fn base_report(app: &AppHandle, state: &CrashReportState) -> CrashReportRecord {
    CrashReportRecord {
        id: report_id(),
        created_at: now_iso(),
        status: "pending".to_string(),
        source: "renderer".to_string(),
        process_type: "react-render".to_string(),
        reason: "react-error-boundary".to_string(),
        exit_code: None,
        app_version: app.package_info().version.to_string(),
        platform: node_platform().to_string(),
        os_release: std::env::var("OS").unwrap_or_else(|_| "unknown".to_string()),
        arch: std::env::consts::ARCH.to_string(),
        electron_version: "tauri".to_string(),
        chrome_version: "webview".to_string(),
        details: Map::new(),
        breadcrumbs: snapshot_breadcrumbs(state),
    }
}

fn store_report(
    app: &AppHandle,
    state: &CrashReportState,
    report: CrashReportRecord,
) -> Result<CrashReportRecord, String> {
    let path = app_data_path(app)?;
    let _guard = state
        .io
        .lock()
        .map_err(|_| "crash report storage is unavailable".to_string())?;
    let mut reports = read_reports(&path);
    reports.insert(0, report.clone());
    reports.truncate(MAX_REPORTS);
    write_reports(&path, &reports)?;
    Ok(report)
}

/// Unexpected exit of the Tauri-owned Node supervisor. The runtime slot only
/// records these when the owner did not signal shutdown, mirroring Electron's
/// expected-teardown scope for owned children.
#[derive(Debug, Clone, Copy)]
pub(crate) struct RuntimeUncapturedExit {
    pub exit_code: Option<i32>,
    pub had_pairing: bool,
}

/// Mirrors the process-gone reason vocabulary for the one child Tauri owns.
/// Windows console/taskkill codes count as kills, not crashes.
pub(crate) fn classify_runtime_exit(exit_code: Option<i32>) -> &'static str {
    match exit_code {
        Some(0) => "abnormal-exit",
        Some(code) if is_windows_control_termination(code) => "killed",
        Some(_) => "crashed",
        None => "killed",
    }
}

fn is_windows_control_termination(code: i32) -> bool {
    // Why: Ctrl+C (0xC000013A) and taskkill (0x40010004) kill from outside;
    // as u32 they match even though i32 renders them negative.
    matches!(code as u32, 0xC000_013A | 0x4001_0004)
}

pub(crate) fn runtime_exit_report(
    metadata: &FeedbackMetadata,
    breadcrumbs: Option<Vec<CrashReportBreadcrumb>>,
    exit: RuntimeUncapturedExit,
) -> CrashReportRecord {
    let mut details = Map::new();
    details.insert("hadPairing".into(), Value::Bool(exit.had_pairing));
    if let Some(code) = exit.exit_code {
        details.insert("exitCode".into(), Value::from(code));
    }
    CrashReportRecord {
        id: report_id(),
        created_at: now_iso(),
        status: "pending".into(),
        source: "native".into(),
        process_type: "node-runtime".into(),
        reason: classify_runtime_exit(exit.exit_code).into(),
        exit_code: exit.exit_code,
        app_version: metadata.app_version.clone(),
        platform: metadata.platform.clone(),
        os_release: metadata.os_release.clone(),
        arch: metadata.arch.clone(),
        electron_version: "tauri".into(),
        chrome_version: "node".into(),
        details,
        breadcrumbs,
    }
}

pub(crate) fn record_runtime_exit(
    app: &AppHandle,
    state: &CrashReportState,
    exit: RuntimeUncapturedExit,
) -> Result<CrashReportRecord, String> {
    let metadata = feedback_metadata(app);
    let breadcrumbs = snapshot_breadcrumbs(state);
    store_report(
        app,
        state,
        runtime_exit_report(&metadata, breadcrumbs, exit),
    )
}
/// Native shell panic captured for the next launch. Breadcrumbs are skipped:
/// the hook runs while the process is unwinding, so touching the state lock
/// could deadlock a thread that panicked while holding it.
#[derive(Debug, Clone)]
pub(crate) struct NativePanicDetails {
    pub message: String,
    pub location: Option<String>,
}

pub(crate) fn native_panic_report(
    metadata: &FeedbackMetadata,
    panic: NativePanicDetails,
) -> CrashReportRecord {
    let mut details = Map::new();
    details.insert(
        "panicMessage".into(),
        Value::from(string_value(&panic.message, MAX_STRING_LENGTH)),
    );
    if let Some(location) = optional_string(panic.location.as_deref(), MAX_DETAIL_STRING_LENGTH) {
        details.insert("panicLocation".into(), Value::from(location));
    }
    CrashReportRecord {
        id: report_id(),
        created_at: now_iso(),
        status: "pending".into(),
        source: "native".into(),
        process_type: "shell".into(),
        reason: "rust-panic".into(),
        exit_code: None,
        app_version: metadata.app_version.clone(),
        platform: metadata.platform.clone(),
        os_release: metadata.os_release.clone(),
        arch: metadata.arch.clone(),
        electron_version: "tauri".into(),
        chrome_version: "none".into(),
        details,
        breadcrumbs: None,
    }
}

pub(crate) fn record_native_panic_report(
    path: &Path,
    metadata: &FeedbackMetadata,
    panic: NativePanicDetails,
) -> Result<CrashReportRecord, String> {
    let mut reports = read_reports(path);
    let report = native_panic_report(metadata, panic);
    reports.insert(0, report.clone());
    reports.truncate(MAX_REPORTS);
    write_reports(path, &reports)?;
    Ok(report)
}

fn panic_message(info: &std::panic::PanicHookInfo) -> String {
    let payload = info.payload();
    if let Some(message) = payload.downcast_ref::<&str>() {
        return message.to_string();
    }
    if let Some(message) = payload.downcast_ref::<String>() {
        return message.clone();
    }
    "unknown panic payload".to_string()
}

pub(crate) fn install_native_panic_hook_with_path(path: PathBuf, metadata: FeedbackMetadata) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info.location().map(|location| {
            format!(
                "{}:{}:{}",
                location.file(),
                location.line(),
                location.column()
            )
        });
        let _ = record_native_panic_report(
            &path,
            &metadata,
            NativePanicDetails {
                message: panic_message(info),
                location,
            },
        );
        previous(info);
    }));
}

pub(crate) fn install_native_panic_hook(app: &AppHandle, metadata: FeedbackMetadata) {
    let Ok(path) = app_data_path(app) else {
        return;
    };
    install_native_panic_hook_with_path(path, metadata);
}

fn apply_dismiss(
    reports: &mut [CrashReportRecord],
    report_id: Option<&str>,
    in_flight: &HashSet<String>,
) -> Option<CrashReportRecord> {
    let report = reports
        .iter_mut()
        .find(|report| Some(report.id.as_str()) == report_id)?;
    // Mirror Electron: a dismiss racing an in-flight submission leaves the report alone.
    if report.status == "pending" && !report_id.is_some_and(|id| in_flight.contains(id)) {
        report.status = "dismissed".to_string();
    }
    Some(report.clone())
}

fn prune_renderer_error_keys(keys: &mut HashMap<String, u128>, now: u128) {
    keys.retain(|_, timestamp| now.saturating_sub(*timestamp) <= RENDERER_ERROR_DEDUPE_MS * 2);
    // Mirror Electron: cap follow-up keys oldest-first so a faulting renderer
    // cannot grow the map without bound inside the window.
    while keys.len() > MAX_RENDERER_ERROR_KEYS {
        let Some(oldest) = keys
            .iter()
            .min_by_key(|(_, seen_at)| **seen_at)
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        keys.remove(&oldest);
    }
}

fn resolve_requested_report(
    reports: Vec<CrashReportRecord>,
    args: Option<CrashReportLookupArgs>,
) -> Option<CrashReportRecord> {
    match args {
        Some(args) => match args.report_id {
            Some(report_id) => reports.into_iter().find(|report| report.id == report_id),
            // Mirror Electron: an explicit lookup without an id resolves nothing
            // instead of a pending crash that appeared later.
            None => None,
        },
        None => reports
            .into_iter()
            .find(|report| report.status == "pending"),
    }
}

fn resolve_submit_report(
    reports: Vec<CrashReportRecord>,
    report_id: Option<&str>,
) -> Option<CrashReportRecord> {
    match report_id {
        Some(report_id) => reports.into_iter().find(|report| report.id == report_id),
        // Mirror Electron: id-less submits are uncaptured user reports and
        // never auto-pick a pending crash.
        None => None,
    }
}

#[tauri::command]
pub fn poc_crash_reports_get_latest_pending(
    app: AppHandle,
    state: State<CrashReportState>,
) -> Result<Option<CrashReportRecord>, String> {
    let path = app_data_path(&app)?;
    let _guard = state
        .io
        .lock()
        .map_err(|_| "crash report storage is unavailable".to_string())?;
    Ok(read_reports(&path)
        .into_iter()
        .find(|report| report.status == "pending"))
}

#[tauri::command]
pub fn poc_crash_reports_get_latest(
    app: AppHandle,
    state: State<CrashReportState>,
) -> Result<Option<CrashReportRecord>, String> {
    let path = app_data_path(&app)?;
    let _guard = state
        .io
        .lock()
        .map_err(|_| "crash report storage is unavailable".to_string())?;
    Ok(read_reports(&path)
        .into_iter()
        .find(|report| report.status == "pending" || report.status == "dismissed"))
}

#[tauri::command]
pub fn poc_crash_reports_get_requested(
    app: AppHandle,
    state: State<CrashReportState>,
    args: Option<CrashReportLookupArgs>,
) -> Result<Option<CrashReportRecord>, String> {
    let path = app_data_path(&app)?;
    let _guard = state
        .io
        .lock()
        .map_err(|_| "crash report storage is unavailable".to_string())?;
    let reports = read_reports(&path);
    Ok(resolve_requested_report(reports, args))
}

#[tauri::command]
pub fn poc_crash_reports_dismiss(
    app: AppHandle,
    state: State<CrashReportState>,
    args: CrashReportLookupArgs,
) -> Result<Option<CrashReportRecord>, String> {
    let path = app_data_path(&app)?;
    let _guard = state
        .io
        .lock()
        .map_err(|_| "crash report storage is unavailable".to_string())?;
    let mut reports = read_reports(&path);
    let in_flight = state
        .in_flight_submissions
        .lock()
        .map_err(|_| "crash report submission state is unavailable".to_string())?;
    let Some(result) = apply_dismiss(&mut reports, args.report_id.as_deref(), &in_flight) else {
        return Ok(None);
    };
    write_reports(&path, &reports)?;
    Ok(Some(result))
}

#[tauri::command]
pub fn poc_crash_reports_record_breadcrumb(
    state: State<CrashReportState>,
    args: CrashReportBreadcrumbArgs,
) -> Result<(), String> {
    let name = string_value(&args.name, 240);
    if name.is_empty() {
        return Ok(());
    }
    let breadcrumb = CrashReportBreadcrumb {
        created_at: now_iso(),
        name,
        data: sanitize_breadcrumb_data(args.data.as_ref()),
    };
    let mut breadcrumbs = state
        .breadcrumbs
        .lock()
        .map_err(|_| "crash report breadcrumbs are unavailable".to_string())?;
    breadcrumbs.push(breadcrumb);
    if breadcrumbs.len() > MAX_BREADCRUMBS {
        let overflow = breadcrumbs.len() - MAX_BREADCRUMBS;
        breadcrumbs.drain(0..overflow);
    }
    Ok(())
}

#[tauri::command]
pub fn poc_crash_reports_record_renderer_error(
    app: AppHandle,
    state: State<CrashReportState>,
    args: CrashReportRendererErrorArgs,
) -> Result<serde_json::Value, String> {
    let surface = [
        "app-root",
        "web-root",
        "workspace-shell",
        "sidebar",
        "terminal-workbench",
        "right-sidebar",
        "page",
        "modal",
        "overlay",
        "rich-markdown-editor",
        "code-editor",
        "dashboard-popout",
    ];
    if !surface.contains(&args.surface.as_str()) || string_value(&args.boundary_id, 120).is_empty()
    {
        return Ok(serde_json::json!({ "ok": false, "error": "Invalid renderer error report." }));
    }
    let boundary_id = string_value(&args.boundary_id, 120);
    let error_name =
        optional_string(Some(&args.error_name), 120).unwrap_or_else(|| "Error".to_string());
    let error_message = optional_string(Some(&args.error_message), 1_000)
        .unwrap_or_else(|| "Unknown render error".to_string());
    let key = serde_json::to_string(&(
        &boundary_id,
        &args.surface,
        &error_name,
        &error_message,
        &args.component_stack,
    ))
    .map_err(|error| error.to_string())?;
    let now = now_ms();
    let mut keys = state
        .renderer_error_keys
        .lock()
        .map_err(|_| "renderer error state is unavailable".to_string())?;
    prune_renderer_error_keys(&mut keys, now);
    if now.saturating_sub(*keys.get(&key).unwrap_or(&0)) < RENDERER_ERROR_DEDUPE_MS {
        return Ok(serde_json::json!({ "ok": true, "report": null, "deduped": true }));
    }
    keys.insert(key, now);
    drop(keys);

    let mut details = vec![
        ("boundary_id".to_string(), Value::String(boundary_id)),
        ("surface".to_string(), Value::String(args.surface)),
        ("error_name".to_string(), Value::String(error_name)),
        ("error_message".to_string(), Value::String(error_message)),
    ];
    for (key, value) in [
        ("error_stack", args.error_stack),
        ("component_stack", args.component_stack),
        ("active_view", args.active_view),
        ("active_modal", args.active_modal),
        ("active_tab_type", args.active_tab_type),
        ("right_sidebar_tab", args.active_right_sidebar_tab),
        ("attribution", args.attribution),
    ] {
        if let Some(value) = optional_string(value.as_deref(), MAX_STRING_LENGTH) {
            details.push((key.to_string(), Value::String(value)));
        }
    }
    if let Some(value) = args.has_active_worktree {
        details.push(("has_active_worktree".to_string(), Value::Bool(value)));
    }
    let mut report = base_report(&app, &state);
    report.details = sanitize_details(details);
    let report = store_report(&app, &state, report)?;
    Ok(serde_json::json!({ "ok": true, "report": report, "deduped": false }))
}

/// Pairs the WebView2 Crashpad dump written for a crash with its report and
/// folds the signature in, mirroring Electron attachMinidumpSignature. Never
/// throws for absent dumps: those resolve to `{ ok: false, reason }`.
fn capture_minidump_for_report(
    app: &AppHandle,
    state: &CrashReportState,
    report_id: &str,
    crashed_at_ms: u128,
    expected_process_type: Option<&str>,
    dump_directory: Option<&str>,
) -> Result<Value, String> {
    let path = app_data_path(app)?;
    {
        let _guard = state
            .io
            .lock()
            .map_err(|_| "crash report storage is unavailable".to_string())?;
        let reports = read_reports(&path);
        if !reports.iter().any(|report| report.id == report_id) {
            return Ok(serde_json::json!({ "ok": false, "reason": "unknown_report" }));
        }
    }
    let directory = match dump_directory {
        Some(directory) => PathBuf::from(directory),
        None => minidump::webview_crash_reports_dir(app)?,
    };
    // Crashpad is still writing when the crash event fires, so poll for the
    // dump like the TS capture instead of reading once.
    let deadline_ms = crashed_at_ms.saturating_add(minidump::DUMP_WAIT_TIMEOUT_MS);
    let mut captured = None;
    let mut candidates = Vec::new();
    while captured.is_none() {
        candidates = minidump::collect_dump_candidates(&directory);
        let mut claims = state
            .minidump_claims
            .lock()
            .map_err(|_| "minidump claim state is unavailable".to_string())?;
        let fresh = minidump::fresh_dump_candidates(&candidates, crashed_at_ms, &mut claims);
        // Newest first like the TS poll: a mismatched process type is
        // skipped, a vanished file is normal because Crashpad promotes dumps
        // by rename.
        for candidate in &fresh {
            let parsed = minidump::parse_dump_file(&candidate.path, expected_process_type);
            let Ok(Some((signature, size_bytes))) = parsed else {
                continue;
            };
            if let Some(expected) = expected_process_type {
                if signature.process_type.as_deref() != Some(expected) {
                    continue;
                }
            }
            claims.insert(candidate.path.clone(), candidate.mtime_ms);
            captured = Some((candidate.clone(), signature, size_bytes));
            break;
        }
        drop(claims);
        if captured.is_none() {
            if now_ms() >= deadline_ms {
                break;
            }
            std::thread::sleep(Duration::from_millis(minidump::DUMP_POLL_INTERVAL_MS));
        }
    }
    let Some((candidate, signature, size_bytes)) = captured else {
        return Ok(serde_json::json!({ "ok": false, "reason": "no_fresh_dump" }));
    };
    let mut extra = minidump::minidump_signature_details(&signature);
    extra.push((
        "minidumpStatus".to_string(),
        Value::String("captured".to_string()),
    ));
    extra.push((
        "minidumpPath".to_string(),
        Value::String(candidate.path.to_string_lossy().into_owned()),
    ));
    extra.push(("minidumpBytes".to_string(), Value::from(size_bytes)));
    let _guard = state
        .io
        .lock()
        .map_err(|_| "crash report storage is unavailable".to_string())?;
    let mut reports = read_reports(&path);
    let Some(index) = reports.iter().position(|report| report.id == report_id) else {
        return Ok(serde_json::json!({ "ok": false, "reason": "unknown_report" }));
    };
    reports[index].details.extend(sanitize_details(extra));
    let report = reports[index].clone();
    write_reports(&path, &reports)?;
    // Crashpad prunes on its own delay; the POC prunes inline because no owned
    // background task runs here. Best effort: a racing Crashpad write wins.
    if let Ok(claims) = state.minidump_claims.lock() {
        for victim in minidump::select_prune_victims(&candidates, &claims) {
            let _ = fs::remove_file(victim);
        }
    }
    Ok(serde_json::json!({ "ok": true, "report": report }))
}

/// Minidump pairing as a renderer-callable command. Dead guests go through
/// record_guest_renderer_crash on a Rust thread instead.
#[tauri::command]
pub fn poc_crash_reports_capture_minidump(
    app: AppHandle,
    state: State<CrashReportState>,
    args: CrashReportMinidumpArgs,
) -> Result<Value, String> {
    capture_minidump_for_report(
        &app,
        &state,
        &string_value(&args.report_id, 120),
        args.crashed_at_ms.unwrap_or_else(now_ms),
        args.expected_process_type.as_deref(),
        args.dump_directory.as_deref(),
    )
}

/// Records a dead guest renderer the way Electron process-gone path does:
/// the report is written from Rust because the renderer that died cannot
/// report itself. The Crashpad dump is paired inline through the same capture
/// core the command uses. Failures only reach the log: recording a crash must
/// never crash the shell.
pub(crate) fn record_guest_renderer_crash(
    app: &AppHandle,
    page_id: &str,
    reason: &str,
    exit_code: Option<i32>,
) {
    let state = app.state::<CrashReportState>();
    let mut report = base_report(app, &state);
    report.process_type = "guest".to_string();
    report.reason = string_value(reason, 120);
    report.exit_code = exit_code;
    report.details = sanitize_details([(
        "browser_page_id".to_string(),
        Value::from(string_value(page_id, MAX_DETAIL_STRING_LENGTH)),
    )]);
    let stored = match store_report(app, &state, report) {
        Ok(stored) => stored,
        Err(error) => {
            eprintln!("orca guest crash report unavailable: {error}");
            return;
        }
    };
    if let Err(error) =
        capture_minidump_for_report(app, &state, &stored.id, now_ms(), Some("renderer"), None)
    {
        eprintln!("orca guest minidump capture failed: {error}");
    }
}

#[tauri::command]
pub async fn poc_crash_reports_submit(
    app: AppHandle,
    state: State<'_, CrashReportState>,
    args: CrashReportSubmitArgs,
) -> Result<Value, String> {
    let path = app_data_path(&app)?;
    let report = {
        let _guard = state
            .io
            .lock()
            .map_err(|_| "crash report storage is unavailable".to_string())?;
        let reports = read_reports(&path);
        resolve_submit_report(reports, args.report_id.as_deref())
    };

    if let Some(report) = &report {
        if report.status == "sent" {
            return Ok(serde_json::json!({ "ok": true, "report": report }));
        }
        let mut in_flight = state
            .in_flight_submissions
            .lock()
            .map_err(|_| "crash report submission state is unavailable".to_string())?;
        if !in_flight.insert(report.id.clone()) {
            return Ok(failure_message(
                "Crash report submission already in progress.",
            ));
        }
    }

    let result = submit_crash_report(&app, &state, report.as_ref(), &args).await;

    if let Some(report) = &report {
        if let Ok(mut in_flight) = state.in_flight_submissions.lock() {
            in_flight.remove(&report.id);
        }
    }
    result
}

async fn submit_crash_report(
    app: &AppHandle,
    state: &CrashReportState,
    report: Option<&CrashReportRecord>,
    args: &CrashReportSubmitArgs,
) -> Result<Value, String> {
    let endpoint = feedback_endpoint()?;
    let mut diagnostic_status = serde_json::json!({
        "status": "not_uploaded",
        "reason": "diagnostic log upload skipped by user"
    });
    let mut diagnostic_bundle = None;
    if args.include_diagnostic_logs != Some(false) {
        if diagnostics_bundle_enabled() {
            match collect_diagnostic_bundle(app, 3 * 24 * 60) {
                Ok(bundle) => {
                    diagnostic_status = serde_json::json!({
                        "status": "attached",
                        "bundleSubmissionId": bundle.bundle_submission_id,
                        "bytes": bundle.bytes,
                        "spanCount": bundle.span_count,
                    });
                    diagnostic_bundle = Some(bundle);
                }
                Err(error) => {
                    diagnostic_status = serde_json::json!({
                        "status": "not_uploaded",
                        "reason": sanitize_submit_text(Some(&error), 500)
                            .unwrap_or_else(|| "diagnostic bundle collection failed".to_string()),
                    });
                }
            }
        } else {
            diagnostic_status = serde_json::json!({
                "status": "not_uploaded",
                "reason": "diagnostic bundle collection is disabled"
            });
        }
    }
    let report_text =
        format_crash_report_text(report, app, args.notes.as_deref(), &diagnostic_status);
    let metadata = feedback_metadata(app);
    let send_result = post_feedback(
        endpoint.clone(),
        &report_text,
        args,
        &metadata,
        diagnostic_bundle.as_ref(),
    )
    .await;
    let mut final_diagnostic_status = diagnostic_status;
    if let Err((status, error)) = send_result {
        if let Some(bundle) = diagnostic_bundle.as_ref() {
            // Match Electron's attachment fallback: retain the report even when
            // a proxy or backend rejects multipart diagnostic data.
            let without_bundle = serde_json::json!({
                "status": "not_uploaded",
                "reason": format!("diagnostic log attachment failed: {error}"),
                "bundleSubmissionId": bundle.bundle_submission_id,
                "bytes": bundle.bytes,
                "spanCount": bundle.span_count,
            });
            let retry_text =
                format_crash_report_text(report, app, args.notes.as_deref(), &without_bundle);
            if let Ok(()) = post_feedback(endpoint, &retry_text, args, &metadata, None).await {
                final_diagnostic_status = without_bundle;
            } else {
                return Ok(serde_json::json!({
                    "ok": false,
                    "status": status,
                    "error": error,
                    "report": report,
                    "diagnosticBundle": without_bundle,
                }));
            }
        } else {
            return Ok(serde_json::json!({
                "ok": false,
                "status": status,
                "error": error,
                "report": report,
                "diagnosticBundle": final_diagnostic_status,
            }));
        }
    }

    let sent_report = if let Some(report) = report {
        let path = app_data_path(app)?;
        let _guard = state
            .io
            .lock()
            .map_err(|_| "crash report storage is unavailable".to_string())?;
        let mut reports = read_reports(&path);
        let updated = reports
            .iter_mut()
            .find(|candidate| candidate.id == report.id);
        if let Some(updated) = updated {
            updated.status = "sent".to_string();
            let sent = updated.clone();
            write_reports(&path, &reports)?;
            Some(sent)
        } else {
            Some(report.clone())
        }
    } else {
        None
    };
    Ok(serde_json::json!({
        "ok": true,
        "report": sent_report,
        "diagnosticBundle": final_diagnostic_status,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnostics::CollectedDiagnosticBundle;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::thread::{self, JoinHandle};

    fn test_args() -> CrashReportSubmitArgs {
        CrashReportSubmitArgs {
            report_id: None,
            notes: Some("test notes".to_string()),
            include_diagnostic_logs: Some(false),
            submit_anonymously: Some(false),
            github_login: Some("octocat".to_string()),
            github_email: Some("octocat@example.com".to_string()),
        }
    }

    fn test_metadata() -> FeedbackMetadata {
        FeedbackMetadata {
            app_version: "1.2.3".to_string(),
            platform: "win32".to_string(),
            os_release: "Windows Test".to_string(),
            arch: "x64".to_string(),
        }
    }

    fn read_request(stream: &mut TcpStream) -> Vec<u8> {
        let mut request = Vec::new();
        let header_end = loop {
            let mut chunk = [0_u8; 4096];
            let read = stream.read(&mut chunk).expect("request should be readable");
            assert!(read > 0, "request ended before headers");
            request.extend_from_slice(&chunk[..read]);
            if let Some(index) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                break index + 4;
            }
        };
        let headers = String::from_utf8_lossy(&request[..header_end]);
        let content_length = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().expect("valid content length"))
            })
            .unwrap_or(0);
        let expected_length = header_end + content_length;
        while request.len() < expected_length {
            let mut chunk = [0_u8; 4096];
            let read = stream
                .read(&mut chunk)
                .expect("request body should be readable");
            assert!(read > 0, "request ended before its body");
            request.extend_from_slice(&chunk[..read]);
        }
        request.truncate(expected_length);
        request
    }

    fn test_server(statuses: Vec<u16>) -> (Url, JoinHandle<Vec<Vec<u8>>>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("test server should bind");
        let address = listener
            .local_addr()
            .expect("test server address should resolve");
        let thread = thread::spawn(move || {
            let mut requests = Vec::new();
            for status in statuses {
                let (mut stream, _) = listener.accept().expect("test request should connect");
                requests.push(read_request(&mut stream));
                let reason = if status < 400 { "OK" } else { "Bad Request" };
                let response = format!(
                    "HTTP/1.1 {status} {reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                );
                stream
                    .write_all(response.as_bytes())
                    .expect("test response should be writable");
            }
            requests
        });
        (
            Url::parse(&format!("http://{address}/v1/feedback")).expect("test URL should parse"),
            thread,
        )
    }

    #[test]
    fn submits_json_feedback_with_sanitized_identity_fields() {
        tauri::async_runtime::block_on(async {
            let (endpoint, server) = test_server(vec![200]);
            let result = post_feedback(
                endpoint,
                "report body",
                &test_args(),
                &test_metadata(),
                None,
            )
            .await;
            assert_eq!(result, Ok(()));
            let requests = server.join().expect("test server should finish");
            let request = String::from_utf8_lossy(&requests[0]);
            let lowercase_request = request.to_ascii_lowercase();
            assert!(request.starts_with("POST /v1/feedback HTTP/1.1"));
            assert!(lowercase_request.contains("content-type: application/json"));
            assert!(request.contains("\"feedback\":\"report body\""));
            assert!(request.contains("\"appVersion\":\"1.2.3\""));
            assert!(request.contains("\"githubLogin\":\"octocat\""));
        });
    }

    #[test]
    fn submits_diagnostic_bundle_as_multipart_attachment() {
        tauri::async_runtime::block_on(async {
            let (endpoint, server) = test_server(vec![200]);
            let bundle = CollectedDiagnosticBundle {
                bundle_submission_id: "bundle-123".to_string(),
                payload: "{\"span\":1}\n".to_string(),
                bytes: 12,
                span_count: 1,
            };
            let result = post_feedback(
                endpoint,
                "report body",
                &test_args(),
                &test_metadata(),
                Some(&bundle),
            )
            .await;
            assert_eq!(result, Ok(()));
            let requests = server.join().expect("test server should finish");
            let request = String::from_utf8_lossy(&requests[0]);
            let lowercase_request = request.to_ascii_lowercase();
            assert!(lowercase_request.contains("content-type: multipart/form-data; boundary="));
            assert!(request.contains("name=\"diagnosticBundleFile\""));
            assert!(request.contains("orca-diagnostics-bundle-123.ndjson"));
            assert!(request.contains("{\"span\":1}"));
            assert!(request.contains("name=\"diagnosticBundleSubmissionId\""));
        });
    }

    #[test]
    fn returns_http_status_for_feedback_failure() {
        tauri::async_runtime::block_on(async {
            let (endpoint, server) = test_server(vec![413]);
            let result = post_feedback(
                endpoint,
                "report body",
                &test_args(),
                &test_metadata(),
                None,
            )
            .await;
            assert_eq!(result, Err((Some(413), "status 413".to_string())));
            server.join().expect("test server should finish");
        });
    }

    #[test]
    fn runtime_exit_classification_mirrors_process_gone_reasons() {
        assert_eq!(classify_runtime_exit(Some(0)), "abnormal-exit");
        assert_eq!(classify_runtime_exit(Some(1)), "crashed");
        // 0xC000013A (Ctrl+C) and 0x40010004 (taskkill) kill from outside.
        assert_eq!(classify_runtime_exit(Some(0xC000_013Au32 as i32)), "killed");
        assert_eq!(classify_runtime_exit(Some(0x4001_0004u32 as i32)), "killed");
        assert_eq!(classify_runtime_exit(None), "killed");
    }

    #[test]
    fn runtime_exit_report_carries_native_attribution() {
        let metadata = FeedbackMetadata {
            app_version: "9.9.9".to_string(),
            platform: "win32".to_string(),
            os_release: "Windows Test".to_string(),
            arch: "x64".to_string(),
        };
        let report = runtime_exit_report(
            &metadata,
            None,
            RuntimeUncapturedExit {
                exit_code: Some(3),
                had_pairing: true,
            },
        );
        assert_eq!(report.status, "pending");
        assert_eq!(report.source, "native");
        assert_eq!(report.process_type, "node-runtime");
        assert_eq!(report.reason, "crashed");
        assert_eq!(report.exit_code, Some(3));
        assert_eq!(report.details.get("hadPairing"), Some(&Value::Bool(true)));
        assert_eq!(report.app_version, "9.9.9");
        assert!(report.breadcrumbs.is_none());
    }

    #[test]
    fn native_panic_report_carries_shell_attribution() {
        let report = native_panic_report(
            &test_metadata(),
            NativePanicDetails {
                message: "explicit panic".to_string(),
                location: Some("src/main.rs:10:2".to_string()),
            },
        );
        assert_eq!(report.status, "pending");
        assert_eq!(report.source, "native");
        assert_eq!(report.process_type, "shell");
        assert_eq!(report.reason, "rust-panic");
        assert_eq!(report.exit_code, None);
        assert_eq!(
            report.details.get("panicMessage"),
            Some(&Value::from("explicit panic")),
        );
        assert_eq!(
            report.details.get("panicLocation"),
            Some(&Value::from("src/main.rs:10:2")),
        );
        assert!(report.breadcrumbs.is_none());
    }

    #[test]
    fn native_panic_storage_truncates_and_caps_reports() {
        let dir = std::env::temp_dir().join(format!("orca-tauri-panic-{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("crash-reports.json");
        let metadata = test_metadata();
        let long = "m".repeat(MAX_STRING_LENGTH + 40);
        for _ in 0..(MAX_REPORTS + 2) {
            record_native_panic_report(
                &path,
                &metadata,
                NativePanicDetails {
                    message: long.clone(),
                    location: None,
                },
            )
            .unwrap();
        }
        let reports = read_reports(&path);
        assert_eq!(reports.len(), MAX_REPORTS);
        let message = reports[0]
            .details
            .get("panicMessage")
            .and_then(Value::as_str)
            .unwrap();
        assert_eq!(message.len(), MAX_STRING_LENGTH);
        assert!(reports[0].details.get("panicLocation").is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn panic_hook_persists_report_for_next_launch() {
        let dir = std::env::temp_dir().join(format!("orca-tauri-panic-hook-{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("crash-reports.json");
        let previous = std::panic::take_hook();
        install_native_panic_hook_with_path(path.clone(), test_metadata());
        let result = std::panic::catch_unwind(|| panic!("probe panic"));
        std::panic::set_hook(previous);
        assert!(result.is_err());
        let reports = read_reports(&path);
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].reason, "rust-panic");
        assert_eq!(reports[0].process_type, "shell");
        let message = reports[0]
            .details
            .get("panicMessage")
            .and_then(Value::as_str)
            .unwrap_or_default();
        assert!(message.contains("probe panic"));
        assert!(reports[0].details.get("panicLocation").is_some());
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn test_report(id: &str, status: &str) -> CrashReportRecord {
        CrashReportRecord {
            id: id.to_string(),
            created_at: "2026-10-20T00:00:00.000Z".to_string(),
            status: status.to_string(),
            source: "renderer".to_string(),
            process_type: "shell".to_string(),
            reason: "rust-panic".to_string(),
            exit_code: None,
            app_version: "1.2.3".to_string(),
            platform: "win32".to_string(),
            os_release: "Windows Test".to_string(),
            arch: "x64".to_string(),
            electron_version: "tauri".to_string(),
            chrome_version: "webview".to_string(),
            details: Map::new(),
            breadcrumbs: None,
        }
    }

    fn lookup_args(report_id: Option<&str>) -> Option<CrashReportLookupArgs> {
        Some(CrashReportLookupArgs {
            report_id: report_id.map(str::to_string),
        })
    }

    #[test]
    fn requested_report_resolves_latest_pending_without_args() {
        let reports = vec![
            test_report("sent-1", "sent"),
            test_report("pending-1", "pending"),
        ];
        let resolved =
            resolve_requested_report(reports, None).expect("pending report should resolve");
        assert_eq!(resolved.id, "pending-1");
    }

    #[test]
    fn requested_report_with_explicit_id_ignores_status() {
        let reports = vec![test_report("dismissed-1", "dismissed")];
        let resolved = resolve_requested_report(reports, lookup_args(Some("dismissed-1")))
            .expect("explicit id should resolve");
        assert_eq!(resolved.id, "dismissed-1");
    }

    #[test]
    fn requested_report_with_empty_lookup_resolves_nothing() {
        let reports = vec![test_report("pending-1", "pending")];
        assert!(resolve_requested_report(reports, lookup_args(None)).is_none());
    }

    #[test]
    fn requested_report_with_unknown_id_resolves_nothing() {
        let reports = vec![test_report("pending-1", "pending")];
        assert!(resolve_requested_report(reports, lookup_args(Some("missing"))).is_none());
    }

    #[test]
    fn submit_resolves_by_id_only() {
        let reports = vec![
            test_report("pending-1", "pending"),
            test_report("pending-2", "pending"),
        ];
        let resolved =
            resolve_submit_report(reports, Some("pending-2")).expect("id should resolve");
        assert_eq!(resolved.id, "pending-2");
    }

    #[test]
    fn submit_without_id_never_auto_picks_pending() {
        let reports = vec![test_report("pending-1", "pending")];
        assert!(resolve_submit_report(reports, None).is_none());
    }

    #[test]
    fn dismiss_flips_pending_only() {
        let mut reports = vec![test_report("pending-1", "pending")];
        let dismissed = apply_dismiss(&mut reports, Some("pending-1"), &HashSet::new())
            .expect("pending report should dismiss");
        assert_eq!(dismissed.status, "dismissed");
        assert_eq!(reports[0].status, "dismissed");
    }

    #[test]
    fn dismiss_leaves_sent_and_unknown_reports_alone() {
        let mut reports = vec![test_report("sent-1", "sent")];
        let kept = apply_dismiss(&mut reports, Some("sent-1"), &HashSet::new())
            .expect("sent report should resolve");
        assert_eq!(kept.status, "sent");
        assert!(apply_dismiss(&mut reports, Some("missing"), &HashSet::new()).is_none());
    }

    #[test]
    fn dismiss_keeps_in_flight_submission_intact() {
        let mut reports = vec![test_report("pending-1", "pending")];
        let in_flight = HashSet::from(["pending-1".to_string()]);
        let kept = apply_dismiss(&mut reports, Some("pending-1"), &in_flight)
            .expect("in-flight report should resolve");
        assert_eq!(kept.status, "pending");
        assert_eq!(reports[0].status, "pending");
    }

    #[test]
    fn renderer_error_keys_evict_oldest_beyond_cap() {
        let mut keys = HashMap::new();
        for index in 0..=MAX_RENDERER_ERROR_KEYS {
            keys.insert(format!("key-{index}"), index as u128);
        }
        prune_renderer_error_keys(&mut keys, 1_000_000);
        assert_eq!(keys.len(), MAX_RENDERER_ERROR_KEYS);
        assert!(!keys.contains_key("key-0"));
        assert!(keys.contains_key(&format!("key-{MAX_RENDERER_ERROR_KEYS}")));
    }
}
