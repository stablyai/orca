use gix::bstr::ByteSlice;
use gix::diff::blob::{Algorithm, Diff, InternedInput};
use gix::status::index_worktree::Item as WtItem;
use gix::status::plumbing::index_as_worktree::{Change as WtChange, EntryStatus};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const MAX_STATUS_ENTRIES: usize = 10_000;
const MAX_DIFF_BYTES: usize = 10 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusArgs {
    pub worktree_path: String,
    pub include_ignored: Option<bool>,
    pub include_line_stats: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffArgs {
    pub worktree_path: String,
    pub file_path: String,
    pub staged: bool,
    pub compare_against_head: Option<bool>,
    pub old_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCheckIgnoredArgs {
    pub worktree_path: String,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusEntryDto {
    pub path: String,
    pub status: String,
    pub area: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitUpstreamStatusDto {
    pub has_upstream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream_name: Option<String>,
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusResultDto {
    pub entries: Vec<GitStatusEntryDto>,
    pub conflict_operation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream_status: Option<GitUpstreamStatusDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ignored_paths: Option<Vec<String>>,
    pub did_hit_limit: bool,
    pub status_length: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GitDiffResultDto {
    #[serde(rename = "text", rename_all = "camelCase")]
    Text {
        original_content: String,
        modified_content: String,
        original_is_binary: bool,
        modified_is_binary: bool,
    },
    #[serde(rename = "binary", rename_all = "camelCase")]
    Binary {
        original_content: String,
        modified_content: String,
        original_is_binary: bool,
        modified_is_binary: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        is_image: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        mime_type: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        modified_deleted: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        too_large: Option<bool>,
    },
}

fn bstr_to_string(bytes: &gix::bstr::BStr) -> String {
    bytes.to_str_lossy().into_owned().replace('\\', "/")
}

fn normalize_rel(path: &str) -> String {
    path.replace('\\', "/").trim_start_matches('/').to_string()
}

fn conflict_operation_str(repo: &gix::Repository) -> &'static str {
    use gix::state::InProgress::*;
    match repo.state() {
        Some(Merge) => "merge",
        Some(Rebase | RebaseInteractive) => "rebase",
        Some(CherryPick | CherryPickSequence) => "cherry-pick",
        Some(Revert | RevertSequence) => "revert",
        _ => "unknown",
    }
}

fn upstream_status(repo: &gix::Repository) -> Option<GitUpstreamStatusDto> {
    let head_ref = repo.head_ref().ok().flatten()?;
    let full_name = head_ref.name();
    let tracking = repo
        .branch_remote_tracking_ref_name(full_name, gix::remote::Direction::Fetch)?
        .ok()?;
    let upstream_name = bstr_to_string(tracking.as_ref().shorten());
    let local_id = repo.head_id().ok().map(|id| id.detach());
    let remote_id = repo
        .try_find_reference(tracking.as_ref())
        .ok()
        .flatten()
        .and_then(|mut r| r.peel_to_id().ok().map(|id| id.detach()));

    let (ahead, behind) = match (local_id, remote_id) {
        (Some(l), Some(u)) if l != u => {
            let count = |tip: gix::ObjectId, hide: gix::ObjectId| -> u32 {
                repo.rev_walk([tip])
                    .with_hidden([hide])
                    .all()
                    .ok()
                    .map(|walk| walk.take(10_000).filter_map(Result::ok).count() as u32)
                    .unwrap_or(0)
            };
            (count(l, u), count(u, l))
        }
        _ => (0, 0),
    };

    Some(GitUpstreamStatusDto {
        has_upstream: true,
        upstream_name: Some(upstream_name),
        ahead,
        behind,
    })
}

fn count_lines_diff(old_bytes: &[u8], new_bytes: &[u8]) -> Option<(u32, u32)> {
    if old_bytes.contains(&0) || new_bytes.contains(&0) {
        return None;
    }
    if old_bytes.len() > MAX_DIFF_BYTES || new_bytes.len() > MAX_DIFF_BYTES {
        return None;
    }
    let old_str = std::str::from_utf8(old_bytes).ok()?;
    let new_str = std::str::from_utf8(new_bytes).ok()?;
    let old_lines: Vec<&str> = old_str.split_inclusive('\n').collect();
    let new_lines: Vec<&str> = new_str.split_inclusive('\n').collect();
    let mut input: InternedInput<&str> = InternedInput::default();
    input.reserve(old_lines.len() as u32, new_lines.len() as u32);
    input.update_before(old_lines.iter().copied());
    input.update_after(new_lines.iter().copied());
    let mut diff = Diff::compute(Algorithm::Histogram, &input);
    diff.postprocess_lines(&input);
    let mut added = 0u32;
    let mut removed = 0u32;
    for h in diff.hunks() {
        removed += h.before.end - h.before.start;
        added += h.after.end - h.after.start;
    }
    Some((added, removed))
}

fn read_head_blob(repo: &gix::Repository, rel_path: &str) -> Option<Vec<u8>> {
    let head_tree = repo.head_commit().ok()?.tree().ok()?;
    let entry = head_tree.lookup_entry_by_path(rel_path).ok()??;
    let obj = entry.object().ok()?;
    Some(obj.data.clone())
}

fn read_index_blob(repo: &gix::Repository, rel_path: &str) -> Option<Vec<u8>> {
    let index = repo.index_or_empty().ok()?;
    let entry = index.entry_by_path(rel_path.as_bytes().as_bstr())?;
    let obj = repo.find_object(entry.id).ok()?;
    Some(obj.data.clone())
}

fn read_worktree_bytes(worktree_root: &Path, rel_path: &str) -> Option<Vec<u8>> {
    let full = worktree_root.join(rel_path);
    fs::read(full).ok()
}

fn mime_for_path(path: &str) -> (Option<bool>, Option<String>) {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    match ext.as_deref() {
        Some("png") => (Some(true), Some("image/png".to_string())),
        Some("jpg" | "jpeg") => (Some(true), Some("image/jpeg".to_string())),
        Some("gif") => (Some(true), Some("image/gif".to_string())),
        Some("webp") => (Some(true), Some("image/webp".to_string())),
        Some("svg") => (Some(true), Some("image/svg+xml".to_string())),
        Some("ico") => (Some(true), Some("image/x-icon".to_string())),
        Some("pdf") => (Some(true), Some("application/pdf".to_string())),
        _ => (None, None),
    }
}

fn git_status_sync(args: GitStatusArgs) -> Result<GitStatusResultDto, String> {
    let worktree_root = PathBuf::from(&args.worktree_path);
    let repo = gix::open(&worktree_root)
        .map_err(|err| format!("Failed to open git repo '{}': {err}", args.worktree_path))?;

    let branch = repo
        .head_name()
        .ok()
        .flatten()
        .map(|n| bstr_to_string(n.as_ref().shorten()));
    let head = repo.head_id().ok().map(|id| id.to_string());
    let conflict_operation = conflict_operation_str(&repo).to_string();
    let upstream_status = upstream_status(&repo);
    let include_line_stats = args.include_line_stats.unwrap_or(false);

    let platform = repo
        .status(gix::progress::Discard)
        .map_err(|err| format!("git status init failed: {err}"))?
        .untracked_files(gix::status::UntrackedFiles::Files)
        .index_worktree_rewrites(None)
        .tree_index_track_renames(gix::status::tree_index::TrackRenames::Given(
            gix::diff::Rewrites::default(),
        ));

    let mut iter = platform
        .into_iter(Vec::<gix::bstr::BString>::new())
        .map_err(|err| format!("git status iter failed: {err}"))?;

    let mut entries = Vec::new();
    let mut status_length = 0usize;
    let mut did_hit_limit = false;

    for item in iter.by_ref() {
        let item = item.map_err(|err| format!("git status entry failed: {err}"))?;
        let dto = match item {
            gix::status::Item::IndexWorktree(wt) => match wt {
                WtItem::Modification {
                    rela_path, status, ..
                } => {
                    let path = bstr_to_string(rela_path.as_ref());
                    let (status_str, conflict_kind) = match status {
                        EntryStatus::Conflict { .. } => {
                            ("modified", Some("both_modified".to_string()))
                        }
                        EntryStatus::Change(WtChange::Removed) => ("deleted", None),
                        EntryStatus::Change(_) => ("modified", None),
                        EntryStatus::IntentToAdd => ("added", None),
                        EntryStatus::NeedsUpdate(_) => continue,
                    };
                    let (added, removed) = if include_line_stats && conflict_kind.is_none() {
                        let old = read_index_blob(&repo, &path).unwrap_or_default();
                        let new = if status_str == "deleted" {
                            Vec::new()
                        } else {
                            read_worktree_bytes(&worktree_root, &path).unwrap_or_default()
                        };
                        count_lines_diff(&old, &new)
                            .map(|(a, r)| (Some(a), Some(r)))
                            .unwrap_or((None, None))
                    } else {
                        (None, None)
                    };
                    GitStatusEntryDto {
                        path,
                        status: status_str.to_string(),
                        area: "unstaged".to_string(),
                        old_path: None,
                        conflict_kind,
                        added,
                        removed,
                    }
                }
                WtItem::DirectoryContents { entry, .. } => {
                    if entry.status != gix::dir::entry::Status::Untracked {
                        continue;
                    }
                    let path = bstr_to_string(entry.rela_path.as_ref());
                    let (added, removed) = if include_line_stats {
                        let new = read_worktree_bytes(&worktree_root, &path).unwrap_or_default();
                        count_lines_diff(&[], &new)
                            .map(|(a, r)| (Some(a), Some(r)))
                            .unwrap_or((None, None))
                    } else {
                        (None, None)
                    };
                    GitStatusEntryDto {
                        path,
                        status: "untracked".to_string(),
                        area: "untracked".to_string(),
                        old_path: None,
                        conflict_kind: None,
                        added,
                        removed,
                    }
                }
                WtItem::Rewrite { dirwalk_entry, .. } => GitStatusEntryDto {
                    path: bstr_to_string(dirwalk_entry.rela_path.as_ref()),
                    status: "untracked".to_string(),
                    area: "untracked".to_string(),
                    old_path: None,
                    conflict_kind: None,
                    added: None,
                    removed: None,
                },
            },
            gix::status::Item::TreeIndex(change) => {
                use gix::diff::index::ChangeRef;
                let (path, status_str, old_path) = match change {
                    ChangeRef::Addition { location, .. } => {
                        (bstr_to_string(location.as_ref()), "added", None)
                    }
                    ChangeRef::Deletion { location, .. } => {
                        (bstr_to_string(location.as_ref()), "deleted", None)
                    }
                    ChangeRef::Modification { location, .. } => {
                        (bstr_to_string(location.as_ref()), "modified", None)
                    }
                    ChangeRef::Rewrite {
                        source_location,
                        location,
                        copy,
                        ..
                    } => {
                        let s = if copy { "copied" } else { "renamed" };
                        (
                            bstr_to_string(location.as_ref()),
                            s,
                            Some(bstr_to_string(source_location.as_ref())),
                        )
                    }
                };
                let (added, removed) = if include_line_stats {
                    let old = read_head_blob(&repo, old_path.as_deref().unwrap_or(&path))
                        .unwrap_or_default();
                    let new = if status_str == "deleted" {
                        Vec::new()
                    } else {
                        read_index_blob(&repo, &path).unwrap_or_default()
                    };
                    count_lines_diff(&old, &new)
                        .map(|(a, r)| (Some(a), Some(r)))
                        .unwrap_or((None, None))
                } else {
                    (None, None)
                };
                GitStatusEntryDto {
                    path,
                    status: status_str.to_string(),
                    area: "staged".to_string(),
                    old_path,
                    conflict_kind: None,
                    added,
                    removed,
                }
            }
        };
        status_length += 1;
        if entries.len() < MAX_STATUS_ENTRIES {
            entries.push(dto);
        } else {
            did_hit_limit = true;
            break;
        }
    }

    Ok(GitStatusResultDto {
        entries,
        conflict_operation,
        head,
        branch,
        upstream_status,
        ignored_paths: if args.include_ignored.unwrap_or(false) {
            Some(Vec::new())
        } else {
            None
        },
        did_hit_limit,
        status_length,
    })
}

fn git_diff_sync(args: GitDiffArgs) -> Result<GitDiffResultDto, String> {
    let worktree_root = PathBuf::from(&args.worktree_path);
    let repo = gix::open(&worktree_root)
        .map_err(|err| format!("Failed to open git repo '{}': {err}", args.worktree_path))?;

    let rel_path = normalize_rel(&args.file_path);
    let old_rel = args
        .old_path
        .as_deref()
        .map(normalize_rel)
        .unwrap_or_else(|| rel_path.clone());

    let original_bytes = if args.staged || args.compare_against_head.unwrap_or(false) {
        read_head_blob(&repo, &old_rel).unwrap_or_default()
    } else {
        read_index_blob(&repo, &old_rel)
            .or_else(|| read_head_blob(&repo, &old_rel))
            .unwrap_or_default()
    };

    let (modified_bytes, modified_deleted) = if args.staged {
        match read_index_blob(&repo, &rel_path) {
            Some(bytes) => (bytes, false),
            None => (Vec::new(), true),
        }
    } else {
        match read_worktree_bytes(&worktree_root, &rel_path) {
            Some(bytes) => (bytes, false),
            None => (Vec::new(), true),
        }
    };

    let too_large =
        original_bytes.len() > MAX_DIFF_BYTES || modified_bytes.len() > MAX_DIFF_BYTES;
    let orig_bin = too_large || original_bytes.contains(&0);
    let mod_bin = too_large || modified_bytes.contains(&0);

    if orig_bin || mod_bin {
        let (is_image, mime_type) = mime_for_path(&rel_path);
        return Ok(GitDiffResultDto::Binary {
            original_content: String::new(),
            modified_content: String::new(),
            original_is_binary: orig_bin,
            modified_is_binary: mod_bin,
            is_image,
            mime_type,
            modified_deleted: if modified_deleted { Some(true) } else { None },
            too_large: if too_large { Some(true) } else { None },
        });
    }

    Ok(GitDiffResultDto::Text {
        original_content: String::from_utf8_lossy(&original_bytes).into_owned(),
        modified_content: String::from_utf8_lossy(&modified_bytes).into_owned(),
        original_is_binary: false,
        modified_is_binary: false,
    })
}

fn git_check_ignored_sync(args: GitCheckIgnoredArgs) -> Result<Vec<String>, String> {
    let worktree_root = PathBuf::from(&args.worktree_path);
    let repo = gix::open(&worktree_root)
        .map_err(|err| format!("Failed to open git repo '{}': {err}", args.worktree_path))?;
    let index = repo.index_or_empty().map_err(|err| format!("{err}"))?;
    let mut excludes = repo
        .excludes(
            &index,
            None,
            gix::worktree::stack::state::ignore::Source::WorktreeThenIdMappingIfNotSkipped,
        )
        .map_err(|err| format!("git excludes init failed: {err}"))?;

    let mut ignored = Vec::new();
    for raw in args.paths {
        let rel = normalize_rel(&raw);
        if rel.is_empty() {
            continue;
        }
        let mode = if worktree_root.join(&rel).is_dir() {
            gix::index::entry::Mode::DIR
        } else {
            gix::index::entry::Mode::FILE
        };
        if let Ok(platform) = excludes.at_path(&rel, Some(mode)) {
            if platform.is_excluded() {
                ignored.push(raw);
            }
        }
    }
    Ok(ignored)
}

#[tauri::command]
pub async fn poc_git_status(args: GitStatusArgs) -> Result<GitStatusResultDto, String> {
    tokio::task::spawn_blocking(move || git_status_sync(args))
        .await
        .map_err(|err| format!("git_status task failed: {err}"))?
}

#[tauri::command]
pub async fn poc_git_diff(args: GitDiffArgs) -> Result<GitDiffResultDto, String> {
    tokio::task::spawn_blocking(move || git_diff_sync(args))
        .await
        .map_err(|err| format!("git_diff task failed: {err}"))?
}

#[tauri::command]
pub async fn poc_git_check_ignored(args: GitCheckIgnoredArgs) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || git_check_ignored_sync(args))
        .await
        .map_err(|err| format!("git_check_ignored task failed: {err}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn make_temp_repo(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("orca-git-insp-{label}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        let status = Command::new("git")
            .args(["init", "-q"])
            .current_dir(&dir)
            .status()
            .unwrap();
        assert!(status.success());
        Command::new("git")
            .args(["config", "user.email", "test@example.com"])
            .current_dir(&dir)
            .status()
            .unwrap();
        Command::new("git")
            .args(["config", "user.name", "Test"])
            .current_dir(&dir)
            .status()
            .unwrap();
        dir
    }

    #[test]
    fn status_and_diff_report_modified_and_untracked_files() {
        let repo_dir = make_temp_repo("status");
        fs::write(repo_dir.join("a.txt"), "line1\nline2\n").unwrap();
        Command::new("git")
            .args(["add", "a.txt"])
            .current_dir(&repo_dir)
            .status()
            .unwrap();
        Command::new("git")
            .args(["commit", "-q", "-m", "init"])
            .current_dir(&repo_dir)
            .status()
            .unwrap();

        fs::write(repo_dir.join("a.txt"), "line1\nline2\nline3\n").unwrap();
        fs::write(repo_dir.join("new.txt"), "hello\n").unwrap();

        let status = git_status_sync(GitStatusArgs {
            worktree_path: repo_dir.to_string_lossy().into_owned(),
            include_ignored: None,
            include_line_stats: Some(true),
        })
        .unwrap();

        assert_eq!(status.conflict_operation, "unknown");
        assert!(status.entries.iter().any(|e| e.path == "a.txt"
            && e.status == "modified"
            && e.area == "unstaged"
            && e.added == Some(1)
            && e.removed == Some(0)));
        assert!(status
            .entries
            .iter()
            .any(|e| e.path == "new.txt" && e.status == "untracked" && e.area == "untracked"));

        let diff = git_diff_sync(GitDiffArgs {
            worktree_path: repo_dir.to_string_lossy().into_owned(),
            file_path: "a.txt".to_string(),
            staged: false,
            compare_against_head: None,
            old_path: None,
        })
        .unwrap();

        match diff {
            GitDiffResultDto::Text {
                original_content,
                modified_content,
                ..
            } => {
                assert_eq!(original_content, "line1\nline2\n");
                assert_eq!(modified_content, "line1\nline2\nline3\n");
            }
            GitDiffResultDto::Binary { .. } => panic!("expected text diff"),
        }

        let _ = fs::remove_dir_all(&repo_dir);
    }
}
