#![allow(dead_code)]
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_opener::OpenerExt;
use url::Url;

const MAX_BUNDLE_BYTES: usize = 4 * 1024 * 1024;
const MAX_INPUT_FILE_BYTES: u64 = 50 * 1024 * 1024;
const MAX_TRACE_FILES: usize = 10;
const PREVIEW_TTL_MS: u128 = 15 * 60 * 1000;
const TOKEN_REQUEST_TIMEOUT_SECONDS: u64 = 10;
const UPLOAD_TIMEOUT_SECONDS: u64 = 30;
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const TOKEN_ENDPOINT_ENV: &str = "ORCA_TAURI_DIAGNOSTICS_TOKEN_ENDPOINT";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsStatus {
    pub local_file_enabled: bool,
    pub bundle_enabled: bool,
    pub trace_file_path: String,
    pub trace_family_size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsBundlePreview {
    pub bundle_submission_id: String,
    pub bytes: usize,
    pub span_count: usize,
}

#[derive(Debug, Clone)]
pub struct CollectedDiagnosticBundle {
    pub bundle_submission_id: String,
    pub payload: String,
    pub bytes: usize,
    pub span_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", untagged)]
pub enum DiagnosticsUploadResult {
    Uploaded { ticket_id: String },
    Canceled { canceled: bool },
}

struct PendingBundle {
    payload: String,
    preview_file_path: PathBuf,
    created_at_ms: u128,
    preview_opened: bool,
}

#[derive(Default)]
pub struct DiagnosticsState {
    pending: Mutex<HashMap<String, PendingBundle>>,
}

fn env_on(name: &str) -> bool {
    matches!(
        std::env::var(name).ok().as_deref(),
        Some("1") | Some("true") | Some("TRUE") | Some("True")
    )
}

fn diagnostics_enabled() -> bool {
    !env_on("ORCA_DIAGNOSTICS_DISABLED") && !in_ci()
}

pub fn diagnostics_bundle_enabled() -> bool {
    diagnostics_enabled() && !env_on("DO_NOT_TRACK") && !env_on("ORCA_TELEMETRY_DISABLED")
}

fn in_ci() -> bool {
    [
        "CI",
        "GITHUB_ACTIONS",
        "GITLAB_CI",
        "CIRCLECI",
        "TRAVIS",
        "BUILDKITE",
        "JENKINS_URL",
        "TEAMCITY_VERSION",
    ]
    .iter()
    .any(|name| std::env::var(name).is_ok_and(|value| !value.is_empty()))
}

fn user_data_dir() -> PathBuf {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    match std::env::consts::OS {
        "windows" => std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or(home)
            .join("Orca"),
        "macos" => home
            .join("Library")
            .join("Application Support")
            .join("Orca"),
        _ => home.join(".config").join("Orca"),
    }
}

fn logs_dir() -> PathBuf {
    user_data_dir().join("logs")
}

fn trace_path() -> PathBuf {
    logs_dir().join("main.trace.ndjson")
}

fn daemon_log_path() -> PathBuf {
    logs_dir().join("daemon.log")
}

fn file_family(path: &Path, max_files: usize) -> Vec<PathBuf> {
    (0..max_files)
        .map(|index| {
            if index == 0 {
                path.to_path_buf()
            } else {
                PathBuf::from(format!("{}.{}", path.display(), index))
            }
        })
        .filter(|candidate| {
            fs::metadata(candidate)
                .map(|metadata| metadata.is_file() && metadata.len() <= MAX_INPUT_FILE_BYTES)
                .unwrap_or(false)
        })
        .collect()
}

fn family_size(path: &Path) -> u64 {
    file_family(path, MAX_TRACE_FILES)
        .iter()
        .filter_map(|candidate| fs::metadata(candidate).ok().map(|metadata| metadata.len()))
        .sum()
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn bundle_id() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| error.to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn is_sensitive_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    [
        "token",
        "secret",
        "password",
        "passwd",
        "authorization",
        "cookie",
        "api_key",
        "apikey",
        "private_key",
        "access_key",
        "refresh_key",
    ]
    .iter()
    .any(|part| key == *part || key.contains(part))
}

fn redact(value: Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, value)| {
                    if is_sensitive_key(&key) {
                        (key, Value::String("[REDACTED]".to_string()))
                    } else {
                        (key, redact(value))
                    }
                })
                .collect::<Map<_, _>>(),
        ),
        Value::Array(values) => Value::Array(values.into_iter().map(redact).collect()),
        other => other,
    }
}

fn parse_record(line: &str, cutoff_ms: u128) -> Option<String> {
    let value: Value = serde_json::from_str(line).ok()?;
    let object = value.as_object()?;
    // Daemon lifecycle logs use ISO timestamps. Keep those records when the
    // standard library cannot parse them; trace spans have nanosecond times.
    if let Some(end_time) = object.get("endTimeUnixNano").and_then(Value::as_str) {
        if let Ok(nanos) = end_time.parse::<u128>() {
            if nanos < cutoff_ms.saturating_mul(1_000_000) {
                return None;
            }
        }
    }
    serde_json::to_string(&redact(value)).ok()
}

fn collect_lines(path: &Path, cutoff_ms: u128, output: &mut Vec<String>, bytes: &mut usize) {
    for file_path in file_family(path, MAX_TRACE_FILES) {
        let Ok(file) = File::open(file_path) else {
            continue;
        };
        let lines: Vec<String> = BufReader::new(file).lines().map_while(Result::ok).collect();
        for line in lines.into_iter().rev() {
            let Some(redacted) = parse_record(&line, cutoff_ms) else {
                continue;
            };
            let line_bytes = redacted.len() + 1;
            if *bytes + line_bytes > MAX_BUNDLE_BYTES {
                return;
            }
            output.push(redacted);
            *bytes += line_bytes;
        }
    }
}

fn prune_pending(state: &DiagnosticsState) {
    let now = now_ms();
    if let Ok(mut pending) = state.pending.lock() {
        pending.retain(|_, value| now.saturating_sub(value.created_at_ms) <= PREVIEW_TTL_MS);
    }
}

pub fn collect_diagnostic_bundle(
    app: &AppHandle,
    lookback_minutes: u32,
) -> Result<CollectedDiagnosticBundle, String> {
    if !diagnostics_bundle_enabled() {
        return Err("creating review files is disabled".to_string());
    }
    let lookback = lookback_minutes.clamp(1, 30 * 24 * 60);
    let cutoff_ms = now_ms().saturating_sub(u128::from(lookback) * 60 * 1000);
    let id = bundle_id()?;
    let header = serde_json::json!({
        "type": "bundle-header",
        "bundle_submission_id": id,
        "app_version": app.package_info().version.to_string(),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "os_release": std::env::var("OS").unwrap_or_default(),
        "orca_channel": std::env::var("ORCA_CHANNEL").unwrap_or_else(|_| "dev".to_string()),
        "collected_at": format!("{}", now_ms()),
        "schema_version": 1,
    });
    let header_line = serde_json::to_string(&header).map_err(|error| error.to_string())?;
    let mut lines = vec![header_line.clone()];
    let mut bytes = header_line.len() + 1;
    collect_lines(&trace_path(), cutoff_ms, &mut lines, &mut bytes);
    collect_lines(&daemon_log_path(), cutoff_ms, &mut lines, &mut bytes);
    let payload = format!("{}\n", lines.join("\n"));
    Ok(CollectedDiagnosticBundle {
        bundle_submission_id: id,
        bytes: payload.len(),
        span_count: lines.len().saturating_sub(1),
        payload,
    })
}

fn configured_token_endpoint() -> Result<Url, String> {
    let raw = std::env::var(TOKEN_ENDPOINT_ENV)
        .map_err(|_| "sending diagnostics is not configured for this build".to_string())?;
    let endpoint =
        Url::parse(&raw).map_err(|_| "invalid diagnostics endpoint configuration".to_string())?;
    if endpoint.scheme() != "https" && endpoint.scheme() != "http" {
        return Err("diagnostics endpoint must use http(s)".to_string());
    }
    if endpoint.host_str().is_none() {
        return Err("diagnostics endpoint has no host".to_string());
    }
    Ok(endpoint)
}

fn valid_identifier(value: &str) -> bool {
    (16..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn validate_upload_url(upload_url: &str, token_endpoint: &Url) -> Result<Url, String> {
    let upload =
        Url::parse(upload_url).map_err(|_| "invalid upload_url from token endpoint".to_string())?;
    if upload.scheme() != "https" && upload.scheme() != "http" {
        return Err("upload_url must use http(s)".to_string());
    }
    if token_endpoint.scheme() == "https" && upload.scheme() != "https" {
        return Err("upload_url must use https when token endpoint is https".to_string());
    }
    if upload.host_str() != token_endpoint.host_str()
        || upload.port_or_known_default() != token_endpoint.port_or_known_default()
    {
        return Err("upload_url host must match token endpoint host".to_string());
    }
    Ok(upload)
}

#[derive(Debug, serde::Deserialize)]
struct TokenResponse {
    token: String,
    upload_url: String,
    max_bytes: usize,
}

#[derive(Debug, serde::Deserialize)]
struct UploadResponse {
    ticket_id: String,
}

async fn response_json<T: serde::de::DeserializeOwned>(
    response: reqwest::Response,
) -> Result<T, String> {
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "diagnostic service returned HTTP {}",
            status.as_u16()
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "diagnostic network request failed".to_string())?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("diagnostic response exceeded size limit".to_string());
    }
    serde_json::from_slice(&bytes).map_err(|_| "malformed diagnostic service response".to_string())
}

async fn upload_payload(
    endpoint: Url,
    bundle_submission_id: &str,
    payload: &str,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(UPLOAD_TIMEOUT_SECONDS))
        .build()
        .map_err(|_| "diagnostic network request failed".to_string())?;
    let bytes = payload.len();
    if bytes > MAX_BUNDLE_BYTES {
        return Err("bundle exceeds 4 MiB cap".to_string());
    }
    let token_response = client
        .post(endpoint.clone())
        .timeout(std::time::Duration::from_secs(
            TOKEN_REQUEST_TIMEOUT_SECONDS,
        ))
        .json(&serde_json::json!({
            "bundle_submission_id": bundle_submission_id,
            "bytes": bytes,
        }))
        .send()
        .await
        .map_err(|_| "diagnostic network request failed".to_string())?;
    let token: TokenResponse = response_json(token_response).await?;
    if token.token.is_empty() || token.upload_url.is_empty() || bytes > token.max_bytes {
        return Err("malformed or undersized diagnostic upload token".to_string());
    }
    let upload_url = validate_upload_url(&token.upload_url, &endpoint)?;
    let upload_response = client
        .post(upload_url)
        .bearer_auth(token.token)
        .header("content-type", "application/x-ndjson")
        .body(payload.to_owned())
        .send()
        .await
        .map_err(|_| "diagnostic network request failed".to_string())?;
    let response: UploadResponse = response_json(upload_response).await?;
    if !valid_identifier(&response.ticket_id) {
        return Err("malformed upload response: missing ticket_id".to_string());
    }
    Ok(response.ticket_id)
}

async fn delete_uploaded_bundle(endpoint: Url, ticket_id: &str) -> Result<(), String> {
    if !valid_identifier(ticket_id) {
        return Err("ticketId has invalid format".to_string());
    }
    let mut delete_url = endpoint;
    delete_url.set_path(&format!("/diagnostics/delete/{ticket_id}"));
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(
            TOKEN_REQUEST_TIMEOUT_SECONDS,
        ))
        .build()
        .map_err(|_| "diagnostic network request failed".to_string())?
        .post(delete_url)
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|_| "diagnostic network request failed".to_string())?;
    if response.status().is_success() {
        return Ok(());
    }
    Err(format!(
        "diagnostic service returned HTTP {}",
        response.status().as_u16()
    ))
}

async fn confirm_upload(
    app: &AppHandle,
    preview: &DiagnosticsBundlePreview,
) -> Result<bool, String> {
    let message = format!(
        "This uploads the redacted app diagnostics file you reviewed.\n\nDiagnostic ID: {}\nDiagnostic records: {}\nSize: {} KB",
        preview.bundle_submission_id,
        preview.span_count,
        (preview.bytes + 1023) / 1024
    );
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(message)
        .title("Send this file to support?")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Send".to_string(),
            "Cancel".to_string(),
        ))
        .show(move |confirmed| {
            let _ = sender.send(confirmed);
        });
    receiver
        .await
        .map_err(|_| "diagnostic confirmation dialog was closed unexpectedly".to_string())
}

#[tauri::command]
pub fn poc_diagnostics_get_status() -> DiagnosticsStatus {
    let trace_file_path = trace_path();
    DiagnosticsStatus {
        local_file_enabled: diagnostics_enabled(),
        bundle_enabled: diagnostics_bundle_enabled(),
        trace_file_path: trace_file_path.to_string_lossy().into_owned(),
        trace_family_size: family_size(&trace_file_path),
    }
}

#[tauri::command]
pub fn poc_diagnostics_collect_bundle(
    app: AppHandle,
    state: State<DiagnosticsState>,
    lookback_minutes: Option<u32>,
) -> Result<DiagnosticsBundlePreview, String> {
    let bundle = collect_diagnostic_bundle(&app, lookback_minutes.unwrap_or(30))?;
    let id = bundle.bundle_submission_id.clone();
    let payload = bundle.payload;
    let preview_dir = std::env::temp_dir().join("orca-diagnostic-bundle-previews");
    fs::create_dir_all(&preview_dir).map_err(|error| error.to_string())?;
    let preview_file_path = preview_dir.join(format!("{id}.ndjson"));
    fs::write(&preview_file_path, payload.as_bytes()).map_err(|error| error.to_string())?;
    let preview = DiagnosticsBundlePreview {
        bundle_submission_id: id.clone(),
        bytes: bundle.bytes,
        span_count: bundle.span_count,
    };
    prune_pending(&state);
    state
        .pending
        .lock()
        .map_err(|_| "diagnostics state is unavailable".to_string())?
        .insert(
            id,
            PendingBundle {
                payload,
                preview_file_path,
                created_at_ms: now_ms(),
                preview_opened: false,
            },
        );
    Ok(preview)
}

#[tauri::command]
pub async fn poc_diagnostics_open_bundle_preview(
    app: AppHandle,
    state: State<'_, DiagnosticsState>,
    bundle_submission_id: String,
) -> Result<(), String> {
    prune_pending(&state);
    let path = state
        .pending
        .lock()
        .map_err(|_| "diagnostics state is unavailable".to_string())?
        .get(&bundle_submission_id)
        .map(|bundle| bundle.preview_file_path.clone())
        .ok_or_else(|| "review file has expired; create a new one before opening".to_string())?;
    app.opener()
        .open_path(path.to_string_lossy().as_ref(), None::<&str>)
        .map_err(|error| error.to_string())?;
    if let Ok(mut pending) = state.pending.lock() {
        if let Some(bundle) = pending.get_mut(&bundle_submission_id) {
            bundle.preview_opened = true;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn poc_diagnostics_upload_bundle(
    app: AppHandle,
    state: State<'_, DiagnosticsState>,
    bundle_submission_id: String,
) -> Result<DiagnosticsUploadResult, String> {
    if !diagnostics_bundle_enabled() {
        return Err("sending diagnostics is disabled".to_string());
    }
    if !valid_identifier(&bundle_submission_id) {
        return Err("bundleSubmissionId has invalid format".to_string());
    }
    prune_pending(&state);
    let (payload, preview) = state
        .pending
        .lock()
        .map_err(|_| "diagnostics state is unavailable".to_string())?
        .get(&bundle_submission_id)
        .filter(|bundle| bundle.preview_opened)
        .map(|bundle| {
            (
                bundle.payload.clone(),
                DiagnosticsBundlePreview {
                    bundle_submission_id: bundle_submission_id.clone(),
                    bytes: bundle.payload.len(),
                    span_count: bundle.payload.lines().count().saturating_sub(1),
                },
            )
        })
        .ok_or_else(|| "open the review file before sending".to_string())?;
    if !confirm_upload(&app, &preview).await? {
        return Ok(DiagnosticsUploadResult::Canceled { canceled: true });
    }
    if !diagnostics_bundle_enabled() {
        return Err("sending diagnostics is disabled".to_string());
    }
    let endpoint = configured_token_endpoint()?;
    let result = upload_payload(endpoint, &bundle_submission_id, &payload).await?;
    if let Ok(mut pending) = state.pending.lock() {
        if let Some(bundle) = pending.remove(&bundle_submission_id) {
            let _ = fs::remove_file(bundle.preview_file_path);
        }
    }
    Ok(DiagnosticsUploadResult::Uploaded { ticket_id: result })
}

#[tauri::command]
pub async fn poc_diagnostics_delete_bundle(ticket_id: String) -> Result<(), String> {
    let endpoint = configured_token_endpoint()?;
    delete_uploaded_bundle(endpoint, &ticket_id).await
}

#[cfg(test)]
mod tests {
    use super::{valid_identifier, validate_upload_url};
    use url::Url;

    #[test]
    fn accepts_generated_style_identifiers_and_rejects_path_text() {
        assert!(valid_identifier("abcdefghijklmnop"));
        assert!(valid_identifier("abcDEF012_-abcdefghijkl"));
        assert!(!valid_identifier("short"));
        assert!(!valid_identifier("abcdefghijklmnop/../secret"));
        assert!(!valid_identifier("abcdefghijklmnop."));
    }

    #[test]
    fn pins_upload_destination_to_the_token_endpoint() {
        let endpoint = Url::parse("https://diagnostics.example.test/diagnostics/token").unwrap();
        assert!(validate_upload_url(
            "https://diagnostics.example.test/diagnostics/upload",
            &endpoint
        )
        .is_ok());
        assert!(validate_upload_url(
            "https://attacker.example.test/diagnostics/upload",
            &endpoint
        )
        .is_err());
        assert!(validate_upload_url(
            "http://diagnostics.example.test/diagnostics/upload",
            &endpoint
        )
        .is_err());
    }
}

#[tauri::command]
pub fn poc_diagnostics_discard_bundle_preview(
    state: State<DiagnosticsState>,
    bundle_submission_id: String,
) -> Result<(), String> {
    let bundle = state
        .pending
        .lock()
        .map_err(|_| "diagnostics state is unavailable".to_string())?
        .remove(&bundle_submission_id);
    if let Some(bundle) = bundle {
        let _ = fs::remove_file(bundle.preview_file_path);
    }
    Ok(())
}
