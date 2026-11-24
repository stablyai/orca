#![allow(dead_code)]
//! Native Crashpad minidump signature capture for Windows parity with the
//! Electron crashpad-capture path. WebView2 runs its own Crashpad handler, so
//! renderer crashes leave dumps in `EBWebView/Crashpad/reports`; pair the
//! fresh dump with the crash, lift the text signature out of it, and merge it
//! into the report. Upload stays off like Electron: dumps hold process memory
//! and never leave disk.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const MINIDUMP_SIGNATURE: u32 = 0x504d444d;
const MINIDUMP_HEADER_SIZE: usize = 32;
const DIRECTORY_ENTRY_SIZE: usize = 12;
const MAX_STREAMS: usize = 4_096;
const MAX_MODULES: usize = 1_024;
const MAX_ANNOTATIONS: usize = 512;
const MAX_ANNOTATION_VALUE_BYTES: usize = 8_192;
const MAX_DUMP_BYTES: u64 = 64 * 1024 * 1024;
const MAX_STORED_DUMP_BYTES: u64 = 128 * 1024 * 1024;
const MAX_STORED_DUMPS: usize = 64;
pub const DUMP_RECENCY_WINDOW_MS: u128 = 30_000;
/// How long the capture path waits for Crashpad to finish writing the dump,
/// and how often it re-scans. Mirrors Electron DUMP_WAIT_TIMEOUT_MS and
/// DUMP_POLL_INTERVAL_MS; the capture thread sleeps between rounds.
pub const DUMP_WAIT_TIMEOUT_MS: u128 = 8_000;
pub const DUMP_POLL_INTERVAL_MS: u64 = 250;

const STREAM_TYPE_MODULE_LIST: u32 = 4;
const STREAM_TYPE_EXCEPTION: u32 = 6;
const STREAM_TYPE_CRASHPAD_INFO: u32 = 0x43500001;

const MODULE_RECORD_SIZE: usize = 108;
const MAX_MODULE_LIST_MODULES: usize = 8_192;
const MODULE_BASE_OFFSET: usize = 0;
const MODULE_SIZE_OFFSET: usize = 8;
const MODULE_NAME_RVA_OFFSET: usize = 20;

const EXCEPTION_RECORD_OFFSET: usize = 8;
const EXCEPTION_CODE_OFFSET: usize = EXCEPTION_RECORD_OFFSET;
const EXCEPTION_ADDRESS_OFFSET: usize = EXCEPTION_RECORD_OFFSET + 16;

const CRASHPAD_INFO_MIN_SIZE: usize = 52;
const CRASHPAD_INFO_SIMPLE_ANNOTATIONS_OFFSET: usize = 36;
const CRASHPAD_INFO_MODULE_LIST_OFFSET: usize = 44;
const MODULE_CRASHPAD_INFO_LINK_SIZE: usize = 12;
const MODULE_CRASHPAD_INFO_MIN_SIZE: usize = 28;
const MODULE_CRASHPAD_INFO_SIMPLE_ANNOTATIONS_OFFSET: usize = 12;
const MODULE_CRASHPAD_INFO_ANNOTATION_OBJECTS_OFFSET: usize = 20;
const ANNOTATION_RECORD_SIZE: usize = 12;
const ANNOTATION_TYPE_STRING: u16 = 1;

const CHECK_LOG_MARKERS: &[&[u8]] = &[b":FATAL:", b":CHECK:", b":DFATAL:", b":ERROR:"];
const MAX_LOG_PREFIX_BYTES: usize = 96;
const MAX_CHECK_LOG_BYTES: usize = 4_000;
const MAX_MARKERS_PER_SEVERITY: usize = 256;

/// Allowlisted Crashpad annotations copied into a report. Default-deny: the
/// key space is open and some keys carry command lines and user data.
const ANNOTATION_ALLOWLIST: &[&str] = &[
    "LOG_FATAL",
    "abort-message",
    "ptype",
    "ver",
    "prod",
    "plat",
    "osarch",
    "channel",
    "crash-loop-before",
    "first-crash-time",
    "gpu-gl-vendor",
    "gpu-gl-renderer",
    "gpu-driver-version",
    "gpu-vendor-id",
    "gpu-device-id",
    "gpu-generation-intel",
];

/// Crash keys that are consumed as signature fields, not copied verbatim.
const CONSUMED_ANNOTATION_KEYS: &[&str] = &["LOG_FATAL", "abort-message", "ptype"];

#[derive(Debug, Clone, Copy)]
struct LocationDescriptor {
    size: usize,
    rva: usize,
}

/// Bounds-checked view over dump bytes. Every accessor returns None past the
/// end so a truncated dump degrades instead of breaking crash reporting.
struct MinidumpView<'a> {
    bytes: &'a [u8],
}

impl<'a> MinidumpView<'a> {
    fn u32(&self, offset: usize) -> Option<u32> {
        let end = offset.checked_add(4)?;
        let chunk = self.bytes.get(offset..end)?;
        Some(u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
    }

    fn u16(&self, offset: usize) -> Option<u16> {
        let end = offset.checked_add(2)?;
        let chunk = self.bytes.get(offset..end)?;
        Some(u16::from_le_bytes([chunk[0], chunk[1]]))
    }

    fn u64(&self, offset: usize) -> Option<u64> {
        let end = offset.checked_add(8)?;
        let chunk = self.bytes.get(offset..end)?;
        Some(u64::from_le_bytes([
            chunk[0], chunk[1], chunk[2], chunk[3], chunk[4], chunk[5], chunk[6], chunk[7],
        ]))
    }

    fn location(&self, offset: usize) -> Option<LocationDescriptor> {
        let size = self.u32(offset)? as usize;
        let rva = self.u32(offset + 4)? as usize;
        if rva == 0 || rva >= self.bytes.len() {
            return None;
        }
        Some(LocationDescriptor { size, rva })
    }

    fn bytes_at(&self, location: LocationDescriptor, max_bytes: usize) -> Option<&'a [u8]> {
        if location.size > max_bytes {
            return None;
        }
        let end = location.rva.checked_add(location.size)?;
        self.bytes.get(location.rva..end)
    }

    fn byte_array(&self, rva: usize, max_bytes: usize) -> Option<&'a [u8]> {
        let length = self.u32(rva)? as usize;
        if length > max_bytes {
            return None;
        }
        let start = rva.checked_add(4)?;
        let end = start.checked_add(length)?;
        self.bytes.get(start..end)
    }

    fn utf8_string(&self, rva: usize, max_bytes: usize) -> Option<String> {
        let raw = self.byte_array(rva, max_bytes)?;
        Some(String::from_utf8_lossy(raw).into_owned())
    }

    fn utf16_string(&self, rva: usize, max_bytes: usize) -> Option<String> {
        let length = self.u32(rva)? as usize;
        if length > max_bytes || length % 2 != 0 {
            return None;
        }
        let start = rva.checked_add(4)?;
        let end = start.checked_add(length)?;
        let raw = self.bytes.get(start..end)?;
        let units: Vec<u16> = raw
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect();
        Some(String::from_utf16_lossy(&units))
    }
}

fn is_minidump(bytes: &[u8]) -> bool {
    bytes.len() >= MINIDUMP_HEADER_SIZE
        && u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) == MINIDUMP_SIGNATURE
}

fn find_stream(view: &MinidumpView, stream_type: u32) -> Option<LocationDescriptor> {
    let stream_count = view.u32(8)? as usize;
    let directory_rva = view.u32(12)? as usize;
    if stream_count > MAX_STREAMS {
        return None;
    }
    for index in 0..stream_count {
        let entry = directory_rva.checked_add(index.checked_mul(DIRECTORY_ENTRY_SIZE)?)?;
        let entry_type = view.u32(entry)?;
        if entry_type != stream_type {
            continue;
        }
        let size = view.u32(entry + 4)? as usize;
        let rva = view.u32(entry + 8)? as usize;
        if rva == 0 || rva >= view.bytes.len() {
            return None;
        }
        return Some(LocationDescriptor { size, rva });
    }
    None
}
fn read_simple_annotations(
    view: &MinidumpView,
    location: Option<LocationDescriptor>,
    into: &mut HashMap<String, String>,
) {
    let Some(location) = location else {
        return;
    };
    let Some(count) = view.u32(location.rva).map(|value| value as usize) else {
        return;
    };
    if count > MAX_ANNOTATIONS {
        return;
    }
    if 4usize.checked_add(count.saturating_mul(8)) != Some(4 + count * 8)
        || 4 + count * 8 > location.size
    {
        return;
    }
    for index in 0..count {
        let entry = location.rva + 4 + index * 8;
        let (Some(key_rva), Some(value_rva)) = (view.u32(entry), view.u32(entry + 4)) else {
            return;
        };
        let Some(key) = view.utf8_string(key_rva as usize, 256) else {
            continue;
        };
        if !ANNOTATION_ALLOWLIST.contains(&key.as_str()) {
            continue;
        }
        if let Some(value) = view.utf8_string(value_rva as usize, MAX_ANNOTATION_VALUE_BYTES) {
            into.insert(key, value);
        }
    }
}

fn read_annotation_objects(
    view: &MinidumpView,
    location: Option<LocationDescriptor>,
    into: &mut HashMap<String, String>,
) {
    let Some(location) = location else {
        return;
    };
    let Some(count) = view.u32(location.rva).map(|value| value as usize) else {
        return;
    };
    if count > MAX_ANNOTATIONS || 4 + count * ANNOTATION_RECORD_SIZE > location.size {
        return;
    }
    for index in 0..count {
        let entry = location.rva + 4 + index * ANNOTATION_RECORD_SIZE;
        let (Some(name_rva), Some(kind), Some(value_rva)) =
            (view.u32(entry), view.u16(entry + 4), view.u32(entry + 8))
        else {
            return;
        };
        if kind != ANNOTATION_TYPE_STRING || value_rva == 0 {
            continue;
        }
        let Some(name) = view.utf8_string(name_rva as usize, 256) else {
            continue;
        };
        if !ANNOTATION_ALLOWLIST.contains(&name.as_str()) {
            continue;
        }
        if let Some(raw) = view.byte_array(value_rva as usize, MAX_ANNOTATION_VALUE_BYTES) {
            let mut value = String::from_utf8_lossy(raw).into_owned();
            while value.ends_with('\0') {
                value.pop();
            }
            into.insert(name, value);
        }
    }
}

fn read_crashpad_annotations(view: &MinidumpView) -> HashMap<String, String> {
    let mut annotations = HashMap::new();
    let Some(info) = find_stream(view, STREAM_TYPE_CRASHPAD_INFO) else {
        return annotations;
    };
    if info.size < CRASHPAD_INFO_MIN_SIZE {
        return annotations;
    }
    read_simple_annotations(
        view,
        view.location(info.rva + CRASHPAD_INFO_SIMPLE_ANNOTATIONS_OFFSET),
        &mut annotations,
    );
    let Some(module_list) = view.location(info.rva + CRASHPAD_INFO_MODULE_LIST_OFFSET) else {
        return annotations;
    };
    let Some(module_count) = view.u32(module_list.rva).map(|value| value as usize) else {
        return annotations;
    };
    if module_count > MAX_MODULES {
        return annotations;
    }
    for index in 0..module_count {
        let link = module_list.rva + 4 + index * MODULE_CRASHPAD_INFO_LINK_SIZE;
        let Some(module_info) = view.location(link + 4) else {
            continue;
        };
        if module_info.size < MODULE_CRASHPAD_INFO_MIN_SIZE {
            continue;
        }
        read_simple_annotations(
            view,
            view.location(module_info.rva + MODULE_CRASHPAD_INFO_SIMPLE_ANNOTATIONS_OFFSET),
            &mut annotations,
        );
        read_annotation_objects(
            view,
            view.location(module_info.rva + MODULE_CRASHPAD_INFO_ANNOTATION_OBJECTS_OFFSET),
            &mut annotations,
        );
    }
    annotations
}

fn is_printable_log_byte(value: u8) -> bool {
    value == 0x09 || (0x20..=0x7e).contains(&value)
}

fn last_bracket_within(bytes: &[u8], from: usize, within: usize) -> Option<usize> {
    let floor = from.saturating_sub(within);
    (floor..=from.min(bytes.len().saturating_sub(1)))
        .rev()
        .find(|at| bytes[*at] == 0x5b)
}

fn allowed_detail_char(value: char) -> bool {
    value != ':' && value != ']' && value != '\r' && value != '\n'
}

/// Hand match for the Chromium fatal-log shape (no regex dependency):
/// `[pid:tid/date:SEVERITY:file(line)] message`. Returns file, line, message.
fn match_check_log(candidate: &str) -> Option<(String, Option<u32>, String)> {
    let bytes = candidate.as_bytes();
    if bytes.first() != Some(&b'[') {
        return None;
    }
    let mut pos = 1;
    // One or two digits-colon groups (pid, optional tid). A digit run not
    // followed by a colon is the date, not a second group: rewind it,
    // like the TS backtrack.
    let mut groups = 0;
    while groups < 2 {
        let start = pos;
        while pos < bytes.len() && bytes[pos].is_ascii_digit() {
            pos += 1;
        }
        if pos == start || pos >= bytes.len() || bytes[pos] != b':' {
            pos = start;
            break;
        }
        pos += 1;
        groups += 1;
    }
    if groups == 0 {
        return None;
    }
    // Date: 4 digits, `/`, 6 digits, `.`, 3-6 digits, then `:`.
    let date = [4, 6];
    for (part, width) in date.into_iter().enumerate() {
        for _ in 0..width {
            if pos >= bytes.len() || !bytes[pos].is_ascii_digit() {
                return None;
            }
            pos += 1;
        }
        if pos >= bytes.len() {
            return None;
        }
        let want = if part == 0 { b'/' } else { b'.' };
        if bytes[pos] != want {
            return None;
        }
        pos += 1;
    }
    let frac_start = pos;
    while pos < bytes.len() && bytes[pos].is_ascii_digit() {
        pos += 1;
    }
    if pos - frac_start < 3 || pos - frac_start > 6 || pos >= bytes.len() || bytes[pos] != b':' {
        return None;
    }
    pos += 1;
    let severity = ["DFATAL", "FATAL", "CHECK", "ERROR"]
        .into_iter()
        .find(|severity| candidate[pos..].starts_with(severity))?;
    pos += severity.len();
    let close = candidate.rfind(']')?;
    if close <= pos {
        return None;
    }
    let message = candidate[close + 1..].trim_start().to_string();
    if message.is_empty() {
        return None;
    }
    let head = &candidate[pos..close];
    // Trailing line construct: `(digits)` or `:digits`.
    let head_bytes = head.as_bytes();
    let (file_region, line) = if head_bytes.last() == Some(&b')') {
        let paren = head.rfind('(')?;
        let digits = &head[paren + 1..head.len() - 1];
        if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        (&head[..paren], Some(digits.parse::<u32>().ok()?))
    } else if let Some(colon) = head.rfind(':') {
        let digits = &head[colon + 1..];
        if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        (&head[..colon], Some(digits.parse::<u32>().ok()?))
    } else {
        return None;
    };
    // File: trailing 1..512 chars without `:`, `]`, CR or LF, after a `:`.
    let file_len = file_region
        .chars()
        .rev()
        .take_while(|char| allowed_detail_char(*char))
        .map(|char| char.len_utf8())
        .sum::<usize>();
    if file_len == 0 || file_len > 512 {
        return None;
    }
    let file_start = file_region.len() - file_len;
    if file_start == 0 || file_region.as_bytes()[file_start - 1] != b':' {
        return None;
    }
    // Between severity and file: zero or more `:segment` groups of 1..80
    // allowed chars, each wrapped in the colons already accounted for.
    let mut middle = &file_region[..file_start - 1];
    if !middle.is_empty() {
        if !middle.starts_with(':') {
            return None;
        }
        middle = &middle[1..];
        if middle.is_empty() {
            return None;
        }
        for segment in middle.split(':') {
            if segment.is_empty() || segment.len() > 80 || !segment.chars().all(allowed_detail_char)
            {
                return None;
            }
        }
    }
    if severity == "ERROR" {
        let lower = message.to_ascii_lowercase();
        if !lower.contains("check failed:")
            && !lower.contains("intentionally causing check")
            && !lower.contains("intentionally causing dcheck")
        {
            return None;
        }
    }
    let file = &file_region[file_start..];
    let separator = file
        .rfind('/')
        .or_else(|| file.rfind('\\'))
        .map(|index| index + 1)
        .unwrap_or(0);
    Some((file[separator..].to_string(), line, message))
}

/// Fatal-log line recovered from captured process memory.
#[derive(Debug, Clone)]
pub struct LocatedCheckMessage {
    pub message: String,
    pub file: String,
    pub line: Option<u32>,
}

fn find_subslice(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || from >= haystack.len() {
        return None;
    }
    haystack[from..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|index| from + index)
}

fn read_check_at(
    bytes: &[u8],
    marker_at: usize,
    after_marker: usize,
) -> Option<LocatedCheckMessage> {
    let start = last_bracket_within(bytes, marker_at, MAX_LOG_PREFIX_BYTES)?;
    let mut end = after_marker;
    let limit = (start + MAX_CHECK_LOG_BYTES).min(bytes.len());
    while end < limit && is_printable_log_byte(bytes[end]) {
        end += 1;
    }
    let candidate = String::from_utf8_lossy(&bytes[start..end]).into_owned();
    let (file, line, message) = match_check_log(&candidate)?;
    Some(LocatedCheckMessage {
        message,
        file,
        line,
    })
}

/// Scans captured memory for Chromium fatal-log lines. Lower severities only
/// win once every earlier severity is exhausted, mirroring the TS ordering.
pub fn find_embedded_check_message(bytes: &[u8]) -> Option<LocatedCheckMessage> {
    let block_bytes = 1024 * 1024;
    struct MarkerState {
        inspected: usize,
        found: Option<LocatedCheckMessage>,
    }
    let mut states: Vec<MarkerState> = CHECK_LOG_MARKERS
        .iter()
        .map(|_| MarkerState {
            inspected: 0,
            found: None,
        })
        .collect();
    let mut from = 0;
    while from < bytes.len() {
        let start_at = from.saturating_sub(MAX_LOG_PREFIX_BYTES);
        let window_end =
            (start_at + (from - start_at) + block_bytes + MAX_CHECK_LOG_BYTES).min(bytes.len());
        let window = &bytes[start_at..window_end];
        let scan_end = (from - start_at + block_bytes).min(window.len());
        for (index, state) in states.iter_mut().enumerate() {
            let marker = CHECK_LOG_MARKERS[index];
            let mut next = from - start_at;
            while state.found.is_none()
                && next < scan_end
                && state.inspected < MAX_MARKERS_PER_SEVERITY
            {
                let Some(marker_at) = find_subslice(window, marker, next) else {
                    break;
                };
                if marker_at >= scan_end {
                    break;
                }
                state.inspected += 1;
                next = marker_at + marker.len();
                state.found = read_check_at(window, marker_at, next);
            }
        }
        for state in states.iter() {
            if state.found.is_some() {
                return state.found.clone();
            }
            if state.inspected < MAX_MARKERS_PER_SEVERITY {
                break;
            }
        }
        from = start_at + scan_end;
    }
    states.into_iter().find_map(|state| state.found)
}

/// Diagnosable parts of a Crashpad minidump, without symbols.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MinidumpCrashSignature {
    pub check_message: Option<String>,
    pub check_file: Option<String>,
    pub check_line: Option<u32>,
    pub process_type: Option<String>,
    pub exception_code: Option<u32>,
    pub exception_address: Option<String>,
    pub faulting_module: Option<String>,
    pub faulting_module_offset: Option<String>,
    pub annotations: HashMap<String, String>,
}

struct ModuleRecord {
    base: u64,
    size: u32,
    name: String,
}

fn read_modules(view: &MinidumpView) -> Vec<ModuleRecord> {
    let Some(stream) = find_stream(view, STREAM_TYPE_MODULE_LIST) else {
        return Vec::new();
    };
    let Some(count) = view.u32(stream.rva).map(|value| value as usize) else {
        return Vec::new();
    };
    if count > MAX_MODULE_LIST_MODULES {
        return Vec::new();
    }
    let mut modules = Vec::new();
    for index in 0..count {
        let record = stream.rva + 4 + index * MODULE_RECORD_SIZE;
        let (Some(base), Some(size), Some(name_rva)) = (
            view.u64(record + MODULE_BASE_OFFSET),
            view.u32(record + MODULE_SIZE_OFFSET),
            view.u32(record + MODULE_NAME_RVA_OFFSET),
        ) else {
            break;
        };
        let name = view
            .utf16_string(name_rva as usize, 2_048)
            .unwrap_or_else(|| "unknown".to_string());
        modules.push(ModuleRecord { base, size, name });
    }
    modules
}

fn module_basename(path: &str) -> &str {
    let slash = path.rfind('/').map(|index| index + 1).unwrap_or(0);
    let backslash = path.rfind('\\').map(|index| index + 1).unwrap_or(0);
    &path[slash.max(backslash)..]
}

fn to_hex(value: u64) -> String {
    format!("0x{value:x}")
}

fn find_faulting_module(modules: &[ModuleRecord], address: u64) -> Option<(&str, String)> {
    modules
        .iter()
        .find(|module| address.wrapping_sub(module.base) < module.size as u64)
        .map(|module| (module_basename(&module.name), to_hex(address - module.base)))
}

/// Parses a Crashpad minidump into the fields that make a CHECK failure
/// nameable. Returns None when the buffer is not a minidump.
pub fn parse_minidump_crash_signature(
    bytes: &[u8],
    expected_process_type: Option<&str>,
) -> Option<MinidumpCrashSignature> {
    if !is_minidump(bytes) {
        return None;
    }
    let view = MinidumpView { bytes };
    let annotations = read_crashpad_annotations(&view);
    let mut signature = MinidumpCrashSignature {
        annotations,
        ..Default::default()
    };
    if let Some(process_type) = signature.annotations.get("ptype").cloned() {
        signature.process_type = Some(process_type);
    }
    // Annotations are bounded; the scans below are not. A mismatched process
    // type stops here with a deliberately partial signature.
    if let Some(expected) = expected_process_type {
        if signature.process_type.as_deref() != Some(expected) {
            return Some(signature);
        }
    }
    let embedded = if signature.annotations.contains_key("LOG_FATAL")
        || signature.annotations.contains_key("abort-message")
    {
        None
    } else {
        find_embedded_check_message(bytes)
    };
    let annotated = signature
        .annotations
        .get("LOG_FATAL")
        .or_else(|| signature.annotations.get("abort-message"))
        .cloned();
    if let Some(message) =
        annotated.or_else(|| embedded.as_ref().map(|found| found.message.clone()))
    {
        signature.check_message = Some(message.clone());
        if let Some(found) = embedded {
            signature.check_file = Some(found.file);
            signature.check_line = found.line;
        } else if let Some((file, line, _)) = match_check_log(&message) {
            signature.check_file = Some(file);
            signature.check_line = line;
        }
    }
    if let Some(stream) = find_stream(&view, STREAM_TYPE_EXCEPTION) {
        if let Some(code) = view.u32(stream.rva + EXCEPTION_CODE_OFFSET) {
            signature.exception_code = Some(code);
        }
        if let Some(address) = view.u64(stream.rva + EXCEPTION_ADDRESS_OFFSET) {
            signature.exception_address = Some(to_hex(address));
            if let Some((name, offset)) = find_faulting_module(&read_modules(&view), address) {
                signature.faulting_module = Some(name.to_string());
                signature.faulting_module_offset = Some(offset);
            }
        }
    }
    Some(signature)
}

/// Flattens a signature into `CrashReportRecord.details` keys.
pub fn minidump_signature_details(
    signature: &MinidumpCrashSignature,
) -> Vec<(String, serde_json::Value)> {
    use serde_json::Value;
    let mut details = Vec::new();
    if let Some(message) = &signature.check_message {
        details.push((
            "minidumpCheckMessage".to_string(),
            Value::String(message.clone()),
        ));
    }
    if let Some(file) = &signature.check_file {
        details.push(("minidumpCheckFile".to_string(), Value::String(file.clone())));
    }
    if let Some(line) = signature.check_line {
        details.push(("minidumpCheckLine".to_string(), Value::from(line)));
    }
    if let Some(process_type) = &signature.process_type {
        details.push((
            "minidumpProcessType".to_string(),
            Value::String(process_type.clone()),
        ));
    }
    if let Some(code) = signature.exception_code {
        details.push((
            "minidumpExceptionCode".to_string(),
            Value::String(format!("0x{:x}", code)),
        ));
    }
    if let Some(address) = &signature.exception_address {
        details.push((
            "minidumpExceptionAddress".to_string(),
            Value::String(address.clone()),
        ));
    }
    if let Some(module) = &signature.faulting_module {
        details.push((
            "minidumpFaultingModule".to_string(),
            Value::String(module.clone()),
        ));
    }
    if let Some(offset) = &signature.faulting_module_offset {
        details.push((
            "minidumpFaultingModuleOffset".to_string(),
            Value::String(offset.clone()),
        ));
    }
    let mut names: Vec<&String> = signature.annotations.keys().collect();
    names.sort();
    for name in names {
        if CONSUMED_ANNOTATION_KEYS.contains(&name.as_str()) {
            continue;
        }
        details.push((
            format!("minidumpAnnotation_{}", name.replace('-', "_")),
            Value::String(signature.annotations[name].clone()),
        ));
    }
    details
}

/// A `.dmp` file found under a Crashpad reports directory.
#[derive(Debug, Clone)]
pub struct DumpCandidate {
    pub path: PathBuf,
    pub mtime_ms: u128,
    pub size: u64,
}

/// Crashpad promotes dumps by rename, so a vanished file is normal; symlinks
/// are refused like the native `O_NOFOLLOW` open.
pub fn collect_dump_candidates(dir: &Path) -> Vec<DumpCandidate> {
    let mut stack = vec![dir.to_path_buf()];
    let mut candidates = Vec::new();
    while let Some(current) = stack.pop() {
        let Ok(entries) = fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            if file_type.is_dir() {
                stack.push(path);
                continue;
            }
            if !file_type.is_file()
                || path.extension().and_then(|extension| extension.to_str()) != Some("dmp")
            {
                continue;
            }
            let Ok(metadata) = fs::metadata(&path) else {
                continue;
            };
            if !metadata.is_file() {
                continue;
            }
            let mtime_ms = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|elapsed| elapsed.as_millis())
                .unwrap_or(0);
            candidates.push(DumpCandidate {
                path,
                mtime_ms,
                size: metadata.len(),
            });
        }
    }
    candidates
}

/// Dumps written for the crash: recent, under the size cap, unclaimed,
/// newest first. Stale claims release so a restart never pins a file forever.
pub fn fresh_dump_candidates(
    candidates: &[DumpCandidate],
    crashed_at_ms: u128,
    claimed: &mut HashMap<PathBuf, u128>,
) -> Vec<DumpCandidate> {
    let floor_ms = crashed_at_ms.saturating_sub(DUMP_RECENCY_WINDOW_MS);
    claimed.retain(|_, claimed_at_ms| *claimed_at_ms >= floor_ms);
    let mut fresh: Vec<DumpCandidate> = candidates
        .iter()
        .filter(|candidate| {
            candidate.mtime_ms >= floor_ms
                && candidate.size <= MAX_DUMP_BYTES
                && !claimed.contains_key(&candidate.path)
        })
        .cloned()
        .collect();
    fresh.sort_by(|left, right| {
        right
            .mtime_ms
            .cmp(&left.mtime_ms)
            .then_with(|| left.path.cmp(&right.path))
    });
    fresh
}

/// Crashpad-budget pruning: keep the newest plus anything a persisted report
/// references; the capture path enforces this because no owned handler runs
/// its own passes here.
pub fn select_prune_victims(
    candidates: &[DumpCandidate],
    claimed: &HashMap<PathBuf, u128>,
) -> Vec<PathBuf> {
    let mut sorted = candidates.to_vec();
    sorted.sort_by(|left, right| {
        right
            .mtime_ms
            .cmp(&left.mtime_ms)
            .then_with(|| left.path.cmp(&right.path))
    });
    let mut retained_bytes = 0u64;
    let mut retained_count = 0usize;
    let mut victims = Vec::new();
    for (index, candidate) in sorted.iter().enumerate() {
        let must_keep = index == 0 || claimed.contains_key(&candidate.path);
        if must_keep
            || (retained_bytes + candidate.size <= MAX_STORED_DUMP_BYTES
                && retained_count < MAX_STORED_DUMPS)
        {
            retained_bytes += candidate.size;
            retained_count += 1;
            continue;
        }
        victims.push(candidate.path.clone());
    }
    victims
}

/// WebView2's own Crashpad reports directory under the app-local data dir.
pub fn webview_crash_reports_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    app.path()
        .app_local_data_dir()
        .map(|dir| dir.join("EBWebView").join("Crashpad").join("reports"))
        .map_err(|error| format!("failed to resolve WebView2 crash reports directory: {error}"))
}

/// Reads and parses one dump file. Oversize files are refused like Electron's
/// 64 MiB pick; Ok(None) also covers non-minidumps.
pub fn parse_dump_file(
    path: &Path,
    expected_process_type: Option<&str>,
) -> Result<Option<(MinidumpCrashSignature, u64)>, String> {
    use std::io::Read;
    let file = fs::File::open(path).map_err(|error| format!("failed to open minidump: {error}"))?;
    let mut limited = file.take(MAX_DUMP_BYTES + 1);
    let mut bytes = Vec::new();
    limited
        .read_to_end(&mut bytes)
        .map_err(|error| format!("failed to read minidump: {error}"))?;
    if bytes.len() as u64 > MAX_DUMP_BYTES {
        return Ok(None);
    }
    let size_bytes = bytes.len() as u64;
    Ok(
        parse_minidump_crash_signature(&bytes, expected_process_type)
            .map(|signature| (signature, size_bytes)),
    )
}
#[cfg(test)]
mod tests {
    use super::*;

    fn put_u32(into: &mut Vec<u8>, value: u32) {
        into.extend_from_slice(&value.to_le_bytes());
    }

    fn put_u64(into: &mut Vec<u8>, value: u64) {
        into.extend_from_slice(&value.to_le_bytes());
    }

    fn utf8_string_bytes(value: &str) -> Vec<u8> {
        let mut out = Vec::new();
        put_u32(&mut out, value.len() as u32);
        out.extend_from_slice(value.as_bytes());
        out
    }

    fn utf16_string_bytes(value: &str) -> Vec<u8> {
        let units: Vec<u16> = value.encode_utf16().collect();
        let mut out = Vec::new();
        put_u32(&mut out, (units.len() * 2) as u32);
        for unit in units {
            out.extend_from_slice(&unit.to_le_bytes());
        }
        out
    }

    /// Minimal valid dump: crashpad info with three annotations, one module,
    /// one exception. Returns the bytes.
    fn annotated_dump() -> Vec<u8> {
        let log = "[1234:5678:0101/010203.123456:FATAL:foo.cc(123)] Check failed: x.";
        let mut bytes = vec![0_u8; 32];
        // Header: magic, version, stream count, directory rva, checksum, stamp, flags.
        bytes[0..4].copy_from_slice(&MINIDUMP_SIGNATURE.to_le_bytes());
        bytes[8..12].copy_from_slice(&3_u32.to_le_bytes());
        bytes[12..16].copy_from_slice(&32_u32.to_le_bytes());
        let mut directory = Vec::new();
        // Reserve the directory; patch entries after the streams are placed.
        directory.resize(36, 0);
        let mut streams = Vec::new();

        // Crashpad info stream.
        let crashpad_rva = 32 + 36 + streams.len();
        let mut info = vec![0_u8; 52];
        info[0..4].copy_from_slice(&1_u32.to_le_bytes());
        let dict_rva = crashpad_rva + 52;
        let mut dict = Vec::new();
        put_u32(&mut dict, 3);
        let str_base = dict_rva + 4 + 3 * 8;
        let k_ptype = utf8_string_bytes("ptype");
        let v_renderer = utf8_string_bytes("renderer");
        let k_log = utf8_string_bytes("LOG_FATAL");
        let v_log = utf8_string_bytes(log);
        let k_ver = utf8_string_bytes("ver");
        let v_ver = utf8_string_bytes("1.0");
        let mut strings = Vec::new();
        let mut string_rvas = Vec::new();
        for part in [&k_ptype, &v_renderer, &k_log, &v_log, &k_ver, &v_ver] {
            string_rvas.push(str_base + strings.len());
            strings.extend_from_slice(part);
        }
        for pair in 0..3 {
            put_u32(&mut dict, string_rvas[pair * 2] as u32);
            put_u32(&mut dict, string_rvas[pair * 2 + 1] as u32);
        }
        info[36..40].copy_from_slice(&(dict.len() as u32).to_le_bytes());
        info[40..44].copy_from_slice(&(dict_rva as u32).to_le_bytes());
        let module_list_rva = dict_rva + dict.len() + strings.len();
        info[44..48].copy_from_slice(&4_u32.to_le_bytes());
        info[48..52].copy_from_slice(&(module_list_rva as u32).to_le_bytes());
        streams.extend_from_slice(&info);
        streams.extend_from_slice(&dict);
        streams.extend_from_slice(&strings);
        streams.extend_from_slice(&0_u32.to_le_bytes()); // module-list count 0

        // Module list stream with one module.
        let module_rva = crashpad_rva + streams.len();
        let name = utf16_string_bytes("C:\\x\\chrome.dll");
        let name_rva = module_rva + 4 + MODULE_RECORD_SIZE;
        let mut module_stream = Vec::new();
        put_u32(&mut module_stream, 1);
        module_stream.resize(module_stream.len() + MODULE_RECORD_SIZE, 0);
        let record = 4;
        module_stream[record..record + 8].copy_from_slice(&0x10000_u64.to_le_bytes());
        module_stream[record + 8..record + 12].copy_from_slice(&0x1000_u32.to_le_bytes());
        module_stream[record + 20..record + 24].copy_from_slice(&(name_rva as u32).to_le_bytes());
        module_stream.extend_from_slice(&name);
        streams.extend_from_slice(&module_stream);

        // Exception stream: tid, align, code 0x80000003, address 0x10100.
        let exception_rva = crashpad_rva + streams.len();
        let mut exception = vec![0_u8; 32];
        exception[8..12].copy_from_slice(&0x80000003_u32.to_le_bytes());
        exception[24..32].copy_from_slice(&0x10100_u64.to_le_bytes());
        streams.extend_from_slice(&exception);

        // Patch the directory.
        let mut entries = Vec::new();
        for (stream_type, rva, size) in [
            (STREAM_TYPE_CRASHPAD_INFO, crashpad_rva, 52),
            (
                STREAM_TYPE_MODULE_LIST,
                module_rva,
                4 + MODULE_RECORD_SIZE + name.len(),
            ),
            (STREAM_TYPE_EXCEPTION, exception_rva, 32),
        ] {
            put_u32(&mut entries, stream_type);
            put_u32(&mut entries, size as u32);
            put_u32(&mut entries, rva as u32);
        }
        directory = entries;
        let mut dump = bytes;
        dump.extend_from_slice(&directory);
        dump.extend_from_slice(&streams);
        dump
    }

    #[test]
    fn parses_annotated_renderer_dump() {
        let dump = annotated_dump();
        let signature = parse_minidump_crash_signature(&dump, None).expect("parses");
        assert_eq!(
            signature.check_message.as_deref(),
            Some("[1234:5678:0101/010203.123456:FATAL:foo.cc(123)] Check failed: x.")
        );
        assert_eq!(signature.check_file.as_deref(), Some("foo.cc"));
        assert_eq!(signature.check_line, Some(123));
        assert_eq!(signature.process_type.as_deref(), Some("renderer"));
        assert_eq!(signature.exception_code, Some(0x80000003));
        assert_eq!(signature.exception_address.as_deref(), Some("0x10100"));
        assert_eq!(signature.faulting_module.as_deref(), Some("chrome.dll"));
        assert_eq!(signature.faulting_module_offset.as_deref(), Some("0x100"));
        assert_eq!(
            signature.annotations.get("ver").map(String::as_str),
            Some("1.0")
        );
    }

    #[test]
    fn ptype_gate_returns_partial_signature() {
        let dump = annotated_dump();
        let signature = parse_minidump_crash_signature(&dump, Some("gpu-process")).expect("parses");
        assert_eq!(signature.process_type.as_deref(), Some("renderer"));
        assert!(signature.check_message.is_none());
        assert!(signature.exception_code.is_none());
    }

    #[test]
    fn embedded_check_message_parses_without_annotations() {
        let mut bare = vec![0_u8; 32];
        bare[0..4].copy_from_slice(&MINIDUMP_SIGNATURE.to_le_bytes());
        bare[8..12].copy_from_slice(&0_u32.to_le_bytes());
        let log = "[11:22:1213/010203.123:CHECK:bar\\baz.cc(45)] Check failed: no.";
        bare.extend_from_slice(&[0_u8; 64]);
        bare.extend_from_slice(log.as_bytes());
        bare.extend_from_slice(&[0_u8; 64]);
        let found = find_embedded_check_message(&bare).expect("found");
        assert_eq!(found.file, "baz.cc");
        assert_eq!(found.line, Some(45));
        assert!(found.message.contains("Check failed"));
    }

    #[test]
    fn rejects_non_minidump() {
        assert!(
            parse_minidump_crash_signature(b"not a dump at all, way too short", None).is_none()
        );
        let bad = vec![0_u8; 64];
        assert!(parse_minidump_crash_signature(&bad, None).is_none());
    }

    #[test]
    fn truncated_dump_degrades() {
        let mut dump = annotated_dump();
        dump.truncate(40);
        let signature = parse_minidump_crash_signature(&dump, None).expect("degrades");
        assert!(signature.check_message.is_none());
        assert!(signature.exception_code.is_none());
    }

    #[test]
    fn oversize_module_list_drops_faulting_module_only() {
        let mut dump = annotated_dump();
        // Module-list count lives at the stream rva; find it via the directory.
        let dir_rva = u32::from_le_bytes(dump[12..16].try_into().unwrap()) as usize;
        let mut module_rva = 0;
        for index in 0..3 {
            let entry = dir_rva + index * 12;
            if u32::from_le_bytes(dump[entry..entry + 4].try_into().unwrap())
                == STREAM_TYPE_MODULE_LIST
            {
                module_rva =
                    u32::from_le_bytes(dump[entry + 8..entry + 12].try_into().unwrap()) as usize;
            }
        }
        assert!(module_rva > 0);
        dump[module_rva..module_rva + 4].copy_from_slice(&9000_u32.to_le_bytes());
        let signature = parse_minidump_crash_signature(&dump, None).expect("parses");
        assert!(signature.faulting_module.is_none());
        assert_eq!(signature.exception_code, Some(0x80000003));
    }

    #[test]
    fn check_log_pattern_cases() {
        let (file, line, _) =
            match_check_log("[1:2:0101/010203.123:FATAL:bar/baz.cc(45)] boom").expect("valid");
        assert_eq!(file, "baz.cc");
        assert_eq!(line, Some(45));
        // Timestamp without groups is rejected like the TS pattern.
        assert!(match_check_log("[0101:010203.123:FATAL:foo.cc(1)] x").is_none());
        // ERROR needs a check-failed message.
        assert!(match_check_log("[1:0101/010203.123:ERROR:foo.cc(7)] just noise").is_none());
        assert!(match_check_log("[1:0101/010203.123:ERROR:foo.cc(7)] Check failed: bad").is_some());
        // Colon-separated middle groups pass.
        let (file, _, _) =
            match_check_log("[12:34:0101/010203.123456:FATAL:mid:seg:deep.cc(9)] Check failed: y.")
                .expect("groups");
        assert_eq!(file, "deep.cc");
    }

    #[test]
    fn flatten_skips_consumed_and_converts_dashes() {
        let mut annotations = HashMap::new();
        annotations.insert("ptype".to_string(), "renderer".to_string());
        annotations.insert("LOG_FATAL".to_string(), "line".to_string());
        annotations.insert("gpu-gl-vendor".to_string(), "ARM".to_string());
        let signature = MinidumpCrashSignature {
            check_message: Some("m".to_string()),
            check_line: Some(7),
            exception_code: Some(0x80000003),
            annotations,
            ..Default::default()
        };
        let details = minidump_signature_details(&signature);
        let keys: Vec<&str> = details.iter().map(|(key, _)| key.as_str()).collect();
        assert!(keys.contains(&"minidumpCheckMessage"));
        assert!(keys.contains(&"minidumpCheckLine"));
        assert!(keys.contains(&"minidumpExceptionCode"));
        assert!(keys.contains(&"minidumpAnnotation_gpu_gl_vendor"));
        assert!(!keys
            .iter()
            .any(|key| key.contains("ptype") || key.contains("LOG_FATAL")));
        let code = details
            .iter()
            .find(|(key, _)| key == "minidumpExceptionCode")
            .map(|(_, value)| value.clone());
        assert_eq!(
            code,
            Some(serde_json::Value::String("0x80000003".to_string()))
        );
    }

    #[test]
    fn pairing_filters_recency_size_and_claims() {
        let base = PathBuf::from("C:\\dumps");
        let candidates = vec![
            DumpCandidate {
                path: base.join("old.dmp"),
                mtime_ms: 1_000,
                size: 100,
            },
            DumpCandidate {
                path: base.join("big.dmp"),
                mtime_ms: 90_000,
                size: MAX_DUMP_BYTES + 1,
            },
            DumpCandidate {
                path: base.join("good.dmp"),
                mtime_ms: 95_000,
                size: 200,
            },
            DumpCandidate {
                path: base.join("new.dmp"),
                mtime_ms: 99_000,
                size: 300,
            },
        ];
        let mut claimed = HashMap::from([(base.join("new.dmp"), 99_000_u128)]);
        let fresh = fresh_dump_candidates(&candidates, 100_000, &mut claimed);
        assert_eq!(fresh.len(), 1);
        assert_eq!(fresh[0].path, base.join("good.dmp"));
        // Recent claims still hold inside the window.
        let fresh = fresh_dump_candidates(&candidates, 120_000, &mut claimed);
        assert_eq!(fresh.len(), 1);
        assert_eq!(fresh[0].path, base.join("good.dmp"));
        assert!(fresh
            .iter()
            .all(|candidate| candidate.path != base.join("new.dmp")));
    }

    #[test]
    fn prune_keeps_newest_and_claimed() {
        let base = PathBuf::from("C:\\dumps");
        let candidates = vec![
            DumpCandidate {
                path: base.join("a.dmp"),
                mtime_ms: 3,
                size: MAX_STORED_DUMP_BYTES,
            },
            DumpCandidate {
                path: base.join("b.dmp"),
                mtime_ms: 2,
                size: MAX_STORED_DUMP_BYTES,
            },
            DumpCandidate {
                path: base.join("c.dmp"),
                mtime_ms: 1,
                size: 10,
            },
        ];
        let claimed = HashMap::from([(base.join("c.dmp"), 1_u128)]);
        let victims = select_prune_victims(&candidates, &claimed);
        // Newest (a) and claimed (c) survive; middle child over budget goes.
        assert_eq!(victims, vec![base.join("b.dmp")]);
    }
}
