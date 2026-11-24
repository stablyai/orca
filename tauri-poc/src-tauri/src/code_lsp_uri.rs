//! `file://` URI <-> filesystem path conversion (RFC 8089, LSP-compatible).

use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, CONTROLS};
use std::path::{Path, PathBuf};

/// Characters escaped in a file path; `/` and `:` (drive letters) stay literal.
const PATH_ESCAPE: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');

pub fn path_to_uri_string(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let normalized = if cfg!(windows) {
        raw.replace('\\', "/")
    } else {
        raw.into_owned()
    };
    let mut out = String::from("file://");
    if !normalized.starts_with('/') {
        out.push('/');
    }
    out.extend(utf8_percent_encode(&normalized, PATH_ESCAPE));
    out
}

/// Converts a `file:` URI to a local filesystem path; `None` for other schemes.
pub fn uri_to_path(uri: &str) -> Option<PathBuf> {
    let rest = uri
        .strip_prefix("file://")
        .or_else(|| uri.strip_prefix("FILE://"))?;
    let path = match rest.find('/') {
        Some(0) => rest,
        Some(i) if rest[..i].eq_ignore_ascii_case("localhost") => &rest[i..],
        _ => return None,
    };
    let path = path.split(['?', '#']).next().unwrap_or(path);
    let decoded = percent_decode_str(path).decode_utf8().ok()?;
    if cfg!(windows) {
        let trimmed = decoded
            .strip_prefix('/')
            .filter(|s| s.as_bytes().get(1) == Some(&b':'))
            .unwrap_or(&decoded);
        return Some(PathBuf::from(trimmed.replace('/', "\\")));
    }
    Some(PathBuf::from(decoded.into_owned()))
}

pub fn normalize_path_key(path: &str) -> String {
    let slashes = path.replace('\\', "/");
    if slashes.len() >= 2 && slashes.as_bytes()[1] == b':' {
        slashes.to_lowercase()
    } else {
        slashes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_windows_drive_letter_keys() {
        assert_eq!(
            normalize_path_key(r"D:\Code\Ego-Lite\src\Index.ts"),
            "d:/code/ego-lite/src/index.ts"
        );
        assert_eq!(normalize_path_key("/Users/dev/Repo.rs"), "/Users/dev/Repo.rs");
    }

    #[cfg(windows)]
    #[test]
    fn windows_round_trip_with_spaces_and_unicode() {
        let p = PathBuf::from(r"D:\code\my project\café#1.rs");
        let uri = path_to_uri_string(&p);
        assert!(uri.starts_with("file:///D:/code/"), "{uri}");
        assert_eq!(uri_to_path(&uri).unwrap(), p);
        assert_eq!(
            uri_to_path("file://localhost/D:/code/main.rs").unwrap(),
            PathBuf::from(r"D:\code\main.rs")
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_round_trip_with_spaces_and_unicode() {
        for p in ["/tmp/a b/c#d%e.rs", "/home/ü/x[1].ts", "/plain/path.rs"] {
            let uri = path_to_uri_string(Path::new(p));
            assert!(uri.starts_with("file:///"), "{uri}");
            assert_eq!(uri_to_path(&uri).unwrap(), PathBuf::from(p));
        }
    }

    #[test]
    fn rejects_non_file_uri() {
        assert_eq!(uri_to_path("jdt://contents/rt.jar"), None);
        assert_eq!(uri_to_path("https://example.com/a.ts"), None);
    }
}
