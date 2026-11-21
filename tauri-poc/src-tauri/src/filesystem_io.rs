use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

const MAX_READ_FILE_BYTES: u64 = 10 * 1024 * 1024;
const WATCH_BATCH_WINDOW_MS: u64 = 75;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileArgs {
    pub file_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileResultDto {
    pub content: String,
    pub is_binary: bool,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_image: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_identity: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileChunkArgs {
    pub file_path: String,
    pub offset: u64,
    pub length: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileChunkResultDto {
    pub content_base64: String,
    pub bytes_read: usize,
    pub eof: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatArgs {
    pub file_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatResultDto {
    pub size: u64,
    pub is_directory: bool,
    pub mtime: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsChangeEventDto {
    pub kind: String,
    pub absolute_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_absolute_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_directory: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsChangedPayloadDto {
    pub worktree_path: String,
    pub events: Vec<FsChangeEventDto>,
}

struct ActiveWatch {
    _watcher: RecommendedWatcher,
    stop_tx: mpsc::Sender<()>,
}

#[derive(Default)]
pub struct FsWatcherState {
    watches: Mutex<HashMap<String, ActiveWatch>>,
}

fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn image_mime_for_path(path: &Path) -> Option<&'static str> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    match ext.as_deref() {
        Some("png") => Some("image/png"),
        Some("jpg" | "jpeg") => Some("image/jpeg"),
        Some("gif") => Some("image/gif"),
        Some("webp") => Some("image/webp"),
        Some("svg") => Some("image/svg+xml"),
        Some("ico") => Some("image/x-icon"),
        _ => None,
    }
}

fn read_file_sync(file_path: &str) -> Result<ReadFileResultDto, String> {
    let path = Path::new(file_path);
    let meta =
        fs::metadata(path).map_err(|err| format!("Failed to stat '{file_path}': {err}"))?;
    if meta.is_dir() {
        return Err(format!("Path is a directory: {file_path}"));
    }
    let size = meta.len();
    let file_identity = Some(format!("{size}:{}", mtime_ms(&meta)));

    if size > MAX_READ_FILE_BYTES {
        return Ok(ReadFileResultDto {
            content: String::new(),
            is_binary: true,
            size,
            is_image: None,
            mime_type: None,
            file_identity,
        });
    }

    let bytes =
        fs::read(path).map_err(|err| format!("Failed to read '{file_path}': {err}"))?;

    if let Some(mime) = image_mime_for_path(path) {
        return Ok(ReadFileResultDto {
            content: BASE64.encode(&bytes),
            is_binary: true,
            size,
            is_image: Some(true),
            mime_type: Some(mime.to_string()),
            file_identity,
        });
    }

    let probe_len = bytes.len().min(8192);
    if bytes[..probe_len].contains(&0) {
        return Ok(ReadFileResultDto {
            content: String::new(),
            is_binary: true,
            size,
            is_image: None,
            mime_type: None,
            file_identity,
        });
    }

    Ok(ReadFileResultDto {
        content: String::from_utf8_lossy(&bytes).into_owned(),
        is_binary: false,
        size,
        is_image: None,
        mime_type: None,
        file_identity,
    })
}

fn read_file_chunk_sync(
    file_path: &str,
    offset: u64,
    length: usize,
) -> Result<ReadFileChunkResultDto, String> {
    let mut file =
        File::open(file_path).map_err(|err| format!("Failed to open '{file_path}': {err}"))?;
    let total_len = file
        .metadata()
        .map_err(|err| format!("Failed to stat '{file_path}': {err}"))?
        .len();
    if offset >= total_len || length == 0 {
        return Ok(ReadFileChunkResultDto {
            content_base64: String::new(),
            bytes_read: 0,
            eof: true,
        });
    }
    file.seek(SeekFrom::Start(offset))
        .map_err(|err| format!("Failed to seek '{file_path}': {err}"))?;
    let to_read = (length as u64).min(total_len - offset) as usize;
    let mut buf = vec![0u8; to_read];
    let mut read_total = 0usize;
    while read_total < to_read {
        let n = file
            .read(&mut buf[read_total..])
            .map_err(|err| format!("Failed to read '{file_path}': {err}"))?;
        if n == 0 {
            break;
        }
        read_total += n;
    }
    buf.truncate(read_total);
    let eof = offset + (read_total as u64) >= total_len;
    Ok(ReadFileChunkResultDto {
        content_base64: BASE64.encode(&buf),
        bytes_read: read_total,
        eof,
    })
}

fn stat_sync(file_path: &str) -> Result<StatResultDto, String> {
    let meta =
        fs::metadata(file_path).map_err(|err| format!("Failed to stat '{file_path}': {err}"))?;
    Ok(StatResultDto {
        size: meta.len(),
        is_directory: meta.is_dir(),
        mtime: mtime_ms(&meta),
    })
}

fn should_ignore_watch_path(path: &Path) -> bool {
    let s = path.to_string_lossy();
    s.contains("/.git/objects")
        || s.contains("\\.git\\objects")
        || s.contains("/.git/logs")
        || s.contains("\\.git\\logs")
}

fn map_notify_event(event: Event) -> Vec<FsChangeEventDto> {
    let kind = match event.kind {
        EventKind::Create(_) => "create",
        EventKind::Modify(_) => "update",
        EventKind::Remove(_) => "delete",
        _ => return Vec::new(),
    };
    event
        .paths
        .into_iter()
        .filter(|p| !should_ignore_watch_path(p))
        .map(|p| FsChangeEventDto {
            kind: kind.to_string(),
            is_directory: if kind == "delete" {
                None
            } else {
                Some(p.is_dir())
            },
            absolute_path: p.to_string_lossy().into_owned(),
            old_absolute_path: None,
        })
        .collect()
}

#[tauri::command]
pub async fn poc_read_file(args: ReadFileArgs) -> Result<ReadFileResultDto, String> {
    let file_path = args.file_path;
    tokio::task::spawn_blocking(move || read_file_sync(&file_path))
        .await
        .map_err(|err| format!("read_file task failed: {err}"))?
}

#[tauri::command]
pub async fn poc_read_file_chunk(
    args: ReadFileChunkArgs,
) -> Result<ReadFileChunkResultDto, String> {
    tokio::task::spawn_blocking(move || read_file_chunk_sync(&args.file_path, args.offset, args.length))
        .await
        .map_err(|err| format!("read_file_chunk task failed: {err}"))?
}

#[tauri::command]
pub async fn poc_stat(args: StatArgs) -> Result<StatResultDto, String> {
    let file_path = args.file_path;
    tokio::task::spawn_blocking(move || stat_sync(&file_path))
        .await
        .map_err(|err| format!("stat task failed: {err}"))?
}

#[tauri::command]
pub fn poc_watch_worktree(
    app: AppHandle,
    state: State<'_, FsWatcherState>,
    worktree_path: String,
) -> Result<(), String> {
    let mut watches = state
        .watches
        .lock()
        .map_err(|_| "watch lock poisoned".to_string())?;
    if watches.contains_key(&worktree_path) {
        return Ok(());
    }

    let root = PathBuf::from(&worktree_path);
    if !root.exists() {
        return Err(format!("Worktree path does not exist: {worktree_path}"));
    }

    let (ev_tx, ev_rx) = mpsc::channel::<notify::Result<Event>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();

    let mut watcher = notify::recommended_watcher(move |res| {
        let _ = ev_tx.send(res);
    })
    .map_err(|err| format!("Failed to create watcher: {err}"))?;

    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|err| format!("Failed to watch '{worktree_path}': {err}"))?;

    let wt = worktree_path.clone();
    std::thread::spawn(move || {
        let mut pending: Vec<FsChangeEventDto> = Vec::new();
        loop {
            if stop_rx.try_recv().is_ok() {
                break;
            }
            match ev_rx.recv_timeout(Duration::from_millis(WATCH_BATCH_WINDOW_MS)) {
                Ok(Ok(event)) => {
                    pending.extend(map_notify_event(event));
                    while let Ok(Ok(more)) = ev_rx.try_recv() {
                        pending.extend(map_notify_event(more));
                    }
                }
                Ok(Err(_)) => {}
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if !pending.is_empty() {
                        let batch = std::mem::take(&mut pending);
                        let _ = app.emit(
                            "fs:changed",
                            FsChangedPayloadDto {
                                worktree_path: wt.clone(),
                                events: batch,
                            },
                        );
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });

    watches.insert(
        worktree_path,
        ActiveWatch {
            _watcher: watcher,
            stop_tx,
        },
    );
    Ok(())
}

#[tauri::command]
pub fn poc_unwatch_worktree(
    state: State<'_, FsWatcherState>,
    worktree_path: String,
) -> Result<(), String> {
    let mut watches = state
        .watches
        .lock()
        .map_err(|_| "watch lock poisoned".to_string())?;
    if let Some(active) = watches.remove(&worktree_path) {
        let _ = active.stop_tx.send(());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn make_temp_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("orca-fs-io-{label}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn read_file_chunk_and_stat_work_for_text_and_binary() {
        let dir = make_temp_dir("io");
        let txt = dir.join("hello.txt");
        let bin = dir.join("data.bin");
        fs::write(&txt, "hello world").unwrap();
        fs::write(&bin, [0u8, 1, 2, 3]).unwrap();

        let text_res = read_file_sync(txt.to_str().unwrap()).unwrap();
        assert!(!text_res.is_binary);
        assert_eq!(text_res.content, "hello world");
        assert_eq!(text_res.size, 11);

        let bin_res = read_file_sync(bin.to_str().unwrap()).unwrap();
        assert!(bin_res.is_binary);

        let chunk = read_file_chunk_sync(txt.to_str().unwrap(), 6, 5).unwrap();
        assert_eq!(chunk.bytes_read, 5);
        assert!(chunk.eof);
        assert_eq!(BASE64.decode(chunk.content_base64).unwrap(), b"world");

        let st = stat_sync(txt.to_str().unwrap()).unwrap();
        assert_eq!(st.size, 11);
        assert!(!st.is_directory);

        let _ = fs::remove_dir_all(&dir);
    }
}
