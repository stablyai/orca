use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::webview::{
    DownloadEvent, NewWindowResponse, PageLoadEvent, PermissionResponse, WebviewBuilder,
};
use tauri::{AppHandle, Emitter, Manager, State, Url, WebviewUrl};

use crate::browser_cdp_events::{drop_cdp_subscriptions_for_page, BrowserCdpEventState};
use crate::browser_identity::{browser_user_agent, BrowserIdentityState};
use crate::doc_preview::{
    grant_id_for_page, guest_script, handle_preview_navigation, notice_preview_download_blocked,
    preview_navigable_url, revoke_grants_for_page, DocPreviewState,
};

const EVENT_BROWSER_PAGE: &str = "browser:page-event";
const EVENT_GUEST_SHORTCUT: &str = "browser:guest-shortcut";
const EVENT_GUEST_CTRL_TAB_COMMIT: &str = "browser:guest-ctrl-tab-commit";
const EVENT_GUEST_WHEEL_ZOOM: &str = "browser:guest-wheel-zoom";
const EVENT_BROWSER_HANDLED_SHORTCUTS: &str = "browser:handled-shortcuts";
const GUEST_SHORTCUT_MESSAGE_TAG: &str = "orca-guest-shortcut";
const EVENT_CERTIFICATE_FAILURE: &str = "browser:certificate-failure-changed";
const CERTIFICATE_CHALLENGE_TTL_MS: u64 = 5 * 60 * 1000;
const MAX_PENDING_CERTIFICATE_CHALLENGES: usize = 32;
const MAX_CERTIFICATE_GRANTS: usize = 32;

#[derive(Debug, Clone, Copy)]
struct AgentInputMark {
    depth: u32,
    last_end: Option<Instant>,
}

#[derive(Default)]
pub struct BrowserWebviewState {
    labels: Mutex<HashMap<String, String>>,
    agent_input: Mutex<HashMap<String, AgentInputMark>>,
    downloads: Mutex<HashMap<String, Vec<BrowserDownload>>>,
    annotation_bridges: Mutex<HashMap<String, AnnotationBridgeConfig>>,
    viewport_operations:
        tauri::async_runtime::Mutex<HashMap<String, Arc<tauri::async_runtime::Mutex<()>>>>,
    certificate_challenges: Mutex<HashMap<String, PendingCertificateChallenge>>,
    accepted_certificates: Mutex<HashMap<String, AcceptedCertificateIdentity>>,
    /// Attachment URLs whose response arrived but native DownloadStarting never fired for (Windows host gap).
    pending_attachment_downloads: Mutex<HashMap<String, PendingAttachmentDownload>>,
    navigation_epochs: Mutex<HashMap<String, u64>>,
    navigation_in_flight: Mutex<HashMap<String, String>>,
    active_grab_ops: Mutex<HashMap<String, String>>,
    /// Most recently DOM-focused child webview (the guest posts `focus`/`blur`
    /// over the shortcut bridge; the last `focus` wins). Drives the host-side
    /// Edit > Copy/SelectAll/Paste target so a guest menu action lands on the
    /// focused page instead of bouncing off the unfocused main window.
    last_dom_focused: Mutex<Option<String>>,
    next_download_id: AtomicU64,
    next_certificate_id: AtomicU64,
    handled_shortcuts: Mutex<HashSet<String>>,
}

impl BrowserWebviewState {
    fn next_download_id(&self) -> u64 {
        self.next_download_id.fetch_add(1, Ordering::Relaxed) + 1
    }

    fn next_certificate_id(&self) -> u64 {
        self.next_certificate_id.fetch_add(1, Ordering::Relaxed) + 1
    }
}

#[derive(Debug, Clone)]
struct BrowserDownload {
    download_id: String,
    browser_page_id: String,
    save_path: PathBuf,
    canceled: bool,
    total_bytes: Option<u64>,
    mime_type: Option<String>,
}

#[derive(Debug, Clone)]
struct AnnotationBridgeConfig {
    token: String,
    script: String,
}

#[derive(Debug, Clone)]
struct PendingCertificateChallenge {
    challenge_id: String,
    browser_page_id: String,
    navigation_url: String,
    secure_endpoint: String,
    leaf_certificate_sha256: String,
    error: String,
    error_code: i32,
    origin: String,
    display_host: String,
    observed_at: u64,
    expires_at: u64,
    navigation_epoch: u64,
}

#[derive(Debug, Clone)]
struct AcceptedCertificateIdentity {
    secure_endpoint: String,
    leaf_certificate_sha256: String,
    error: String,
    accepted_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserCertificateFailure {
    challenge_id: String,
    browser_page_id: String,
    error_code: Option<i32>,
    error: String,
    origin: String,
    display_host: String,
    can_proceed: bool,
    observed_at: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCertificateProceedArgs {
    pub browser_page_id: String,
    pub challenge_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(untagged)]
pub enum BrowserCertificateProceedResult {
    Ok { ok: bool },
    Failed { ok: bool, reason: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPageEvent {
    pub browser_page_id: String,
    pub event_type: String,
    pub url: Option<String>,
    pub title: Option<String>,
    pub error_code: Option<i32>,
    pub error_description: Option<String>,
    pub validated_url: Option<String>,
    pub is_main_frame: Option<bool>,
    pub is_in_place: Option<bool>,
    pub permission: Option<String>,
    pub action: Option<String>,
    pub favicons: Option<Vec<String>>,
    pub reason: Option<String>,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserGuestShortcutEvent {
    browser_page_id: String,
    event_type: String,
    key: String,
    code: String,
    ctrl_key: bool,
    shift_key: bool,
    alt_key: bool,
    meta_key: bool,
    repeat: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserContextMenuRequestedEvent {
    browser_page_id: String,
    x: f64,
    y: f64,
    screen_x: f64,
    screen_y: f64,
    page_url: String,
    link_url: Option<String>,
    selection_text: String,
    can_go_back: bool,
    can_go_forward: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserDownloadRequestedEvent {
    browser_page_id: String,
    download_id: String,
    origin: String,
    filename: String,
    total_bytes: Option<u64>,
    mime_type: Option<String>,
    save_path: String,
    status: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserDownloadFinishedEvent {
    browser_page_id: String,
    download_id: String,
    status: &'static str,
    save_path: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserDownloadProgressEvent {
    browser_page_id: String,
    download_id: String,
    received_bytes: u64,
    total_bytes: Option<u64>,
    state: Option<&'static str>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPageBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPageCreateArgs {
    pub browser_page_id: String,
    pub partition: Option<String>,
    pub bounds: BrowserPageBounds,
    pub visible: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPageIdArgs {
    pub browser_page_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDownloadIdArgs {
    pub download_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPageNavigateArgs {
    pub browser_page_id: String,
    pub url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPageBoundsArgs {
    pub browser_page_id: String,
    pub bounds: BrowserPageBounds,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPageVisibilityArgs {
    pub browser_page_id: String,
    pub visible: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPageZoomArgs {
    pub browser_page_id: String,
    pub scale_factor: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPageViewportArgs {
    pub browser_page_id: String,
    #[serde(rename = "override")]
    pub override_: Option<BrowserViewportOverride>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserViewportOverride {
    pub width: f64,
    pub height: f64,
    pub device_scale_factor: f64,
    pub mobile: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserAnnotationViewportBridgeArgs {
    pub browser_page_id: String,
    pub enabled: bool,
    pub markers: Vec<serde_json::Value>,
    pub token: String,
    /// Generated by the shared renderer bridge; Rust owns page/token validation and lifecycle.
    pub script: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPageState {
    pub url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserGrabSetModeArgs {
    pub browser_page_id: String,
    pub enabled: bool,
    pub script: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserGrabAwaitArgs {
    pub browser_page_id: String,
    pub op_id: String,
    pub script: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserGrabCancelArgs {
    pub browser_page_id: String,
    pub script: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserGrabExtractArgs {
    pub browser_page_id: String,
    pub script: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserGrabScreenshotArgs {
    pub browser_page_id: String,
    pub rect: BrowserGrabRect,
    pub hide_script: String,
    pub restore_script: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserGrabRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

fn label_for_page(browser_page_id: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    browser_page_id.hash(&mut hasher);
    format!(
        "orca-browser-{browser_page_id_hash:016x}",
        browser_page_id_hash = hasher.finish()
    )
}

pub(crate) fn store_identifier(value: &str) -> [u8; 16] {
    let mut first = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut first);
    let mut second = std::collections::hash_map::DefaultHasher::new();
    format!("{value}:secondary").hash(&mut second);
    let mut identifier = [0; 16];
    identifier[..8].copy_from_slice(&first.finish().to_le_bytes());
    identifier[8..].copy_from_slice(&second.finish().to_le_bytes());
    identifier
}

fn bounded_bounds(
    bounds: &BrowserPageBounds,
) -> (tauri::LogicalPosition<f64>, tauri::LogicalSize<f64>) {
    let width = bounds.width.max(1.0).min(10000.0);
    let height = bounds.height.max(1.0).min(10000.0);
    (
        tauri::LogicalPosition::new(bounds.x, bounds.y),
        tauri::LogicalSize::new(width, height),
    )
}

fn emit_page_event(app: &AppHandle, event: BrowserPageEvent) {
    let _ = app.emit(EVENT_BROWSER_PAGE, event);
}

// Why: guest webviews run untrusted remote content, so they hold no invoke grant
// for the set; Rust pushes it on every page load instead of letting them pull it.
fn read_handled_shortcuts(state: &State<BrowserWebviewState>) -> Vec<String> {
    let mut chords: Vec<String> = state
        .handled_shortcuts
        .lock()
        .map(|stored| stored.iter().cloned().collect())
        .unwrap_or_default();
    chords.sort();
    chords
}

fn push_handled_shortcuts_to_guest(app: &AppHandle, webview: &tauri::Webview) {
    // Why: eval runs in the guest context after its init script, so the push
    // cannot race the listener registration the way a load-time emit can.
    let chords = read_handled_shortcuts(&app.state::<BrowserWebviewState>());
    if let Ok(chords_json) = serde_json::to_string(&chords) {
        let _ = webview.eval(format!(
            "window.__orcaGuestReplaceHandledChords && window.__orcaGuestReplaceHandledChords({chords_json});",
        ));
    }
}

fn emit_handled_shortcuts(app: &AppHandle) {
    let chords = read_handled_shortcuts(&app.state::<BrowserWebviewState>());
    let _ = app.emit(
        EVENT_BROWSER_HANDLED_SHORTCUTS,
        serde_json::json!({ "chords": chords }),
    );
}

fn current_url(app: &AppHandle, label: &str) -> Option<String> {
    app.get_webview(label)
        .and_then(|webview| webview.url().ok())
        .map(|url| url.to_string())
}

fn certificate_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn certificate_error_details(status: i32) -> Option<(i32, &'static str)> {
    // Chromium's certificate codes are the values consumed by the shared
    // renderer overlay. WebView2 exposes a smaller status enum, so preserve
    // the exact mapping for the statuses it can report.
    Some(match status {
        1 => (-200, "ERR_CERT_COMMON_NAME_INVALID"),
        2 => (-201, "ERR_CERT_DATE_INVALID"),
        4 => (-206, "ERR_CERT_REVOKED"),
        5 => (-202, "ERR_CERT_AUTHORITY_INVALID"),
        _ => return None,
    })
}

fn navigation_failure_details(status: i32) -> Option<(i32, &'static str)> {
    // Chromium net codes are what the shared renderer overlay renders.
    // None means the caller decides: certificate statuses (1-5) stay silent
    // here because the challenge flow reports its own did-fail-load, while
    // unmapped statuses fall back to a diagnostic that names the raw status.
    // Live observation: refused connections and unresolvable hosts both
    // surface status 0 (UNKNOWN) on this runtime, so 0 reads as refused,
    // the representative case (a down dev server).
    if (1..=5).contains(&status) || status < 0 || status > 15 {
        return None;
    }
    Some(match status {
        0 => (-102, "ERR_CONNECTION_REFUSED"),
        6 => (-109, "ERR_ADDRESS_UNREACHABLE"),
        7 => (-7, "ERR_TIMED_OUT"),
        8 => (-370, "ERR_INVALID_HTTP_RESPONSE"),
        9 => (-3, "ERR_ABORTED"),
        10 => (-101, "ERR_CONNECTION_RESET"),
        11 => (-106, "ERR_INTERNET_DISCONNECTED"),
        12 => (-102, "ERR_CONNECTION_REFUSED"),
        13 => (-105, "ERR_NAME_NOT_RESOLVED"),
        14 => (-3, "ERR_ABORTED"),
        15 => (-310, "ERR_TOO_MANY_REDIRECTS"),
        _ => return None,
    })
}

fn is_eligible_certificate_host(host: &str) -> bool {
    // Why matched brackets only: Electron strips one [...] pair, so a stray
    // bracket stays invalid instead of becoming localhost.
    let trimmed = host.trim();
    let unbracketed = if trimmed.starts_with('[') && trimmed.ends_with(']') {
        &trimmed[1..trimmed.len() - 1]
    } else {
        trimmed
    };
    let normalized = unbracketed.trim_end_matches('.').to_ascii_lowercase();
    if normalized == "localhost" || normalized.ends_with(".localhost") || normalized == "::1" {
        return true;
    }
    let Ok(address) = normalized.parse::<std::net::Ipv4Addr>() else {
        return false;
    };
    address.octets()[0] == 127
}

fn certificate_endpoint(url: &Url) -> Option<String> {
    if url.scheme() != "https" && url.scheme() != "wss" {
        return None;
    }
    let scheme = url.scheme();
    let host = url
        .host_str()?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if host.contains(':') {
        Some(format!(
            "{scheme}://[{host}]:{}",
            url.port_or_known_default().unwrap_or(443)
        ))
    } else {
        Some(format!(
            "{scheme}://{host}:{}",
            url.port_or_known_default().unwrap_or(443)
        ))
    }
}

fn certificate_origin(url: &Url) -> String {
    url.origin().ascii_serialization()
}

fn certificate_display_host(url: &Url) -> String {
    match url.port() {
        Some(port) => format!("{}:{port}", url.host_str().unwrap_or_default()),
        None => url.host_str().unwrap_or_default().to_string(),
    }
}

fn certificate_leaf_sha256(pem: &str) -> Option<String> {
    let body = pem
        .split_once("-----BEGIN CERTIFICATE-----")?
        .1
        .split_once("-----END CERTIFICATE-----")?
        .0;
    let der = BASE64
        .decode(body.split_whitespace().collect::<String>())
        .ok()?;
    if der.is_empty() {
        return None;
    }
    let digest = Sha256::digest(der);
    Some(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn clear_certificate_failure(app: &AppHandle, state: &BrowserWebviewState, page_id: &str) {
    let removed = state
        .certificate_challenges
        .lock()
        .ok()
        .and_then(|mut challenges| challenges.remove(page_id));
    if removed.is_some() {
        let _ = app.emit(
            EVENT_CERTIFICATE_FAILURE,
            serde_json::json!({ "browserPageId": page_id, "failure": null }),
        );
    }
}

fn reset_certificate_page(app: &AppHandle, state: &BrowserWebviewState, page_id: &str) {
    clear_certificate_failure(app, state, page_id);
    if let Ok(mut accepted) = state.accepted_certificates.lock() {
        let prefix = format!("{page_id}\n");
        accepted.retain(|key, _| !key.starts_with(&prefix));
    }
    if let Ok(mut epochs) = state.navigation_epochs.lock() {
        epochs.remove(page_id);
    }
}

fn oldest_certificate_challenge_page(
    challenges: &HashMap<String, PendingCertificateChallenge>,
) -> Option<String> {
    challenges
        .iter()
        .min_by_key(|(_, challenge)| challenge.observed_at)
        .map(|(page_id, _)| page_id.clone())
}

fn oldest_certificate_grant_key(
    accepted: &HashMap<String, AcceptedCertificateIdentity>,
) -> Option<String> {
    accepted
        .iter()
        .min_by_key(|(_, identity)| identity.accepted_at)
        .map(|(key, _)| key.clone())
}

fn prune_expired_certificate_challenges(app: &AppHandle, state: &BrowserWebviewState) {
    let now = certificate_now_ms();
    let expired: Vec<String> = state
        .certificate_challenges
        .lock()
        .map(|challenges| {
            challenges
                .iter()
                .filter(|(_, challenge)| challenge.expires_at <= now)
                .map(|(page_id, _)| page_id.clone())
                .collect()
        })
        .unwrap_or_default();
    for page_id in expired {
        clear_certificate_failure(app, state, &page_id);
    }
}

fn enforce_certificate_challenge_bound(app: &AppHandle, state: &BrowserWebviewState) {
    loop {
        let oldest = state
            .certificate_challenges
            .lock()
            .ok()
            .and_then(|challenges| {
                if challenges.len() <= MAX_PENDING_CERTIFICATE_CHALLENGES {
                    return None;
                }
                oldest_certificate_challenge_page(&challenges)
            });
        let Some(page_id) = oldest else {
            return;
        };
        clear_certificate_failure(app, state, &page_id);
    }
}

fn enforce_certificate_grant_bound(accepted: &mut HashMap<String, AcceptedCertificateIdentity>) {
    while accepted.len() > MAX_CERTIFICATE_GRANTS {
        let Some(oldest) = oldest_certificate_grant_key(accepted) else {
            return;
        };
        accepted.remove(&oldest);
    }
}

fn begin_browser_navigation(
    app: &AppHandle,
    state: &BrowserWebviewState,
    page_id: &str,
    url: &str,
) {
    if let Ok(mut epochs) = state.navigation_epochs.lock() {
        let next = epochs.get(page_id).copied().unwrap_or(0).saturating_add(1);
        epochs.insert(page_id.to_string(), next);
    }
    // Why in-flight: NavigationCompleted carries no URL, so the last main-frame
    // target names the failure. Completions without one are subframe noise.
    if let Ok(mut in_flight) = state.navigation_in_flight.lock() {
        in_flight.insert(page_id.to_string(), url.to_string());
    }
    clear_certificate_failure(app, state, page_id);
}

fn certificate_identity_matches(
    accepted: &AcceptedCertificateIdentity,
    endpoint: &str,
    leaf_sha256: &str,
    error: &str,
) -> bool {
    accepted.secure_endpoint == endpoint
        && accepted.leaf_certificate_sha256 == leaf_sha256
        && accepted.error == error
}

fn accepted_certificate_key(page_id: &str, endpoint: &str) -> String {
    format!("{page_id}\n{endpoint}")
}

fn emit_certificate_load_failure(
    app: &AppHandle,
    page_id: &str,
    url: &str,
    error_code: i32,
    error: &str,
) {
    emit_page_event(
        app,
        BrowserPageEvent {
            browser_page_id: page_id.to_string(),
            event_type: "did-fail-load".to_string(),
            url: Some(url.to_string()),
            title: None,
            error_code: Some(error_code),
            error_description: Some(error.to_string()),
            validated_url: Some(url.to_string()),
            is_main_frame: Some(true),
            is_in_place: Some(false),
            permission: None,
            action: None,
            favicons: None,
            reason: None,
            exit_code: None,
        },
    );
}

fn record_certificate_failure(
    app: &AppHandle,
    state: &BrowserWebviewState,
    page_id: &str,
    request_url: String,
    error_code: i32,
    error: &'static str,
    leaf_sha256: String,
) {
    let Ok(url) = Url::parse(&request_url) else {
        return;
    };
    emit_certificate_load_failure(app, page_id, &request_url, error_code, error);
    if let Ok(mut in_flight) = state.navigation_in_flight.lock() {
        in_flight.remove(page_id);
    }
    let Some(endpoint) = certificate_endpoint(&url) else {
        return;
    };
    let Some(host) = url.host_str() else {
        return;
    };
    if error_code != -202 || url.scheme() != "https" || !is_eligible_certificate_host(host) {
        return;
    }
    // Why fail closed on a second leaf: Chromium caches the TLS verdict per
    // endpoint, so a conflicting identity can never proceed anyway.
    let grant_key = accepted_certificate_key(page_id, &endpoint);
    if let Ok(accepted) = state.accepted_certificates.lock() {
        if let Some(existing) = accepted.get(&grant_key) {
            if !certificate_identity_matches(existing, &endpoint, &leaf_sha256, error) {
                return;
            }
        }
    }
    let observed_at = certificate_now_ms();
    let navigation_epoch = state
        .navigation_epochs
        .lock()
        .ok()
        .and_then(|epochs| epochs.get(page_id).copied())
        .unwrap_or(0);
    let challenge = PendingCertificateChallenge {
        challenge_id: format!("tauri-certificate-{}", state.next_certificate_id()),
        browser_page_id: page_id.to_string(),
        navigation_url: request_url,
        secure_endpoint: endpoint,
        leaf_certificate_sha256: leaf_sha256,
        error: error.to_string(),
        error_code,
        origin: certificate_origin(&url),
        display_host: certificate_display_host(&url),
        observed_at,
        expires_at: observed_at.saturating_add(CERTIFICATE_CHALLENGE_TTL_MS),
        navigation_epoch,
    };
    let failure = BrowserCertificateFailure {
        challenge_id: challenge.challenge_id.clone(),
        browser_page_id: challenge.browser_page_id.clone(),
        error_code: Some(challenge.error_code),
        error: challenge.error.clone(),
        origin: challenge.origin.clone(),
        display_host: challenge.display_host.clone(),
        can_proceed: true,
        observed_at: challenge.observed_at,
    };
    if let Ok(mut challenges) = state.certificate_challenges.lock() {
        if let Some(previous) = challenges.get(page_id) {
            if previous.secure_endpoint == challenge.secure_endpoint
                && previous.leaf_certificate_sha256 == challenge.leaf_certificate_sha256
                && previous.error == challenge.error
                && previous.navigation_epoch == challenge.navigation_epoch
            {
                return;
            }
        }
        challenges.insert(page_id.to_string(), challenge);
    } else {
        return;
    }
    prune_expired_certificate_challenges(app, state);
    enforce_certificate_challenge_bound(app, state);
    let _ = app.emit(
        EVENT_CERTIFICATE_FAILURE,
        serde_json::json!({ "browserPageId": page_id, "failure": failure }),
    );
}

// Why: a focused browser guest is its own document whose key events never
// reach the main window; forward shortcut-grade chords so global keybindings
// keep working while a browser page has focus. Best effort and v1-scoped:
// plain typing never crosses the bridge, and the guest suppresses its own
// default handling only for chords the host publishes as handled.
#[cfg(windows)]
fn install_guest_shortcut_forwarding(
    webview: &tauri::Webview<tauri::Wry>,
    app: &AppHandle,
    page_id: &str,
) -> Result<(), String> {
    use webview2_com::{take_pwstr, WebMessageReceivedEventHandler};
    use windows_core::PWSTR;

    let app = app.clone();
    let page_id = page_id.to_string();
    let (sender, receiver) = std::sync::mpsc::channel();
    webview
        .with_webview(move |platform| {
            let result = (|| -> Result<(), String> {
                let controller = platform.controller();
                let core =
                    unsafe { controller.CoreWebView2() }.map_err(|error| error.to_string())?;
                let app_for_event = app.clone();
                let page_id_for_event = page_id.clone();
                let handler = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else {
                        return Ok(());
                    };
                    // Why string coercion first: object posts (devtools, other
                    // bridges) and Tauri IPC traffic are never ours.
                    let mut raw = PWSTR::null();
                    if unsafe { args.TryGetWebMessageAsString(&mut raw) }.is_err() {
                        return Ok(());
                    }
                    let message = take_pwstr(raw);
                    let parsed: serde_json::Value =
                        serde_json::from_str(&message).unwrap_or(serde_json::Value::Null);
                    if parsed.get("tag").and_then(|tag| tag.as_str())
                        != Some(GUEST_SHORTCUT_MESSAGE_TAG)
                    {
                        return Ok(());
                    }
                    let event_kind = parsed
                        .get("type")
                        .and_then(|kind| kind.as_str())
                        .unwrap_or("");
                    if event_kind == "ctrl-tab-commit" {
                        let _ = app_for_event.emit(
                            EVENT_GUEST_CTRL_TAB_COMMIT,
                            serde_json::json!({ "browserPageId": page_id_for_event.clone() }),
                        );
                        return Ok(());
                    }
                    if event_kind == "focus" || event_kind == "blur" {
                        if let Ok(mut slot) = app_for_event
                            .state::<BrowserWebviewState>()
                            .last_dom_focused
                            .lock()
                        {
                            *slot = if event_kind == "focus" {
                                Some(page_id_for_event.clone())
                            } else if slot.as_deref() == Some(page_id_for_event.as_str()) {
                                None
                            } else {
                                // A stale blur must not erase a newer page's focus.
                                slot.clone()
                            };
                        }
                        return Ok(());
                    }
                    if event_kind == "wheel-zoom" {
                        let direction = parsed
                            .get("direction")
                            .and_then(|direction| direction.as_str())
                            .unwrap_or("");
                        if direction != "in" && direction != "out" {
                            return Ok(());
                        }
                        let _ = app_for_event.emit(
                            EVENT_GUEST_WHEEL_ZOOM,
                            serde_json::json!({
                                "browserPageId": page_id_for_event.clone(),
                                "direction": direction,
                            }),
                        );
                        return Ok(());
                    }
                    if event_kind != "keydown" && event_kind != "keyup" {
                        return Ok(());
                    }
                    let string_field = |name: &str| {
                        parsed
                            .get(name)
                            .and_then(|value| value.as_str())
                            .unwrap_or("")
                            .to_string()
                    };
                    let bool_field = |name: &str| {
                        parsed
                            .get(name)
                            .and_then(|value| value.as_bool())
                            .unwrap_or(false)
                    };
                    // Why: agent-injected keys must not run Orca shortcuts or grab
                    // actions; the page keeps them, the app never sees them.
                    if is_agent_injected_input(
                        &app_for_event.state::<BrowserWebviewState>(),
                        &page_id_for_event,
                    ) {
                        return Ok(());
                    }
                    let _ = app_for_event.emit(
                        EVENT_GUEST_SHORTCUT,
                        BrowserGuestShortcutEvent {
                            browser_page_id: page_id_for_event.clone(),
                            event_type: event_kind.to_string(),
                            key: string_field("key"),
                            code: string_field("code"),
                            ctrl_key: bool_field("ctrlKey"),
                            shift_key: bool_field("shiftKey"),
                            alt_key: bool_field("altKey"),
                            meta_key: bool_field("metaKey"),
                            repeat: bool_field("repeat"),
                        },
                    );
                    Ok(())
                }));
                let mut token = 0_i64;
                unsafe {
                    core.add_WebMessageReceived(&handler, &mut token)
                        .map_err(|error| error.to_string())?;
                }
                Ok(())
            })();
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "Timed out installing the WebView2 guest-shortcut handler.".to_string())?
}

#[cfg(not(windows))]
fn install_guest_shortcut_forwarding(
    _webview: &tauri::Webview<tauri::Wry>,
    _app: &AppHandle,
    _page_id: &str,
) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
fn install_certificate_handler(
    webview: &tauri::Webview<tauri::Wry>,
    app: &AppHandle,
    page_id: &str,
) -> Result<(), String> {
    use webview2_com::{
        take_pwstr, Microsoft::Web::WebView2::Win32::*, ServerCertificateErrorDetectedEventHandler,
    };
    use windows_core::{Interface, PWSTR};

    let app = app.clone();
    let page_id = page_id.to_string();
    let (sender, receiver) = std::sync::mpsc::channel();
    webview
        .with_webview(move |platform| {
            let result = (|| -> Result<(), String> {
                let controller = platform.controller();
                let core =
                    unsafe { controller.CoreWebView2() }.map_err(|error| error.to_string())?;
                let core14 = core
                    .cast::<ICoreWebView2_14>()
                    .map_err(|error| error.to_string())?;
                let app_for_event = app.clone();
                let page_id_for_event = page_id.clone();
                let handler = ServerCertificateErrorDetectedEventHandler::create(Box::new(
                    move |_webview, args| {
                        let Some(args) = args else {
                            return Ok(());
                        };
                        let mut status = COREWEBVIEW2_WEB_ERROR_STATUS::default();
                        unsafe { args.ErrorStatus(&mut status)? };
                        let Some((error_code, error)) = certificate_error_details(status.0) else {
                            unsafe {
                                args.SetAction(
                                    COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_CANCEL,
                                )?;
                            }
                            return Ok(());
                        };
                        let mut request_uri = PWSTR::null();
                        unsafe { args.RequestUri(&mut request_uri)? };
                        let request_url = take_pwstr(request_uri);
                        let certificate = unsafe { args.ServerCertificate()? };
                        let mut pem = PWSTR::null();
                        unsafe { certificate.ToPemEncoding(&mut pem)? };
                        let pem = take_pwstr(pem);
                        let Some(leaf_sha256) = certificate_leaf_sha256(&pem) else {
                            unsafe {
                                args.SetAction(
                                    COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_CANCEL,
                                )?;
                            }
                            return Ok(());
                        };
                        let Some(url) = Url::parse(&request_url).ok() else {
                            unsafe {
                                args.SetAction(
                                    COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_CANCEL,
                                )?;
                            }
                            return Ok(());
                        };
                        let Some(endpoint) = certificate_endpoint(&url) else {
                            unsafe {
                                args.SetAction(
                                    COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_CANCEL,
                                )?;
                            }
                            return Ok(());
                        };
                        let accepted = app_for_event
                            .state::<BrowserWebviewState>()
                            .accepted_certificates
                            .lock()
                            .ok()
                            .and_then(|accepted| {
                                accepted
                                    .get(&accepted_certificate_key(&page_id_for_event, &endpoint))
                                    .cloned()
                            });
                        if accepted.as_ref().is_some_and(|accepted| {
                            certificate_identity_matches(accepted, &endpoint, &leaf_sha256, error)
                        }) {
                            unsafe {
                                args.SetAction(
                                    COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_ALWAYS_ALLOW,
                                )?;
                            }
                            return Ok(());
                        }
                        unsafe {
                            args.SetAction(COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_CANCEL)?;
                        }
                        record_certificate_failure(
                            &app_for_event,
                            &app_for_event.state::<BrowserWebviewState>(),
                            &page_id_for_event,
                            request_url,
                            error_code,
                            error,
                            leaf_sha256,
                        );
                        Ok(())
                    },
                ));
                let mut token = 0_i64;
                unsafe {
                    core14
                        .add_ServerCertificateErrorDetected(&handler, &mut token)
                        .map_err(|error| error.to_string())?;
                }
                Ok(())
            })();
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "Timed out installing the WebView2 certificate handler.".to_string())?
}
// Why remembered bypasses: WebView2 remembers an ALWAYS_ALLOW bypass at
// profile scope, so a later page would load the same endpoint with no
// challenge. Electron restores the narrower per-page boundary with its
// request guard; clear the remembered bypasses whenever a page is
// (re)created or closed so only the page the user approved keeps loading
// silently through the accepted-identity map.
#[cfg(windows)]
fn clear_remembered_certificate_bypasses(
    webview: &tauri::Webview<tauri::Wry>,
) -> Result<(), String> {
    use webview2_com::{
        ClearServerCertificateErrorActionsCompletedHandler, Microsoft::Web::WebView2::Win32::*,
    };
    use windows_core::Interface;
    let (sender, receiver) = std::sync::mpsc::channel::<Option<String>>();
    webview
        .with_webview(move |platform| {
            let result = (|| -> Result<(), String> {
                let controller = platform.controller();
                let core =
                    unsafe { controller.CoreWebView2() }.map_err(|error| error.to_string())?;
                let core14 = core
                    .cast::<ICoreWebView2_14>()
                    .map_err(|error| error.to_string())?;
                let completed = sender.clone();
                let handler = ClearServerCertificateErrorActionsCompletedHandler::create(Box::new(
                    move |_error_code| {
                        let _ = completed.send(None);
                        Ok(())
                    },
                ));
                unsafe { core14.ClearServerCertificateErrorActions(&handler) }
                    .map_err(|error| error.to_string())?;
                Ok(())
            })();
            if let Err(error) = result {
                let _ = sender.send(Some(error));
            }
        })
        .map_err(|error| error.to_string())?;
    match receiver.recv_timeout(Duration::from_secs(5)) {
        Ok(None) => Ok(()),
        Ok(Some(error)) => Err(error),
        Err(_) => Err("Timed out clearing remembered WebView2 certificate bypasses.".to_string()),
    }
}

// Why COM hooks: Tauri's WebviewBuilder exposes navigation start, load and
// title, but not redirects, same-document commits, favicon changes or render
// crashes, so tap the underlying WebView2 events the same way the CDP event
// tap does. Installed hooks die with their webview, matching Electron's
// per-guest listeners, and a hook the runtime rejects never fails creation.
#[cfg(windows)]
fn install_lifecycle_hooks(webview: &tauri::Webview<tauri::Wry>, app: &AppHandle, page_id: &str) {
    use webview2_com::{
        take_pwstr, FaviconChangedEventHandler, Microsoft::Web::WebView2::Win32::*,
        NavigationCompletedEventHandler, NavigationStartingEventHandler, ProcessFailedEventHandler,
        SourceChangedEventHandler, WebMessageReceivedEventHandler,
        WebResourceResponseReceivedEventHandler,
    };
    use windows_core::{Interface, BOOL, HSTRING, PCWSTR, PWSTR};

    fn base_event(page_id: &str, event_type: &str) -> BrowserPageEvent {
        BrowserPageEvent {
            browser_page_id: page_id.to_string(),
            event_type: event_type.to_string(),
            url: None,
            title: None,
            error_code: None,
            error_description: None,
            validated_url: None,
            is_main_frame: Some(true),
            is_in_place: Some(false),
            permission: None,
            action: None,
            favicons: None,
            reason: None,
            exit_code: None,
        }
    }

    let app = app.clone();
    let page_id = page_id.to_string();
    let _ = webview.with_webview(move |platform| {
        let result = (|| -> Result<(), String> {
            let controller = platform.controller();
            let core = unsafe { controller.CoreWebView2() }.map_err(|error| error.to_string())?;
            // Redirects announce before commit so the pane can drop a stale favicon.
            let app_for_redirect = app.clone();
            let page_id_for_redirect = page_id.clone();
            let redirect_handler =
                NavigationStartingEventHandler::create(Box::new(move |_sender, args| {
                    let Some(args) = args else {
                        return Ok(());
                    };
                    let mut redirected = BOOL::from(false);
                    unsafe { args.IsRedirected(&mut redirected)? };
                    if !redirected.as_bool() {
                        return Ok(());
                    }
                    let mut raw = PWSTR::null();
                    unsafe { args.Uri(&mut raw)? };
                    let mut event = base_event(&page_id_for_redirect, "did-redirect-navigation");
                    event.url = Some(take_pwstr(raw));
                    emit_page_event(&app_for_redirect, event);
                    Ok(())
                }));
            let mut token = 0_i64;
            unsafe {
                core.add_NavigationStarting(&redirect_handler, &mut token)
                    .map_err(|error| error.to_string())?;
            }
            // Same-document commits never reach on_navigation, so SourceChanged
            // is the in-page signal, matching Electron's did-navigate-in-page.
            let app_for_in_page = app.clone();
            let page_id_for_in_page = page_id.clone();
            let in_page_handler =
                SourceChangedEventHandler::create(Box::new(move |sender, args| {
                    let Some(args) = args else {
                        return Ok(());
                    };
                    let mut is_new = BOOL::from(true);
                    unsafe { args.IsNewDocument(&mut is_new)? };
                    if is_new.as_bool() {
                        return Ok(());
                    }
                    // SourceChanged carries no URL, so read the committed source.
                    let mut url = None;
                    if let Some(sender) = sender.as_ref() {
                        let mut raw = PWSTR::null();
                        if unsafe { sender.Source(&mut raw) }.is_ok() {
                            url = Some(take_pwstr(raw));
                        }
                    }
                    let mut event = base_event(&page_id_for_in_page, "did-navigate-in-page");
                    event.url = url;
                    event.is_in_place = Some(true);
                    emit_page_event(&app_for_in_page, event);
                    Ok(())
                }));
            unsafe {
                core.add_SourceChanged(&in_page_handler, &mut token)
                    .map_err(|error| error.to_string())?;
            }
            // Only renderer exits map to render-process-gone: a dead GPU or
            // utility process leaves the page alive, and a dead browser process
            // takes the app with it, so neither should trigger guest recovery.
            let app_for_crash = app.clone();
            let page_id_for_crash = page_id.clone();
            let crash_handler =
                ProcessFailedEventHandler::create(Box::new(move |_sender, args| {
                    let Some(args) = args else {
                        return Ok(());
                    };
                    let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND(0);
                    unsafe { args.ProcessFailedKind(&mut kind)? };
                    let renderer_gone = kind
                        == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
                        || kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE
                        || kind == COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED;
                    if !renderer_gone {
                        return Ok(());
                    }
                    // Reason and exit code need Args2; older runtimes still report
                    // the kind, so missing detail maps to crashed below.
                    let mut reason = COREWEBVIEW2_PROCESS_FAILED_REASON_CRASHED;
                    let mut exit_code = 0_i32;
                    if let Ok(args2) = args.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
                        unsafe { args2.Reason(&mut reason)? };
                        unsafe { args2.ExitCode(&mut exit_code)? };
                    }
                    let mut event = base_event(&page_id_for_crash, "render-process-gone");
                    event.reason = Some(
                        if reason == COREWEBVIEW2_PROCESS_FAILED_REASON_OUT_OF_MEMORY {
                            "oom"
                        } else if reason == COREWEBVIEW2_PROCESS_FAILED_REASON_TERMINATED {
                            "killed"
                        } else if reason == COREWEBVIEW2_PROCESS_FAILED_REASON_LAUNCH_FAILED {
                            "launch-failed"
                        } else if reason == COREWEBVIEW2_PROCESS_FAILED_REASON_CRASHED {
                            "crashed"
                        } else {
                            "abnormal-exit"
                        }
                        .to_string(),
                    );
                    event.exit_code = Some(exit_code);
                    let report_reason =
                        event.reason.clone().unwrap_or_else(|| "crashed".to_string());
                    let report_exit = event.exit_code;
                    let app_for_report = app_for_crash.clone();
                    let page_id_for_report = page_id_for_crash.clone();
                    emit_page_event(&app_for_crash, event);
                    // The dead renderer cannot report itself: record from Rust
                    // on a worker thread so dump pairing never runs on the
                    // COM callback.
                    std::thread::spawn(move || {
                        crate::crash_reports::record_guest_renderer_crash(
                            &app_for_report,
                            &page_id_for_report,
                            &report_reason,
                            report_exit,
                        );
                    });
                    Ok(())
                }));
            unsafe {
                core.add_ProcessFailed(&crash_handler, &mut token)
                    .map_err(|error| error.to_string())?;
            }
            // Failed loads never reach PageLoad Finished with an error, so
            // NavigationCompleted is the did-fail-load signal. Success consumes
            // the in-flight URL; without one the completion is subframe noise.
            let app_for_failed = app.clone();
            let page_id_for_failed = page_id.clone();
            let failed_handler =
                NavigationCompletedEventHandler::create(Box::new(move |_sender, args| {
                    let Some(args) = args else {
                        return Ok(());
                    };
                    let mut success = BOOL::from(false);
                    unsafe { args.IsSuccess(&mut success)? };
                    let state = app_for_failed.state::<BrowserWebviewState>();
                    let url = state
                        .navigation_in_flight
                        .lock()
                        .ok()
                        .and_then(|mut in_flight| in_flight.remove(&page_id_for_failed));
                    if success.as_bool() {
                        return Ok(());
                    }
                    let Some(url) = url else {
                        return Ok(());
                    };
                    let mut status = COREWEBVIEW2_WEB_ERROR_STATUS::default();
                    unsafe { args.WebErrorStatus(&mut status)? };
                    // Why dynamic fallback: an unmapped WebView2 status still names
                    // the failed navigation, and the raw status tells us which arm to add.
                    let (error_code, error_description) = match navigation_failure_details(status.0)
                    {
                        Some((code, description)) => (code, description.to_string()),
                        None if (1..=5).contains(&status.0) => return Ok(()),
                        None => (-2, format!("ERR_FAILED (WebView2 status {})", status.0)),
                    };
                    // Attachment fallback: a main-frame abort after an
                    // attachment response means DownloadStarting stayed
                    // silent, so fetch the bytes in-page instead of losing
                    // the download. Native wins when it fires (checked inside).
                    if error_code == -3 {
                        start_attachment_fallback(&app_for_failed, &page_id_for_failed, &url);
                    }
                    let mut event = base_event(&page_id_for_failed, "did-fail-load");
                    event.url = Some(url.clone());
                    event.error_code = Some(error_code);
                    event.error_description = Some(error_description);
                    event.validated_url = Some(url);
                    emit_page_event(&app_for_failed, event);
                    Ok(())
                }));
            unsafe {
                core.add_NavigationCompleted(&failed_handler, &mut token)
                    .map_err(|error| error.to_string())?;
            }
            // Attachment fallback signal: record main-frame responses that
            // declare a download. When DownloadStarting stays silent the
            // navigation still fails with ERR_ABORTED, and the fail arm below
            // consumes this entry to fetch the bytes in-page instead.
            let app_for_attachment = app.clone();
            let page_id_for_attachment = page_id.clone();
            let attachment_handler =
                WebResourceResponseReceivedEventHandler::create(Box::new(move |_sender, args| {
                    let Some(args) = args else {
                        return Ok(());
                    };
                    let request_uri = (|| {
                        let request = unsafe { args.Request()? };
                        let mut raw = PWSTR::null();
                        unsafe { request.Uri(&mut raw)? };
                        Ok::<_, windows_core::Error>(take_pwstr(raw))
                    })();
                    let disposition = (|| {
                        let response = unsafe { args.Response()? };
                        let headers = unsafe { response.Headers()? };
                        let name = HSTRING::from("Content-Disposition");
                        let mut raw = PWSTR::null();
                        unsafe { headers.GetHeader(PCWSTR::from_raw(name.as_ptr()), &mut raw)? };
                        Ok::<_, windows_core::Error>(take_pwstr(raw))
                    })();
                    let (Ok(request_uri), Ok(disposition)) = (request_uri, disposition) else {
                        return Ok(());
                    };
                    let header = |name_str: &str| -> Option<String> {
                        let response = unsafe { args.Response().ok()? };
                        let headers = unsafe { response.Headers().ok()? };
                        let name = HSTRING::from(name_str);
                        let mut raw = PWSTR::null();
                        unsafe {
                            headers
                                .GetHeader(PCWSTR::from_raw(name.as_ptr()), &mut raw)
                                .ok()?
                        };
                        Some(take_pwstr(raw))
                    };
                    let total_bytes =
                        header("Content-Length").and_then(|value| value.trim().parse::<u64>().ok());
                    let mime_type = header("Content-Type")
                        .map(|value| {
                            value
                                .split(";")
                                .next()
                                .unwrap_or(value.as_str())
                                .trim()
                                .to_string()
                        })
                        .filter(|value| !value.is_empty());
                    if !disposition.to_ascii_lowercase().contains("attachment") {
                        return Ok(());
                    }
                    let state = app_for_attachment.state::<BrowserWebviewState>();
                    let is_main_frame = state
                        .navigation_in_flight
                        .lock()
                        .map(|in_flight| {
                            in_flight
                                .get(&page_id_for_attachment)
                                .is_some_and(|url| *url == request_uri)
                        })
                        .unwrap_or(false);
                    if !is_main_frame {
                        return Ok(());
                    }
                    if let Ok(mut pending) = state.pending_attachment_downloads.lock() {
                        pending.insert(
                            page_id_for_attachment.clone(),
                            PendingAttachmentDownload {
                                url: request_uri,
                                filename: disposition_filename(&disposition),
                                total_bytes,
                                mime_type,
                            },
                        );
                    }
                    Ok(())
                }));
            unsafe {
                let filter = HSTRING::from("*");
                core.AddWebResourceRequestedFilter(
                    PCWSTR::from_raw(filter.as_ptr()),
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT,
                )
                .map_err(|error| error.to_string())?;
                let core2: ICoreWebView2_2 =
                    core.cast().map_err(|error| error.to_string())?;
                core2
                    .add_WebResourceResponseReceived(&attachment_handler, &mut token)
                    .map_err(|error| error.to_string())?;
            }
            // Download blob pipe: arbitrary guest origins cannot invoke
            // Tauri commands (capability gate), so fallback chunks cross
            // over the native WebView2 message pipe instead.
            let app_for_blob = app.clone();
            let page_id_for_blob = page_id.clone();
            let blob_handler =
                WebMessageReceivedEventHandler::create(Box::new(move |_sender, args| {
                    let Some(args) = args else {
                        return Ok(());
                    };
                    let mut raw = PWSTR::null();
                    if unsafe { args.TryGetWebMessageAsString(&mut raw) }.is_err() {
                        return Ok(());
                    }
                    let parsed: serde_json::Value =
                        serde_json::from_str(&take_pwstr(raw)).unwrap_or(serde_json::Value::Null);
                    if parsed.get("tag").and_then(|tag| tag.as_str()) != Some("orca-download-blob") {
                        return Ok(());
                    }
                    let download_id = parsed
                        .get("downloadId")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    let content = parsed
                        .get("contentBase64")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    let done = parsed.get("done").and_then(|value| value.as_bool()).unwrap_or(false);
                    let error = parsed
                        .get("error")
                        .and_then(|value| value.as_str())
                        .map(str::to_string);
                    if download_id.is_empty() {
                        return Ok(());
                    }
                    let _ = ingest_fallback_chunk(
                        &app_for_blob,
                        &page_id_for_blob,
                        download_id,
                        content,
                        done,
                        error,
                    );
                    Ok(())
                }));
            unsafe {
                core.add_WebMessageReceived(&blob_handler, &mut token)
                    .map_err(|error| error.to_string())?;
            }            // FaviconChanged needs ICoreWebView2_15; older runtimes keep today's
            // behavior (no favicon event) instead of failing page creation.
            if let Ok(core15) = core.cast::<ICoreWebView2_15>() {
                let app_for_favicon = app.clone();
                let page_id_for_favicon = page_id.clone();
                let favicon_handler =
                    FaviconChangedEventHandler::create(Box::new(move |sender, _args| {
                        let mut uri = None;
                        if let Some(sender) = sender.as_ref() {
                            if let Ok(core15) = sender.cast::<ICoreWebView2_15>() {
                                let mut raw = PWSTR::null();
                                if unsafe { core15.FaviconUri(&mut raw) }.is_ok() {
                                    uri = Some(take_pwstr(raw));
                                }
                            }
                        }
                        let mut event = base_event(&page_id_for_favicon, "page-favicon-updated");
                        // Why empty and not missing: Electron reports iconless documents as an empty list.
                        event.favicons = Some(uri.into_iter().collect());
                        emit_page_event(&app_for_favicon, event);
                        Ok(())
                    }));
                let mut favicon_token = 0_i64;
                unsafe {
                    core15
                        .add_FaviconChanged(&favicon_handler, &mut favicon_token)
                        .map_err(|error| error.to_string())?;
                }
            }
            Ok(())
        })();
        let _ = result;
    });
}

#[cfg(not(windows))]
fn install_lifecycle_hooks(
    _webview: &tauri::Webview<tauri::Wry>,
    _app: &AppHandle,
    _page_id: &str,
) {
}
#[cfg(not(windows))]
fn install_certificate_handler(
    _webview: &tauri::Webview<tauri::Wry>,
    _app: &AppHandle,
    _page_id: &str,
) -> Result<(), String> {
    Ok(())
}
#[cfg(not(windows))]
fn clear_remembered_certificate_bypasses(
    _webview: &tauri::Webview<tauri::Wry>,
) -> Result<(), String> {
    Ok(())
}

fn child_label(state: &BrowserWebviewState, browser_page_id: &str) -> Result<String, String> {
    state
        .labels
        .lock()
        .map_err(|_| "browser webview state is poisoned".to_string())?
        .get(browser_page_id)
        .cloned()
        .ok_or_else(|| "browser webview does not exist".to_string())
}

fn browser_page_id_for_label(state: &BrowserWebviewState, label: &str) -> Option<String> {
    state
        .labels
        .lock()
        .ok()?
        .iter()
        .find_map(|(page_id, page_label)| (page_label == label).then(|| page_id.clone()))
}

pub(crate) fn child_webview(
    app: &AppHandle,
    state: &BrowserWebviewState,
    browser_page_id: &str,
) -> Result<tauri::Webview<tauri::Wry>, String> {
    let label = child_label(state, browser_page_id)?;
    app.get_webview(&label)
        .ok_or_else(|| "browser webview is no longer available".to_string())
}

/// The child webview the guest most recently reported as DOM-focused, if the
/// page is still alive. Used by Edit > Copy/SelectAll/Paste so a guest's menu
/// click lands on its own document instead of the unfocused main window —
/// Electron's `webContents.getFocusedWebContents()` parity.
pub(crate) fn last_focused_child_webview(
    app: &AppHandle,
    state: &BrowserWebviewState,
) -> Option<tauri::Webview<tauri::Wry>> {
    let page_id = state.last_dom_focused.lock().ok()?.clone()?;
    child_webview(app, state, &page_id).ok()
}
/// Edit commands the menu may route into a focused browser guest. Kept as an
/// allowlist so a menu id can never eval an arbitrary script in the guest.
const GUEST_EDIT_COMMANDS: [&str; 3] = ["copy", "selectAll", "paste"];

fn is_guest_edit_command(command: &str) -> bool {
    GUEST_EDIT_COMMANDS.contains(&command)
}

/// Route an Edit > Copy/SelectAll/Paste click into the most recently
/// DOM-focused guest. Returns false when no live guest holds focus so the
/// caller falls back to the renderer event.
pub(crate) fn route_guest_edit(
    app: &AppHandle,
    state: &BrowserWebviewState,
    command: &str,
) -> bool {
    if !is_guest_edit_command(command) {
        return false;
    }
    let Some(webview) = last_focused_child_webview(app, state) else {
        return false;
    };
    // execCommand is sync and idempotent; a rejected eval only loses this one
    // menu click, so we never surface the error.
    let _ = webview.eval(&format!("document.execCommand('{command}')"));
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserGuestEditArgs {
    pub command: String,
}

// Why a poc command: a real menu click needs a visible OS run, but the
// routing decision plus the guest-side execCommand are fully drivable
// headless, so the live check invokes the same shared helper the menu calls.
#[tauri::command]
pub fn poc_browser_guest_edit(
    app: AppHandle,
    state: State<BrowserWebviewState>,
    args: BrowserGuestEditArgs,
) -> Result<bool, String> {
    if !is_guest_edit_command(&args.command) {
        return Err("unknown guest edit command".to_string());
    }
    Ok(route_guest_edit(&app, &state, &args.command))
}

fn page_url(url: &Url) -> Option<String> {
    Some(redact_kagi_session_token(url.as_str()))
}

fn redact_kagi_session_token(raw_url: &str) -> String {
    let Ok(mut url) = Url::parse(raw_url) else {
        return raw_url.to_string();
    };
    let hostname = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if url.scheme() != "https"
        || (hostname != "kagi.com" && hostname != "www.kagi.com")
        || (url.path() != "/search" && url.path() != "/search/")
        || !url.query_pairs().any(|(key, _)| key == "token")
    {
        return raw_url.to_string();
    }
    let query = url
        .query_pairs()
        .filter(|(key, _)| key != "token")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    url.query_pairs_mut().clear().extend_pairs(query);
    url.to_string()
}

fn normalize_context_menu_link(raw_url: &str) -> Option<String> {
    let url = Url::parse(raw_url).ok()?;
    matches!(url.scheme(), "http" | "https" | "file")
        .then(|| redact_kagi_session_token(url.as_str()))
}

fn context_menu_value<'a>(url: &'a Url, key: &str) -> Option<String> {
    url.query_pairs()
        .find_map(|(candidate, value)| (candidate == key).then(|| value.into_owned()))
}

fn emit_context_menu_from_navigation(app: &AppHandle, browser_page_id: &str, url: &Url) -> bool {
    if url.scheme() != "orca-internal" || url.host_str() != Some("context-menu") {
        return false;
    }
    let parse_number = |key: &str| context_menu_value(url, key)?.parse::<f64>().ok();
    let page_url = context_menu_value(url, "pageUrl")
        .map(|value| redact_kagi_session_token(&value))
        .unwrap_or_default();
    let link_url =
        context_menu_value(url, "linkUrl").and_then(|value| normalize_context_menu_link(&value));
    let selection_text = context_menu_value(url, "selectionText")
        .unwrap_or_default()
        .chars()
        .take(16_384)
        .collect::<String>();
    let Some(x) = parse_number("x") else {
        return true;
    };
    let Some(y) = parse_number("y") else {
        return true;
    };
    let Some(screen_x) = parse_number("screenX") else {
        return true;
    };
    let Some(screen_y) = parse_number("screenY") else {
        return true;
    };
    let _ = app.emit(
        "browser:context-menu-requested",
        BrowserContextMenuRequestedEvent {
            browser_page_id: browser_page_id.to_string(),
            x,
            y,
            screen_x,
            screen_y,
            page_url,
            link_url,
            selection_text,
            can_go_back: context_menu_value(url, "canGoBack").as_deref() == Some("true"),
            can_go_forward: context_menu_value(url, "canGoForward").as_deref() == Some("true"),
        },
    );
    true
}

fn emit_context_menu_dismissed_from_navigation(
    app: &AppHandle,
    browser_page_id: &str,
    url: &Url,
) -> bool {
    if url.scheme() != "orca-internal" || url.host_str() != Some("context-menu-dismiss") {
        return false;
    }
    let _ = app.emit(
        "browser:context-menu-dismissed",
        serde_json::json!({ "browserPageId": browser_page_id }),
    );
    true
}

fn emit_annotation_viewport_from_navigation(
    app: &AppHandle,
    state: &BrowserWebviewState,
    browser_page_id: &str,
    url: &Url,
) -> bool {
    if url.scheme() != "orca-internal" || url.host_str() != Some("annotation-viewport") {
        return false;
    }
    let Some(token) = context_menu_value(url, "token") else {
        return true;
    };
    let Some(message) = context_menu_value(url, "message") else {
        return true;
    };
    if message.len() > 128 * 1024 {
        return true;
    }
    let owned_by_page = state
        .annotation_bridges
        .lock()
        .ok()
        .and_then(|bridges| bridges.get(browser_page_id).cloned())
        .is_some_and(|bridge| bridge.token == token);
    if !owned_by_page {
        return true;
    }
    let _ = app.emit(
        "browser:annotation-viewport-message",
        serde_json::json!({
            "browserPageId": browser_page_id,
            "message": message,
        }),
    );
    true
}

fn browser_guest_shortcut_script() -> &'static str {
    r#"
(() => {
  if (window.__orcaGuestShortcutInstalled) {
    return;
  }
  window.__orcaGuestShortcutInstalled = true;
  const handledChords = new Set();
  const modifierPrefix = (event) =>
    (event.ctrlKey === true ? '1' : '0') +
    (event.altKey === true ? '1' : '0') +
    (event.shiftKey === true ? '1' : '0') +
    (event.metaKey === true ? '1' : '0');
  const logicalKeyToken = (event) => {
    const key = event.key;
    if (typeof key === 'string' && key.length === 1) {
      return key.toUpperCase();
    }
    return key === ' ' ? 'Space' : null;
  };
  const isHandledChord = (event) => {
    const prefix = modifierPrefix(event);
    if (handledChords.has('c:' + prefix + ':' + (event.code || ''))) {
      return true;
    }
    const token = logicalKeyToken(event);
    return token !== null && handledChords.has('k:' + prefix + ':' + token);
  };
  const replaceHandledChords = (chords) => {
    handledChords.clear();
    if (Array.isArray(chords)) {
      for (const chord of chords) {
        if (typeof chord === 'string' && chord.length > 0) {
          handledChords.add(chord);
        }
      }
    }
  };
  // Why: remote guests hold no invoke grant and can miss broadcast events,
  // so Rust pushes the set per page load through this setter.
  window.__orcaGuestReplaceHandledChords = replaceHandledChords;
  try {
    const internals = window.__TAURI_INTERNALS__;
    if (internals && typeof internals.invoke === 'function') {
      internals
        .invoke('poc_browser_get_handled_shortcuts')
        .then((chords) => replaceHandledChords(chords))
        .catch(() => {});
    }
    const tauriEvent = window.__TAURI__ && window.__TAURI__.event;
    if (tauriEvent && typeof tauriEvent.listen === 'function') {
      tauriEvent
        .listen('browser:handled-shortcuts', (message) =>
          replaceHandledChords(message && message.payload && message.payload.chords),
        )
        .catch(() => {});
    }
  } catch {
    // Best effort: suppression is an enhancement; forwarding still works.
  }
  // Why: host bindings can lag document scripts; looking them up per send
  // keeps an early page from muting itself forever (never poison the guard).
  const isFunctionKey = (key) => /^F\d{1,2}$/.test(key || '');
  // Why: every guest key goes through the shared double-tap detector,
  // so a Shift-held chord must cross too; otherwise typing a capital between
  // two Shift taps would phantom-trigger a double-tap. Plain typing still
  // lands in the guest (only handled chords are preventDefaulted below).
  const shouldForward = (event) =>
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.shiftKey ||
    event.key === 'Escape' ||
    isFunctionKey(event.key);
  // Why: the main window commits a held Ctrl+Tab switcher on Control release;
  // arm on the switcher Tab and report an armed release as a commit so the overlay
  // cannot strand. Unarmed releases forward normally for double-tap. The host may consume
  // the Ctrl+Tab keydown as an accelerator before it reaches the page, so a
  // Ctrl-held Tab keyup arms too; the Tab keyup still bridges while Ctrl is held.
  let switcherArmed = false;
  const isControlKey = (event) =>
    event.code === 'ControlLeft' ||
    event.code === 'ControlRight' ||
    event.code === 'Control' ||
    event.key === 'Control';
  // Why: bare-modifier releases carry no modifier flag, so the forward gate
  // below would drop them and the main window could never complete a double-tap.
  const isModifierKey = (event) =>
    isControlKey(event) ||
    event.code === 'ShiftLeft' ||
    event.code === 'ShiftRight' ||
    event.code === 'AltLeft' ||
    event.code === 'AltRight' ||
    event.code === 'MetaLeft' ||
    event.code === 'MetaRight' ||
    event.key === 'Shift' ||
    event.key === 'Alt' ||
    event.key === 'Meta';
  const send = (event, type) => {
    const target = window.chrome && window.chrome.webview;
    if (!target || typeof target.postMessage !== 'function') {
      return;
    }
    const postMessage = target.postMessage.bind(target);
    if (type === 'keyup' && isControlKey(event)) {
      if (switcherArmed) {
        switcherArmed = false;
        try {
          postMessage(JSON.stringify({ tag: 'orca-guest-shortcut', type: 'ctrl-tab-commit' }));
        } catch {
          // Best effort: a missed commit only strands until Escape or blur.
        }
        return;
      }
      // Unarmed Control release falls through: the main window needs the
      // keyup to complete modifier double-taps.
    } else if (!shouldForward(event) && !isModifierKey(event)) {
      return;
    }
    if (
      (type === 'keydown' || type === 'keyup') &&
      event.code === 'Tab' &&
      event.ctrlKey === true &&
      event.metaKey !== true &&
      event.altKey !== true
    ) {
      switcherArmed = true;
    }
    // Why: Electron's before-input-event lets auto-repeat fall through to the
    // guest's own default handling (only non-repeat chords are consumed);
    // match that so a held key still page-scrolls or re-fires in-page.
    if (type === 'keydown' && event.repeat !== true && isHandledChord(event)) {
      try {
        event.preventDefault();
      } catch {
        // Best effort: a rejected suppression must never break the guest page.
      }
    }
    try {
      postMessage(
        JSON.stringify({
          tag: 'orca-guest-shortcut',
          type,
          key: event.key || '',
          code: event.code || '',
          ctrlKey: event.ctrlKey === true,
          shiftKey: event.shiftKey === true,
          altKey: event.altKey === true,
          metaKey: event.metaKey === true,
          repeat: event.repeat === true,
        }),
      );
    } catch {
      // Best effort: a rejected bridge payload must never break the guest page.
    }
  };
  document.addEventListener('keydown', (event) => send(event, 'keydown'), true);
  document.addEventListener('keyup', (event) => send(event, 'keyup'), true);
  window.addEventListener('blur', () => {
    switcherArmed = false;
  });

  // Why: Ctrl+wheel over a focused guest never reaches renderer DOM zoom
  // handlers, so consume it and forward a zoom direction the host turns into
  // the shared `ui:zoomBrowserPage` path (Electron before-mouse-event parity).
  // Shift/Alt keep their own meaning (horizontal scroll, blocked chords), so
  // only plain Ctrl/Meta wheels count.
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  document.addEventListener(
    'wheel',
    (event) => {
      if (event.altKey === true || event.shiftKey === true) {
        return;
      }
      const hasZoomModifier = isMac ? event.metaKey === true : event.ctrlKey === true;
      if (!hasZoomModifier || typeof event.deltaY !== 'number' || event.deltaY === 0) {
        return;
      }
      const target = window.chrome && window.chrome.webview;
      if (!target || typeof target.postMessage !== 'function') {
        return;
      }
      try {
        event.preventDefault();
      } catch {
        // Best effort: a rejected suppression must never break the guest page.
      }
      try {
        target.postMessage(
          JSON.stringify({
            tag: 'orca-guest-shortcut',
            type: 'wheel-zoom',
            direction: event.deltaY < 0 ? 'in' : 'out',
          }),
        );
      } catch {
        // Best effort: a rejected bridge payload must never break the guest page.
      }
    },
    { capture: true, passive: false },
  );

  // Why: the host's Edit > Copy/SelectAll/Paste handler needs to know which
  // guest currently holds DOM focus so it can route the action into that
  // webview instead of the unfocused main window (Electron
  // `webContents.getFocusedWebContents()` parity).
  const postFocusState = (focused) => {
    const target = window.chrome && window.chrome.webview;
    if (!target || typeof target.postMessage !== 'function') {
      return;
    }
    try {
      target.postMessage(
        JSON.stringify({
          tag: 'orca-guest-shortcut',
          type: focused ? 'focus' : 'blur',
        }),
      );
    } catch {
      // Best effort.
    }
  };
  window.addEventListener('focus', () => postFocusState(true));
  window.addEventListener('blur', () => postFocusState(false));
  if (document.hasFocus()) {
    postFocusState(true);
  }
})();
"#
}

fn browser_context_menu_script() -> &'static str {
    r#"
(() => {
  const maxLength = 16384;
  const signal = (kind, values = {}) => {
    const query = new URLSearchParams({
      ...values,
      pageUrl: location.href,
      canGoBack: history.length > 1 ? 'true' : 'false',
      canGoForward: 'false'
    });
    try {
      location.href = `orca-internal://${kind}?${query.toString()}`;
    } catch {
      // The native navigation guard is best effort during page teardown.
    }
  };
  document.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
    const selection = window.getSelection()?.toString() ?? '';
    signal('context-menu', {
      x: event.clientX,
      y: event.clientY,
      screenX: event.screenX,
      screenY: event.screenY,
      linkUrl: target?.href ?? '',
      selectionText: selection.slice(0, maxLength)
    });
  }, true);
  document.addEventListener('mousedown', (event) => {
    if (event.button !== 2) {
      signal('context-menu-dismiss');
    }
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      signal('context-menu-dismiss');
    }
  }, true);
  const annotationPrefix = '__orca_annotation_viewport__:';
  const originalDebug = console.debug.bind(console);
  console.debug = (...args) => {
    try {
      const value = typeof args[0] === 'string' ? args[0] : '';
      if (value.startsWith(annotationPrefix)) {
        const separator = value.indexOf(':', annotationPrefix.length);
        if (separator > annotationPrefix.length) {
          const token = value.slice(annotationPrefix.length, separator);
          const message = value.slice(separator + 1);
          const query = new URLSearchParams({ token, message });
          location.href = `orca-internal://annotation-viewport?${query.toString()}`;
        }
      }
    } catch {
      // The native navigation guard is best effort during page teardown.
    }
    originalDebug(...args);
  };
})();
"#
}

fn safe_origin(url: &Url) -> String {
    url.origin().ascii_serialization()
}

fn safe_download_filename(url: &Url) -> String {
    let candidate = url
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .filter(|value| !value.is_empty())
        .unwrap_or("download");
    let basename = Path::new(candidate)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("download");
    let sanitized = basename
        .chars()
        .map(|character| {
            if character.is_control() || "<>:\"/\\|?*".contains(character) {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    if sanitized.trim().is_empty() {
        "download".to_string()
    } else {
        sanitized
    }
}

pub(crate) fn browser_download_directory(app: &AppHandle) -> PathBuf {
    app.path()
        .download_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("orca-downloads"))
}

fn reserve_download_path(app: &AppHandle, filename: &str) -> Result<PathBuf, String> {
    let directory = browser_download_directory(app);
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let original = directory.join(filename);
    if !original.exists() {
        return Ok(original);
    }
    let path = Path::new(filename);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("download");
    let extension = path.extension().and_then(|value| value.to_str());
    for index in 1..=10_000 {
        let candidate_name = match extension {
            Some(extension) if !extension.is_empty() => format!("{stem} ({index}).{extension}"),
            _ => format!("{stem} ({index})"),
        };
        let candidate = directory.join(candidate_name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("Could not choose a unique Downloads file name.".to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDownloadBlobArgs {
    pub browser_page_id: String,
    pub download_id: String,
    pub content_base64: String,
    pub done: bool,
    pub error: Option<String>,
}

// 4 GiB cap keeps a compromised guest from filling the disk unchecked.
const MAX_FALLBACK_DOWNLOAD_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const FALLBACK_FETCH_CHUNK_BYTES: usize = 512 * 1024;

/// Attachment response seen without a native DownloadStarting: the URL that
/// must still match at abort time plus the server-suggested file name.
#[derive(Clone, Debug)]
struct PendingAttachmentDownload {
    url: String,
    filename: Option<String>,
    total_bytes: Option<u64>,
    mime_type: Option<String>,
}

fn sanitize_download_filename(name: &str) -> String {
    let sanitized = name
        .chars()
        .map(|character| {
            if character.is_control() || "<>:\"/\\|?*".contains(character) {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    if sanitized.trim().is_empty() || sanitized.len() > 128 {
        "download".to_string()
    } else {
        sanitized
    }
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok()?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                index += 3;
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

// Electron names the download from Content-Disposition when the server sends
// one; match that instead of always falling back to the URL tail.
fn disposition_filename(disposition: &str) -> Option<String> {
    for part in disposition.split(';') {
        let part = part.trim();
        let raw = if let Some(encoded) = part
            .strip_prefix("filename*=")
            .or_else(|| part.strip_prefix("Filename*="))
        {
            // RFC 5987 shape: charset'lang'percent-encoded.
            let encoded = encoded.split('\'').nth(2).unwrap_or(encoded);
            percent_decode(encoded)
        } else if let Some(name) = part
            .strip_prefix("filename=")
            .or_else(|| part.strip_prefix("Filename="))
        {
            Some(name.trim().trim_matches('"').trim().to_string())
        } else {
            None
        };
        if let Some(raw) = raw {
            let tail = raw
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or(raw.as_str())
                .trim();
            if !tail.is_empty() && tail != "." && tail != ".." {
                return Some(sanitize_download_filename(tail));
            }
        }
    }
    None
}
fn fallback_staging_path(download_id: &str) -> Option<PathBuf> {
    if download_id.is_empty() || download_id.len() > 128 {
        return None;
    }
    if !download_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return None;
    }
    Some(
        std::env::temp_dir()
            .join("orca-browser-downloads")
            .join(format!("{download_id}.part")),
    )
}

fn find_fallback_download(
    state: &BrowserWebviewState,
    download_id: &str,
) -> Option<BrowserDownload> {
    state
        .downloads
        .lock()
        .ok()?
        .values()
        .flat_map(|entries| entries.iter())
        .find(|entry| entry.download_id == download_id)
        .cloned()
}

fn take_fallback_download(
    state: &BrowserWebviewState,
    download_id: &str,
) -> Option<BrowserDownload> {
    let mut downloads = state.downloads.lock().ok()?;
    let mut found = None;
    let mut empty_key = None;
    for (key, entries) in downloads.iter_mut() {
        if let Some(position) = entries
            .iter()
            .position(|entry| entry.download_id == download_id)
        {
            found = Some(entries.remove(position));
            if entries.is_empty() {
                empty_key = Some(key.clone());
            }
            break;
        }
    }
    if let Some(key) = empty_key {
        downloads.remove(&key);
    }
    found
}

fn fail_fallback_download(app: &AppHandle, download: &BrowserDownload, error: String) {
    let state = app.state::<BrowserWebviewState>();
    take_fallback_download(&state, &download.download_id);
    if let Some(staging) = fallback_staging_path(&download.download_id) {
        let _ = fs::remove_file(&staging);
    }
    emit_download_finished(app, download, "failed", Some(error));
}

// Native DownloadStarting is silent on some Windows hosts even though the
// attachment response arrived. Fetch the bytes in-page (cookies included)
// and surface the same download events Electron emits.
#[cfg(windows)]
fn start_attachment_fallback(app: &AppHandle, page_id: &str, url: &str) {
    let state = app.state::<BrowserWebviewState>();
    let Ok(parsed) = Url::parse(url) else {
        return;
    };
    // Native records before NavigationCompleted, so a tracked entry means
    // the native path owns this URL and the fallback must stand down.
    let native_claimed = state
        .downloads
        .lock()
        .map(|downloads| downloads.contains_key(&download_key(page_id, &parsed)))
        .unwrap_or(false);
    let recorded = state
        .pending_attachment_downloads
        .lock()
        .ok()
        .and_then(|mut pending| pending.remove(page_id));
    let Some(recorded) = recorded else {
        return;
    };
    if recorded.url != url || native_claimed {
        return;
    }
    // Preview partitions refuse downloads instead of saving them.
    let preview_state = app.state::<DocPreviewState>();
    if let Some(grant_id) = grant_id_for_page(&preview_state, page_id) {
        notice_preview_download_blocked(app, &preview_state, &grant_id);
        return;
    }
    let filename = recorded
        .filename
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| safe_download_filename(&parsed));
    let total_bytes = recorded.total_bytes;
    let mime_type = recorded.mime_type;
    let path = match reserve_download_path(app, &filename) {
        Ok(path) => path,
        Err(_) => return,
    };
    let download = BrowserDownload {
        download_id: format!("tauri-download-{}", state.next_download_id()),
        browser_page_id: page_id.to_string(),
        save_path: path,
        total_bytes,
        mime_type: mime_type.clone(),
        canceled: false,
    };
    let key = download_key(page_id, &parsed);
    if let Ok(mut downloads) = state.downloads.lock() {
        downloads.entry(key).or_default().push(download.clone());
    }
    let _ = app.emit(
        "browser:download-requested",
        BrowserDownloadRequestedEvent {
            browser_page_id: download.browser_page_id.clone(),
            download_id: download.download_id.clone(),
            origin: safe_origin(&parsed),
            filename,
            total_bytes,
            mime_type: download.mime_type.clone(),
            save_path: download.save_path.to_string_lossy().into_owned(),
            status: "downloading",
        },
    );
    let app_thread = app.clone();
    let script = attachment_fetch_script(page_id, &download.download_id, url);
    std::thread::spawn(move || {
        let state = app_thread.state::<BrowserWebviewState>();
        match child_webview(&app_thread, &state, &download.browser_page_id) {
            Ok(webview) => {
                let eval_result = webview.eval(&script);
                if let Err(error) = eval_result {
                    fail_fallback_download(&app_thread, &download, error.to_string());
                }
            }
            Err(error) => fail_fallback_download(&app_thread, &download, error),
        }
    });
}

fn attachment_fetch_script(page_id: &str, download_id: &str, url: &str) -> String {
    let page = serde_json::to_string(page_id).unwrap_or_else(|_| "\"\"".to_string());
    let id = serde_json::to_string(download_id).unwrap_or_else(|_| "\"\"".to_string());
    let target = serde_json::to_string(url).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        r#"(async () => {{
  const request = {{ pageId: {page}, downloadId: {id}, url: {target} }};
  const post = (payload) => window.chrome.webview.postMessage(JSON.stringify(Object.assign(
    {{ tag: 'orca-download-blob' }},
    payload,
  )));
  const send = (index, contentBase64, done, error) => post(Object.assign(
    {{ downloadId: request.downloadId, index, contentBase64, done }},
    error === undefined ? null : {{ error }},
  ));
  try {{
    const webview = window.chrome && window.chrome.webview;
    if (!webview || typeof webview.postMessage !== 'function') {{
      throw new Error('browser message bridge is unavailable');
    }}
    const response = await fetch(request.url, {{ credentials: 'include' }});
    if (!response.ok) {{
      throw new Error('HTTP ' + response.status);
    }}
    const bytes = new Uint8Array(await response.arrayBuffer());
    const CHUNK = {chunk};
    if (bytes.length === 0) {{
      await send(0, '', true);
      return;
    }}
    let index = 0;
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {{
      const slice = bytes.subarray(offset, Math.min(offset + CHUNK, bytes.length));
      let binary = '';
      for (let i = 0; i < slice.length; i += 0x8000) {{
        binary += String.fromCharCode.apply(null, slice.subarray(i, i + 0x8000));
      }}
      await send(index, btoa(binary), offset + CHUNK >= bytes.length);
      index += 1;
    }}
  }} catch (error) {{
    try {{
      post({{ downloadId: request.downloadId, index: 0, contentBase64: '', done: true, error: String((error && error.message) || error) }});
    }} catch {{
      // Page teardown can drop the bridge mid-flight; Rust cleans up on close.
    }}
  }}
}})();"#,
        chunk = FALLBACK_FETCH_CHUNK_BYTES,
    )
}
#[tauri::command]
pub fn poc_browser_download_blob(
    app: AppHandle,
    _state: State<BrowserWebviewState>,
    args: BrowserDownloadBlobArgs,
) -> Result<(), String> {
    ingest_fallback_chunk(
        &app,
        &args.browser_page_id,
        &args.download_id,
        &args.content_base64,
        args.done,
        args.error,
    )
}

fn ingest_fallback_chunk(
    app: &AppHandle,
    page_id: &str,
    download_id: &str,
    content_base64: &str,
    done: bool,
    error: Option<String>,
) -> Result<(), String> {
    let state = app.state::<BrowserWebviewState>();
    let staging = fallback_staging_path(download_id)
        .ok_or_else(|| "browser download id is invalid".to_string())?;
    if let Some(error) = error {
        if let Some(download) = take_fallback_download(&state, download_id) {
            let _ = fs::remove_file(&staging);
            emit_download_finished(&app, &download, "failed", Some(error));
        }
        return Ok(());
    }
    if content_base64.is_empty() && !done {
        return Err("browser download chunk is empty".to_string());
    }
    if !content_base64.is_empty() {
        let bytes = BASE64
            .decode(content_base64.as_bytes())
            .map_err(|error| format!("browser download chunk is invalid: {error}"))?;
        if let Some(parent) = staging.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&staging)
            .map_err(|error| error.to_string())?;
        file.write_all(&bytes).map_err(|error| error.to_string())?;
    }
    let Some(download) = find_fallback_download(&state, download_id) else {
        return Err("browser download is no longer tracked".to_string());
    };
    if download.browser_page_id != page_id {
        return Err("browser download page mismatch".to_string());
    }
    if download.canceled {
        take_fallback_download(&state, download_id);
        let _ = fs::remove_file(&staging);
        emit_download_finished(&app, &download, "canceled", None);
        return Ok(());
    }
    let received = fs::metadata(&staging).map(|metadata| metadata.len()).unwrap_or(0);
    if received > MAX_FALLBACK_DOWNLOAD_BYTES {
        fail_fallback_download(
            &app,
            &download,
            "browser download exceeds its byte budget".to_string(),
        );
        return Ok(());
    }
    emit_download_progress(&app, &download, received, Some("progressing"));
    if !done {
        return Ok(());
    }
    if let Some(parent) = download.save_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    if fs::rename(&staging, &download.save_path).is_err() {
        fs::copy(&staging, &download.save_path).map_err(|error| error.to_string())?;
        let _ = fs::remove_file(&staging);
    }
    take_fallback_download(&state, download_id);
    emit_download_finished(&app, &download, "completed", None);
    Ok(())
}
fn download_key(browser_page_id: &str, url: &Url) -> String {
    format!("{browser_page_id}\n{url}")
}

fn emit_download_finished(
    app: &AppHandle,
    download: &BrowserDownload,
    status: &'static str,
    error: Option<String>,
) {
    let save_path = if status == "completed" {
        Some(download.save_path.to_string_lossy().into_owned())
    } else {
        None
    };
    let _ = app.emit(
        "browser:download-finished",
        BrowserDownloadFinishedEvent {
            browser_page_id: download.browser_page_id.clone(),
            download_id: download.download_id.clone(),
            status,
            save_path,
            error,
        },
    );
}

fn emit_download_progress(
    app: &AppHandle,
    download: &BrowserDownload,
    received_bytes: u64,
    state: Option<&'static str>,
) {
    let _ = app.emit(
        "browser:download-progress",
        BrowserDownloadProgressEvent {
            browser_page_id: download.browser_page_id.clone(),
            download_id: download.download_id.clone(),
            received_bytes,
            total_bytes: download.total_bytes,
            state,
        },
    );
}

fn start_download_progress_monitor(app: &AppHandle, download: &BrowserDownload) {
    let app = app.clone();
    let download_id = download.download_id.clone();
    let save_path = download.save_path.clone();
    tauri::async_runtime::spawn(async move {
        let mut last_received_bytes = None;
        loop {
            let active = app
                .state::<BrowserWebviewState>()
                .downloads
                .lock()
                .ok()
                .and_then(|downloads| {
                    downloads
                        .values()
                        .flat_map(|entries| entries.iter())
                        .find(|entry| entry.download_id == download_id)
                        .cloned()
                });
            let Some(download) = active else {
                break;
            };
            let received_bytes = fs::metadata(&save_path)
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            if last_received_bytes != Some(received_bytes) {
                emit_download_progress(&app, &download, received_bytes, Some("progressing"));
                last_received_bytes = Some(received_bytes);
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    });
}

pub(crate) async fn call_browser_devtools_protocol(
    webview: tauri::Webview<tauri::Wry>,
    method: &str,
    parameters: String,
) -> Result<serde_json::Value, String> {
    let (sender, receiver) = std::sync::mpsc::channel();
    let method = method.to_owned();
    let dispatch_result = webview.with_webview(move |platform| {
        #[cfg(windows)]
        {
            use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
            use windows_core::{HSTRING, PCWSTR};

            let result = (|| -> windows_core::Result<()> {
                let controller = platform.controller();
                let webview = unsafe { controller.CoreWebView2()? };
                let method = HSTRING::from(method.as_str());
                let parameters = HSTRING::from(parameters);
                let callback_sender = sender.clone();
                let callback = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                    move |result, response| {
                        let response = if result.is_ok() {
                            let response = response.to_string();
                            serde_json::from_str::<serde_json::Value>(&response)
                                .map_err(|error| format!("invalid DevTools response: {error}"))
                        } else {
                            Err(format!("DevTools command failed: {result:?}"))
                        };
                        let _ = callback_sender.send(response);
                        result
                    },
                ));
                unsafe {
                    webview.CallDevToolsProtocolMethod(
                        PCWSTR::from_raw(method.as_ptr()),
                        PCWSTR::from_raw(parameters.as_ptr()),
                        &callback,
                    )?;
                }
                Ok(())
            })();
            if result.is_err() {
                let _ = sender.send(Err(format!(
                    "failed to dispatch DevTools command: {result:?}"
                )));
            }
        }

        #[cfg(not(windows))]
        {
            let _ = platform;
            let _ = sender.send(Err(
                "browser DevTools protocol is only available on Windows".to_string(),
            ));
        }
    });
    if dispatch_result.is_err() {
        return Err("failed to dispatch DevTools command".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(Duration::from_secs(5))
            .unwrap_or_else(|_| Err("timed out waiting for DevTools response".to_string()))
    })
    .await
    .unwrap_or_else(|_| Err("DevTools response task failed".to_string()))
}

pub(crate) async fn call_browser_devtools_protocol_for_session(
    webview: tauri::Webview<tauri::Wry>,
    session_id: &str,
    method: &str,
    parameters: String,
) -> Result<serde_json::Value, String> {
    let (sender, receiver) = std::sync::mpsc::channel();
    let session_id = session_id.to_owned();
    let method = method.to_owned();
    let dispatch_result = webview.with_webview(move |platform| {
        #[cfg(windows)]
        {
            use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
            use windows_core::{HSTRING, PCWSTR};

            let result = (|| -> windows_core::Result<()> {
                let controller = platform.controller();
                let webview = unsafe { controller.CoreWebView2()? };
                // ForSession lives on ICoreWebView2_11; the runtime always
                // implements it where CallDevToolsProtocolMethod exists.
                use windows_core::Interface;
                let webview: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_11 =
                    webview.cast()?;
                let session = HSTRING::from(session_id.as_str());
                let method = HSTRING::from(method.as_str());
                let parameters = HSTRING::from(parameters);
                let callback_sender = sender.clone();
                let callback = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                    move |result, response| {
                        let response = if result.is_ok() {
                            let response = response.to_string();
                            serde_json::from_str::<serde_json::Value>(&response)
                                .map_err(|error| format!("invalid DevTools response: {error}"))
                        } else {
                            Err(format!("DevTools command failed: {result:?}"))
                        };
                        let _ = callback_sender.send(response);
                        result
                    },
                ));
                unsafe {
                    webview.CallDevToolsProtocolMethodForSession(
                        PCWSTR::from_raw(session.as_ptr()),
                        PCWSTR::from_raw(method.as_ptr()),
                        PCWSTR::from_raw(parameters.as_ptr()),
                        &callback,
                    )?;
                }
                Ok(())
            })();
            if result.is_err() {
                let _ = sender.send(Err(format!(
                    "failed to dispatch DevTools command: {result:?}"
                )));
            }
        }

        #[cfg(not(windows))]
        {
            let _ = platform;
            let _ = sender.send(Err(
                "browser DevTools protocol is only available on Windows".to_string(),
            ));
        }
    });
    if dispatch_result.is_err() {
        return Err("failed to dispatch DevTools command".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(Duration::from_secs(5))
            .unwrap_or_else(|_| Err("timed out waiting for DevTools response".to_string()))
    })
    .await
    .unwrap_or_else(|_| Err("DevTools response task failed".to_string()))
}

async fn evaluate_browser_script(
    webview: tauri::Webview<tauri::Wry>,
    script: String,
    await_promise: bool,
) -> Result<serde_json::Value, String> {
    let parameters = serde_json::json!({
        "expression": script,
        "awaitPromise": await_promise,
        "returnByValue": true,
        "userGesture": true,
    })
    .to_string();
    let response = call_browser_devtools_protocol(webview, "Runtime.evaluate", parameters).await?;
    if let Some(error) = response
        .get("error")
        .and_then(|value| value.get("message"))
        .and_then(serde_json::Value::as_str)
    {
        return Err(error.to_string());
    }
    if let Some(exception) = response.get("exceptionDetails") {
        return Err(format!("browser script failed: {exception}"));
    }
    let result = response
        .get("result")
        .and_then(|value| value.get("result"))
        .ok_or_else(|| "DevTools evaluate response did not contain a result".to_string())?;
    if let Some(description) = result
        .get("description")
        .and_then(serde_json::Value::as_str)
    {
        if result.get("type").and_then(serde_json::Value::as_str) == Some("undefined") {
            return Err(description.to_string());
        }
    }
    Ok(result
        .get("value")
        .cloned()
        .unwrap_or(serde_json::Value::Null))
}

#[tauri::command]
// Async like the cookie-import path: building a child webview hops to the
// main thread, so this must not run on it.
pub async fn poc_browser_create(
    app: AppHandle,
    state: State<'_, BrowserWebviewState>,
    cdp_state: State<'_, BrowserCdpEventState>,
    args: BrowserPageCreateArgs,
) -> Result<BrowserPageState, String> {
    let main_window = app
        .get_window("main")
        .ok_or_else(|| "main window is unavailable".to_string())?;
    revoke_grants_for_page(&app.state::<DocPreviewState>(), &args.browser_page_id);
    let label = label_for_page(&args.browser_page_id);
    if let Some(existing) = app.get_webview(&label) {
        let _ = existing.close();
    }
    state
        .annotation_bridges
        .lock()
        .map_err(|_| "browser webview state is poisoned".to_string())?
        .remove(&args.browser_page_id);
    if let Ok(mut marks) = state.agent_input.lock() {
        marks.remove(&args.browser_page_id);
    }
    if let Ok(mut in_flight) = state.navigation_in_flight.lock() {
        in_flight.remove(&args.browser_page_id);
    }
    drop_cdp_subscriptions_for_page(&cdp_state, &args.browser_page_id);

    let initial_url = Url::parse("about:blank").map_err(|error| error.to_string())?;
    let page_id = args.browser_page_id.clone();
    reset_certificate_page(&app, &state, &page_id);
    let app_for_navigation = app.clone();
    let page_id_for_navigation = page_id.clone();
    let app_for_context_menu = app.clone();
    let page_id_for_context_menu = page_id.clone();
    let app_for_load = app.clone();
    let page_id_for_load = page_id.clone();
    let app_for_title = app.clone();
    let page_id_for_title = page_id.clone();
    let title_label = label.clone();
    let app_for_popup = app.clone();
    let page_id_for_popup = page_id.clone();
    let app_for_permission = app.clone();
    let page_id_for_permission = page_id.clone();
    let app_for_download = app.clone();
    let page_id_for_download = page_id.clone();
    let mut builder = WebviewBuilder::new(label.clone(), WebviewUrl::External(initial_url));
    if let Some(user_agent) = browser_user_agent(app.state::<BrowserIdentityState>().inner()) {
        builder = builder.user_agent(&user_agent);
    }
    let builder = builder
        .focused(false)
        .transparent(false)
        .zoom_hotkeys_enabled(false)
        .initialization_script(browser_context_menu_script())
        .initialization_script(browser_guest_shortcut_script())
        .data_store_identifier(store_identifier(
            args.partition.as_deref().unwrap_or("orca-browser-default"),
        ))
        .on_navigation(move |url| {
            let state = app_for_context_menu.state::<BrowserWebviewState>();
            begin_browser_navigation(
                &app_for_context_menu,
                &state,
                &page_id_for_context_menu,
                url.as_str(),
            );
            let preview_state = app_for_context_menu.state::<DocPreviewState>();
            if let Some(allowed) = handle_preview_navigation(
                &app_for_context_menu,
                &preview_state,
                &page_id_for_context_menu,
                url,
            ) {
                return allowed;
            }
            if emit_context_menu_from_navigation(
                &app_for_context_menu,
                &page_id_for_context_menu,
                url,
            ) || emit_context_menu_dismissed_from_navigation(
                &app_for_context_menu,
                &page_id_for_context_menu,
                url,
            ) || emit_annotation_viewport_from_navigation(
                &app_for_context_menu,
                &state,
                &page_id_for_context_menu,
                url,
            ) {
                return false;
            }
            emit_page_event(
                &app_for_navigation,
                BrowserPageEvent {
                    browser_page_id: page_id_for_navigation.clone(),
                    event_type: "did-start-navigation".to_string(),
                    url: page_url(url),
                    title: None,
                    error_code: None,
                    error_description: None,
                    validated_url: None,
                    is_main_frame: Some(true),
                    is_in_place: Some(false),
                    permission: None,
                    action: None,
                    favicons: None,
                    reason: None,
                    exit_code: None,
                },
            );
            true
        })
        .on_new_window(move |url, _| {
            emit_page_event(
                &app_for_popup,
                BrowserPageEvent {
                    browser_page_id: page_id_for_popup.clone(),
                    event_type: "popup".to_string(),
                    url: Some(url.to_string()),
                    title: None,
                    error_code: None,
                    error_description: None,
                    validated_url: None,
                    is_main_frame: Some(true),
                    is_in_place: Some(false),
                    permission: None,
                    action: Some("blocked".to_string()),
                    favicons: None,
                    reason: None,
                    exit_code: None,
                },
            );
            NewWindowResponse::Deny
        })
        .on_permission_request(move |webview, permission| {
            let origin = webview
                .url()
                .ok()
                .map(|url| safe_origin(&url))
                .unwrap_or_else(|| "unknown".to_string());
            emit_page_event(
                &app_for_permission,
                BrowserPageEvent {
                    browser_page_id: page_id_for_permission.clone(),
                    event_type: "permission-denied".to_string(),
                    url: Some(origin),
                    title: None,
                    error_code: None,
                    error_description: None,
                    validated_url: None,
                    is_main_frame: Some(true),
                    is_in_place: Some(false),
                    permission: Some(permission.to_string()),
                    action: None,
                    favicons: None,
                    reason: None,
                    exit_code: None,
                },
            );
            PermissionResponse::Deny
        })
        .on_download(move |webview, event| {
            let state = app_for_download.state::<BrowserWebviewState>();
            let browser_page_id = browser_page_id_for_label(&state, webview.label())
                .unwrap_or_else(|| page_id_for_download.clone());
            match event {
                DownloadEvent::Requested { url, destination } => {
                    let preview_state = app_for_download.state::<DocPreviewState>();
                    if let Some(grant_id) = grant_id_for_page(&preview_state, &browser_page_id) {
                        notice_preview_download_blocked(
                            &app_for_download,
                            &preview_state,
                            &grant_id,
                        );
                        return false;
                    }
                    let filename = safe_download_filename(&url);
                    let path = match reserve_download_path(&app_for_download, &filename) {
                        Ok(path) => path,
                        Err(error) => {
                            let failed = BrowserDownload {
                                download_id: format!("tauri-download-{}", state.next_download_id()),
                                browser_page_id,
                                save_path: PathBuf::new(),
                                total_bytes: None,
                                mime_type: None,
                                canceled: false,
                            };
                            emit_download_finished(
                                &app_for_download,
                                &failed,
                                "failed",
                                Some(error),
                            );
                            return false;
                        }
                    };
                    *destination = path.clone();
                    let download = BrowserDownload {
                        download_id: format!("tauri-download-{}", state.next_download_id()),
                        browser_page_id: browser_page_id.clone(),
                        save_path: path.clone(),
                        total_bytes: None,
                        mime_type: None,
                        canceled: false,
                    };
                    let key = download_key(&browser_page_id, &url);
                    if let Ok(mut downloads) = state.downloads.lock() {
                        downloads.entry(key).or_default().push(download.clone());
                    }
                    let _ = app_for_download.emit(
                        "browser:download-requested",
                        BrowserDownloadRequestedEvent {
                            browser_page_id: browser_page_id.clone(),
                            download_id: download.download_id.clone(),
                            origin: safe_origin(&url),
                            filename,
                            total_bytes: None,
                            mime_type: None,
                            save_path: path.to_string_lossy().into_owned(),
                            status: "downloading",
                        },
                    );
                    start_download_progress_monitor(&app_for_download, &download);
                    true
                }
                DownloadEvent::Finished { url, path, success } => {
                    let key = download_key(&browser_page_id, &url);
                    let download = state.downloads.lock().ok().and_then(|mut downloads| {
                        let entries = downloads.get_mut(&key)?;
                        let download = entries.pop()?;
                        if entries.is_empty() {
                            downloads.remove(&key);
                        }
                        Some(download)
                    });
                    let Some(download) = download else {
                        return true;
                    };
                    let canceled = download.canceled;
                    let received_bytes = fs::metadata(&download.save_path)
                        .map(|metadata| metadata.len())
                        .unwrap_or(0);
                    if canceled {
                        let _ = fs::remove_file(&download.save_path);
                    }
                    let status = if canceled {
                        "canceled"
                    } else if success {
                        "completed"
                    } else {
                        "failed"
                    };
                    if !canceled {
                        emit_download_progress(
                            &app_for_download,
                            &download,
                            received_bytes,
                            (!success).then_some("interrupted"),
                        );
                    }
                    let error = (!success && !canceled).then(|| "Download failed.".to_string());
                    let _ = path;
                    emit_download_finished(&app_for_download, &download, status, error);
                    true
                }
                _ => true,
            }
        })
        .on_page_load(move |webview, payload| {
            let url = page_url(payload.url());
            match payload.event() {
                PageLoadEvent::Started => emit_page_event(
                    &app_for_load,
                    BrowserPageEvent {
                        browser_page_id: page_id_for_load.clone(),
                        event_type: "did-start-loading".to_string(),
                        url,
                        title: None,
                        error_code: None,
                        error_description: None,
                        validated_url: None,
                        is_main_frame: Some(true),
                        is_in_place: Some(false),
                        permission: None,
                        action: None,
                        favicons: None,
                        reason: None,
                        exit_code: None,
                    },
                ),
                PageLoadEvent::Finished => {
                    if let Some(grant_id) = grant_id_for_page(
                        &app_for_load.state::<DocPreviewState>(),
                        &page_id_for_load,
                    ) {
                        let _ = webview.eval(guest_script(&grant_id));
                    }
                    if let Some(script) = app_for_load
                        .state::<BrowserWebviewState>()
                        .annotation_bridges
                        .lock()
                        .ok()
                        .and_then(|bridges| {
                            bridges
                                .get(&page_id_for_load)
                                .map(|bridge| bridge.script.clone())
                        })
                    {
                        let _ = webview.eval(script);
                    }
                    push_handled_shortcuts_to_guest(&app_for_load, &webview);
                    emit_handled_shortcuts(&app_for_load);
                    let loaded_url = webview.url().ok().map(|value| value.to_string()).or(url);
                    emit_page_event(
                        &app_for_load,
                        BrowserPageEvent {
                            browser_page_id: page_id_for_load.clone(),
                            event_type: "dom-ready".to_string(),
                            url: loaded_url.clone(),
                            title: None,
                            error_code: None,
                            error_description: None,
                            validated_url: None,
                            is_main_frame: Some(true),
                            is_in_place: Some(false),
                            permission: None,
                            action: None,
                            favicons: None,
                            reason: None,
                            exit_code: None,
                        },
                    );
                    emit_page_event(
                        &app_for_load,
                        BrowserPageEvent {
                            browser_page_id: page_id_for_load.clone(),
                            event_type: "did-stop-loading".to_string(),
                            url: loaded_url.clone(),
                            title: None,
                            error_code: None,
                            error_description: None,
                            validated_url: None,
                            is_main_frame: Some(true),
                            is_in_place: Some(false),
                            permission: None,
                            action: None,
                            favicons: None,
                            reason: None,
                            exit_code: None,
                        },
                    );
                    emit_page_event(
                        &app_for_load,
                        BrowserPageEvent {
                            browser_page_id: page_id_for_load.clone(),
                            event_type: "did-navigate".to_string(),
                            url: loaded_url,
                            title: None,
                            error_code: None,
                            error_description: None,
                            validated_url: None,
                            is_main_frame: Some(true),
                            is_in_place: Some(false),
                            permission: None,
                            action: None,
                            favicons: None,
                            reason: None,
                            exit_code: None,
                        },
                    );
                }
            }
        })
        .on_document_title_changed(move |_webview, title| {
            emit_page_event(
                &app_for_title,
                BrowserPageEvent {
                    browser_page_id: page_id_for_title.clone(),
                    event_type: "page-title-updated".to_string(),
                    url: current_url(&app_for_title, &title_label),
                    title: Some(title),
                    error_code: None,
                    error_description: None,
                    validated_url: None,
                    is_main_frame: Some(true),
                    is_in_place: Some(false),
                    permission: None,
                    action: None,
                    favicons: None,
                    reason: None,
                    exit_code: None,
                },
            );
        });

    let (position, size) = bounded_bounds(&args.bounds);
    let child = main_window
        .add_child(builder, position, size)
        .map_err(|error| error.to_string())?;
    install_certificate_handler(&child, &app, &page_id)?;
    if let Err(error) = install_guest_shortcut_forwarding(&child, &app, &page_id) {
        eprintln!("orca browser guest-shortcut forwarding unavailable: {error}");
    }
    clear_remembered_certificate_bypasses(&child)?;
    install_lifecycle_hooks(&child, &app, &page_id);
    if !args.visible {
        child.hide().map_err(|error| error.to_string())?;
    }
    state
        .labels
        .lock()
        .map_err(|_| "browser webview state is poisoned".to_string())?
        .insert(page_id, label);

    Ok(BrowserPageState {
        url: child.url().map_err(|error| error.to_string())?.to_string(),
    })
}

#[tauri::command]
pub fn poc_browser_close(
    app: AppHandle,
    state: State<BrowserWebviewState>,
    cdp_state: State<'_, BrowserCdpEventState>,
    args: BrowserPageIdArgs,
) -> Result<(), String> {
    revoke_grants_for_page(&app.state::<DocPreviewState>(), &args.browser_page_id);
    reset_certificate_page(&app, &state, &args.browser_page_id);
    let label = child_label(&state, &args.browser_page_id)?;
    emit_page_event(
        &app,
        BrowserPageEvent {
            browser_page_id: args.browser_page_id.clone(),
            event_type: "destroyed".to_string(),
            url: None,
            title: None,
            error_code: None,
            error_description: None,
            validated_url: None,
            is_main_frame: Some(true),
            is_in_place: Some(false),
            permission: None,
            action: None,
            favicons: None,
            reason: None,
            exit_code: None,
        },
    );
    if let Some(webview) = app.get_webview(&label) {
        let _ = clear_remembered_certificate_bypasses(&webview);
        webview.close().map_err(|error| error.to_string())?;
    }
    state
        .labels
        .lock()
        .map_err(|_| "browser webview state is poisoned".to_string())?
        .remove(&args.browser_page_id);
    state
        .annotation_bridges
        .lock()
        .map_err(|_| "browser webview state is poisoned".to_string())?
        .remove(&args.browser_page_id);
    if let Ok(mut marks) = state.agent_input.lock() {
        marks.remove(&args.browser_page_id);
    }
    if let Ok(mut in_flight) = state.navigation_in_flight.lock() {
        in_flight.remove(&args.browser_page_id);
    }
    #[cfg(windows)]
    {
        if let Ok(mut pending) = state.pending_attachment_downloads.lock() {
            pending.remove(&args.browser_page_id);
        }
        // Fallback downloads never complete natively; drop their staging
        // and entries so a closed page cannot leak either.
        if let Ok(downloads) = state.downloads.lock() {
            let mut staged_ids = Vec::new();
            for entries in downloads.values() {
                for download in entries {
                    if download.browser_page_id == args.browser_page_id {
                        if let Some(staging) = fallback_staging_path(&download.download_id) {
                            if staging.exists() {
                                staged_ids.push((download.download_id.clone(), staging));
                            }
                        }
                    }
                }
            }
            drop(downloads);
            for (download_id, staging) in staged_ids {
                take_fallback_download(&state, &download_id);
                let _ = fs::remove_file(&staging);
            }
        }
    }
    if let Ok(mut focused) = state.last_dom_focused.lock() {
        if focused.as_deref() == Some(args.browser_page_id.as_str()) {
            *focused = None;
        }
    }
    drop_cdp_subscriptions_for_page(&cdp_state, &args.browser_page_id);
    Ok(())
}

#[tauri::command]
pub fn poc_browser_proceed_certificate(
    app: AppHandle,
    state: State<BrowserWebviewState>,
    args: BrowserCertificateProceedArgs,
) -> Result<BrowserCertificateProceedResult, String> {
    let Some(pending) = state
        .certificate_challenges
        .lock()
        .map_err(|_| "browser webview state is poisoned".to_string())?
        .get(&args.browser_page_id)
        .cloned()
    else {
        return Ok(BrowserCertificateProceedResult::Failed {
            ok: false,
            reason: "missing".to_string(),
        });
    };
    if pending.challenge_id != args.challenge_id {
        return Ok(BrowserCertificateProceedResult::Failed {
            ok: false,
            reason: "changed".to_string(),
        });
    }
    if pending.expires_at <= certificate_now_ms() {
        clear_certificate_failure(&app, &state, &args.browser_page_id);
        return Ok(BrowserCertificateProceedResult::Failed {
            ok: false,
            reason: "expired".to_string(),
        });
    }
    if pending.error_code != -202 {
        return Ok(BrowserCertificateProceedResult::Failed {
            ok: false,
            reason: "ineligible".to_string(),
        });
    }
    let current_epoch = state
        .navigation_epochs
        .lock()
        .map_err(|_| "browser webview state is poisoned".to_string())?
        .get(&args.browser_page_id)
        .copied()
        .unwrap_or(0);
    if current_epoch != pending.navigation_epoch {
        clear_certificate_failure(&app, &state, &args.browser_page_id);
        return Ok(BrowserCertificateProceedResult::Failed {
            ok: false,
            reason: "navigated".to_string(),
        });
    }
    let webview = child_webview(&app, &state, &args.browser_page_id)?;
    if let Ok(mut accepted) = state.accepted_certificates.lock() {
        let grant_key = accepted_certificate_key(&args.browser_page_id, &pending.secure_endpoint);
        if let Some(existing) = accepted.get(&grant_key) {
            // Why fail closed here too: the loaded leaf changed after the
            // grant, so success would be a lie the next error backs out.
            if !certificate_identity_matches(
                existing,
                &pending.secure_endpoint,
                &pending.leaf_certificate_sha256,
                &pending.error,
            ) {
                return Ok(BrowserCertificateProceedResult::Failed {
                    ok: false,
                    reason: "ineligible".to_string(),
                });
            }
        }
        accepted.insert(
            grant_key,
            AcceptedCertificateIdentity {
                secure_endpoint: pending.secure_endpoint.clone(),
                leaf_certificate_sha256: pending.leaf_certificate_sha256.clone(),
                error: pending.error.clone(),
                accepted_at: certificate_now_ms(),
            },
        );
        enforce_certificate_grant_bound(&mut accepted);
    } else {
        return Err("browser webview state is poisoned".to_string());
    }
    clear_certificate_failure(&app, &state, &args.browser_page_id);
    webview
        .navigate(Url::parse(&pending.navigation_url).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    Ok(BrowserCertificateProceedResult::Ok { ok: true })
}

#[tauri::command]
pub fn poc_browser_cancel_download(
    app: AppHandle,
    state: State<BrowserWebviewState>,
    args: BrowserDownloadIdArgs,
) -> bool {
    let found = state.downloads.lock().map(|mut downloads| {
        let mut found = false;
        for entries in downloads.values_mut() {
            if let Some(download) = entries
                .iter_mut()
                .find(|download| download.download_id == args.download_id)
            {
                download.canceled = true;
                found = true;
                break;
            }
        }
        found
    });
    // Fallback downloads never complete natively, so finish them here.
    #[cfg(windows)]
    if matches!(found, Ok(true)) {
        if let Some(download) = find_fallback_download(&state, &args.download_id) {
            if fallback_staging_path(&download.download_id)
                .is_some_and(|staging| staging.exists())
            {
                take_fallback_download(&state, &download.download_id);
                if let Some(staging) = fallback_staging_path(&download.download_id) {
                    let _ = fs::remove_file(&staging);
                }
                emit_download_finished(&app, &download, "canceled", None);
            }
        }
    }
    found.unwrap_or(false)
}

#[tauri::command]
pub fn poc_browser_open_devtools(
    app: AppHandle,
    state: State<BrowserWebviewState>,
    args: BrowserPageIdArgs,
) -> Result<bool, String> {
    let webview = child_webview(&app, &state, &args.browser_page_id)?;
    #[cfg(any(debug_assertions, feature = "devtools"))]
    {
        webview.open_devtools();
        Ok(true)
    }
    #[cfg(not(any(debug_assertions, feature = "devtools")))]
    {
        let _ = webview;
        Ok(false)
    }
}

fn valid_viewport_override(override_: &BrowserViewportOverride) -> bool {
    override_.width.is_finite()
        && override_.height.is_finite()
        && override_.device_scale_factor.is_finite()
        && (1.0..=10_000.0).contains(&override_.width)
        && (1.0..=10_000.0).contains(&override_.height)
        && (0.1..=10.0).contains(&override_.device_scale_factor)
}

#[tauri::command]
pub async fn poc_browser_set_viewport_override(
    app: AppHandle,
    state: State<'_, BrowserWebviewState>,
    args: BrowserPageViewportArgs,
) -> Result<bool, String> {
    if let Some(override_) = args.override_.as_ref() {
        if !valid_viewport_override(override_) {
            return Ok(false);
        }
    }

    let operation = {
        let mut operations = state.viewport_operations.lock().await;
        operations
            .entry(args.browser_page_id.clone())
            .or_insert_with(|| Arc::new(tauri::async_runtime::Mutex::new(())))
            .clone()
    };
    let _operation_guard = operation.lock().await;

    let Ok(label) = child_label(&state, &args.browser_page_id) else {
        return Ok(false);
    };
    let Some(webview) = app.get_webview(&label) else {
        return Ok(false);
    };
    let metrics = match args.override_.as_ref() {
        Some(override_) => serde_json::json!({
            "width": override_.width,
            "height": override_.height,
            "deviceScaleFactor": override_.device_scale_factor,
            "mobile": override_.mobile,
        })
        .to_string(),
        None => "{}".to_string(),
    };
    if call_browser_devtools_protocol(
        webview.clone(),
        if args.override_.is_some() {
            "Emulation.setDeviceMetricsOverride"
        } else {
            "Emulation.clearDeviceMetricsOverride"
        },
        metrics,
    )
    .await
    .is_err()
    {
        return Ok(false);
    }

    let touch = if args
        .override_
        .as_ref()
        .is_some_and(|override_| override_.mobile)
    {
        serde_json::json!({ "enabled": true, "maxTouchPoints": 5 }).to_string()
    } else {
        serde_json::json!({ "enabled": false }).to_string()
    };
    Ok(
        call_browser_devtools_protocol(webview, "Emulation.setTouchEmulationEnabled", touch)
            .await
            .is_ok(),
    )
}

#[tauri::command]
pub fn poc_browser_set_bounds(
    app: AppHandle,
    state: State<BrowserWebviewState>,
    args: BrowserPageBoundsArgs,
) -> Result<(), String> {
    let webview = child_webview(&app, &state, &args.browser_page_id)?;
    let (position, size) = bounded_bounds(&args.bounds);
    webview
        .set_position(position)
        .and_then(|_| webview.set_size(size))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn poc_browser_set_visible(
    app: AppHandle,
    state: State<BrowserWebviewState>,
    args: BrowserPageVisibilityArgs,
) -> Result<(), String> {
    let webview = child_webview(&app, &state, &args.browser_page_id)?;
    if args.visible {
        webview.show()
    } else {
        webview.hide()
    }
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn poc_browser_navigate(
    app: AppHandle,
    state: State<BrowserWebviewState>,
    args: BrowserPageNavigateArgs,
) -> Result<(), String> {
    // Why rewrite: WRY aliases custom schemes to http only for the initial URL.
    let url = Url::parse(&preview_navigable_url(&args.url)).map_err(|error| error.to_string())?;
    child_webview(&app, &state, &args.browser_page_id)?
        .navigate(url)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn poc_browser_go_back(
    app: AppHandle,
    state: State<BrowserWebviewState>,
    args: BrowserPageIdArgs,
) -> Result<(), String> {
    child_webview(&app, &state, &args.browser_page_id)?
        .eval("window.history.back();")
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn poc_browser_go_forward(
    app: AppHandle,
    state: State<BrowserWebviewState>,
    args: BrowserPageIdArgs,
) -> Result<(), String> {
    child_webview(&app, &state, &args.browser_page_id)?
        .eval("window.history.forward();")
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn poc_browser_reload(
    app: AppHandle,
    state: State<BrowserWebviewState>,
    args: BrowserPageIdArgs,
) -> Result<(), String> {
    child_webview(&app, &state, &args.browser_page_id)?
        .reload()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn poc_browser_stop(
    app: AppHandle,
    state: State<BrowserWebviewState>,
    args: BrowserPageIdArgs,
) -> Result<(), String> {
    child_webview(&app, &state, &args.browser_page_id)?
        .eval("window.stop();")
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn poc_browser_focus(
    app: AppHandle,
    state: State<BrowserWebviewState>,
    args: BrowserPageIdArgs,
) -> Result<(), String> {
    child_webview(&app, &state, &args.browser_page_id)?
        .set_focus()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn poc_browser_set_zoom(
    app: AppHandle,
    state: State<BrowserWebviewState>,
    args: BrowserPageZoomArgs,
) -> Result<(), String> {
    if !args.scale_factor.is_finite() || !(0.1..=10.0).contains(&args.scale_factor) {
        return Err("zoom scale factor is outside the supported range".to_string());
    }
    child_webview(&app, &state, &args.browser_page_id)?
        .set_zoom(args.scale_factor)
        .map_err(|error| error.to_string())
}

// Why: Input.dispatchKeyEvent returns before the page handles the key; the
// grace covers that lag so an agent chord never leaks into app shortcuts.
const AGENT_INPUT_GRACE_MS: u64 = 500;

fn is_agent_injected_input(state: &BrowserWebviewState, browser_page_id: &str) -> bool {
    let marks = state.agent_input.lock().ok();
    let Some(mark) = marks.as_ref().and_then(|marks| marks.get(browser_page_id)) else {
        return false;
    };
    if mark.depth > 0 {
        return true;
    }
    mark.last_end
        .map(|ended| ended.elapsed().as_millis() < u128::from(AGENT_INPUT_GRACE_MS))
        .unwrap_or(false)
}

// Why: agent-driven guest keys must not run Orca shortcuts (Electron
// withAgentInputInjection parity). Depth-nested like the Electron side.
#[allow(dead_code)]
#[tauri::command]
pub fn poc_browser_agent_input_begin(
    state: State<BrowserWebviewState>,
    args: BrowserPageIdArgs,
) -> Result<(), String> {
    let mut marks = state
        .agent_input
        .lock()
        .map_err(|_| "agent input state is unavailable".to_string())?;
    let mark = marks
        .entry(args.browser_page_id.clone())
        .or_insert(AgentInputMark {
            depth: 0,
            last_end: None,
        });
    mark.depth = mark.depth.saturating_add(1);
    Ok(())
}

#[allow(dead_code)]
#[tauri::command]
pub fn poc_browser_agent_input_end(
    state: State<BrowserWebviewState>,
    args: BrowserPageIdArgs,
) -> Result<(), String> {
    let mut marks = state
        .agent_input
        .lock()
        .map_err(|_| "agent input state is unavailable".to_string())?;
    if let Some(mark) = marks.get_mut(&args.browser_page_id) {
        mark.depth = mark.depth.saturating_sub(1);
        mark.last_end = Some(Instant::now());
    }
    Ok(())
}

const MAX_HANDLED_SHORTCUT_CHORDS: usize = 4096;
const MAX_HANDLED_SHORTCUT_CHORD_BYTES: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserHandledShortcutsArgs {
    pub chords: Vec<String>,
}

// Why: the guest suppresses its own default handling only for chords the app
// actually consumes (Electron preventDefault parity). The set is computed by
// the main renderer from the live keybinding registry; Rust stores it and
// pushes it into every live guest, since remote guests hold no invoke grant
// and can miss broadcast events.
#[tauri::command]
pub fn poc_browser_set_handled_shortcuts(
    app: AppHandle,
    state: State<BrowserWebviewState>,
    args: BrowserHandledShortcutsArgs,
) -> Result<(), String> {
    if args.chords.len() > MAX_HANDLED_SHORTCUT_CHORDS {
        return Err("handled shortcut set is too large".to_string());
    }
    {
        let mut stored = state
            .handled_shortcuts
            .lock()
            .map_err(|_| "handled shortcut set is unavailable".to_string())?;
        stored.clear();
        for chord in args.chords {
            if chord.len() > MAX_HANDLED_SHORTCUT_CHORD_BYTES {
                return Err("handled shortcut chord is too large".to_string());
            }
            stored.insert(chord);
        }
    }
    // Why: a keybinding change must reach guests sitting on a page, not just
    // the next navigation; eval-push into every live child webview.
    let labels: Vec<String> = state
        .labels
        .lock()
        .map_err(|_| "browser webview state is poisoned".to_string())?
        .values()
        .cloned()
        .collect();
    for label in labels {
        if let Some(webview) = app.get_webview(&label) {
            push_handled_shortcuts_to_guest(&app, &webview);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn poc_browser_get_handled_shortcuts(state: State<BrowserWebviewState>) -> Vec<String> {
    read_handled_shortcuts(&state)
}

const MAX_CDP_PARAMS_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCdpArgs {
    pub browser_page_id: String,
    pub method: String,
    pub params: Option<serde_json::Value>,
}

// Why passthrough: the renderer's automation engine speaks CDP directly, the
// same way Electron's main drives its guests internally. The method gate keeps
// this to real DevTools domains, and non-Windows webviews reject in the
// bridge below. Results are raw DevTools JSON, parsed caller-side.
#[tauri::command]
pub async fn poc_browser_cdp(
    app: AppHandle,
    state: State<'_, BrowserWebviewState>,
    args: BrowserCdpArgs,
) -> Result<serde_json::Value, String> {
    if args.method.is_empty()
        || args.method.len() > 128
        || !args
            .method
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.')
    {
        return Err("browser CDP method is invalid".to_string());
    }
    let params = match args.params {
        None | Some(serde_json::Value::Null) => "{}".to_string(),
        Some(value) => {
            let text = serde_json::to_string(&value).map_err(|error| error.to_string())?;
            if text.len() > MAX_CDP_PARAMS_BYTES {
                return Err("browser CDP params exceed their byte budget".to_string());
            }
            text
        }
    };
    let webview = child_webview(&app, &state, &args.browser_page_id)?;
    call_browser_devtools_protocol(webview, &args.method, params).await
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCdpSessionArgs {
    pub browser_page_id: String,
    pub session_id: String,
    pub method: String,
    pub params: Option<serde_json::Value>,
}

// Why session-scoped: cross-origin iframes expose their AX/DOM trees only
// through their own CDP session (flattened Target sessions), the same way
// Electron's guest debugger addresses them. Stale sessions fail here and
// the caller skips the frame, never the whole snapshot.
#[tauri::command]
pub async fn poc_browser_cdp_session(
    app: AppHandle,
    state: State<'_, BrowserWebviewState>,
    args: BrowserCdpSessionArgs,
) -> Result<serde_json::Value, String> {
    if args.session_id.is_empty() || args.session_id.len() > 256 {
        return Err("browser CDP session is invalid".to_string());
    }
    if args.method.is_empty()
        || args.method.len() > 128
        || !args
            .method
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.')
    {
        return Err("browser CDP method is invalid".to_string());
    }
    let params = match args.params {
        None | Some(serde_json::Value::Null) => "{}".to_string(),
        Some(value) => {
            let text = serde_json::to_string(&value).map_err(|error| error.to_string())?;
            if text.len() > MAX_CDP_PARAMS_BYTES {
                return Err("browser CDP params exceed their byte budget".to_string());
            }
            text
        }
    };
    let webview = child_webview(&app, &state, &args.browser_page_id)?;
    call_browser_devtools_protocol_for_session(webview, &args.session_id, &args.method, params)
        .await
}

const MAX_GRAB_SCRIPT_BYTES: usize = 512 * 1024;
const MAX_GRAB_SCREENSHOT_BYTES: usize = 2 * 1024 * 1024;

fn validate_grab_script(script: &str) -> Result<(), String> {
    if script.is_empty() || script.len() > MAX_GRAB_SCRIPT_BYTES {
        return Err("browser grab script is invalid".to_string());
    }
    Ok(())
}

fn valid_grab_payload(value: &serde_json::Value) -> bool {
    value.as_object().is_some_and(|object| {
        object.get("page").is_some_and(serde_json::Value::is_object)
            && object
                .get("target")
                .is_some_and(serde_json::Value::is_object)
    })
}

fn grab_error_result(op_id: Option<&str>, reason: impl Into<String>) -> serde_json::Value {
    match op_id {
        Some(op_id) => serde_json::json!({
            "opId": op_id,
            "kind": "error",
            "reason": reason.into(),
        }),
        None => serde_json::json!({
            "ok": false,
            "reason": reason.into(),
        }),
    }
}

fn grab_selection_error(reason: impl Into<String>) -> serde_json::Value {
    serde_json::json!({
        "kind": "error",
        "reason": reason.into(),
    })
}

fn grab_script_result(value: serde_json::Value) -> serde_json::Value {
    if value
        .get("__orcaCancelled")
        .and_then(serde_json::Value::as_bool)
        == Some(true)
    {
        return serde_json::json!({ "kind": "cancelled", "reason": "user" });
    }
    if value
        .get("__orcaContextMenu")
        .and_then(serde_json::Value::as_bool)
        == Some(true)
    {
        let Some(payload) = value.get("payload") else {
            return grab_selection_error("Guest returned an invalid context-menu payload");
        };
        if !valid_grab_payload(payload) {
            return grab_selection_error("Guest returned invalid payload structure");
        }
        return serde_json::json!({ "kind": "context-selected", "payload": payload });
    }
    if valid_grab_payload(&value) {
        serde_json::json!({ "kind": "selected", "payload": value })
    } else {
        grab_selection_error("Guest returned invalid payload structure")
    }
}

fn safe_grab_rect(rect: &BrowserGrabRect) -> Result<(f64, f64, f64, f64), String> {
    if !rect.x.is_finite()
        || !rect.y.is_finite()
        || !rect.width.is_finite()
        || !rect.height.is_finite()
        || rect.width <= 0.0
        || rect.height <= 0.0
    {
        return Err("selection rectangle is invalid".to_string());
    }
    Ok((
        rect.x.max(0.0),
        rect.y.max(0.0),
        rect.width.min(10_000.0),
        rect.height.min(10_000.0),
    ))
}

#[tauri::command]
pub async fn poc_browser_set_grab_mode(
    app: AppHandle,
    state: State<'_, BrowserWebviewState>,
    args: BrowserGrabSetModeArgs,
) -> Result<serde_json::Value, String> {
    validate_grab_script(&args.script)?;
    let Ok(webview) = child_webview(&app, &state, &args.browser_page_id) else {
        return Ok(grab_error_result(None, "injection-failed"));
    };
    if !args.enabled {
        if let Ok(mut active_ops) = state.active_grab_ops.lock() {
            active_ops.remove(&args.browser_page_id);
        }
    }
    match evaluate_browser_script(webview, args.script, false).await {
        Ok(_) => Ok(serde_json::json!({ "ok": true })),
        Err(_) => Ok(grab_error_result(None, "injection-failed")),
    }
}

#[tauri::command]
pub async fn poc_browser_await_grab_selection(
    app: AppHandle,
    state: State<'_, BrowserWebviewState>,
    args: BrowserGrabAwaitArgs,
) -> Result<serde_json::Value, String> {
    validate_grab_script(&args.script)?;
    let webview = child_webview(&app, &state, &args.browser_page_id)?;
    {
        let mut active_ops = state
            .active_grab_ops
            .lock()
            .map_err(|_| "browser webview state is poisoned".to_string())?;
        active_ops.insert(args.browser_page_id.clone(), args.op_id.clone());
    }
    let raw_result = evaluate_browser_script(webview, args.script, true).await;
    let is_current = state
        .active_grab_ops
        .lock()
        .ok()
        .and_then(|mut active_ops| {
            (active_ops.get(&args.browser_page_id) == Some(&args.op_id))
                .then(|| active_ops.remove(&args.browser_page_id))
        })
        .is_some();
    if !is_current {
        return Ok(serde_json::json!({
            "opId": args.op_id,
            "kind": "cancelled",
            "reason": "user",
        }));
    }
    let result = match raw_result {
        Ok(value) => grab_script_result(value),
        Err(reason) => grab_error_result(Some(&args.op_id), reason),
    };
    Ok(if result.get("opId").is_none() {
        let mut result = result;
        if let Some(object) = result.as_object_mut() {
            object.insert("opId".to_string(), serde_json::json!(args.op_id));
        }
        result
    } else {
        result
    })
}

#[tauri::command]
pub async fn poc_browser_cancel_grab(
    app: AppHandle,
    state: State<'_, BrowserWebviewState>,
    args: BrowserGrabCancelArgs,
) -> Result<bool, String> {
    validate_grab_script(&args.script)?;
    if let Ok(mut active_ops) = state.active_grab_ops.lock() {
        active_ops.remove(&args.browser_page_id);
    }
    let webview = child_webview(&app, &state, &args.browser_page_id)?;
    Ok(evaluate_browser_script(webview, args.script, false)
        .await
        .is_ok())
}

#[tauri::command]
pub async fn poc_browser_extract_hover_payload(
    app: AppHandle,
    state: State<'_, BrowserWebviewState>,
    args: BrowserGrabExtractArgs,
) -> Result<serde_json::Value, String> {
    validate_grab_script(&args.script)?;
    let webview = child_webview(&app, &state, &args.browser_page_id)?;
    let payload = match evaluate_browser_script(webview, args.script, false).await {
        Ok(value) if valid_grab_payload(&value) => value,
        Ok(_) => return Ok(grab_error_result(None, "no hovered element")),
        Err(reason) => return Ok(grab_error_result(None, reason)),
    };
    Ok(serde_json::json!({ "ok": true, "payload": payload }))
}

#[tauri::command]
pub async fn poc_browser_capture_selection_screenshot(
    app: AppHandle,
    state: State<'_, BrowserWebviewState>,
    args: BrowserGrabScreenshotArgs,
) -> Result<serde_json::Value, String> {
    validate_grab_script(&args.hide_script)?;
    validate_grab_script(&args.restore_script)?;
    let (x, y, width, height) = safe_grab_rect(&args.rect)?;
    let webview = child_webview(&app, &state, &args.browser_page_id)?;
    let _ = evaluate_browser_script(webview.clone(), args.hide_script, false).await;
    let capture = call_browser_devtools_protocol(
        webview.clone(),
        "Page.captureScreenshot",
        serde_json::json!({
            "format": "png",
            "fromSurface": true,
            "captureBeyondViewport": false,
            "clip": {
                "x": x,
                "y": y,
                "width": width,
                "height": height,
                "scale": 1,
            },
        })
        .to_string(),
    )
    .await;
    let _ = evaluate_browser_script(webview, args.restore_script, false).await;

    let response = capture?;
    let data = response
        .get("data")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "DevTools screenshot response did not contain data".to_string())?;
    let bytes = BASE64
        .decode(data)
        .map_err(|error| format!("invalid screenshot data: {error}"))?;
    if bytes.len() > MAX_GRAB_SCREENSHOT_BYTES {
        return Ok(grab_error_result(None, "screenshot-too-large"));
    }
    Ok(serde_json::json!({
        "ok": true,
        "screenshot": {
            "mimeType": "image/png",
            "dataUrl": format!("data:image/png;base64,{data}"),
            "width": width.round(),
            "height": height.round(),
        },
    }))
}

fn is_valid_annotation_token(value: &str) -> bool {
    (16..=80).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn is_valid_annotation_marker(marker: &serde_json::Value) -> bool {
    let Some(marker) = marker.as_object() else {
        return false;
    };
    let Some(id) = marker.get("id").and_then(serde_json::Value::as_str) else {
        return false;
    };
    let Some(index) = marker.get("index").and_then(serde_json::Value::as_i64) else {
        return false;
    };
    if marker
        .get("isFixed")
        .and_then(serde_json::Value::as_bool)
        .is_none()
    {
        return false;
    }
    let valid_rect = |value: Option<&serde_json::Value>| {
        let Some(rect) = value.and_then(serde_json::Value::as_object) else {
            return false;
        };
        ["x", "y", "width", "height"].iter().all(|key| {
            rect.get(*key)
                .and_then(serde_json::Value::as_f64)
                .is_some_and(f64::is_finite)
        })
    };
    !id.is_empty()
        && id.len() <= 100
        && (0..100).contains(&index)
        && valid_rect(marker.get("rectPage"))
        && valid_rect(marker.get("rectViewport"))
}

#[tauri::command]
pub fn poc_browser_set_annotation_viewport_bridge(
    app: AppHandle,
    state: State<BrowserWebviewState>,
    args: BrowserAnnotationViewportBridgeArgs,
) -> Result<bool, String> {
    if !is_valid_annotation_token(&args.token) {
        return Err("annotation viewport bridge token is invalid".to_string());
    }
    if args.markers.len() > 50 || !args.markers.iter().all(is_valid_annotation_marker) {
        return Err("annotation viewport bridge markers are invalid".to_string());
    }
    if args.script.len() > 512 * 1024 || args.script.is_empty() {
        return Err("annotation viewport bridge script is invalid".to_string());
    }
    let webview = child_webview(&app, &state, &args.browser_page_id)?;
    {
        let mut bridges = state
            .annotation_bridges
            .lock()
            .map_err(|_| "browser webview state is poisoned".to_string())?;
        if let Some(existing) = bridges.get(&args.browser_page_id) {
            if existing.token != args.token {
                return Err("annotation viewport bridge token does not own this page".to_string());
            }
        }
        if args.enabled {
            bridges.insert(
                args.browser_page_id.clone(),
                AnnotationBridgeConfig {
                    token: args.token,
                    script: args.script.clone(),
                },
            );
        } else {
            bridges.remove(&args.browser_page_id);
        }
    }
    webview
        .eval(args.script)
        .map_err(|error| error.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::{
        browser_context_menu_script, browser_guest_shortcut_script, certificate_endpoint,
        certificate_error_details, certificate_identity_matches, certificate_leaf_sha256,
        is_agent_injected_input, is_eligible_certificate_host, is_guest_edit_command, is_valid_annotation_marker,
        is_valid_annotation_token, label_for_page,
        navigation_failure_details, normalize_context_menu_link, oldest_certificate_challenge_page,
        oldest_certificate_grant_key, redact_kagi_session_token, store_identifier,
        AcceptedCertificateIdentity, AgentInputMark, BrowserWebviewState,
        PendingCertificateChallenge, BASE64,
    };
    use base64::Engine as _;
    use std::collections::HashMap;
    use std::time::{Duration, Instant};
    use tauri::Url;

    #[test]
    fn labels_are_stable_and_safe_for_tauri_webviews() {
        let first = label_for_page("page/with spaces");
        assert_eq!(first, label_for_page("page/with spaces"));
        assert!(first.starts_with("orca-browser-"));
        assert!(first
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-'));
    }

    #[test]
    fn agent_input_marks_drop_only_while_active() {
        let state = BrowserWebviewState::default();
        assert!(!is_agent_injected_input(&state, "page-1"));
        if let Ok(mut marks) = state.agent_input.lock() {
            marks.insert(
                "page-1".to_string(),
                AgentInputMark {
                    depth: 1,
                    last_end: None,
                },
            );
        }
        assert!(is_agent_injected_input(&state, "page-1"));
        assert!(!is_agent_injected_input(&state, "page-2"));
        // End of injection: depth is back to zero but the grace still covers
        // the dispatch-to-handle lag.
        if let Ok(mut marks) = state.agent_input.lock() {
            if let Some(mark) = marks.get_mut("page-1") {
                mark.depth = 0;
                mark.last_end = Some(Instant::now());
            }
        }
        assert!(is_agent_injected_input(&state, "page-1"));
        // A stale mark no longer drops physical keys.
        if let Ok(mut marks) = state.agent_input.lock() {
            if let Some(mark) = marks.get_mut("page-1") {
                mark.last_end = Some(Instant::now() - Duration::from_secs(1));
            }
        }
        assert!(!is_agent_injected_input(&state, "page-1"));
    }

    #[test]
    fn partition_identifiers_are_stable_and_16_bytes() {
        assert_eq!(
            store_identifier("persist:orca"),
            store_identifier("persist:orca")
        );
        assert_ne!(
            store_identifier("persist:orca"),
            store_identifier("persist:other")
        );
        assert_eq!(store_identifier("persist:orca").len(), 16);
    }

    #[test]
    fn annotation_tokens_and_markers_are_bounded() {
        assert!(is_valid_annotation_token("a".repeat(16).as_str()));
        assert!(!is_valid_annotation_token("short"));
        assert!(!is_valid_annotation_token(
            "a".repeat(16).replace('a', "!").as_str()
        ));

        let marker = serde_json::json!({
            "id": "note-1",
            "index": 0,
            "isFixed": false,
            "rectPage": {"x": 0.0, "y": 1.0, "width": 20.0, "height": 20.0},
            "rectViewport": {"x": 0.0, "y": 1.0, "width": 20.0, "height": 20.0}
        });
        assert!(is_valid_annotation_marker(&marker));
        assert!(!is_valid_annotation_marker(
            &serde_json::json!({"id": "note-1"})
        ));
    }

    #[test]
    fn navigation_failures_map_to_shared_error_codes() {
        assert_eq!(navigation_failure_details(1), None);
        assert_eq!(navigation_failure_details(5), None);
        assert_eq!(
            navigation_failure_details(12),
            Some((-102, "ERR_CONNECTION_REFUSED"))
        );
        assert_eq!(
            navigation_failure_details(13),
            Some((-105, "ERR_NAME_NOT_RESOLVED"))
        );
        assert_eq!(navigation_failure_details(14), Some((-3, "ERR_ABORTED")));
        assert_eq!(
            navigation_failure_details(0),
            Some((-102, "ERR_CONNECTION_REFUSED"))
        );
        assert_eq!(navigation_failure_details(99), None);
    }

    #[test]
    fn context_menu_urls_are_redacted_and_limited_to_browser_schemes() {
        assert_eq!(
            redact_kagi_session_token("https://kagi.com/search?token=secret&q=hello"),
            "https://kagi.com/search?q=hello"
        );
        assert_eq!(
            normalize_context_menu_link("https://example.com/docs"),
            Some("https://example.com/docs".to_string())
        );
        assert_eq!(normalize_context_menu_link("javascript:alert(1)"), None);
        assert!(browser_context_menu_script().contains("event.preventDefault()"));
    }

    #[test]
    fn guest_shortcut_script_only_forwards_shortcut_grade_keys() {
        let script = browser_guest_shortcut_script();
        assert!(script.contains("orca-guest-shortcut"));
        assert!(script.contains("chrome.webview"));
        assert!(script.contains("postMessage"));
        assert!(script.contains("keydown"));
        assert!(script.contains("keyup"));
        assert!(script.contains("Escape"));
    }

    #[test]
    fn guest_shortcut_script_suppresses_only_handled_chords() {
        let script = browser_guest_shortcut_script();
        assert!(script.contains("poc_browser_get_handled_shortcuts"));
        assert!(script.contains("browser:handled-shortcuts"));
        assert!(script.contains("preventDefault"));
        assert!(script.contains("isHandledChord"));
        // Auto-repeat falls through to the guest so held keys still re-fire
        // in-page (Electron before-input-event parity).
        assert!(script.contains("event.repeat !== true"));
        assert!(script.contains("__orcaGuestReplaceHandledChords"));
        assert!(script.contains("ctrl-tab-commit"));
        assert!(script.contains("isModifierKey"));
        assert!(script.contains("event.shiftKey"));
    }

    #[test]
    fn guest_shortcut_script_reports_dom_focus_state() {
        let script = browser_guest_shortcut_script();
        // The Edit > Copy/SelectAll/Paste menu handler routes by the most
        // recently reported focused guest.
        assert!(script.contains("type: focused ? 'focus' : 'blur'"));
        assert!(script.contains("document.hasFocus()"));
        assert!(script.contains("'focus'"));
        assert!(script.contains("'blur'"));
    }

    #[test]
    fn guest_shortcut_script_consumes_ctrl_wheel_as_zoom() {
        let script = browser_guest_shortcut_script();
        // Ctrl/Meta+wheel posts the shared zoom channel; Shift/Alt wheels and
        // bare scrolls stay with the page.
        assert!(script.contains("'wheel'"));
        assert!(script.contains("type: 'wheel-zoom'"));
        assert!(script.contains("direction: event.deltaY < 0 ? 'in' : 'out'"));
        assert!(script.contains("event.altKey === true || event.shiftKey === true"));
        assert!(script.contains("passive: false"));
    }

    #[test]
    fn certificate_statuses_preserve_shared_error_codes() {
        assert_eq!(
            certificate_error_details(1),
            Some((-200, "ERR_CERT_COMMON_NAME_INVALID"))
        );
        assert_eq!(
            certificate_error_details(2),
            Some((-201, "ERR_CERT_DATE_INVALID"))
        );
        assert_eq!(
            certificate_error_details(4),
            Some((-206, "ERR_CERT_REVOKED"))
        );
        assert_eq!(
            certificate_error_details(5),
            Some((-202, "ERR_CERT_AUTHORITY_INVALID"))
        );
        assert_eq!(certificate_error_details(99), None);
    }

    #[test]
    fn certificate_exception_hosts_are_local_only() {
        assert!(is_eligible_certificate_host("localhost"));
        assert!(is_eligible_certificate_host("API.LOCALHOST."));
        assert!(is_eligible_certificate_host("127.0.0.1"));
        assert!(is_eligible_certificate_host("127.42.7.9"));
        assert!(is_eligible_certificate_host("::1"));
        assert!(is_eligible_certificate_host("[::1]"));
        assert!(!is_eligible_certificate_host("[localhost"));
        assert!(!is_eligible_certificate_host("127.0.0.1]"));
        assert!(!is_eligible_certificate_host("128.0.0.1"));
        assert!(!is_eligible_certificate_host("192.168.1.10"));
        assert!(!is_eligible_certificate_host("example.com"));
    }

    #[test]
    fn certificate_endpoint_normalizes_scheme_host_and_port() {
        assert_eq!(
            certificate_endpoint(&Url::parse("https://LOCALHOST./path").unwrap()),
            Some("https://localhost:443".to_string())
        );
        assert_eq!(
            certificate_endpoint(&Url::parse("https://127.0.0.1:8443").unwrap()),
            Some("https://127.0.0.1:8443".to_string())
        );
        assert_eq!(
            certificate_endpoint(&Url::parse("wss://[::1]/socket").unwrap()),
            Some("wss://[::1]:443".to_string())
        );
        assert_eq!(
            certificate_endpoint(&Url::parse("http://localhost").unwrap()),
            None
        );
    }

    #[test]
    fn certificate_leaf_fingerprint_is_sha256_of_der_bytes() {
        let pem = format!(
            "-----BEGIN CERTIFICATE-----\n{}\n-----END CERTIFICATE-----",
            BASE64.encode(b"test-certificate-der")
        );
        assert_eq!(
            certificate_leaf_sha256(&pem),
            Some("69be57455b3b4f84c7c23140e875002791c5a5509ca9d0c644a63d5eaf836cce".to_string())
        );
    }

    #[test]
    fn accepted_certificate_identity_is_exact() {
        let accepted = AcceptedCertificateIdentity {
            secure_endpoint: "https://localhost:443".to_string(),
            leaf_certificate_sha256: "abc".to_string(),
            error: "ERR_CERT_AUTHORITY_INVALID".to_string(),
            accepted_at: 0,
        };
        assert!(certificate_identity_matches(
            &accepted,
            "https://localhost:443",
            "abc",
            "ERR_CERT_AUTHORITY_INVALID"
        ));
        assert!(!certificate_identity_matches(
            &accepted,
            "https://localhost:8443",
            "abc",
            "ERR_CERT_AUTHORITY_INVALID"
        ));
        assert!(!certificate_identity_matches(
            &accepted,
            "https://localhost:443",
            "different",
            "ERR_CERT_AUTHORITY_INVALID"
        ));
    }

    fn test_challenge(page_id: &str, observed_at: u64) -> PendingCertificateChallenge {
        PendingCertificateChallenge {
            challenge_id: format!("challenge-{page_id}"),
            browser_page_id: page_id.to_string(),
            navigation_url: "https://localhost/".to_string(),
            secure_endpoint: "https://localhost:443".to_string(),
            leaf_certificate_sha256: "abc".to_string(),
            error: "ERR_CERT_AUTHORITY_INVALID".to_string(),
            error_code: -202,
            origin: "https://localhost".to_string(),
            display_host: "localhost".to_string(),
            observed_at,
            expires_at: observed_at.saturating_add(300_000),
            navigation_epoch: 0,
        }
    }

    #[test]
    fn certificate_bounds_evict_oldest_first() {
        let mut challenges = HashMap::new();
        challenges.insert("new".to_string(), test_challenge("new", 200));
        challenges.insert("old".to_string(), test_challenge("old", 100));
        assert_eq!(
            oldest_certificate_challenge_page(&challenges),
            Some("old".to_string())
        );
        let mut grants = HashMap::new();
        grants.insert(
            "new".to_string(),
            AcceptedCertificateIdentity {
                secure_endpoint: "https://localhost:443".to_string(),
                leaf_certificate_sha256: "abc".to_string(),
                error: "ERR_CERT_AUTHORITY_INVALID".to_string(),
                accepted_at: 200,
            },
        );
        grants.insert(
            "old".to_string(),
            AcceptedCertificateIdentity {
                secure_endpoint: "https://localhost:443".to_string(),
                leaf_certificate_sha256: "abc".to_string(),
                error: "ERR_CERT_AUTHORITY_INVALID".to_string(),
                accepted_at: 100,
            },
        );
        assert_eq!(
            oldest_certificate_grant_key(&grants),
            Some("old".to_string())
        );
        assert_eq!(oldest_certificate_challenge_page(&HashMap::new()), None);
        assert_eq!(oldest_certificate_grant_key(&HashMap::new()), None);
    }

    #[test]
    fn guest_edit_allowlist_matches_menu_call_sites() {
        assert!(is_guest_edit_command("copy"));
        assert!(is_guest_edit_command("selectAll"));
        assert!(is_guest_edit_command("paste"));
        assert!(!is_guest_edit_command("cut"));
        assert!(!is_guest_edit_command(""));
        assert!(!is_guest_edit_command("document.cookie"));
    }
}
