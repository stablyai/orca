use globset::{Glob, GlobSet, GlobSetBuilder};
use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::sinks::UTF8;
use grep_searcher::{BinaryDetection, SearcherBuilder};
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

const DEFAULT_MAX_SEARCH_MATCHES: usize = 2000;
const MAX_LINE_CONTENT_CHARS: usize = 500;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryDto {
    pub name: String,
    pub is_directory: bool,
    pub is_symlink: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadDirArgs {
    pub dir_path: String,
    pub follow_symlinks: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListFilesArgs {
    pub root_path: String,
    pub exclude_paths: Option<Vec<String>>,
    pub max_results: Option<usize>,
    pub search_query: Option<String>,
    pub candidate_paths: Option<Vec<String>>,
    pub include_ignored: Option<bool>,
    pub follow_symlinks: Option<bool>,
    pub name_filter: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFilesArgs {
    pub query: String,
    pub root_path: String,
    pub case_sensitive: Option<bool>,
    pub whole_word: Option<bool>,
    pub use_regex: Option<bool>,
    pub include_pattern: Option<String>,
    pub exclude_pattern: Option<String>,
    pub max_results: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatchDto {
    pub line: usize,
    pub column: usize,
    pub match_length: usize,
    pub line_content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFileResultDto {
    pub file_path: String,
    pub relative_path: String,
    pub matches: Vec<SearchMatchDto>,
    pub match_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResultDto {
    pub files: Vec<SearchFileResultDto>,
    pub total_matches: usize,
    pub truncated: bool,
}

fn normalize_rel_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn normalize_excludes(exclude_paths: Option<Vec<String>>) -> Vec<String> {
    exclude_paths
        .unwrap_or_default()
        .into_iter()
        .map(|p| p.replace('\\', "/").trim_matches('/').to_string())
        .filter(|p| !p.is_empty())
        .collect()
}

fn is_excluded_rel(rel: &str, excludes: &[String]) -> bool {
    let trimmed = rel.trim_matches('/');
    if trimmed == ".git" || trimmed.starts_with(".git/") {
        return true;
    }
    excludes.iter().any(|ex| {
        trimmed == ex || trimmed.starts_with(&format!("{ex}/"))
    })
}

fn compile_glob_set(pattern: Option<&str>) -> Result<Option<GlobSet>, String> {
    let Some(raw) = pattern.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let mut builder = GlobSetBuilder::new();
    for part in raw.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        let normalized = part.replace('\\', "/");
        let pat = if normalized.contains('/') || normalized.starts_with('*') {
            normalized
        } else {
            format!("**/{normalized}")
        };
        let glob = Glob::new(&pat).map_err(|err| format!("Invalid glob '{part}': {err}"))?;
        builder.add(glob);
    }
    let set = builder
        .build()
        .map_err(|err| format!("Failed to compile glob set: {err}"))?;
    Ok(Some(set))
}

fn read_dir_sync(dir_path: &str, follow_symlinks: bool) -> Result<Vec<DirEntryDto>, String> {
    let entries = fs::read_dir(dir_path)
        .map_err(|err| format!("Failed to read directory '{dir_path}': {err}"))?;
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let is_symlink = file_type.is_symlink();
        let is_directory = if is_symlink && follow_symlinks {
            entry.path().is_dir()
        } else {
            file_type.is_dir()
        };
        out.push(DirEntryDto {
            name,
            is_directory,
            is_symlink,
        });
    }
    out.sort_by(|a, b| {
        b.is_directory
            .cmp(&a.is_directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(out)
}

fn matches_file_filters(rel: &str, query_lower: Option<&str>, name_lower: Option<&str>) -> bool {
    if let Some(q) = query_lower {
        if !rel.to_lowercase().contains(q) {
            return false;
        }
    }
    if let Some(nf) = name_lower {
        let file_name = rel.rsplit('/').next().unwrap_or(rel);
        if !file_name.to_lowercase().contains(nf) {
            return false;
        }
    }
    true
}

fn list_files_sync(args: ListFilesArgs) -> Result<Vec<String>, String> {
    let root = PathBuf::from(&args.root_path);
    if !root.exists() {
        return Err(format!("Root path does not exist: {}", args.root_path));
    }

    let excludes = normalize_excludes(args.exclude_paths);
    let max_results = args.max_results.unwrap_or(usize::MAX);
    let query_lower = args
        .search_query
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_lowercase);
    let name_lower = args
        .name_filter
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_lowercase);

    if let Some(candidates) = args.candidate_paths {
        let mut seen = HashSet::new();
        let mut results: Vec<String> = candidates
            .into_iter()
            .map(|p| p.replace('\\', "/").trim_start_matches('/').to_string())
            .filter(|rel| {
                !rel.is_empty()
                    && !is_excluded_rel(rel, &excludes)
                    && matches_file_filters(rel, query_lower.as_deref(), name_lower.as_deref())
                    && seen.insert(rel.clone())
            })
            .collect();
        results.sort();
        results.truncate(max_results);
        return Ok(results);
    }

    let include_ignored = args.include_ignored.unwrap_or(false);
    let mut builder = WalkBuilder::new(&root);
    builder
        .hidden(false)
        .git_ignore(!include_ignored)
        .git_global(!include_ignored)
        .git_exclude(!include_ignored)
        .ignore(!include_ignored)
        .follow_links(args.follow_symlinks.unwrap_or(false));

    let root_for_filter = root.clone();
    let excludes_for_filter = excludes.clone();
    builder.filter_entry(move |entry| {
        if entry.path() == root_for_filter {
            return true;
        }
        let Ok(rel) = entry.path().strip_prefix(&root_for_filter) else {
            return false;
        };
        let rel_str = normalize_rel_path(rel);
        !is_excluded_rel(&rel_str, &excludes_for_filter)
    });

    let mut files = Vec::new();
    for entry in builder.build().flatten() {
        if !entry.file_type().is_some_and(|ft| ft.is_file()) {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(&root) else {
            continue;
        };
        let rel_str = normalize_rel_path(rel);
        if matches_file_filters(&rel_str, query_lower.as_deref(), name_lower.as_deref()) {
            files.push(rel_str);
            if files.len() >= max_results {
                break;
            }
        }
    }
    files.sort();
    Ok(files)
}

fn search_files_sync(args: SearchFilesArgs) -> Result<SearchResultDto, String> {
    if args.query.is_empty() {
        return Ok(SearchResultDto {
            files: Vec::new(),
            total_matches: 0,
            truncated: false,
        });
    }

    let root = PathBuf::from(&args.root_path);
    if !root.exists() {
        return Err(format!("Root path does not exist: {}", args.root_path));
    }

    let matcher = RegexMatcherBuilder::new()
        .case_insensitive(!args.case_sensitive.unwrap_or(false))
        .word(args.whole_word.unwrap_or(false))
        .fixed_strings(!args.use_regex.unwrap_or(false))
        .build(&args.query)
        .map_err(|err| format!("Invalid search pattern: {err}"))?;

    let include_globs = compile_glob_set(args.include_pattern.as_deref())?;
    let exclude_globs = compile_glob_set(args.exclude_pattern.as_deref())?;
    let max_results = args.max_results.unwrap_or(DEFAULT_MAX_SEARCH_MATCHES);

    let mut builder = WalkBuilder::new(&root);
    builder
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true);

    let root_for_filter = root.clone();
    builder.filter_entry(move |entry| {
        if entry.path() == root_for_filter {
            return true;
        }
        let Some(name) = entry.file_name().to_str() else {
            return true;
        };
        name != ".git"
    });

    let mut searcher = SearcherBuilder::new()
        .binary_detection(BinaryDetection::quit(b'\x00'))
        .line_number(true)
        .build();

    let mut files = Vec::new();
    let mut total_matches = 0usize;
    let mut truncated = false;

    for entry in builder.build().flatten() {
        if total_matches >= max_results {
            truncated = true;
            break;
        }
        if !entry.file_type().is_some_and(|ft| ft.is_file()) {
            continue;
        }
        let path = entry.path();
        let Ok(rel) = path.strip_prefix(&root) else {
            continue;
        };
        let rel_str = normalize_rel_path(rel);
        if let Some(ref ex) = exclude_globs {
            if ex.is_match(&rel_str) {
                continue;
            }
        }
        if let Some(ref inc) = include_globs {
            if !inc.is_match(&rel_str) {
                continue;
            }
        }

        let mut file_matches = Vec::new();
        let remaining = max_results.saturating_sub(total_matches);
        let search_res = searcher.search_path(
            &matcher,
            path,
            UTF8(|line_num, line_text| {
                let trimmed_line = line_text.trim_end_matches(['\r', '\n']);
                if let Ok(Some(m)) = matcher.find(trimmed_line.as_bytes()) {
                    let prefix_chars = trimmed_line[..m.start()].chars().count();
                    let match_chars = trimmed_line[m.start()..m.end()].chars().count().max(1);
                    let content = if trimmed_line.chars().count() > MAX_LINE_CONTENT_CHARS {
                        trimmed_line.chars().take(MAX_LINE_CONTENT_CHARS).collect()
                    } else {
                        trimmed_line.to_string()
                    };
                    file_matches.push(SearchMatchDto {
                        line: line_num as usize,
                        column: prefix_chars + 1,
                        match_length: match_chars,
                        line_content: content,
                    });
                    if file_matches.len() >= remaining {
                        return Ok(false);
                    }
                }
                Ok(true)
            }),
        );

        if search_res.is_ok() && !file_matches.is_empty() {
            let match_count = file_matches.len();
            total_matches += match_count;
            files.push(SearchFileResultDto {
                file_path: path.to_string_lossy().into_owned(),
                relative_path: rel_str,
                matches: file_matches,
                match_count,
            });
            if total_matches >= max_results {
                truncated = true;
                break;
            }
        }
    }

    Ok(SearchResultDto {
        files,
        total_matches,
        truncated,
    })
}

#[tauri::command]
pub async fn poc_read_dir(args: ReadDirArgs) -> Result<Vec<DirEntryDto>, String> {
    let follow = args.follow_symlinks.unwrap_or(true);
    let dir_path = args.dir_path;
    tokio::task::spawn_blocking(move || read_dir_sync(&dir_path, follow))
        .await
        .map_err(|err| format!("read_dir task failed: {err}"))?
}

#[tauri::command]
pub async fn poc_list_files(args: ListFilesArgs) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || list_files_sync(args))
        .await
        .map_err(|err| format!("list_files task failed: {err}"))?
}

#[tauri::command]
pub async fn poc_search_files(args: SearchFilesArgs) -> Result<SearchResultDto, String> {
    tokio::task::spawn_blocking(move || search_files_sync(args))
        .await
        .map_err(|err| format!("search_files task failed: {err}"))?
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
        let dir = std::env::temp_dir().join(format!("orca-fs-search-{label}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn read_dir_sorts_directories_before_files() {
        let dir = make_temp_dir("readdir");
        fs::create_dir_all(dir.join("zeta")).unwrap();
        fs::create_dir_all(dir.join("alpha")).unwrap();
        fs::write(dir.join("beta.txt"), "hi").unwrap();
        fs::write(dir.join("aardvark.txt"), "hi").unwrap();

        let entries = read_dir_sync(dir.to_str().unwrap(), true).unwrap();
        let names: Vec<(&str, bool)> = entries
            .iter()
            .map(|e| (e.name.as_str(), e.is_directory))
            .collect();
        assert_eq!(
            names,
            vec![
                ("alpha", true),
                ("zeta", true),
                ("aardvark.txt", false),
                ("beta.txt", false),
            ]
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_and_search_files_respects_excludes_and_matches() {
        let dir = make_temp_dir("search");
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(dir.join("src/hello.ts"), "export const greet = 'hello world'\n").unwrap();
        fs::write(dir.join("src/skip.rs"), "fn nope() {}\n").unwrap();
        fs::write(dir.join(".git/config"), "greet = hidden\n").unwrap();

        let listed = list_files_sync(ListFilesArgs {
            root_path: dir.to_string_lossy().into_owned(),
            exclude_paths: Some(vec!["src/skip.rs".to_string()]),
            max_results: None,
            search_query: None,
            candidate_paths: None,
            include_ignored: Some(true),
            follow_symlinks: None,
            name_filter: None,
        })
        .unwrap();
        assert_eq!(listed, vec!["src/hello.ts"]);

        let searched = search_files_sync(SearchFilesArgs {
            query: "greet".to_string(),
            root_path: dir.to_string_lossy().into_owned(),
            case_sensitive: Some(true),
            whole_word: Some(true),
            use_regex: Some(false),
            include_pattern: Some("*.ts".to_string()),
            exclude_pattern: None,
            max_results: Some(10),
        })
        .unwrap();
        assert_eq!(searched.total_matches, 1);
        assert_eq!(searched.files[0].relative_path, "src/hello.ts");
        assert_eq!(searched.files[0].matches[0].line, 1);
        assert_eq!(searched.files[0].matches[0].column, 14);
        assert_eq!(searched.files[0].matches[0].match_length, 5);
        let _ = fs::remove_dir_all(&dir);
    }
}
