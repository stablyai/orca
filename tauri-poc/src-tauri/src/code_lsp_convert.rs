//! Shared code-intelligence DTOs and LSP JSON <-> 1-based Orca coordinate converters.

use crate::code_lsp_uri::{normalize_path_key, uri_to_path};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::Path;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeLocation {
    pub file_path: String,
    pub line: u32,
    pub column: u32,
    pub end_line: u32,
    pub end_column: u32,
    pub preview: Option<String>,
    pub symbol_name: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeNavigationResult {
    pub source: String,
    pub server_id: Option<String>,
    pub locations: Vec<CodeLocation>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeHover {
    pub markdown: String,
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub end_line: Option<u32>,
    pub end_column: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeCompletionItem {
    pub label: String,
    pub kind: String,
    pub detail: Option<String>,
    pub documentation: Option<String>,
    pub insert_text: Option<String>,
    pub replace_from_line: Option<u32>,
    pub replace_from_column: Option<u32>,
    pub replace_to_line: Option<u32>,
    pub replace_to_column: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeSignatureInfo {
    pub label: String,
    pub documentation: Option<String>,
    pub parameters: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeSignatureHelp {
    pub signatures: Vec<CodeSignatureInfo>,
    pub active_signature: u32,
    pub active_parameter: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeDocumentSymbol {
    pub name: String,
    pub detail: Option<String>,
    pub kind: String,
    pub line: u32,
    pub column: u32,
    pub end_line: u32,
    pub end_column: u32,
    pub selection_line: u32,
    pub selection_column: u32,
    pub children: Vec<CodeDocumentSymbol>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeDiagnostic {
    pub line: u32,
    pub column: u32,
    pub end_line: u32,
    pub end_column: u32,
    pub severity: String,
    pub message: String,
    pub source: Option<String>,
    pub code: Option<String>,
    pub deprecated: bool,
    pub unnecessary: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodePrepareRename {
    pub can_rename: bool,
    pub line: u32,
    pub column: u32,
    pub end_line: u32,
    pub end_column: u32,
    pub placeholder: String,
    pub lsp_available: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeTextEdit {
    pub start_line: u32,
    pub start_column: u32,
    pub end_line: u32,
    pub end_column: u32,
    pub new_text: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeFileEdits {
    pub file_path: String,
    pub edits: Vec<CodeTextEdit>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeWorkspaceEdit {
    pub files: Vec<CodeFileEdits>,
}

pub fn read_single_line_preview(path: &Path, line1: u32) -> Option<String> {
    if line1 == 0 {
        return None;
    }
    let meta = fs::metadata(path).ok()?;
    if meta.len() > 2 * 1024 * 1024 {
        return None;
    }
    let content = fs::read_to_string(path).ok()?;
    content
        .lines()
        .nth((line1 - 1) as usize)
        .map(|s| s.trim().chars().take(180).collect())
}

fn u32_1based(zero_based: u64) -> u32 {
    u32::try_from(zero_based.saturating_add(1)).unwrap_or(u32::MAX)
}

fn parse_pos_1based(pos: &Value) -> Option<(u32, u32)> {
    let line0 = pos.get("line")?.as_u64()?;
    let char0 = pos.get("character")?.as_u64()?;
    Some((u32_1based(line0), u32_1based(char0)))
}

fn parse_range_1based(range: &Value) -> Option<(u32, u32, u32, u32)> {
    let (sl, sc) = parse_pos_1based(range.get("start")?)?;
    let (el, ec) = parse_pos_1based(range.get("end")?)?;
    Some((sl, sc, el, ec))
}

fn location_from_uri_and_range(uri: &str, range: &Value) -> Option<CodeLocation> {
    let path = uri_to_path(uri)?;
    let (line, column, end_line, end_column) = parse_range_1based(range)?;
    let preview = read_single_line_preview(&path, line);
    Some(CodeLocation {
        file_path: path.to_string_lossy().into_owned(),
        line,
        column,
        end_line,
        end_column,
        preview,
        symbol_name: None,
    })
}

pub fn parse_locations_response(val: Value) -> Vec<CodeLocation> {
    if val.is_null() {
        return Vec::new();
    }
    let items = if let Some(arr) = val.as_array() {
        arr.clone()
    } else if val.is_object() {
        vec![val]
    } else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in items {
        if let Some(target_uri) = item.get("targetUri").and_then(|v| v.as_str()) {
            let range = item
                .get("targetSelectionRange")
                .or_else(|| item.get("targetRange"));
            if let Some(r) = range {
                if let Some(loc) = location_from_uri_and_range(target_uri, r) {
                    out.push(loc);
                }
            }
        } else if let Some(uri) = item.get("uri").and_then(|v| v.as_str()) {
            if let Some(r) = item.get("range") {
                if let Some(loc) = location_from_uri_and_range(uri, r) {
                    out.push(loc);
                }
            }
        }
    }
    out
}

fn marked_string_to_markdown(item: &Value) -> String {
    if let Some(s) = item.as_str() {
        return s.to_string();
    }
    if let Some(value) = item.get("value").and_then(|v| v.as_str()) {
        if let Some(lang) = item.get("language").and_then(|v| v.as_str()) {
            if !lang.is_empty() {
                return format!("```{lang}\n{value}\n```");
            }
        }
        return value.to_string();
    }
    String::new()
}

pub fn parse_hover_response(val: Value) -> Option<CodeHover> {
    if val.is_null() {
        return None;
    }
    let contents = val.get("contents")?;
    let markdown = if let Some(arr) = contents.as_array() {
        arr.iter()
            .map(marked_string_to_markdown)
            .filter(|s| !s.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n\n---\n\n")
    } else {
        marked_string_to_markdown(contents)
    };
    if markdown.trim().is_empty() {
        return None;
    }
    let range = val.get("range").and_then(parse_range_1based);
    Some(CodeHover {
        markdown,
        line: range.map(|r| r.0),
        column: range.map(|r| r.1),
        end_line: range.map(|r| r.2),
        end_column: range.map(|r| r.3),
    })
}

fn lsp_completion_kind_name(kind_num: u64) -> &'static str {
    match kind_num {
        1 => "text",
        2 => "method",
        3 => "function",
        4 => "constructor",
        5 => "field",
        6 => "variable",
        7 => "class",
        8 => "interface",
        9 => "module",
        10 => "property",
        11 => "unit",
        12 => "value",
        13 => "enum",
        14 => "keyword",
        15 => "snippet",
        16 => "color",
        17 => "file",
        18 => "reference",
        19 => "folder",
        20 => "enumMember",
        21 => "constant",
        22 => "struct",
        23 => "event",
        24 => "operator",
        25 => "type",
        _ => "text",
    }
}

fn strip_simple_snippet(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let chars: Vec<char> = raw.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '$' && i + 1 < chars.len() {
            if chars[i + 1] == '{' {
                if let Some(close_rel) = chars[i + 2..].iter().position(|&c| c == '}') {
                    let inner: String = chars[i + 2..i + 2 + close_rel].iter().collect();
                    if let Some((_, default_val)) = inner.split_once(':') {
                        out.push_str(default_val);
                    }
                    i += 3 + close_rel;
                    continue;
                }
            } else if chars[i + 1].is_ascii_digit() {
                i += 2;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

pub fn parse_completion_response(val: Value) -> Vec<CodeCompletionItem> {
    if val.is_null() {
        return Vec::new();
    }
    let items_val = if let Some(arr) = val.as_array() {
        arr
    } else if let Some(arr) = val.get("items").and_then(|v| v.as_array()) {
        arr
    } else {
        return Vec::new();
    };

    let mut pairs: Vec<(String, CodeCompletionItem)> = Vec::new();
    for item in items_val.iter().take(150) {
        let Some(label) = item.get("label").and_then(|v| v.as_str()) else {
            continue;
        };
        let sort_key = item
            .get("sortText")
            .and_then(|v| v.as_str())
            .unwrap_or(label)
            .to_string();
        let kind_num = item.get("kind").and_then(|v| v.as_u64()).unwrap_or(1);
        let detail = item
            .get("detail")
            .and_then(|v| v.as_str())
            .map(ToOwned::to_owned);
        let documentation = item.get("documentation").and_then(|d| {
            let text = marked_string_to_markdown(d);
            if text.trim().is_empty() {
                None
            } else {
                Some(text)
            }
        });
        let text_edit = item.get("textEdit");
        let insert_format = item
            .get("insertTextFormat")
            .and_then(|v| v.as_u64())
            .unwrap_or(1);
        let raw_insert = text_edit
            .and_then(|te| te.get("newText"))
            .or_else(|| item.get("insertText"))
            .and_then(|v| v.as_str())
            .map(|s| {
                if insert_format == 2 {
                    strip_simple_snippet(s)
                } else {
                    s.to_string()
                }
            });
        let edit_range = text_edit
            .and_then(|te| te.get("range").or_else(|| te.get("replace")))
            .and_then(parse_range_1based);

        pairs.push((
            sort_key,
            CodeCompletionItem {
                label: label.to_string(),
                kind: lsp_completion_kind_name(kind_num).to_string(),
                detail,
                documentation,
                insert_text: raw_insert,
                replace_from_line: edit_range.map(|r| r.0),
                replace_from_column: edit_range.map(|r| r.1),
                replace_to_line: edit_range.map(|r| r.2),
                replace_to_column: edit_range.map(|r| r.3),
            },
        ));
    }
    pairs.sort_by(|a, b| a.0.cmp(&b.0));
    pairs.into_iter().take(100).map(|(_, item)| item).collect()
}

pub fn parse_signature_help_response(val: Value) -> Option<CodeSignatureHelp> {
    if val.is_null() {
        return None;
    }
    let sigs_arr = val.get("signatures")?.as_array()?;
    if sigs_arr.is_empty() {
        return None;
    }
    let mut signatures = Vec::new();
    for sig in sigs_arr {
        let Some(label) = sig.get("label").and_then(|v| v.as_str()) else {
            continue;
        };
        let documentation = sig.get("documentation").and_then(|d| {
            let s = marked_string_to_markdown(d);
            if s.trim().is_empty() {
                None
            } else {
                Some(s)
            }
        });
        let parameters = sig
            .get("parameters")
            .and_then(|p| p.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|param| {
                        let lbl = param.get("label")?;
                        if let Some(s) = lbl.as_str() {
                            return Some(s.to_string());
                        }
                        let range = lbl.as_array()?;
                        let start = range.first()?.as_u64()? as usize;
                        let end = range.get(1)?.as_u64()? as usize;
                        label.get(start..end).map(ToOwned::to_owned)
                    })
                    .collect()
            })
            .unwrap_or_default();
        signatures.push(CodeSignatureInfo {
            label: label.to_string(),
            documentation,
            parameters,
        });
    }
    if signatures.is_empty() {
        return None;
    }
    let active_signature = val
        .get("activeSignature")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    let active_parameter = val
        .get("activeParameter")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    Some(CodeSignatureHelp {
        signatures,
        active_signature,
        active_parameter,
    })
}

pub fn lsp_symbol_kind_name(kind_num: u64) -> &'static str {
    match kind_num {
        1 => "file",
        2 => "module",
        3 => "namespace",
        4 => "package",
        5 => "class",
        6 => "method",
        7 => "property",
        8 => "field",
        9 => "constructor",
        10 => "enum",
        11 => "interface",
        12 => "function",
        13 => "variable",
        14 => "constant",
        15 => "string",
        16 => "number",
        17 => "boolean",
        18 => "array",
        19 => "object",
        20 => "key",
        21 => "null",
        22 => "enumMember",
        23 => "struct",
        24 => "event",
        25 => "operator",
        26 => "typeAlias",
        _ => "symbol",
    }
}

fn parse_document_symbol_node(item: &Value) -> Option<CodeDocumentSymbol> {
    let name = item.get("name")?.as_str()?.to_string();
    let kind_num = item.get("kind").and_then(|v| v.as_u64()).unwrap_or(13);
    let detail = item
        .get("detail")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);
    if let Some(range) = item.get("range") {
        let (line, column, end_line, end_column) = parse_range_1based(range)?;
        let (sel_line, sel_col, _, _) = item
            .get("selectionRange")
            .and_then(parse_range_1based)
            .unwrap_or((line, column, end_line, end_column));
        let children = item
            .get("children")
            .and_then(|c| c.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(parse_document_symbol_node)
                    .collect()
            })
            .unwrap_or_default();
        return Some(CodeDocumentSymbol {
            name,
            detail,
            kind: lsp_symbol_kind_name(kind_num).to_string(),
            line,
            column,
            end_line,
            end_column,
            selection_line: sel_line,
            selection_column: sel_col,
            children,
        });
    }
    let range = item.get("location")?.get("range")?;
    let (line, column, end_line, end_column) = parse_range_1based(range)?;
    Some(CodeDocumentSymbol {
        name,
        detail: item
            .get("containerName")
            .and_then(|v| v.as_str())
            .map(ToOwned::to_owned),
        kind: lsp_symbol_kind_name(kind_num).to_string(),
        line,
        column,
        end_line,
        end_column,
        selection_line: line,
        selection_column: column,
        children: Vec::new(),
    })
}

pub fn parse_document_symbols_response(val: Value) -> Vec<CodeDocumentSymbol> {
    let Some(arr) = val.as_array() else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(parse_document_symbol_node)
        .collect()
}

pub fn parse_prepare_rename_response(val: Value, fallback_word: &str) -> Option<CodePrepareRename> {
    if val.is_null() {
        return None;
    }
    if val.get("defaultBehavior").and_then(|v| v.as_bool()) == Some(true) {
        return None;
    }
    if let Some(range) = val.get("range") {
        let (line, column, end_line, end_column) = parse_range_1based(range)?;
        let placeholder = val
            .get("placeholder")
            .and_then(|v| v.as_str())
            .unwrap_or(fallback_word)
            .to_string();
        return Some(CodePrepareRename {
            can_rename: true,
            line,
            column,
            end_line,
            end_column,
            placeholder,
            lsp_available: true,
        });
    }
    let (line, column, end_line, end_column) = parse_range_1based(&val)?;
    Some(CodePrepareRename {
        can_rename: true,
        line,
        column,
        end_line,
        end_column,
        placeholder: fallback_word.to_string(),
        lsp_available: true,
    })
}

fn push_text_edits(out: &mut Vec<CodeTextEdit>, edits: &[Value]) {
    for edit in edits {
        let Some(range) = edit.get("range").and_then(parse_range_1based) else {
            continue;
        };
        let Some(new_text) = edit.get("newText").and_then(|v| v.as_str()) else {
            continue;
        };
        out.push(CodeTextEdit {
            start_line: range.0,
            start_column: range.1,
            end_line: range.2,
            end_column: range.3,
            new_text: new_text.to_string(),
        });
    }
}

pub fn parse_workspace_edit_response(val: Value) -> Option<CodeWorkspaceEdit> {
    if val.is_null() {
        return None;
    }
    let mut by_key: std::collections::BTreeMap<String, CodeFileEdits> =
        std::collections::BTreeMap::new();

    if let Some(changes) = val.get("changes").and_then(|v| v.as_object()) {
        for (uri, arr_val) in changes {
            let Some(arr) = arr_val.as_array() else {
                continue;
            };
            let Some(path) = uri_to_path(uri) else {
                continue;
            };
            let path_str = path.to_string_lossy().into_owned();
            let key = normalize_path_key(&path_str);
            let entry = by_key.entry(key).or_insert_with(|| CodeFileEdits {
                file_path: path_str,
                edits: Vec::new(),
            });
            push_text_edits(&mut entry.edits, arr);
        }
    }

    if let Some(doc_changes) = val.get("documentChanges").and_then(|v| v.as_array()) {
        for change in doc_changes {
            let Some(uri) = change
                .get("textDocument")
                .and_then(|td| td.get("uri"))
                .and_then(|u| u.as_str())
            else {
                continue;
            };
            let Some(edits_arr) = change.get("edits").and_then(|e| e.as_array()) else {
                continue;
            };
            let Some(path) = uri_to_path(uri) else {
                continue;
            };
            let path_str = path.to_string_lossy().into_owned();
            let key = normalize_path_key(&path_str);
            let entry = by_key.entry(key).or_insert_with(|| CodeFileEdits {
                file_path: path_str,
                edits: Vec::new(),
            });
            push_text_edits(&mut entry.edits, edits_arr);
        }
    }

    let files: Vec<CodeFileEdits> = by_key
        .into_values()
        .filter(|f| !f.edits.is_empty())
        .collect();
    if files.is_empty() {
        None
    } else {
        Some(CodeWorkspaceEdit { files })
    }
}

pub fn parse_diagnostics_params(val: &Value) -> Option<(String, Vec<CodeDiagnostic>)> {
    let uri = val.get("uri")?.as_str()?;
    let path = uri_to_path(uri)?;
    let path_str = path.to_string_lossy().into_owned();
    let arr = val.get("diagnostics")?.as_array()?;
    let mut items = Vec::with_capacity(arr.len());
    for diag in arr.iter().take(300) {
        let Some((line, column, end_line, end_column)) =
            diag.get("range").and_then(parse_range_1based)
        else {
            continue;
        };
        let Some(message) = diag.get("message").and_then(|v| v.as_str()) else {
            continue;
        };
        let severity = match diag.get("severity").and_then(|v| v.as_u64()).unwrap_or(1) {
            2 => "warning",
            3 => "info",
            4 => "hint",
            _ => "error",
        };
        let tags = diag
            .get("tags")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let unnecessary = tags.iter().any(|t| t.as_u64() == Some(1));
        let deprecated = tags.iter().any(|t| t.as_u64() == Some(2));
        let code = diag.get("code").and_then(|c| {
            c.as_str()
                .map(ToOwned::to_owned)
                .or_else(|| c.as_i64().map(|n| n.to_string()))
        });
        items.push(CodeDiagnostic {
            line,
            column,
            end_line,
            end_column,
            severity: severity.to_string(),
            message: message.to_string(),
            source: diag
                .get("source")
                .and_then(|v| v.as_str())
                .map(ToOwned::to_owned),
            code,
            deprecated,
            unnecessary,
        });
    }
    Some((path_str, items))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_location_link_and_converts_to_1based() {
        let uri = if cfg!(windows) {
            "file:///D:/code/app/src/lib.rs"
        } else {
            "file:///tmp/app/src/lib.rs"
        };
        let locs = parse_locations_response(json!([{
            "targetUri": uri,
            "targetRange": { "start": { "line": 10, "character": 0 }, "end": { "line": 12, "character": 1 } },
            "targetSelectionRange": { "start": { "line": 10, "character": 7 }, "end": { "line": 10, "character": 15 } }
        }]));
        assert_eq!(locs.len(), 1);
        assert_eq!(locs[0].line, 11);
        assert_eq!(locs[0].column, 8);
        assert_eq!(locs[0].end_column, 16);
    }

    #[test]
    fn parses_hover_marked_strings_and_markup() {
        let h = parse_hover_response(json!({
            "contents": [{ "language": "rust", "value": "fn main()" }, "Entry point"]
        }))
        .expect("hover parsed");
        assert!(h.markdown.contains("```rust\nfn main()\n```"));
        assert!(h.markdown.contains("Entry point"));
    }

    #[test]
    fn parses_completion_and_strips_snippet_placeholders() {
        let items = parse_completion_response(json!({
            "isIncomplete": false,
            "items": [{
                "label": "println!",
                "kind": 3,
                "insertTextFormat": 2,
                "insertText": "println!(\"${1:msg}\")$0"
            }]
        }));
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].kind, "function");
        assert_eq!(items[0].insert_text.as_deref(), Some("println!(\"msg\")"));
    }

    #[test]
    fn parses_diagnostics_with_tags() {
        let uri = if cfg!(windows) {
            "file:///D:/code/x.ts"
        } else {
            "file:///tmp/x.ts"
        };
        let (path, items) = parse_diagnostics_params(&json!({
            "uri": uri,
            "diagnostics": [{
                "range": { "start": { "line": 2, "character": 4 }, "end": { "line": 2, "character": 9 } },
                "severity": 2,
                "message": "Unused variable",
                "source": "ts",
                "code": 6133,
                "tags": [1]
            }]
        }))
        .expect("diag parsed");
        assert!(!path.is_empty());
        assert_eq!(items[0].line, 3);
        assert_eq!(items[0].column, 5);
        assert_eq!(items[0].severity, "warning");
        assert!(items[0].unnecessary);
        assert_eq!(items[0].code.as_deref(), Some("6133"));
    }
}
