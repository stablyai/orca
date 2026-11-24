#![allow(dead_code)]
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State, Url};

const PREVIEW_SCHEME: &str = "orca-preview";
const INTERNAL_SCHEME: &str = "orca-internal";
const MAX_TEXT_BYTES: u64 = 10 * 1024 * 1024;
const MAX_BINARY_BYTES: u64 = 50 * 1024 * 1024;
const UNSERVABLE_ASSET_MESSAGE: &str = "This workspace cannot send this file type to a preview.";
const AUTHORIZATION_REQUIRED_MESSAGE: &str =
    "This file needs permission before the preview can read it.";
const DOWNLOAD_NOTICE_FLOOR: Duration = Duration::from_secs(2);
const CSP: &str = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'";

#[derive(Debug, Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DocPreviewOwner {
    #[serde(rename_all = "camelCase")]
    Ssh { connection_id: String },
    #[serde(rename_all = "camelCase")]
    Runtime {
        environment_id: String,
        worktree_selector: String,
        worktree_root: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocPreviewGrantRequest {
    pub owner: DocPreviewOwner,
    pub request_base: String,
    pub root: String,
    pub entry_relative_path: String,
    pub browser_page_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocPreviewGrantResult {
    pub grant_id: String,
    pub url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocPreviewCacheFileRequest {
    pub grant_id: String,
    pub relative_path: String,
    pub file_path: String,
    pub content_base64: String,
    pub content_type: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DocPreviewResourceRequest {
    grant_id: String,
    browser_page_id: String,
    relative_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DocPreviewFailure {
    grant_id: String,
    relative_path: String,
    reason: &'static str,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DocPreviewDownloadBlocked {
    grant_id: String,
    reason: &'static str,
}

fn download_notice_due(last: Option<Instant>, now: Instant) -> bool {
    last.is_none_or(|noticed| now.saturating_duration_since(noticed) >= DOWNLOAD_NOTICE_FLOOR)
}

/// Refuse a download the way the Electron preview partition does: nothing is
/// reserved or written, and the shell learns through the failure channel — at
/// most once per grant per floor so a looping document cannot re-render it.
pub fn notice_preview_download_blocked(app: &AppHandle, state: &DocPreviewState, grant_id: &str) {
    let due = state
        .download_notices
        .lock()
        .map(|mut notices| {
            let now = Instant::now();
            notices.retain(|_, noticed| {
                now.saturating_duration_since(*noticed) < DOWNLOAD_NOTICE_FLOOR
            });
            if download_notice_due(notices.get(grant_id).copied(), now) {
                notices.insert(grant_id.to_string(), now);
                true
            } else {
                false
            }
        })
        .unwrap_or(false);
    if due {
        let _ = app.emit(
            "doc-preview:load-failure",
            DocPreviewDownloadBlocked {
                grant_id: grant_id.to_string(),
                reason: "download-blocked",
            },
        );
    }
}

#[derive(Debug)]
struct DocPreviewGrant {
    owner: DocPreviewOwner,
    request_base: PathBuf,
    root: PathBuf,
    entry_relative_path: String,
    entry_path: Option<PathBuf>,
    worktree_root: Option<PathBuf>,
    authorized_roots: Vec<PathBuf>,
    browser_page_id: String,
    ssh_request_base: Option<String>,
    ssh_root: Option<String>,
    ssh_entry_path: Option<String>,
    ssh_cached_files: HashMap<String, CachedDocPreviewFile>,
}

#[derive(Debug)]
struct CachedDocPreviewFile {
    content_type: &'static str,
    bytes: Vec<u8>,
}

#[derive(Default)]
pub struct DocPreviewState {
    grants: Mutex<HashMap<String, DocPreviewGrant>>,
    download_notices: Mutex<HashMap<String, Instant>>,
}

fn random_grant_id() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("Could not create preview grant: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn valid_nonempty(value: &str) -> bool {
    !value.trim().is_empty()
}

fn canonical_directory(path: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(path);
    if !candidate.is_absolute() {
        return Err("Document preview paths must be absolute.".to_string());
    }
    let canonical = fs::canonicalize(candidate).map_err(|error| error.to_string())?;
    if !canonical.is_dir() {
        return Err("Document preview path is not a directory.".to_string());
    }
    Ok(canonical)
}

fn safe_relative_path(relative_path: &str) -> Option<Vec<String>> {
    let segments = relative_path
        .split('/')
        .map(str::to_string)
        .collect::<Vec<_>>();
    let segments = segments
        .into_iter()
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    if segments.is_empty()
        || segments.iter().any(|segment| {
            segment == "." || segment == ".." || segment.contains('\\') || segment.contains('\0')
        })
    {
        return None;
    }
    Some(segments)
}

fn normalize_ssh_path(path: &str) -> Option<String> {
    if path.trim().is_empty() || path.contains('\\') || path.contains('\0') {
        return None;
    }
    let path = path.to_string();
    let (prefix, rest) = if path.starts_with('/') {
        ("/", path.as_str())
    } else if path.len() >= 3
        && path.as_bytes()[0].is_ascii_alphabetic()
        && path.as_bytes()[1] == b':'
        && path.as_bytes()[2] == b'/'
    {
        (&path[..3], &path[3..])
    } else {
        return None;
    };
    let mut segments = Vec::new();
    for segment in rest.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return None;
        }
        segments.push(segment);
    }
    if prefix == "/" {
        if segments.is_empty() {
            Some("/".to_string())
        } else {
            Some(format!("/{}", segments.join("/")))
        }
    } else if segments.is_empty() {
        Some(prefix.trim_end_matches('/').to_string())
    } else {
        Some(format!("{}{}", prefix, segments.join("/")))
    }
}

fn join_ssh_path(base: &str, relative_path: &str) -> Option<String> {
    let segments = safe_relative_path(relative_path)?;
    let base = normalize_ssh_path(base)?;
    if segments.is_empty() {
        return Some(base);
    }
    let separator = if base.ends_with('/') { "" } else { "/" };
    Some(format!("{}{}{}", base, separator, segments.join("/")))
}

fn ssh_path_is_under(path: &str, root: &str) -> bool {
    path == root
        || path
            .strip_prefix(root)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn ssh_parent(path: &str) -> Option<String> {
    let path = path.trim_end_matches('/');
    let separator = path.rfind('/')?;
    if separator == 0 {
        Some("/".to_string())
    } else {
        Some(path[..separator].to_string())
    }
}

fn is_ssh_authorized(grant: &DocPreviewGrant, target: &str) -> bool {
    if grant.ssh_entry_path.as_deref() == Some(target) {
        return true;
    }
    if let Some(root) = grant.ssh_root.as_deref() {
        if grant.ssh_request_base.as_deref() != Some(root) && ssh_path_is_under(target, root) {
            return true;
        }
    }
    grant.authorized_roots.iter().any(|root| {
        let root = root.to_string_lossy();
        ssh_path_is_under(target, &root)
    })
}

// Already-authorized coverage mirrors Electron directoryAuthorityRoots: the implicit
// root covers its subtree only when it differs from the request base, and every
// authorized root covers its own subtree. Exact equality would stack one redundant
// entry per subdirectory instead of stopping at the parent.
fn runtime_directory_already_authorized(grant: &DocPreviewGrant, directory: &Path) -> bool {
    if grant.root != grant.request_base && directory.starts_with(&grant.root) {
        return true;
    }
    grant
        .authorized_roots
        .iter()
        .any(|root| directory.starts_with(root))
}

fn ssh_directory_already_authorized(grant: &DocPreviewGrant, directory: &str) -> bool {
    if let Some(root) = grant.ssh_root.as_deref() {
        if grant.ssh_request_base.as_deref() != Some(root) && ssh_path_is_under(directory, root) {
            return true;
        }
    }
    grant.authorized_roots.iter().any(|root| {
        let root = root.to_string_lossy();
        ssh_path_is_under(directory, &root)
    })
}

fn candidate_path(grant: &DocPreviewGrant, relative_path: &str) -> Option<PathBuf> {
    let path = if relative_path.is_empty() {
        grant.entry_relative_path.as_str()
    } else {
        relative_path
    };
    let segments = safe_relative_path(path)?;
    let candidate = segments
        .iter()
        .fold(grant.request_base.clone(), |path, segment| {
            path.join(segment)
        });
    candidate
        .starts_with(&grant.request_base)
        .then_some(candidate)
}

fn is_authorized(grant: &DocPreviewGrant, target: &Path) -> bool {
    if grant.entry_path.as_deref() == Some(target) {
        return true;
    }
    let roots = grant
        .authorized_roots
        .iter()
        .chain((grant.root != grant.request_base).then_some(&grant.root));
    roots.into_iter().any(|root| target.starts_with(root))
}

fn is_preview_url(url: &Url) -> bool {
    url.scheme() == PREVIEW_SCHEME
        || (url.scheme() == "https" && url.host_str() == Some("orca-preview.localhost"))
}

fn decode_segment(value: &str) -> Option<String> {
    percent_decode_str(value)
        .decode_utf8()
        .ok()
        .map(|value| value.into_owned())
}

fn parse_preview_url(url: &Url) -> Option<(String, String)> {
    if !is_preview_url(url) {
        return None;
    }
    let mut segments = url.path_segments()?.filter(|segment| !segment.is_empty());
    let grant_id = if url.scheme() == PREVIEW_SCHEME {
        url.host_str()?.to_string()
    } else {
        decode_segment(segments.next()?)?
    };
    if grant_id.len() != 32 || !grant_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let relative = segments
        .map(decode_segment)
        .collect::<Option<Vec<_>>>()?
        .join("/");
    Some((grant_id, relative))
}

fn build_preview_url(grant_id: &str, relative_path: &str) -> String {
    let encoded = relative_path
        .replace('\\', "/")
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(|segment| utf8_percent_encode(segment, NON_ALPHANUMERIC).to_string())
        .collect::<Vec<_>>()
        .join("/");
    format!("{PREVIEW_SCHEME}://{grant_id}/{encoded}")
}
/// WRY rewrites only the initial webview URL to its http alias, so later
/// navigations to the raw scheme abort in WebView2 before reaching the handler.
pub fn preview_navigable_url(url: &str) -> String {
    if let Some(rest) = url.strip_prefix(&format!("{PREVIEW_SCHEME}://")) {
        format!("http://{PREVIEW_SCHEME}.{rest}")
    } else {
        url.to_string()
    }
}

/// Map a WRY alias navigation back to its preview URL for the gate check.
fn revert_preview_workaround(url: &Url) -> Option<Url> {
    if !matches!(url.scheme(), "http" | "https")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    let grant_host = url
        .host_str()?
        .strip_prefix(PREVIEW_SCHEME)?
        .strip_prefix(".")?;
    if grant_host.is_empty() || grant_host.contains(".") {
        return None;
    }
    let prefix = format!("{}://{}.", url.scheme(), PREVIEW_SCHEME);
    let rest = url.as_str().strip_prefix(prefix.as_str())?;
    Url::parse(&format!("{PREVIEW_SCHEME}://{rest}")).ok()
}

fn content_type(path: &Path) -> Option<(&'static str, bool)> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    let value = match extension.as_str() {
        "html" | "htm" => ("text/html; charset=utf-8", false),
        "css" => ("text/css; charset=utf-8", false),
        "js" | "mjs" => ("text/javascript; charset=utf-8", false),
        "json" => ("application/json; charset=utf-8", false),
        "txt" | "md" | "csv" => ("text/plain; charset=utf-8", false),
        "pdf" => ("application/pdf", true),
        "svg" => ("image/svg+xml", true),
        "png" => ("image/png", true),
        "jpg" | "jpeg" => ("image/jpeg", true),
        "gif" => ("image/gif", true),
        "webp" => ("image/webp", true),
        "bmp" => ("image/bmp", true),
        "ico" => ("image/x-icon", true),
        "woff" => ("font/woff", true),
        "woff2" => ("font/woff2", true),
        "ttf" => ("font/ttf", true),
        "otf" => ("font/otf", true),
        _ => return None,
    };
    Some(value)
}

/// Binary heuristic shared with the renderer direct-SSH reader: a NUL byte in
/// the first 8 KiB means binary.
fn is_binary_probe(bytes: &[u8]) -> bool {
    const BINARY_PROBE_BYTES: usize = 8192;
    bytes.iter().take(BINARY_PROBE_BYTES).any(|byte| *byte == 0)
}

/// Resolve the served MIME for a cached preview file. Unknown extensions fall
/// back to octet-stream for caller-decoded text (the renderer only omits the
/// content type for text); a caller-provided type for an unknown extension
/// stays rejected like before.
fn cache_mime_for(file_path: &Path, caller_type: Option<&str>) -> Option<(&'static str, bool)> {
    match (content_type(file_path), caller_type) {
        (Some(known), _) => Some(known),
        (None, None) => Some(("application/octet-stream", false)),
        (None, Some(_)) => None,
    }
}

fn response(status: u16, content_type: &str, body: Vec<u8>) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", content_type)
        .header("Content-Security-Policy", CSP)
        .header("Cache-Control", "no-store")
        .body(body)
        .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

fn failure_response(
    app: &AppHandle,
    grant_id: &str,
    relative_path: &str,
    reason: &'static str,
    status: u16,
    message: &str,
) -> tauri::http::Response<Vec<u8>> {
    let _ = app.emit(
        "doc-preview:load-failure",
        DocPreviewFailure {
            grant_id: grant_id.to_string(),
            relative_path: relative_path.to_string(),
            reason,
        },
    );
    response(
        status,
        "text/plain; charset=utf-8",
        message.as_bytes().to_vec(),
    )
}

pub fn handle_protocol_request(app: &AppHandle, uri: &str) -> tauri::http::Response<Vec<u8>> {
    let Ok(url) = Url::parse(uri) else {
        return response(404, "text/plain; charset=utf-8", b"Not found".to_vec());
    };
    let Some((grant_id, relative_path)) = parse_preview_url(&url) else {
        return response(404, "text/plain; charset=utf-8", b"Not found".to_vec());
    };
    let state = app.state::<DocPreviewState>();
    let Ok(grants) = state.grants.lock() else {
        return response(
            500,
            "text/plain; charset=utf-8",
            b"Preview unavailable".to_vec(),
        );
    };
    let Some(grant) = grants.get(&grant_id) else {
        return failure_response(
            app,
            &grant_id,
            &relative_path,
            "unreadable",
            404,
            "Not found",
        );
    };
    if matches!(grant.owner, DocPreviewOwner::Ssh { .. }) {
        let Some(candidate) = grant
            .ssh_request_base
            .as_deref()
            .and_then(|base| join_ssh_path(base, &relative_path))
        else {
            return failure_response(
                app,
                &grant_id,
                &relative_path,
                "unreadable",
                404,
                "Not found",
            );
        };
        if !is_ssh_authorized(grant, &candidate) {
            return failure_response(
                app,
                &grant_id,
                &relative_path,
                "authorization-required",
                403,
                AUTHORIZATION_REQUIRED_MESSAGE,
            );
        }
        if let Some(file) = grant.ssh_cached_files.get(&relative_path) {
            return response(200, file.content_type, file.bytes.clone());
        }
        let _ = app.emit(
            "doc-preview:resource-requested",
            DocPreviewResourceRequest {
                grant_id: grant_id.clone(),
                browser_page_id: grant.browser_page_id.clone(),
                relative_path: relative_path.clone(),
            },
        );
        return response(404, "text/plain; charset=utf-8", b"Loading".to_vec());
    }
    let Some(candidate) = candidate_path(grant, &relative_path) else {
        return failure_response(
            app,
            &grant_id,
            &relative_path,
            "unreadable",
            404,
            "Not found",
        );
    };
    let Ok(canonical_target) = fs::canonicalize(&candidate) else {
        return failure_response(
            app,
            &grant_id,
            &relative_path,
            "unreadable",
            404,
            "Not found",
        );
    };
    if !canonical_target.starts_with(&grant.request_base)
        || !grant
            .worktree_root
            .as_ref()
            .is_some_and(|root| canonical_target.starts_with(root))
    {
        return failure_response(
            app,
            &grant_id,
            &relative_path,
            "unreadable",
            404,
            "Not found",
        );
    }
    if !is_authorized(grant, &canonical_target) {
        return failure_response(
            app,
            &grant_id,
            &relative_path,
            "authorization-required",
            403,
            AUTHORIZATION_REQUIRED_MESSAGE,
        );
    }
    let known = content_type(&canonical_target);
    let Ok(metadata) = fs::metadata(&canonical_target) else {
        return failure_response(
            app,
            &grant_id,
            &relative_path,
            "unreadable",
            404,
            "Not found",
        );
    };
    // Named types keep their declared cap; unnamed paths cannot exceed the
    // binary cap before the content sniff below refines the limit.
    let early_limit = match known {
        Some((_, binary)) => {
            if binary {
                MAX_BINARY_BYTES
            } else {
                MAX_TEXT_BYTES
            }
        }
        None => MAX_BINARY_BYTES,
    };
    if metadata.len() > early_limit {
        return failure_response(
            app,
            &grant_id,
            &relative_path,
            "too-large",
            413,
            "This document is too large for the server to send in full.",
        );
    }
    let bytes = match fs::read(&canonical_target) {
        Ok(bytes) => bytes,
        Err(_) => {
            return failure_response(
                app,
                &grant_id,
                &relative_path,
                "unreadable",
                404,
                "Not found",
            );
        }
    };
    match known {
        Some((mime, _)) => response(200, mime, bytes),
        // No named type: mirror the octet-stream fallback for text the table
        // does not list, while content that looks binary keeps the 415 used
        // for a mime-less binary outcome.
        None if is_binary_probe(&bytes) => failure_response(
            app,
            &grant_id,
            &relative_path,
            "unsupported-asset",
            415,
            UNSERVABLE_ASSET_MESSAGE,
        ),
        None => {
            if bytes.len() as u64 > MAX_TEXT_BYTES {
                return failure_response(
                    app,
                    &grant_id,
                    &relative_path,
                    "too-large",
                    413,
                    "This document is too large for the server to send in full.",
                );
            }
            response(200, "application/octet-stream", bytes)
        }
    }
}

fn validate_request(request: &DocPreviewGrantRequest) -> Result<(), String> {
    if !valid_nonempty(&request.request_base)
        || !valid_nonempty(&request.root)
        || !valid_nonempty(&request.entry_relative_path)
        || !valid_nonempty(&request.browser_page_id)
    {
        return Err("Invalid document preview grant request.".to_string());
    }
    match &request.owner {
        DocPreviewOwner::Ssh { connection_id } => {
            if !valid_nonempty(connection_id) {
                return Err("Invalid SSH document preview owner.".to_string());
            }
        }
        DocPreviewOwner::Runtime {
            environment_id,
            worktree_selector,
            worktree_root,
        } => {
            if !valid_nonempty(environment_id)
                || !valid_nonempty(worktree_selector)
                || !valid_nonempty(worktree_root)
            {
                return Err("Invalid runtime document preview owner.".to_string());
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn poc_doc_preview_mint_grant(
    state: State<DocPreviewState>,
    request: DocPreviewGrantRequest,
) -> Result<DocPreviewGrantResult, String> {
    validate_request(&request)?;
    let entry_relative_path = request.entry_relative_path.replace('\\', "/");
    let (request_base, root, entry_path, worktree_root) = match &request.owner {
        DocPreviewOwner::Ssh { .. } => (PathBuf::new(), PathBuf::new(), None, None),
        DocPreviewOwner::Runtime { worktree_root, .. } => {
            let request_base = canonical_directory(&request.request_base)?;
            let root = canonical_directory(&request.root)?;
            if !root.starts_with(&request_base) {
                return Err("Document preview root is outside its request base.".to_string());
            }
            let worktree_root = canonical_directory(worktree_root)?;
            let entry_path = candidate_path(
                &DocPreviewGrant {
                    owner: request.owner.clone(),
                    request_base: request_base.clone(),
                    root: root.clone(),
                    entry_relative_path: entry_relative_path.clone(),
                    entry_path: None,
                    worktree_root: Some(worktree_root.clone()),
                    authorized_roots: Vec::new(),
                    browser_page_id: request.browser_page_id.clone(),
                    ssh_request_base: None,
                    ssh_root: None,
                    ssh_entry_path: None,
                    ssh_cached_files: HashMap::new(),
                },
                &entry_relative_path,
            )
            .ok_or_else(|| "Invalid document preview entry path.".to_string())?;
            let entry_path = fs::canonicalize(entry_path)
                .map_err(|error| format!("Document preview entry is unreadable: {error}"))?;
            if !entry_path.starts_with(&request_base) || !entry_path.is_file() {
                return Err("Document preview entry is outside its request base.".to_string());
            }
            (request_base, root, Some(entry_path), Some(worktree_root))
        }
    };
    let grant_id = random_grant_id()?;
    let url = build_preview_url(&grant_id, &entry_relative_path);
    let ssh_request_base = match &request.owner {
        DocPreviewOwner::Ssh { .. } => Some(
            normalize_ssh_path(&request.request_base)
                .ok_or_else(|| "Invalid SSH document preview request base.".to_string())?,
        ),
        DocPreviewOwner::Runtime { .. } => None,
    };
    let ssh_root = match &request.owner {
        DocPreviewOwner::Ssh { .. } => Some(
            normalize_ssh_path(&request.root)
                .ok_or_else(|| "Invalid SSH document preview root.".to_string())?,
        ),
        DocPreviewOwner::Runtime { .. } => None,
    };
    let ssh_entry_path = match &request.owner {
        DocPreviewOwner::Ssh { .. } => Some(
            join_ssh_path(&request.request_base, &entry_relative_path)
                .ok_or_else(|| "Invalid SSH document preview entry path.".to_string())?,
        ),
        DocPreviewOwner::Runtime { .. } => None,
    };
    let grant = DocPreviewGrant {
        owner: request.owner,
        request_base,
        root,
        entry_relative_path,
        entry_path,
        worktree_root,
        authorized_roots: Vec::new(),
        browser_page_id: request.browser_page_id,
        ssh_request_base,
        ssh_root,
        ssh_entry_path,
        ssh_cached_files: HashMap::new(),
    };
    let mut grants = state
        .grants
        .lock()
        .map_err(|_| "Document preview state is poisoned.".to_string())?;
    grants.retain(|_, existing| existing.browser_page_id != grant.browser_page_id);
    grants.insert(grant_id.clone(), grant);
    Ok(DocPreviewGrantResult { grant_id, url })
}

pub fn revoke_grants_for_page(state: &DocPreviewState, browser_page_id: &str) {
    let removed: Vec<String> = state
        .grants
        .lock()
        .map(|mut grants| {
            let removed = grants
                .iter()
                .filter(|(_, grant)| grant.browser_page_id == browser_page_id)
                .map(|(grant_id, _)| grant_id.clone())
                .collect();
            grants.retain(|_, grant| grant.browser_page_id != browser_page_id);
            removed
        })
        .unwrap_or_default();
    if let Ok(mut notices) = state.download_notices.lock() {
        for grant_id in removed {
            notices.remove(&grant_id);
        }
    }
}

#[tauri::command]
pub fn poc_doc_preview_revoke_grant(
    state: State<DocPreviewState>,
    grant_id: String,
) -> Result<bool, String> {
    let removed = state
        .grants
        .lock()
        .map_err(|_| "Document preview state is poisoned.".to_string())?
        .remove(&grant_id)
        .is_some();
    if removed {
        if let Ok(mut notices) = state.download_notices.lock() {
            notices.remove(&grant_id);
        }
    }
    Ok(removed)
}

#[tauri::command]
pub fn poc_doc_preview_authorize_directory(
    state: State<DocPreviewState>,
    grant_id: String,
    relative_path: String,
) -> Result<bool, String> {
    let mut grants = state
        .grants
        .lock()
        .map_err(|_| "Document preview state is poisoned.".to_string())?;
    let Some(grant) = grants.get_mut(&grant_id) else {
        return Ok(false);
    };
    if matches!(grant.owner, DocPreviewOwner::Ssh { .. }) {
        let Some(base) = grant.ssh_request_base.as_deref() else {
            return Ok(false);
        };
        let Some(candidate) = join_ssh_path(base, &relative_path) else {
            return Ok(false);
        };
        let Some(directory) = ssh_parent(&candidate) else {
            return Ok(false);
        };
        let Some(root) = grant.ssh_root.as_deref() else {
            return Ok(false);
        };
        if !ssh_path_is_under(&directory, base) || !ssh_path_is_under(&directory, root) {
            return Ok(false);
        }
        let already_authorized = ssh_directory_already_authorized(grant, &directory);
        if !already_authorized {
            grant.authorized_roots.push(PathBuf::from(directory));
        }
        return Ok(true);
    }
    let Some(candidate) = candidate_path(grant, &relative_path) else {
        return Ok(false);
    };
    let Ok(canonical_candidate) = fs::canonicalize(candidate) else {
        return Ok(false);
    };
    let Some(directory) = canonical_candidate.parent() else {
        return Ok(false);
    };
    let directory = directory.to_path_buf();
    if !directory.starts_with(&grant.request_base)
        || !grant
            .worktree_root
            .as_ref()
            .is_some_and(|root| directory.starts_with(root))
    {
        return Ok(false);
    }
    let already_authorized = runtime_directory_already_authorized(grant, &directory);
    if !already_authorized {
        grant.authorized_roots.push(directory);
    }
    Ok(true)
}

#[tauri::command]
pub fn poc_doc_preview_cache_file(
    state: State<DocPreviewState>,
    request: DocPreviewCacheFileRequest,
) -> Result<bool, String> {
    let mut grants = state
        .grants
        .lock()
        .map_err(|_| "Document preview state is poisoned.".to_string())?;
    let Some(grant) = grants.get_mut(&request.grant_id) else {
        return Ok(false);
    };
    if !matches!(grant.owner, DocPreviewOwner::Ssh { .. }) {
        return Ok(false);
    }
    let Some(base) = grant.ssh_request_base.as_deref() else {
        return Ok(false);
    };
    let Some(candidate) = join_ssh_path(base, &request.relative_path) else {
        return Ok(false);
    };
    let Some(file_path) = normalize_ssh_path(&request.file_path) else {
        return Ok(false);
    };
    if file_path != candidate || !is_ssh_authorized(grant, &candidate) {
        return Ok(false);
    }
    let Some((inferred_type, binary)) = cache_mime_for(
        Path::new(&request.file_path),
        request.content_type.as_deref(),
    ) else {
        return Ok(false);
    };
    if let Some(content_type) = request.content_type.as_deref() {
        let allowed = [
            "application/pdf",
            "image/bmp",
            "image/gif",
            "image/jpeg",
            "image/png",
            "image/svg+xml",
            "image/webp",
            "font/otf",
            "font/ttf",
            "font/woff",
            "font/woff2",
        ];
        if content_type != inferred_type && !allowed.contains(&content_type) {
            return Ok(false);
        }
    }
    let bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        request.content_base64.as_bytes(),
    )
    .map_err(|_| "Invalid document preview content.".to_string())?;
    let limit = if binary {
        MAX_BINARY_BYTES
    } else {
        MAX_TEXT_BYTES
    };
    if bytes.len() as u64 > limit {
        return Ok(false);
    }
    grant.ssh_cached_files.insert(
        request.relative_path,
        CachedDocPreviewFile {
            content_type: inferred_type,
            bytes,
        },
    );
    Ok(true)
}

pub fn grant_id_for_page(state: &DocPreviewState, browser_page_id: &str) -> Option<String> {
    state
        .grants
        .lock()
        .ok()?
        .iter()
        .find_map(|(grant_id, grant)| {
            (grant.browser_page_id == browser_page_id).then(|| grant_id.clone())
        })
}

pub fn handle_preview_navigation(
    app: &AppHandle,
    state: &DocPreviewState,
    browser_page_id: &str,
    url: &Url,
) -> Option<bool> {
    let grant_id = grant_id_for_page(state, browser_page_id)?;
    if is_preview_url(url) {
        return Some(parse_preview_url(url).is_some_and(|(candidate, _)| candidate == grant_id));
    }
    if let Some(raw) = revert_preview_workaround(url) {
        return Some(parse_preview_url(&raw).is_some_and(|(candidate, _)| candidate == grant_id));
    }
    if url.scheme() == INTERNAL_SCHEME && url.host_str() == Some("doc-preview-external-link") {
        let reported_grant = url
            .query_pairs()
            .find_map(|(key, value)| (key == "grantId").then(|| value.into_owned()));
        let target = url
            .query_pairs()
            .find_map(|(key, value)| (key == "url").then(|| value.into_owned()));
        if reported_grant.as_deref() == Some(grant_id.as_str())
            && target.as_deref().is_some_and(|target| {
                Url::parse(target)
                    .map(|url| matches!(url.scheme(), "http" | "https"))
                    .unwrap_or(false)
            })
        {
            let _ = app.emit(
                "doc-preview:external-link",
                serde_json::json!({
                    "browserPageId": browser_page_id,
                    "url": target.unwrap_or_default(),
                }),
            );
        }
        return Some(false);
    }
    if url.scheme() == INTERNAL_SCHEME && url.host_str() == Some("doc-preview-download-blocked") {
        let reported_grant = url
            .query_pairs()
            .find_map(|(key, value)| (key == "grantId").then(|| value.into_owned()));
        if reported_grant.as_deref() == Some(grant_id.as_str()) {
            notice_preview_download_blocked(app, state, &grant_id);
        }
        return Some(false);
    }
    if matches!(url.scheme(), "data" | "blob" | "devtools") {
        return Some(true);
    }
    if matches!(url.scheme(), "http" | "https" | "file") {
        return Some(false);
    }
    Some(false)
}

pub fn guest_script(grant_id: &str) -> String {
    let grant_id = serde_json::to_string(grant_id).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        r#"(() => {{
  const grantId = {grant_id};
  const signal = (url) => {{
    try {{ location.href = 'orca-internal://doc-preview-external-link?grantId=' + encodeURIComponent(grantId) + '&url=' + encodeURIComponent(url); }} catch {{}}
  }};
  if (globalThis.__orcaDocPreviewLinkBridge) return;
  globalThis.__orcaDocPreviewLinkBridge = true;
  const isPreviewAlias = (url) => url.protocol === 'http:' && typeof url.host === 'string' && url.host.indexOf('orca-preview.') === 0;
  const scrollToFragment = (fragment) => {{
    let target = document.getElementById(fragment);
    if (!target) {{
      try {{ target = document.getElementById(decodeURIComponent(fragment)); }} catch {{ target = null; }}
    }}
    if (target) {{ target.scrollIntoView(); return; }}
    if (fragment === 'top') {{ window.scrollTo(0, 0); }}
  }};
  const readAnchor = (event) => {{
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    for (const node of path) {{
      if (node && typeof node.tagName === 'string' && node.tagName.toUpperCase() === 'A') {{
        let raw = null;
        try {{ raw = node.getAttribute('href'); }} catch {{ raw = null; }}
        return {{ node, raw }};
      }}
    }}
    return null;
  }};
  document.addEventListener('click', (event) => {{
    if (!event.isTrusted || event.defaultPrevented || event.button !== 0) return;
    const anchor = readAnchor(event);
    if (!anchor) return;
    if (anchor.raw === '#') {{ event.preventDefault(); window.scrollTo(0, 0); return; }}
    let href = null;
    try {{
      const current = anchor.node.href;
      const base = current && current.baseVal !== undefined ? current.baseVal : current;
      href = new URL(base, location.href).toString();
    }} catch {{ return; }}
    const hashIndex = href.indexOf('#');
    if (hashIndex !== -1 && href.slice(0, hashIndex) === location.href.split('#')[0]) {{
      event.preventDefault();
      scrollToFragment(href.slice(hashIndex + 1));
      return;
    }}
    let url;
    try {{ url = new URL(href); }} catch {{ return; }}
    if (url.protocol === 'orca-preview:') {{
      event.preventDefault();
      event.stopPropagation();
      try {{ location.href = 'http://orca-preview.' + url.href.slice('orca-preview://'.length); }} catch {{}}
      return;
    }}
    if (isPreviewAlias(url)) {{
      let download = false;
      try {{ download = anchor.node.hasAttribute('download'); }} catch {{ download = false; }}
      if (download) {{
        event.preventDefault();
        event.stopPropagation();
        try {{ location.href = 'orca-internal://doc-preview-download-blocked?grantId=' + encodeURIComponent(grantId); }} catch {{}}
      }}
      return;
    }}
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    event.preventDefault();
    event.stopPropagation();
    signal(url.href);
  }}, true);
  document.addEventListener('auxclick', (event) => {{
    if (!event.isTrusted || event.button !== 1) return;
    if (readAnchor(event)) event.preventDefault();
  }}, true);
}})();"#
    )
}

#[cfg(test)]
mod tests {
    use super::{
        build_preview_url, cache_mime_for, download_notice_due, guest_script, is_binary_probe,
        parse_preview_url, preview_navigable_url, revert_preview_workaround,
        runtime_directory_already_authorized, safe_relative_path, ssh_directory_already_authorized,
        DocPreviewDownloadBlocked, DocPreviewGrant, DocPreviewOwner, DOWNLOAD_NOTICE_FLOOR,
    };
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::time::Instant;

    #[test]
    fn preview_alias_round_trips_through_wry_workaround() {
        let grant = "0123456789abcdef0123456789abcdef";
        let raw = build_preview_url(grant, "a b/index.html");
        let navigable = preview_navigable_url(&raw);
        assert_eq!(
            navigable,
            "http://orca-preview.0123456789abcdef0123456789abcdef/a%20b/index%2Ehtml"
        );
        let reverted = revert_preview_workaround(&tauri::Url::parse(&navigable).unwrap()).unwrap();
        let (candidate, relative) = parse_preview_url(&reverted).unwrap();
        assert_eq!(candidate, grant);
        assert_eq!(relative, "a b/index.html");
        assert_eq!(
            preview_navigable_url("https://example.com/x"),
            "https://example.com/x"
        );
        assert!(
            revert_preview_workaround(&tauri::Url::parse("http://example.com/x").unwrap())
                .is_none()
        );
        assert!(revert_preview_workaround(
            &tauri::Url::parse("http://orca-preview.a.b/x").unwrap()
        )
        .is_none());
        assert!(revert_preview_workaround(
            &tauri::Url::parse("http://orca-preview.a:8080/x").unwrap()
        )
        .is_none());
    }

    #[test]
    fn preview_urls_encode_segments_and_reject_traversal() {
        let url = build_preview_url("0123456789abcdef0123456789abcdef", "a b/index.html");
        assert_eq!(
            url,
            "orca-preview://0123456789abcdef0123456789abcdef/a%20b/index%2Ehtml"
        );
        assert!(safe_relative_path("assets/logo.png").is_some());
        assert!(safe_relative_path("../secret.txt").is_none());
        assert!(safe_relative_path("assets\\secret.txt").is_none());
    }

    fn runtime_grant(request_base: &str, root: &str, authorized: &[&str]) -> DocPreviewGrant {
        DocPreviewGrant {
            owner: DocPreviewOwner::Runtime {
                environment_id: String::from("env-1"),
                worktree_selector: String::from("sel"),
                worktree_root: String::from(request_base),
            },
            request_base: PathBuf::from(request_base),
            root: PathBuf::from(root),
            entry_relative_path: String::from("index.html"),
            entry_path: None,
            worktree_root: None,
            authorized_roots: authorized
                .iter()
                .map(|entry| PathBuf::from(*entry))
                .collect(),
            browser_page_id: String::from("page-1"),
            ssh_request_base: None,
            ssh_root: None,
            ssh_entry_path: None,
            ssh_cached_files: HashMap::new(),
        }
    }

    #[test]
    fn authorize_reuses_parent_directory_authorization() {
        let grant = runtime_grant("/base", "/base", &["/base/assets"]);
        assert!(runtime_directory_already_authorized(
            &grant,
            &PathBuf::from("/base/assets/sub")
        ));
        assert!(!runtime_directory_already_authorized(
            &grant,
            &PathBuf::from("/base/other")
        ));
    }

    #[test]
    fn authorize_honors_implicit_root_when_it_differs_from_base() {
        let grant = runtime_grant("/base", "/base/docs", &[]);
        assert!(runtime_directory_already_authorized(
            &grant,
            &PathBuf::from("/base/docs/sub")
        ));
    }

    fn ssh_grant(request_base: &str, root: &str, authorized: &[&str]) -> DocPreviewGrant {
        DocPreviewGrant {
            owner: DocPreviewOwner::Ssh {
                connection_id: String::from("conn-1"),
            },
            request_base: PathBuf::new(),
            root: PathBuf::new(),
            entry_relative_path: String::from("index.html"),
            entry_path: None,
            worktree_root: None,
            authorized_roots: authorized
                .iter()
                .map(|entry| PathBuf::from(*entry))
                .collect(),
            browser_page_id: String::from("page-1"),
            ssh_request_base: Some(String::from(request_base)),
            ssh_root: Some(String::from(root)),
            ssh_entry_path: None,
            ssh_cached_files: HashMap::new(),
        }
    }

    #[test]
    fn ssh_authorize_reuses_parent_directory_authorization() {
        let grant = ssh_grant("/docs", "/docs", &["/docs/assets"]);
        assert!(ssh_directory_already_authorized(&grant, "/docs/assets/sub"));
        assert!(!ssh_directory_already_authorized(&grant, "/docs/other"));
    }

    #[test]
    fn binary_probe_uses_nul_in_first_8kib() {
        assert!(!is_binary_probe(b"plain text"));
        assert!(is_binary_probe(b"\0binary"));
        let mut edge = vec![97u8; 8192];
        edge[8191] = 0;
        assert!(is_binary_probe(&edge));
        let mut past = vec![97u8; 8193];
        past[8192] = 0;
        assert!(!is_binary_probe(&past));
    }

    #[test]
    fn cache_mime_falls_back_to_octet_stream_for_text() {
        assert_eq!(
            cache_mime_for(Path::new("notes.md"), None),
            Some(("text/plain; charset=utf-8", false))
        );
        assert_eq!(
            cache_mime_for(Path::new("notes.ts"), None),
            Some(("application/octet-stream", false))
        );
        assert_eq!(
            cache_mime_for(Path::new("logo.png"), None),
            Some(("image/png", true))
        );
        assert_eq!(
            cache_mime_for(Path::new("data.bin"), Some("image/png")),
            None
        );
    }

    #[test]
    fn owner_wire_shape_matches_renderer_camel_case() {
        let ssh: DocPreviewOwner =
            serde_json::from_str(r#"{"kind":"ssh","connectionId":"conn-1"}"#)
                .expect("ssh owner shape");
        assert!(matches!(ssh, DocPreviewOwner::Ssh { .. }));
        let runtime: DocPreviewOwner = serde_json::from_str(
            r#"{"kind":"runtime","environmentId":"e","worktreeSelector":"s","worktreeRoot":"r"}"#,
        )
        .expect("runtime owner shape");
        match runtime {
            DocPreviewOwner::Runtime {
                environment_id,
                worktree_selector,
                worktree_root,
            } => {
                assert_eq!(environment_id, "e");
                assert_eq!(worktree_selector, "s");
                assert_eq!(worktree_root, "r");
            }
            DocPreviewOwner::Ssh { .. } => panic!("wrong variant"),
        }
    }
    #[test]
    fn guest_link_bridge_keeps_fragments_and_siblings_in_page() {
        let script = guest_script("0123456789abcdef0123456789abcdef");
        for marker in [
            "__orcaDocPreviewLinkBridge",
            "isTrusted",
            "composedPath",
            "scrollIntoView",
            "auxclick",
            "orca-preview.",
            "doc-preview-external-link",
            "doc-preview-external-link",
            "doc-preview-download-blocked",
            "hasAttribute",
        ] {
            assert!(script.contains(marker), "guest script lost {marker}");
        }
    }
    #[test]
    fn download_blocked_notice_carries_no_path() {
        let payload = DocPreviewDownloadBlocked {
            grant_id: String::from("0123456789abcdef0123456789abcdef"),
            reason: "download-blocked",
        };
        assert_eq!(
            serde_json::to_value(&payload).expect("notice serializes"),
            serde_json::json!({
                "grantId": "0123456789abcdef0123456789abcdef",
                "reason": "download-blocked",
            })
        );
    }

    #[test]
    fn download_notice_floor_suppresses_repeats() {
        let now = Instant::now();
        assert!(download_notice_due(None, now));
        assert!(!download_notice_due(Some(now), now));
        assert!(download_notice_due(Some(now - DOWNLOAD_NOTICE_FLOOR), now));
    }
}
