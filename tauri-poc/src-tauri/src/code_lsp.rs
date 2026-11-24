//! Native LSP lifecycle, document sync, requests, and workspace edit application.
//!
//! Coordinates crossing the IPC boundary with Orca's renderer are 1-based
//! (`line`, `column` in UTF-16 code units) to match CodeMirror `doc.line(n)`.
//! LSP wire JSON uses 0-based coordinates, converted at this boundary.

use crate::code_lsp_convert::{
    parse_completion_response, parse_diagnostics_params, parse_document_symbols_response,
    parse_hover_response, parse_locations_response, parse_prepare_rename_response,
    parse_signature_help_response, parse_workspace_edit_response, CodeCompletionItem,
    CodeDiagnostic, CodeDocumentSymbol, CodeFileEdits, CodeHover, CodeNavigationResult,
    CodePrepareRename, CodeSignatureHelp, CodeTextEdit, CodeWorkspaceEdit,
};
use crate::code_lsp_servers::{
    build_spawn_env_with_tools, canonical_language_id, collect_server_statuses,
    detect_project_root, install_server, select_server_for_language, LspServerStatusDto,
};
use crate::code_lsp_uri::{normalize_path_key, path_to_uri_string};
use crate::code_nav_fallback::{
    extract_identifier_at, fallback_definition, fallback_document_symbols, fallback_references,
};
use ide_jsonrpc::{codes, Handler, Peer};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

pub const EVENT_LSP_DIAGNOSTICS: &str = "lsp:diagnostics";
pub const EVENT_LSP_STATUS: &str = "lsp:status";

const INIT_TIMEOUT: Duration = Duration::from_secs(20);
const QUERY_TIMEOUT: Duration = Duration::from_secs(6);
const COMPLETION_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDiagnosticsEvent {
    pub file_path: String,
    pub file_key: String,
    pub diagnostics: Vec<CodeDiagnostic>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspStatusEvent {
    pub server_id: String,
    pub root_path: String,
    pub status: String,
    pub message: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct ServerKey {
    server_id: String,
    root_key: String,
}

struct RunningServer {
    server_id: String,
    peer: Peer,
    opened_uris: Mutex<HashSet<String>>,
}

struct OpenDocRecord {
    file_path: PathBuf,
    uri: String,
    language_id: String,
    workspace_root: Option<PathBuf>,
    version: i32,
    text: String,
}

struct LspRpcHandler {
    app: AppHandle,
    root_uri: String,
    root_name: String,
}

impl Handler for LspRpcHandler {
    fn on_notification(&self, method: &str, params: Value) {
        if method == "textDocument/publishDiagnostics" {
            if let Some((file_path, diagnostics)) = parse_diagnostics_params(&params) {
                let file_key = normalize_path_key(&file_path);
                let _ = self.app.emit(
                    EVENT_LSP_DIAGNOSTICS,
                    LspDiagnosticsEvent {
                        file_path,
                        file_key,
                        diagnostics,
                    },
                );
            }
        }
    }

    fn on_request(&self, method: &str, params: Value) -> Result<Value, (i64, String)> {
        match method {
            "workspace/configuration" => {
                let count = params
                    .get("items")
                    .and_then(|v| v.as_array())
                    .map(|a| a.len())
                    .unwrap_or(1);
                Ok(Value::Array(vec![json!({}); count]))
            }
            "workspace/workspaceFolders" => Ok(json!([{
                "uri": self.root_uri,
                "name": self.root_name,
            }])),
            "client/registerCapability"
            | "client/unregisterCapability"
            | "window/workDoneProgress/create" => Ok(Value::Null),
            "workspace/applyEdit" => Ok(json!({ "applied": false })),
            _ => Err((codes::METHOD_NOT_FOUND, format!("Unhandled method {method}"))),
        }
    }
}

pub struct CodeLspState {
    app: AppHandle,
    server_locks: Mutex<HashMap<ServerKey, Arc<Mutex<Option<Arc<RunningServer>>>>>>,
    open_docs: Mutex<HashMap<String, OpenDocRecord>>,
}

impl CodeLspState {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            server_locks: Mutex::new(HashMap::new()),
            open_docs: Mutex::new(HashMap::new()),
        }
    }

    fn emit_status(&self, server_id: &str, root_path: &Path, status: &str, message: Option<String>) {
        let _ = self.app.emit(
            EVENT_LSP_STATUS,
            LspStatusEvent {
                server_id: server_id.to_string(),
                root_path: root_path.to_string_lossy().into_owned(),
                status: status.to_string(),
                message,
            },
        );
    }

    async fn get_server_slot(&self, key: ServerKey) -> Arc<Mutex<Option<Arc<RunningServer>>>> {
        let mut map = self.server_locks.lock().await;
        map.entry(key)
            .or_insert_with(|| Arc::new(Mutex::new(None)))
            .clone()
    }

    async fn running_server_ids(&self) -> HashSet<String> {
        let slots: Vec<(String, Arc<Mutex<Option<Arc<RunningServer>>>>)> = {
            let map = self.server_locks.lock().await;
            map.iter()
                .map(|(k, slot)| (k.server_id.clone(), slot.clone()))
                .collect()
        };
        let mut ids = HashSet::new();
        for (id, slot) in slots {
            if let Ok(guard) = slot.try_lock() {
                if let Some(srv) = guard.as_ref() {
                    if !srv.peer.is_closed() {
                        ids.insert(id);
                    }
                }
            }
        }
        ids
    }

    async fn ensure_server_for_doc(
        &self,
        file_path: &Path,
        workspace_root: Option<&Path>,
        language_id: &str,
        text: Option<&str>,
    ) -> Option<Arc<RunningServer>> {
        let (spec, bin_path) = select_server_for_language(language_id, workspace_root)?;
        let project_root = detect_project_root(file_path, workspace_root, spec.root_markers);
        let root_key = normalize_path_key(&project_root.to_string_lossy());
        let key = ServerKey {
            server_id: spec.id.to_string(),
            root_key,
        };
        let slot = self.get_server_slot(key).await;
        let mut guard = slot.lock().await;

        let needs_start = match guard.as_ref() {
            Some(existing) => existing.peer.is_closed(),
            None => true,
        };

        if needs_start {
            self.emit_status(spec.id, &project_root, "starting", None);
            let root_uri = path_to_uri_string(&project_root);
            let root_name = project_root
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("workspace")
                .to_string();
            let handler = Arc::new(LspRpcHandler {
                app: self.app.clone(),
                root_uri: root_uri.clone(),
                root_name: root_name.clone(),
            });
            let args: Vec<String> = spec.args.iter().map(|s| (*s).to_string()).collect();
            let env = build_spawn_env_with_tools();
            let cmd_str = bin_path.to_string_lossy().into_owned();
            let spawned = Peer::spawn(
                &cmd_str,
                &args,
                &project_root,
                &env,
                handler,
                Box::new(|_line| {}),
            );
            let peer = match spawned {
                Ok(p) => p,
                Err(err) => {
                    self.emit_status(spec.id, &project_root, "error", Some(err.to_string()));
                    return None;
                }
            };

            let init_params = json!({
                "processId": std::process::id(),
                "rootUri": root_uri,
                "workspaceFolders": [{ "uri": path_to_uri_string(&project_root), "name": root_name }],
                "capabilities": {
                    "textDocument": {
                        "synchronization": {
                            "dynamicRegistration": false,
                            "didSave": true,
                            "willSave": false,
                            "willSaveWaitUntil": false
                        },
                        "hover": { "contentFormat": ["markdown", "plaintext"] },
                        "completion": {
                            "completionItem": {
                                "snippetSupport": false,
                                "documentationFormat": ["markdown", "plaintext"]
                            }
                        },
                        "signatureHelp": {
                            "signatureInformation": {
                                "documentationFormat": ["markdown", "plaintext"],
                                "parameterInformation": { "labelOffsetSupport": true }
                            }
                        },
                        "definition": { "linkSupport": true },
                        "declaration": { "linkSupport": true },
                        "typeDefinition": { "linkSupport": true },
                        "implementation": { "linkSupport": true },
                        "references": {},
                        "documentSymbol": { "hierarchicalDocumentSymbolSupport": true },
                        "rename": { "prepareSupport": true },
                        "publishDiagnostics": { "relatedInformation": false }
                    },
                    "workspace": {
                        "workspaceFolders": true,
                        "configuration": true
                    }
                }
            });

            let init_res =
                tokio::time::timeout(INIT_TIMEOUT, peer.request::<Value, Value>("initialize", init_params, None)).await;
            match init_res {
                Ok(Ok(_)) => {
                    let _ = peer.notify("initialized", json!({}));
                    self.emit_status(spec.id, &project_root, "ready", None);
                }
                Ok(Err(err)) => {
                    peer.kill();
                    self.emit_status(spec.id, &project_root, "error", Some(err.to_string()));
                    return None;
                }
                Err(_) => {
                    peer.kill();
                    self.emit_status(
                        spec.id,
                        &project_root,
                        "error",
                        Some("Language server initialization timed out".to_string()),
                    );
                    return None;
                }
            }

            let srv = Arc::new(RunningServer {
                server_id: spec.id.to_string(),
                peer,
                opened_uris: Mutex::new(HashSet::new()),
            });
            *guard = Some(srv.clone());
        }

        let srv = guard.clone()?;
        drop(guard);

        let file_key = normalize_path_key(&file_path.to_string_lossy());
        let uri = path_to_uri_string(file_path);
        let mut opened = srv.opened_uris.lock().await;
        if !opened.contains(&uri) {
            let doc_text = {
                let docs = self.open_docs.lock().await;
                if let Some(rec) = docs.get(&file_key) {
                    (rec.version, rec.text.clone())
                } else if let Some(t) = text {
                    (1, t.to_string())
                } else {
                    (1, std::fs::read_to_string(file_path).unwrap_or_default())
                }
            };
            let _ = srv.peer.notify(
                "textDocument/didOpen",
                json!({
                    "textDocument": {
                        "uri": uri,
                        "languageId": language_id,
                        "version": doc_text.0,
                        "text": doc_text.1,
                    }
                }),
            );
            opened.insert(uri);
        } else if let Some(next_text) = text {
            let version_opt = {
                let mut docs = self.open_docs.lock().await;
                docs.get_mut(&file_key).and_then(|rec| {
                    if rec.text != next_text {
                        rec.version += 1;
                        rec.text = next_text.to_string();
                        Some(rec.version)
                    } else {
                        None
                    }
                })
            };
            if let Some(version) = version_opt {
                drop(opened);
                let _ = srv.peer.notify(
                    "textDocument/didChange",
                    json!({
                        "textDocument": { "uri": uri, "version": version },
                        "contentChanges": [{ "text": next_text }]
                    }),
                );
                return Some(srv);
            }
        }
        drop(opened);
        Some(srv)
    }

    async fn resolve_doc_text(&self, file_path: &Path, provided: Option<String>) -> String {
        if let Some(text) = provided {
            return text;
        }
        let key = normalize_path_key(&file_path.to_string_lossy());
        if let Some(rec) = self.open_docs.lock().await.get(&key) {
            return rec.text.clone();
        }
        std::fs::read_to_string(file_path).unwrap_or_default()
    }
}

async fn lsp_pos_request(
    server: &RunningServer,
    method: &str,
    file_path: &Path,
    line1: u32,
    col1: u32,
    timeout: Duration,
) -> Result<Value, String> {
    let uri = path_to_uri_string(file_path);
    let params = json!({
        "textDocument": { "uri": uri },
        "position": {
            "line": line1.saturating_sub(1),
            "character": col1.saturating_sub(1),
        }
    });
    tokio::time::timeout(timeout, server.peer.request::<Value, Value>(method, params, None))
        .await
        .map_err(|_| format!("{method} timed out"))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn poc_lsp_did_open(
    state: State<'_, CodeLspState>,
    file_path: String,
    workspace_root: Option<String>,
    language: String,
    text: String,
) -> Result<(), String> {
    let path = PathBuf::from(&file_path);
    let lang_id = canonical_language_id(&language, &path);
    let ws = workspace_root.filter(|s| !s.is_empty()).map(PathBuf::from);
    let key = normalize_path_key(&file_path);
    let uri = path_to_uri_string(&path);
    {
        let mut docs = state.open_docs.lock().await;
        docs.insert(
            key,
            OpenDocRecord {
                file_path: path.clone(),
                uri,
                language_id: lang_id.clone(),
                workspace_root: ws.clone(),
                version: 1,
                text: text.clone(),
            },
        );
    }
    let state_ws = ws.as_deref();
    let _ = state
        .ensure_server_for_doc(&path, state_ws, &lang_id, Some(&text))
        .await;
    Ok(())
}

#[tauri::command]
pub async fn poc_lsp_did_change(
    state: State<'_, CodeLspState>,
    file_path: String,
    workspace_root: Option<String>,
    language: String,
    text: String,
) -> Result<(), String> {
    let path = PathBuf::from(&file_path);
    let lang_id = canonical_language_id(&language, &path);
    let ws = workspace_root.filter(|s| !s.is_empty()).map(PathBuf::from);
    let key = normalize_path_key(&file_path);
    {
        let mut docs = state.open_docs.lock().await;
        if let Some(rec) = docs.get_mut(&key) {
            if rec.text == text {
                return Ok(());
            }
            rec.language_id = lang_id.clone();
            rec.workspace_root = ws.clone();
        } else {
            docs.insert(
                key,
                OpenDocRecord {
                    file_path: path.clone(),
                    uri: path_to_uri_string(&path),
                    language_id: lang_id.clone(),
                    workspace_root: ws.clone(),
                    version: 1,
                    text: String::new(),
                },
            );
        }
    }
    let _ = state
        .ensure_server_for_doc(&path, ws.as_deref(), &lang_id, Some(&text))
        .await;
    Ok(())
}

#[tauri::command]
pub async fn poc_lsp_did_save(
    state: State<'_, CodeLspState>,
    file_path: String,
    text: Option<String>,
) -> Result<(), String> {
    let key = normalize_path_key(&file_path);
    let rec_opt = {
        let mut docs = state.open_docs.lock().await;
        if let Some(rec) = docs.get_mut(&key) {
            if let Some(next_text) = text.as_ref() {
                rec.text = next_text.clone();
            }
            Some((
                rec.file_path.clone(),
                rec.uri.clone(),
                rec.language_id.clone(),
                rec.workspace_root.clone(),
                rec.text.clone(),
            ))
        } else {
            None
        }
    };
    if let Some((path, uri, lang_id, ws, saved_text)) = rec_opt {
        if let Some(srv) = state
            .ensure_server_for_doc(&path, ws.as_deref(), &lang_id, Some(&saved_text))
            .await
        {
            let _ = srv.peer.notify(
                "textDocument/didSave",
                json!({
                    "textDocument": { "uri": uri },
                    "text": saved_text,
                }),
            );
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn poc_lsp_did_close(
    state: State<'_, CodeLspState>,
    file_path: String,
) -> Result<(), String> {
    let key = normalize_path_key(&file_path);
    let removed = state.open_docs.lock().await.remove(&key);
    let Some(rec) = removed else {
        return Ok(());
    };
    let slots: Vec<Arc<Mutex<Option<Arc<RunningServer>>>>> = {
        let map = state.server_locks.lock().await;
        map.values().cloned().collect()
    };
    for slot in slots {
        let srv_opt = { slot.lock().await.clone() };
        if let Some(srv) = srv_opt {
            let mut opened = srv.opened_uris.lock().await;
            if opened.remove(&rec.uri) && !srv.peer.is_closed() {
                let _ = srv.peer.notify(
                    "textDocument/didClose",
                    json!({ "textDocument": { "uri": rec.uri } }),
                );
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn poc_lsp_definition(
    state: State<'_, CodeLspState>,
    file_path: String,
    workspace_root: Option<String>,
    language: String,
    line: u32,
    column: u32,
    kind: Option<String>,
    text: Option<String>,
) -> Result<CodeNavigationResult, String> {
    let path = PathBuf::from(&file_path);
    let ws = workspace_root.filter(|s| !s.is_empty()).map(PathBuf::from);
    let lang_id = canonical_language_id(&language, &path);
    let live_text = state.resolve_doc_text(&path, text).await;
    let goto_kind = kind.unwrap_or_else(|| "definition".to_string());
    let method = match goto_kind.as_str() {
        "declaration" => "textDocument/declaration",
        "typeDefinition" => "textDocument/typeDefinition",
        "implementation" => "textDocument/implementation",
        _ => "textDocument/definition",
    };

    if let Some(srv) = state
        .ensure_server_for_doc(&path, ws.as_deref(), &lang_id, Some(&live_text))
        .await
    {
        if let Ok(val) = lsp_pos_request(&srv, method, &path, line, column, QUERY_TIMEOUT).await {
            let locs = parse_locations_response(val);
            if !locs.is_empty() {
                return Ok(CodeNavigationResult {
                    source: "lsp".to_string(),
                    server_id: Some(srv.server_id.clone()),
                    locations: locs,
                });
            }
        }
    }

    if goto_kind == "definition" || goto_kind == "declaration" {
        let fb = fallback_definition(&path, ws.as_deref(), &lang_id, &live_text, line, column);
        return Ok(CodeNavigationResult {
            source: "fallback".to_string(),
            server_id: None,
            locations: fb,
        });
    }

    Ok(CodeNavigationResult {
        source: "fallback".to_string(),
        server_id: None,
        locations: Vec::new(),
    })
}

#[tauri::command]
pub async fn poc_lsp_references(
    state: State<'_, CodeLspState>,
    file_path: String,
    workspace_root: Option<String>,
    language: String,
    line: u32,
    column: u32,
    include_declaration: Option<bool>,
    text: Option<String>,
) -> Result<CodeNavigationResult, String> {
    let path = PathBuf::from(&file_path);
    let ws = workspace_root.filter(|s| !s.is_empty()).map(PathBuf::from);
    let lang_id = canonical_language_id(&language, &path);
    let live_text = state.resolve_doc_text(&path, text).await;

    if let Some(srv) = state
        .ensure_server_for_doc(&path, ws.as_deref(), &lang_id, Some(&live_text))
        .await
    {
        let uri = path_to_uri_string(&path);
        let params = json!({
            "textDocument": { "uri": uri },
            "position": { "line": line.saturating_sub(1), "character": column.saturating_sub(1) },
            "context": { "includeDeclaration": include_declaration.unwrap_or(true) }
        });
        if let Ok(Ok(val)) = tokio::time::timeout(
            QUERY_TIMEOUT,
            srv.peer.request::<Value, Value>("textDocument/references", params, None),
        )
        .await
        {
            let locs = parse_locations_response(val);
            if !locs.is_empty() {
                return Ok(CodeNavigationResult {
                    source: "lsp".to_string(),
                    server_id: Some(srv.server_id.clone()),
                    locations: locs,
                });
            }
        }
    }

    let fb = fallback_references(&path, ws.as_deref(), &live_text, line, column);
    Ok(CodeNavigationResult {
        source: "fallback".to_string(),
        server_id: None,
        locations: fb,
    })
}

#[tauri::command]
pub async fn poc_lsp_hover(
    state: State<'_, CodeLspState>,
    file_path: String,
    workspace_root: Option<String>,
    language: String,
    line: u32,
    column: u32,
    text: Option<String>,
) -> Result<Option<CodeHover>, String> {
    let path = PathBuf::from(&file_path);
    let ws = workspace_root.filter(|s| !s.is_empty()).map(PathBuf::from);
    let lang_id = canonical_language_id(&language, &path);
    let live_text = state.resolve_doc_text(&path, text).await;

    let Some(srv) = state
        .ensure_server_for_doc(&path, ws.as_deref(), &lang_id, Some(&live_text))
        .await
    else {
        return Ok(None);
    };
    let val = match lsp_pos_request(
        &srv,
        "textDocument/hover",
        &path,
        line,
        column,
        Duration::from_secs(4),
    )
    .await
    {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    Ok(parse_hover_response(val))
}

#[tauri::command]
pub async fn poc_lsp_completion(
    state: State<'_, CodeLspState>,
    file_path: String,
    workspace_root: Option<String>,
    language: String,
    line: u32,
    column: u32,
    trigger_character: Option<String>,
    text: Option<String>,
) -> Result<Vec<CodeCompletionItem>, String> {
    let path = PathBuf::from(&file_path);
    let ws = workspace_root.filter(|s| !s.is_empty()).map(PathBuf::from);
    let lang_id = canonical_language_id(&language, &path);
    let live_text = state.resolve_doc_text(&path, text).await;

    let Some(srv) = state
        .ensure_server_for_doc(&path, ws.as_deref(), &lang_id, Some(&live_text))
        .await
    else {
        return Ok(Vec::new());
    };
    let uri = path_to_uri_string(&path);
    let context = if let Some(ch) = trigger_character.filter(|s| !s.is_empty()) {
        json!({ "triggerKind": 2, "triggerCharacter": ch })
    } else {
        json!({ "triggerKind": 1 })
    };
    let params = json!({
        "textDocument": { "uri": uri },
        "position": { "line": line.saturating_sub(1), "character": column.saturating_sub(1) },
        "context": context
    });
    let val = match tokio::time::timeout(
        COMPLETION_TIMEOUT,
        srv.peer.request::<Value, Value>("textDocument/completion", params, None),
    )
    .await
    {
        Ok(Ok(v)) => v,
        _ => return Ok(Vec::new()),
    };
    Ok(parse_completion_response(val))
}

#[tauri::command]
pub async fn poc_lsp_signature_help(
    state: State<'_, CodeLspState>,
    file_path: String,
    workspace_root: Option<String>,
    language: String,
    line: u32,
    column: u32,
    text: Option<String>,
) -> Result<Option<CodeSignatureHelp>, String> {
    let path = PathBuf::from(&file_path);
    let ws = workspace_root.filter(|s| !s.is_empty()).map(PathBuf::from);
    let lang_id = canonical_language_id(&language, &path);
    let live_text = state.resolve_doc_text(&path, text).await;

    let Some(srv) = state
        .ensure_server_for_doc(&path, ws.as_deref(), &lang_id, Some(&live_text))
        .await
    else {
        return Ok(None);
    };
    let val = match lsp_pos_request(
        &srv,
        "textDocument/signatureHelp",
        &path,
        line,
        column,
        COMPLETION_TIMEOUT,
    )
    .await
    {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    Ok(parse_signature_help_response(val))
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeOutlineResult {
    pub source: String,
    pub symbols: Vec<CodeDocumentSymbol>,
}

#[tauri::command]
pub async fn poc_lsp_document_symbols(
    state: State<'_, CodeLspState>,
    file_path: String,
    workspace_root: Option<String>,
    language: String,
    text: Option<String>,
) -> Result<CodeOutlineResult, String> {
    let path = PathBuf::from(&file_path);
    let ws = workspace_root.filter(|s| !s.is_empty()).map(PathBuf::from);
    let lang_id = canonical_language_id(&language, &path);
    let live_text = state.resolve_doc_text(&path, text).await;

    if let Some(srv) = state
        .ensure_server_for_doc(&path, ws.as_deref(), &lang_id, Some(&live_text))
        .await
    {
        let uri = path_to_uri_string(&path);
        if let Ok(Ok(val)) = tokio::time::timeout(
            Duration::from_secs(4),
            srv.peer.request::<Value, Value>(
                "textDocument/documentSymbol",
                json!({ "textDocument": { "uri": uri } }),
                None,
            ),
        )
        .await
        {
            let symbols = parse_document_symbols_response(val);
            if !symbols.is_empty() {
                return Ok(CodeOutlineResult {
                    source: "lsp".to_string(),
                    symbols,
                });
            }
        }
    }

    Ok(CodeOutlineResult {
        source: "fallback".to_string(),
        symbols: fallback_document_symbols(&live_text, &lang_id),
    })
}

#[tauri::command]
pub async fn poc_lsp_prepare_rename(
    state: State<'_, CodeLspState>,
    file_path: String,
    workspace_root: Option<String>,
    language: String,
    line: u32,
    column: u32,
    text: Option<String>,
) -> Result<Option<CodePrepareRename>, String> {
    let path = PathBuf::from(&file_path);
    let ws = workspace_root.filter(|s| !s.is_empty()).map(PathBuf::from);
    let lang_id = canonical_language_id(&language, &path);
    let live_text = state.resolve_doc_text(&path, text).await;
    let Some((word, start_col1, end_col1)) = extract_identifier_at(&live_text, line, column) else {
        return Ok(None);
    };

    if let Some(srv) = state
        .ensure_server_for_doc(&path, ws.as_deref(), &lang_id, Some(&live_text))
        .await
    {
        if let Ok(val) = lsp_pos_request(
            &srv,
            "textDocument/prepareRename",
            &path,
            line,
            column,
            Duration::from_secs(4),
        )
        .await
        {
            if let Some(prep) = parse_prepare_rename_response(val, &word) {
                return Ok(Some(prep));
            }
        }
        return Ok(Some(CodePrepareRename {
            can_rename: true,
            line,
            column: start_col1,
            end_line: line,
            end_column: end_col1,
            placeholder: word,
            lsp_available: true,
        }));
    }

    Ok(Some(CodePrepareRename {
        can_rename: true,
        line,
        column: start_col1,
        end_line: line,
        end_column: end_col1,
        placeholder: word,
        lsp_available: false,
    }))
}

#[tauri::command]
pub async fn poc_lsp_rename(
    state: State<'_, CodeLspState>,
    file_path: String,
    workspace_root: Option<String>,
    language: String,
    line: u32,
    column: u32,
    new_name: String,
    text: Option<String>,
) -> Result<Option<CodeWorkspaceEdit>, String> {
    let path = PathBuf::from(&file_path);
    let ws = workspace_root.filter(|s| !s.is_empty()).map(PathBuf::from);
    let lang_id = canonical_language_id(&language, &path);
    let live_text = state.resolve_doc_text(&path, text).await;

    let Some(srv) = state
        .ensure_server_for_doc(&path, ws.as_deref(), &lang_id, Some(&live_text))
        .await
    else {
        return Err("Language server is unavailable for workspace rename.".to_string());
    };
    let uri = path_to_uri_string(&path);
    let params = json!({
        "textDocument": { "uri": uri },
        "position": { "line": line.saturating_sub(1), "character": column.saturating_sub(1) },
        "newName": new_name
    });
    let val = tokio::time::timeout(
        QUERY_TIMEOUT,
        srv.peer.request::<Value, Value>("textDocument/rename", params, None),
    )
    .await
    .map_err(|_| "Rename request timed out".to_string())?
    .map_err(|e| e.to_string())?;
    Ok(parse_workspace_edit_response(val))
}

fn line_col_to_byte_offset(text: &str, line1: u32, col1: u32) -> usize {
    let target_line0 = line1.saturating_sub(1) as usize;
    let target_u16 = col1.saturating_sub(1) as usize;
    let mut current_line = 0usize;
    let mut line_start_byte = 0usize;
    for (idx, ch) in text.char_indices() {
        if current_line == target_line0 {
            line_start_byte = idx;
            break;
        }
        if ch == '\n' {
            current_line += 1;
            line_start_byte = idx + 1;
        }
    }
    if current_line < target_line0 {
        return text.len();
    }
    let slice = &text[line_start_byte..];
    let mut seen_u16 = 0usize;
    for (rel_byte, ch) in slice.char_indices() {
        if ch == '\n' || ch == '\r' || seen_u16 >= target_u16 {
            return line_start_byte + rel_byte;
        }
        seen_u16 += ch.len_utf16();
    }
    line_start_byte + slice.len()
}

pub fn apply_edits_to_string(source: &str, edits: &[CodeTextEdit]) -> String {
    let mut sorted = edits.to_vec();
    sorted.sort_by(|a, b| {
        b.start_line
            .cmp(&a.start_line)
            .then_with(|| b.start_column.cmp(&a.start_column))
    });
    let mut result = source.to_string();
    for edit in sorted {
        let start = line_col_to_byte_offset(&result, edit.start_line, edit.start_column);
        let end = line_col_to_byte_offset(&result, edit.end_line, edit.end_column).max(start);
        result.replace_range(start..end, &edit.new_text);
    }
    result
}

#[tauri::command]
pub async fn poc_lsp_apply_workspace_edit(
    files: Vec<CodeFileEdits>,
) -> Result<Vec<String>, String> {
    let mut modified = Vec::new();
    for file in files {
        let path = PathBuf::from(&file.file_path);
        let content = tokio::fs::read_to_string(&path)
            .await
            .map_err(|e| format!("Failed to read '{}': {e}", file.file_path))?;
        let next = apply_edits_to_string(&content, &file.edits);
        if next != content {
            tokio::fs::write(&path, next)
                .await
                .map_err(|e| format!("Failed to write '{}': {e}", file.file_path))?;
            modified.push(file.file_path);
        }
    }
    Ok(modified)
}

#[tauri::command]
pub async fn poc_lsp_server_statuses(
    state: State<'_, CodeLspState>,
    workspace_root: Option<String>,
) -> Result<Vec<LspServerStatusDto>, String> {
    let running_ids = state.running_server_ids().await;
    let ws = workspace_root.filter(|s| !s.is_empty()).map(PathBuf::from);
    Ok(collect_server_statuses(ws.as_deref(), &running_ids))
}

#[tauri::command]
pub async fn poc_lsp_install_server(
    state: State<'_, CodeLspState>,
    server_id: String,
    workspace_root: Option<String>,
) -> Result<LspServerStatusDto, String> {
    let ws = workspace_root.filter(|s| !s.is_empty()).map(PathBuf::from);
    let mut status = install_server(&server_id, ws.as_deref()).await?;
    if state.running_server_ids().await.contains(&server_id) {
        status.status = "running".to_string();
    }
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applies_multiple_edits_bottom_up_accurately() {
        let src = "const alpha = 1;\nreturn alpha + alpha;\n";
        let edited = apply_edits_to_string(
            src,
            &[
                CodeTextEdit {
                    start_line: 1,
                    start_column: 7,
                    end_line: 1,
                    end_column: 12,
                    new_text: "beta".to_string(),
                },
                CodeTextEdit {
                    start_line: 2,
                    start_column: 8,
                    end_line: 2,
                    end_column: 13,
                    new_text: "beta".to_string(),
                },
                CodeTextEdit {
                    start_line: 2,
                    start_column: 16,
                    end_line: 2,
                    end_column: 21,
                    new_text: "beta".to_string(),
                },
            ],
        );
        assert_eq!(edited, "const beta = 1;\nreturn beta + beta;\n");
    }
}
