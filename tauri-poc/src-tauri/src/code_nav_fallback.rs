//! Fast zero-LSP navigation, references, and document outline fallback.
//!
//! Operates purely on the active editor buffer + workspace files via `ignore` and
//! `grep_searcher` so `Ctrl+B` / `Ctrl+Click` / `Shift+F12` / `Ctrl+F12` work
//! immediately even when no external language server is installed or running.

use crate::code_lsp_convert::{CodeDocumentSymbol, CodeLocation};
use crate::code_lsp_uri::normalize_path_key;
use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::sinks::UTF8;
use grep_searcher::{BinaryDetection, SearcherBuilder};
use ignore::WalkBuilder;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

const MAX_DECL_RESULTS: usize = 40;
const MAX_REF_RESULTS: usize = 160;
const MAX_FILES_TO_SCAN: usize = 2500;

const EXT_FAMILIES: &[&[&str]] = &[
    &["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "vue", "svelte"],
    &["rs"],
    &["py", "pyi", "pyw"],
    &["go"],
    &["c", "h", "cc", "cpp", "cxx", "hpp", "hh", "hxx"],
    &["java", "kt", "kts", "scala", "groovy"],
    &["rb", "rake"],
];

fn is_ident_char(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_' || ch == '$'
}

fn is_keyword(ident: &str) -> bool {
    matches!(
        ident,
        "import"
            | "export"
            | "from"
            | "default"
            | "const"
            | "let"
            | "var"
            | "function"
            | "class"
            | "interface"
            | "type"
            | "enum"
            | "return"
            | "if"
            | "else"
            | "for"
            | "while"
            | "switch"
            | "case"
            | "break"
            | "continue"
            | "try"
            | "catch"
            | "finally"
            | "throw"
            | "new"
            | "await"
            | "async"
            | "true"
            | "false"
            | "null"
            | "undefined"
            | "this"
            | "super"
            | "fn"
            | "pub"
            | "mod"
            | "use"
            | "crate"
            | "struct"
            | "trait"
            | "impl"
            | "match"
            | "def"
            | "elif"
            | "pass"
            | "None"
            | "True"
            | "False"
            | "func"
            | "package"
            | "self"
            | "Self"
    )
}

pub fn extract_identifier_at(text: &str, line1: u32, col1: u32) -> Option<(String, u32, u32)> {
    let line_text = text.lines().nth(line1.saturating_sub(1) as usize)?;
    let target_utf16 = col1.saturating_sub(1) as usize;
    let chars: Vec<(usize, char, usize)> = {
        let mut v = Vec::new();
        let mut u16_pos = 0usize;
        for (byte_idx, ch) in line_text.char_indices() {
            v.push((byte_idx, ch, u16_pos));
            u16_pos += ch.len_utf16();
        }
        v
    };
    if chars.is_empty() {
        return None;
    }
    let mut idx = chars
        .iter()
        .position(|(_, _, u16p)| *u16p >= target_utf16)
        .unwrap_or(chars.len());
    if idx == chars.len() || !is_ident_char(chars[idx].1) {
        if idx > 0 && is_ident_char(chars[idx - 1].1) {
            idx -= 1;
        } else {
            return None;
        }
    }
    let mut start = idx;
    while start > 0 && is_ident_char(chars[start - 1].1) {
        start -= 1;
    }
    let mut end = idx + 1;
    while end < chars.len() && is_ident_char(chars[end].1) {
        end += 1;
    }
    let start_byte = chars[start].0;
    let end_byte = if end < chars.len() {
        chars[end].0
    } else {
        line_text.len()
    };
    let word = &line_text[start_byte..end_byte];
    if word.is_empty() || word.chars().next().is_some_and(|c| c.is_ascii_digit()) || is_keyword(word)
    {
        return None;
    }
    let start_col1 = (chars[start].2 + 1) as u32;
    let end_u16 = if end < chars.len() {
        chars[end].2
    } else {
        chars.last().map(|c| c.2 + c.1.len_utf16()).unwrap_or(0)
    };
    let end_col1 = (end_u16 + 1) as u32;
    Some((word.to_string(), start_col1, end_col1))
}

fn string_literal_at(line_text: &str, col1: u32) -> Option<String> {
    let target_utf16 = col1.saturating_sub(1) as usize;
    let mut u16_pos = 0usize;
    let mut active_quote: Option<(char, usize)> = None;
    for (byte_idx, ch) in line_text.char_indices() {
        let ch_u16_end = u16_pos + ch.len_utf16();
        if let Some((q, start_byte)) = active_quote {
            if ch == q {
                let start_u16 = line_text[..start_byte].encode_utf16().count();
                if target_utf16 >= start_u16 && target_utf16 <= ch_u16_end {
                    return Some(line_text[start_byte + q.len_utf8()..byte_idx].to_string());
                }
                active_quote = None;
            }
        } else if ch == '\'' || ch == '"' || ch == '`' {
            active_quote = Some((ch, byte_idx));
        }
        u16_pos = ch_u16_end;
    }
    None
}

fn utf16_col1(line_text: &str, byte_offset: usize) -> u32 {
    let prefix = line_text.get(..byte_offset).unwrap_or(line_text);
    (prefix.encode_utf16().count() + 1) as u32
}

fn extension_of(path: &Path) -> String {
    path.extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn is_compatible_extension(from_ext: &str, target_ext: &str) -> bool {
    if from_ext.is_empty() || from_ext == target_ext {
        return true;
    }
    for family in EXT_FAMILIES {
        if family.contains(&from_ext) {
            return family.contains(&target_ext);
        }
    }
    false
}

fn lexical_clean_path(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut stack: Vec<std::ffi::OsString> = Vec::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                if stack
                    .last()
                    .is_some_and(|s| s != ".." && !s.to_string_lossy().ends_with(':'))
                {
                    stack.pop();
                } else {
                    stack.push(comp.as_os_str().to_os_string());
                }
            }
            _ => stack.push(comp.as_os_str().to_os_string()),
        }
    }
    let mut out = PathBuf::new();
    for part in stack {
        out.push(part);
    }
    out
}

fn push_if_file(candidates: &mut Vec<PathBuf>, candidate: PathBuf) {
    if candidate.is_file() {
        let cleaned = lexical_clean_path(&candidate);
        if !candidates.contains(&cleaned) {
            candidates.push(cleaned);
        }
    }
}

fn resolve_module_specifier_paths(from_file: &Path, spec: &str) -> Vec<PathBuf> {
    if !spec.starts_with('.') {
        return Vec::new();
    }
    let Some(base_dir) = from_file.parent() else {
        return Vec::new();
    };
    let raw = lexical_clean_path(&base_dir.join(spec));
    let mut source_twins = Vec::new();
    let norm = raw.to_string_lossy().replace('\\', "/");
    if let Some(replaced) = norm.find("/dist/").map(|i| {
        let mut s = String::with_capacity(norm.len());
        s.push_str(&norm[..i]);
        s.push('/');
        s.push_str(&norm[i + 6..]);
        PathBuf::from(s)
    }) {
        for ext in ["ts", "tsx", "mts", "cts"] {
            push_if_file(&mut source_twins, replaced.with_extension(ext));
        }
    }
    if !source_twins.is_empty() {
        return source_twins;
    }

    let mut candidates = Vec::new();
    let exts = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"];
    push_if_file(&mut candidates, raw.clone());
    if let Some(ext) = raw.extension().and_then(|s| s.to_str()) {
        if matches!(ext, "js" | "mjs" | "cjs" | "jsx") {
            let map_exts: &[&str] = if ext == "jsx" {
                &["tsx", "ts"]
            } else {
                &["ts", "tsx", "mts", "cts"]
            };
            for mapped in map_exts {
                push_if_file(&mut candidates, raw.with_extension(mapped));
            }
        }
    } else {
        for ext in exts {
            push_if_file(&mut candidates, raw.with_extension(ext));
        }
        for ext in exts {
            push_if_file(&mut candidates, raw.join(format!("index.{ext}")));
        }
    }
    candidates
}

fn find_imported_binding(text: &str, local_ident: &str) -> Option<(String, String)> {
    // Normalize whitespace/newlines into a searchable scan of import/require statements.
    let bytes = text.as_bytes();
    let mut pos = 0usize;
    while pos < bytes.len() {
        let rest = &text[pos..];
        let Some(stmt_end_rel) = rest.find([';', '\n']).or(Some(rest.len())) else {
            break;
        };
        // Handle multi-line `import { ... } from '...'` up to semicolon or closing quote.
        let line_trim = rest[..stmt_end_rel].trim_start();
        if line_trim.starts_with("import ") || line_trim.starts_with("import{") {
            let block_limit = rest.len().min(800);
            let block = &rest[..block_limit];
            if let Some(from_idx) = block.find("from") {
                let after_from = &block[from_idx + 4..];
                if let Some(q1) = after_from.find(['\'', '"']) {
                    let quote_char = after_from.as_bytes()[q1] as char;
                    let spec_start = q1 + 1;
                    if let Some(q2_rel) = after_from[spec_start..].find(quote_char) {
                        let spec = &after_from[spec_start..spec_start + q2_rel];
                        let clause = &block[..from_idx];
                        if let Some(exported) = match_js_import_clause(clause, local_ident) {
                            return Some((spec.to_string(), exported));
                        }
                        pos += from_idx + 4 + spec_start + q2_rel + 1;
                        continue;
                    }
                }
            }
        } else if line_trim.contains("require(") {
            if let Some((spec, exported)) = parse_require_binding(line_trim, local_ident) {
                return Some((spec, exported));
            }
        }
        pos += stmt_end_rel + 1;
    }
    None
}

fn match_js_import_clause(clause: &str, local_ident: &str) -> Option<String> {
    let trimmed = clause
        .trim()
        .strip_prefix("import")?
        .trim()
        .strip_prefix("type")
        .unwrap_or_else(|| clause.trim().strip_prefix("import").unwrap_or(""))
        .trim();
    if let Some(brace_start) = trimmed.find('{') {
        if let Some(brace_end) = trimmed[brace_start + 1..].find('}') {
            let inside = &trimmed[brace_start + 1..brace_start + 1 + brace_end];
            for item in inside.split(',') {
                let part = item
                    .trim()
                    .strip_prefix("type ")
                    .unwrap_or_else(|| item.trim())
                    .trim();
                if part.is_empty() {
                    continue;
                }
                if let Some((orig, alias)) = part.split_once(" as ") {
                    if alias.trim() == local_ident {
                        return Some(orig.trim().to_string());
                    }
                } else if part == local_ident {
                    return Some(part.to_string());
                }
            }
        }
    }
    let before_brace = trimmed.split(['{', '*']).next().unwrap_or("").trim();
    let default_name = before_brace.trim_end_matches(',').trim();
    if default_name == local_ident && !default_name.is_empty() {
        return Some(local_ident.to_string());
    }
    if let Some(star_idx) = trimmed.find("* as ") {
        let ns = trimmed[star_idx + 5..].trim();
        if ns == local_ident {
            return Some(String::new());
        }
    }
    None
}

fn parse_require_binding(line: &str, local_ident: &str) -> Option<(String, String)> {
    let req_idx = line.find("require(")?;
    let after = &line[req_idx + 8..];
    let q_char = after.trim_start().chars().next()?;
    if q_char != '\'' && q_char != '"' {
        return None;
    }
    let q1 = after.find(q_char)?;
    let q2_rel = after[q1 + 1..].find(q_char)?;
    let spec = &after[q1 + 1..q1 + 1 + q2_rel];
    let lhs = line[..req_idx].trim();
    if let Some(brace_s) = lhs.find('{') {
        if let Some(brace_e) = lhs[brace_s + 1..].find('}') {
            let inner = &lhs[brace_s + 1..brace_s + 1 + brace_e];
            for part in inner.split(',') {
                let p = part.trim();
                if let Some((orig, alias)) = p.split_once(':') {
                    if alias.trim() == local_ident {
                        return Some((spec.to_string(), orig.trim().to_string()));
                    }
                } else if p == local_ident {
                    return Some((spec.to_string(), p.to_string()));
                }
            }
        }
    }
    if lhs
        .split([' ', '=', ':'])
        .filter(|s| !s.is_empty())
        .any(|tok| tok == local_ident)
    {
        return Some((spec.to_string(), local_ident.to_string()));
    }
    None
}

fn build_decl_pattern(name: &str, language_id: &str) -> String {
    let esc = regex_escape(name);
    match language_id {
        "rust" => format!(
            r"(?m)(?:^|\s)(?:async\s+|unsafe\s+|const\s+|extern\s+)?(?:fn|struct|enum|trait|type|const|static|mod|macro_rules!)\s+{esc}\b"
        ),
        "python" => format!(r"(?m)^\s*(?:async\s+)?(?:def|class)\s+{esc}\b|^\s*{esc}\s*(?::[^=\n]+)?="),
        "go" => format!(r"(?m)^\s*(?:func\s+(?:\([^)]+\)\s+)?|type\s+|const\s+|var\s+){esc}\b"),
        _ => format!(
            r"(?m)(?:(?:function\*?|class|interface|type|enum|const|let|var|def|fn|struct|trait|mod)\s+{esc}\b|^\s*(?:export\s+)?(?:public\s+|private\s+|protected\s+|static\s+|async\s+|readonly\s+|get\s+|set\s+)*(?:function\s+)?{esc}\s*(?:<[^>]*>)?\s*\()"
        ),
    }
}

fn regex_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        if "\\.^$|?*+()[]{}".contains(ch) {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

fn find_declarations_in_text(
    file_path: &Path,
    text: &str,
    name: &str,
    language_id: &str,
) -> Vec<CodeLocation> {
    let pattern = build_decl_pattern(name, language_id);
    let Ok(matcher) = RegexMatcherBuilder::new().build(&pattern) else {
        return Vec::new();
    };
    let mut locs = Vec::new();
    for (idx, line) in text.lines().enumerate() {
        if let Ok(Some(m)) = matcher.find(line.as_bytes()) {
            let slice = &line[m.start()..m.end()];
            let name_col_byte = slice
                .rfind(name)
                .map(|rel| m.start() + rel)
                .unwrap_or(m.start());
            let col1 = utf16_col1(line, name_col_byte);
            let end_col1 = col1 + name.encode_utf16().count() as u32;
            let line1 = (idx + 1) as u32;
            locs.push(CodeLocation {
                file_path: file_path.to_string_lossy().into_owned(),
                line: line1,
                column: col1,
                end_line: line1,
                end_column: end_col1,
                preview: Some(line.trim().chars().take(180).collect()),
                symbol_name: Some(name.to_string()),
            });
            if locs.len() >= MAX_DECL_RESULTS {
                break;
            }
        }
    }
    locs
}

fn dedupe_locations(locs: Vec<CodeLocation>) -> Vec<CodeLocation> {
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(locs.len());
    for loc in locs {
        let key = format!("{}:{}:{}", normalize_path_key(&loc.file_path), loc.line, loc.column);
        if seen.insert(key) {
            out.push(loc);
        }
    }
    out
}

pub fn fallback_definition(
    file_path: &Path,
    workspace_root: Option<&Path>,
    language_id: &str,
    text: &str,
    line1: u32,
    col1: u32,
) -> Vec<CodeLocation> {
    let line_text = text.lines().nth(line1.saturating_sub(1) as usize).unwrap_or("");
    if let Some(spec) = string_literal_at(line_text, col1) {
        if line_text.contains("import")
            || line_text.contains("from")
            || line_text.contains("require(")
            || line_text.contains("#include")
        {
            let files = resolve_module_specifier_paths(file_path, &spec);
            if !files.is_empty() {
                return files
                    .into_iter()
                    .map(|target| CodeLocation {
                        file_path: target.to_string_lossy().into_owned(),
                        line: 1,
                        column: 1,
                        end_line: 1,
                        end_column: 1,
                        preview: Some(format!("module: {spec}")),
                        symbol_name: None,
                    })
                    .collect();
            }
        }
    }

    let Some((ident, _, _)) = extract_identifier_at(text, line1, col1) else {
        return Vec::new();
    };

    if let Some((spec, exported_name)) = find_imported_binding(text, &ident) {
        let resolved_files = resolve_module_specifier_paths(file_path, &spec);
        let mut import_targets = Vec::new();
        for target in &resolved_files {
            if exported_name.is_empty() {
                import_targets.push(CodeLocation {
                    file_path: target.to_string_lossy().into_owned(),
                    line: 1,
                    column: 1,
                    end_line: 1,
                    end_column: 1,
                    preview: Some(format!("module: {spec}")),
                    symbol_name: Some(ident.clone()),
                });
                continue;
            }
            if let Ok(target_text) = fs::read_to_string(target) {
                let target_lang = crate::code_lsp_servers::canonical_language_id("", target);
                let decls =
                    find_declarations_in_text(target, &target_text, &exported_name, &target_lang);
                import_targets.extend(decls);
            }
        }
        if !import_targets.is_empty() {
            return dedupe_locations(import_targets);
        }
        if let Some(first) = resolved_files.into_iter().next() {
            return vec![CodeLocation {
                file_path: first.to_string_lossy().into_owned(),
                line: 1,
                column: 1,
                end_line: 1,
                end_column: 1,
                preview: Some(format!("module: {spec}")),
                symbol_name: Some(ident),
            }];
        }
    }

    let local_decls = find_declarations_in_text(file_path, text, &ident, language_id);
    if !local_decls.is_empty() {
        return dedupe_locations(local_decls);
    }

    let Some(root) = workspace_root else {
        return Vec::new();
    };
    let from_ext = extension_of(file_path);
    let current_key = normalize_path_key(&file_path.to_string_lossy());
    let pattern = build_decl_pattern(&ident, language_id);
    let Ok(matcher) = RegexMatcherBuilder::new().build(&pattern) else {
        return Vec::new();
    };
    let mut searcher = SearcherBuilder::new()
        .binary_detection(BinaryDetection::quit(b'\x00'))
        .line_number(true)
        .build();
    let mut found = Vec::new();
    let walker = WalkBuilder::new(root)
        .hidden(true)
        .git_ignore(true)
        .filter_entry(|entry| {
            let name = entry.file_name().to_str().unwrap_or("");
            !matches!(
                name,
                ".git" | "node_modules" | "target" | ".next" | ".cache" | "coverage"
            )
        })
        .build();

    let mut scanned = 0usize;
    for entry in walker.flatten() {
        if !entry.file_type().is_some_and(|ft| ft.is_file()) {
            continue;
        }
        scanned += 1;
        if scanned > MAX_FILES_TO_SCAN {
            break;
        }
        let path = entry.path();
        if normalize_path_key(&path.to_string_lossy()) == current_key {
            continue;
        }
        let ext = extension_of(path);
        if !is_compatible_extension(&from_ext, &ext) {
            continue;
        }
        let path_owned = path.to_path_buf();
        let ident_clone = ident.clone();
        let _ = searcher.search_path(
            &matcher,
            path,
            UTF8(|line_num, line_str| {
                let col_byte = line_str.find(&ident_clone).unwrap_or(0);
                let col1 = utf16_col1(line_str, col_byte);
                found.push(CodeLocation {
                    file_path: path_owned.to_string_lossy().into_owned(),
                    line: line_num as u32,
                    column: col1,
                    end_line: line_num as u32,
                    end_column: col1 + ident_clone.encode_utf16().count() as u32,
                    preview: Some(line_str.trim().chars().take(180).collect()),
                    symbol_name: Some(ident_clone.clone()),
                });
                Ok(found.len() < MAX_DECL_RESULTS)
            }),
        );
        if found.len() >= MAX_DECL_RESULTS {
            break;
        }
    }
    found.sort_by_key(|loc| {
        let norm = loc.file_path.replace('\\', "/");
        let is_dist = norm.contains("/dist/") || norm.contains("/build/");
        (is_dist, norm, loc.line)
    });
    dedupe_locations(found)
}

pub fn fallback_references(
    file_path: &Path,
    workspace_root: Option<&Path>,
    text: &str,
    line1: u32,
    col1: u32,
) -> Vec<CodeLocation> {
    let Some((ident, _, _)) = extract_identifier_at(text, line1, col1) else {
        return Vec::new();
    };
    let esc = regex_escape(&ident);
    let pattern = format!(r"\b{esc}\b");
    let Ok(matcher) = RegexMatcherBuilder::new().build(&pattern) else {
        return Vec::new();
    };
    let mut results = Vec::new();
    let ident_len = ident.encode_utf16().count() as u32;

    for (idx, line) in text.lines().enumerate() {
        let mut offset = 0usize;
        while offset <= line.len() {
            let Ok(Some(m)) = matcher.find(&line.as_bytes()[offset..]) else {
                break;
            };
            let abs_byte = offset + m.start();
            let col = utf16_col1(line, abs_byte);
            let line_num = (idx + 1) as u32;
            results.push(CodeLocation {
                file_path: file_path.to_string_lossy().into_owned(),
                line: line_num,
                column: col,
                end_line: line_num,
                end_column: col + ident_len,
                preview: Some(line.trim().chars().take(180).collect()),
                symbol_name: Some(ident.clone()),
            });
            offset += m.end().max(1);
            if results.len() >= MAX_REF_RESULTS {
                return dedupe_locations(results);
            }
        }
    }

    let Some(root) = workspace_root else {
        return dedupe_locations(results);
    };
    let from_ext = extension_of(file_path);
    let current_key = normalize_path_key(&file_path.to_string_lossy());
    let include_dist = current_key.contains("/dist/");
    let mut searcher = SearcherBuilder::new()
        .binary_detection(BinaryDetection::quit(b'\x00'))
        .line_number(true)
        .build();
    let walker = WalkBuilder::new(root)
        .hidden(true)
        .git_ignore(true)
        .filter_entry(move |entry| {
            let name = entry.file_name().to_str().unwrap_or("");
            if matches!(
                name,
                ".git" | "node_modules" | "target" | ".next" | ".cache" | "coverage"
            ) {
                return false;
            }
            if !include_dist && name == "dist" {
                return false;
            }
            true
        })
        .build();

    let mut scanned = 0usize;
    for entry in walker.flatten() {
        if !entry.file_type().is_some_and(|ft| ft.is_file()) {
            continue;
        }
        scanned += 1;
        if scanned > MAX_FILES_TO_SCAN || results.len() >= MAX_REF_RESULTS {
            break;
        }
        let path = entry.path();
        if normalize_path_key(&path.to_string_lossy()) == current_key {
            continue;
        }
        if !is_compatible_extension(&from_ext, &extension_of(path)) {
            continue;
        }
        let path_owned = path.to_path_buf();
        let ident_clone = ident.clone();
        let _ = searcher.search_path(
            &matcher,
            path,
            UTF8(|line_num, line_str| {
                if let Ok(Some(m)) = matcher.find(line_str.as_bytes()) {
                    let col = utf16_col1(line_str, m.start());
                    results.push(CodeLocation {
                        file_path: path_owned.to_string_lossy().into_owned(),
                        line: line_num as u32,
                        column: col,
                        end_line: line_num as u32,
                        end_column: col + ident_len,
                        preview: Some(line_str.trim().chars().take(180).collect()),
                        symbol_name: Some(ident_clone.clone()),
                    });
                }
                Ok(results.len() < MAX_REF_RESULTS)
            }),
        );
    }
    dedupe_locations(results)
}

pub fn fallback_document_symbols(text: &str, language_id: &str) -> Vec<CodeDocumentSymbol> {
    let rules: &[(&str, &str)] = match language_id {
        "rust" => &[
            (
                r"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+|unsafe\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)",
                "function",
            ),
            (
                r"^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)",
                "struct",
            ),
            (
                r"^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)",
                "enum",
            ),
            (
                r"^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)",
                "interface",
            ),
            (
                r"^\s*impl(?:<[^>]*>)?\s+(?:[A-Za-z0-9_:]+\s+for\s+)?([A-Za-z_][A-Za-z0-9_]*)",
                "class",
            ),
            (
                r"^\s*(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_][A-Za-z0-9_]*)",
                "typeAlias",
            ),
        ],
        "python" => &[
            (r"^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)", "function"),
            (r"^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)", "class"),
        ],
        "go" => &[
            (r"^func\s+(?:\([^)]+\)\s+)?([A-Za-z_][A-Za-z0-9_]*)", "function"),
            (r"^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:struct|interface)\b", "struct"),
        ],
        _ => &[
            (
                r"^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\*?\s+([A-Za-z_$][A-Za-z0-9_$]*)",
                "function",
            ),
            (
                r"^\s*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)",
                "class",
            ),
            (
                r"^\s*(?:export\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)",
                "interface",
            ),
            (
                r"^\s*(?:export\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<|=)",
                "typeAlias",
            ),
            (
                r"^\s*(?:export\s+)?enum\s+([A-Za-z_$][A-Za-z0-9_$]*)",
                "enum",
            ),
            (
                r"^(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>",
                "function",
            ),
        ],
    };

    let compiled: Vec<(regex_lite_or_grep::MatcherWrap, &str)> = rules
        .iter()
        .filter_map(|(pat, kind)| {
            regex_lite_or_grep::MatcherWrap::new(pat).map(|m| (m, *kind))
        })
        .collect();

    let mut out = Vec::new();
    for (idx, line) in text.lines().enumerate() {
        for (matcher, kind) in &compiled {
            if let Some((name, byte_pos)) = matcher.find_capture_one(line) {
                let col1 = utf16_col1(line, byte_pos);
                let end_col1 = col1 + name.encode_utf16().count() as u32;
                let line1 = (idx + 1) as u32;
                out.push(CodeDocumentSymbol {
                    name,
                    detail: None,
                    kind: (*kind).to_string(),
                    line: line1,
                    column: col1,
                    end_line: line1,
                    end_column: end_col1,
                    selection_line: line1,
                    selection_column: col1,
                    children: Vec::new(),
                });
                break;
            }
        }
    }
    out
}

mod regex_lite_or_grep {
    use grep_matcher::{Captures, Matcher};
    use grep_regex::{RegexCaptures, RegexMatcher, RegexMatcherBuilder};

    pub struct MatcherWrap(RegexMatcher);

    impl MatcherWrap {
        pub fn new(pattern: &str) -> Option<Self> {
            RegexMatcherBuilder::new().build(pattern).ok().map(Self)
        }

        pub fn find_capture_one(&self, line: &str) -> Option<(String, usize)> {
            let mut caps: RegexCaptures = self.0.new_captures().ok()?;
            let matched = self.0.captures(line.as_bytes(), &mut caps).ok()?;
            if !matched {
                return None;
            }
            let span = caps.get(1)?;
            Some((line[span.start()..span.end()].to_string(), span.start()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_identifier_and_skips_keywords() {
        let code = "const result = compactSnapshotResult(raw)";
        assert_eq!(
            extract_identifier_at(code, 1, 20),
            Some(("compactSnapshotResult".to_string(), 16, 37))
        );
        assert_eq!(extract_identifier_at(code, 1, 2), None);
    }

    #[test]
    fn resolves_import_specifier_and_imported_symbol() {
        let dir = std::env::temp_dir().join(format!("orca-nav-fb-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let src_dir = dir.join("src");
        fs::create_dir_all(&src_dir).unwrap();
        let target = src_dir.join("snapshot-result.ts");
        fs::write(
            &target,
            "export interface Item { id: string }\nexport function compactSnapshotResult(x: Item) {\n  return x\n}\n",
        )
        .unwrap();
        let test_file = src_dir.join("snapshot-result.test.mjs");
        let test_code = "import { compactSnapshotResult as compact } from './snapshot-result.js';\ncompact({ id: '1' });\n";
        fs::write(&test_file, test_code).unwrap();

        let locs = fallback_definition(&test_file, Some(&dir), "javascript", test_code, 2, 3);
        assert_eq!(locs.len(), 1);
        assert_eq!(
            normalize_path_key(&locs[0].file_path),
            normalize_path_key(&target.to_string_lossy())
        );
        assert_eq!(locs[0].line, 2);
        assert_eq!(locs[0].symbol_name.as_deref(), Some("compactSnapshotResult"));

        let module_locs =
            fallback_definition(&test_file, Some(&dir), "javascript", test_code, 1, 55);
        assert_eq!(module_locs.len(), 1);
        assert_eq!(
            normalize_path_key(&module_locs[0].file_path),
            normalize_path_key(&target.to_string_lossy())
        );

        let refs = fallback_references(&target, Some(&dir), &fs::read_to_string(&target).unwrap(), 2, 20);
        assert!(!refs.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn extracts_document_symbols_across_languages() {
        let ts = "export class Store {\n}\nexport async function runTask() {}\nexport const helper = () => 1\n";
        let syms = fallback_document_symbols(ts, "typescript");
        let names: Vec<&str> = syms.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["Store", "runTask", "helper"]);

        let rs = "pub struct Engine {}\nimpl Engine {}\npub async fn start() {}\n";
        let rs_syms = fallback_document_symbols(rs, "rust");
        let rs_names: Vec<&str> = rs_syms.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(rs_names, vec!["Engine", "Engine", "start"]);
    }
}
