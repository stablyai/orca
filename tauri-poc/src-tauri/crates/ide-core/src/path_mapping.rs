//! Lexical path translation at protocol boundaries, independent of LSP or DAP.
use percent_encoding::{CONTROLS, percent_decode_str, utf8_percent_encode};
use serde_json::Value;

const ESCAPES: &percent_encoding::AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'[')
    .add(b']')
    .add(b'\\')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PathMapping {
    host: String,
    target: String,
    windows: bool,
}

#[derive(Clone, Copy)]
pub enum Direction {
    ToTarget,
    ToHost,
}

fn normalized(path: &str) -> String {
    let path = path
        .strip_prefix(r"\\?\UNC\")
        .map(|p| format!("//{p}"))
        .unwrap_or_else(|| path.strip_prefix(r"\\?\").unwrap_or(path).to_owned());
    let path = path.replace('\\', "/");
    if path == "/" { path } else { path.trim_end_matches('/').to_owned() }
}

pub fn file_path(uri: &str) -> Option<String> {
    if !uri.get(..7)?.eq_ignore_ascii_case("file://") {
        return None;
    }
    let rest = &uri[7..];
    let path = if rest.starts_with('/') {
        rest.to_owned()
    } else {
        let (authority, path) = rest.split_once('/')?;
        if authority.eq_ignore_ascii_case("localhost") { format!("/{path}") } else { format!("//{authority}/{path}") }
    };
    let decoded = percent_decode_str(path.split(['?', '#']).next()?).decode_utf8().ok()?;
    let path = decoded.strip_prefix('/').filter(|p| p.as_bytes().get(1) == Some(&b':')).unwrap_or(&decoded);
    Some(path.to_owned())
}

pub fn file_uri(path: &str) -> String {
    let path = normalized(path);
    format!("file://{}{}", if path.starts_with('/') { "" } else { "/" }, utf8_percent_encode(&path, ESCAPES))
}

impl PathMapping {
    pub fn new(host: &str, target: &str) -> Self {
        let host = normalized(host);
        let windows = host.as_bytes().get(1) == Some(&b':') || host.starts_with("//");
        Self { host, target: normalized(target), windows }
    }

    pub fn map(&self, value: &str, direction: Direction) -> Option<String> {
        let uri_path = file_path(value);
        let is_uri = uri_path.is_some();
        let path = normalized(uri_path.as_deref().unwrap_or(value));
        let (from, to) = match direction {
            Direction::ToTarget => (&self.host, &self.target),
            Direction::ToHost => (&self.target, &self.host),
        };
        let prefix = path.get(..from.len())?;
        let same = if self.windows && matches!(direction, Direction::ToTarget) {
            prefix.eq_ignore_ascii_case(from)
        } else {
            prefix == from
        };
        if !same {
            return None;
        }
        let suffix = &path[from.len()..];
        if !suffix.is_empty() && !suffix.starts_with('/') && from != "/" {
            return None;
        }
        // Never let lexical parent segments escape either mapped root.
        if suffix.split('/').any(|p| p == ".." || p == ".") {
            return None;
        }
        let mapped = format!("{}/{}", to.trim_end_matches('/'), suffix.trim_start_matches('/'));
        let mapped = if suffix.is_empty() { to.clone() } else { mapped };
        Some(if is_uri {
            let suffix = value.find(['?', '#']).map(|i| &value[i..]).unwrap_or("");
            format!("{}{suffix}", file_uri(&mapped))
        } else if self.windows && matches!(direction, Direction::ToHost) {
            mapped.replace('/', "\\")
        } else {
            mapped
        })
    }

    pub fn rewrite(&self, value: &mut Value, direction: Direction) {
        rewrite_strings(value, &|s| self.map(s, direction));
    }
}

/// Rewrites strings and object keys (WorkspaceEdit.changes uses URIs as keys).
/// Resolve tokens and command arguments remain opaque; source text is never a path.
pub fn rewrite_strings(value: &mut Value, map: &dyn Fn(&str) -> Option<String>) {
    match value {
        Value::String(s) => {
            if let Some(mapped) = map(s) {
                *s = mapped;
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|v| rewrite_strings(v, map)),
        Value::Object(fields) => {
            let old = std::mem::take(fields);
            for (key, mut value) in old {
                if !matches!(key.as_str(), "data" | "arguments" | "text" | "newText" | "insertText") {
                    rewrite_strings(&mut value, map);
                }
                fields.insert(map(&key).unwrap_or(key), value);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn roots_encoding_boundaries_and_windows() {
        for host in ["C:/Users/me/项目", r"C:\Users\me\项目", r"\\?\C:\Users\me\项目"] {
            let m = PathMapping::new(host, "/app");
            assert_eq!(m.map(r"\\?\c:\Users\me\项目\a b#%.php", Direction::ToTarget).unwrap(), "/app/a b#%.php");
            assert_eq!(
                m.map("file:///C:/Users/me/%E9%A1%B9%E7%9B%AE/a%20b%23%25.php", Direction::ToTarget).unwrap(),
                "file:///app/a%20b%23%25.php"
            );
            assert_eq!(
                m.map("file:///app/a%20b%23%25.php", Direction::ToHost).unwrap(),
                "file:///C:/Users/me/%E9%A1%B9%E7%9B%AE/a%20b%23%25.php"
            );
            assert_eq!(m.map("/app/a.php", Direction::ToHost).unwrap(), r"C:\Users\me\项目\a.php");
            for outside in ["/app2/a", "/vendor/a", "/app/../outside", "jdt://app/a"] {
                assert!(m.map(outside, Direction::ToHost).is_none());
            }
        }
        let unc = PathMapping::new(r"\\?\UNC\server\share\project", "/app");
        assert_eq!(unc.map("file://server/share/project/a.php", Direction::ToTarget).unwrap(), "file:///app/a.php");
        assert_eq!(unc.map("/app/a.php", Direction::ToHost).unwrap(), r"\\server\share\project\a.php");
        let m = PathMapping::new("/home/me/project", "/app");
        assert_eq!(m.map("/home/me/project", Direction::ToTarget).unwrap(), "/app");
        assert_eq!(m.map("file://localhost/app/a", Direction::ToHost).unwrap(), "file:///home/me/project/a");
        assert!(m.map("/home/me/project2/a", Direction::ToTarget).is_none());
        assert_eq!(
            m.map("file:///app/a%23b?query#fragment", Direction::ToHost).unwrap(),
            "file:///home/me/project/a%23b?query#fragment"
        );
    }

    #[test]
    fn nested_messages_resource_operations_and_opaque_payloads() {
        let m = PathMapping::new("/host/project", "/app");
        let mut v = json!({"rootUri":"file:///host/project", "rootPath":"/host/project", "workspaceFolders":[{"uri":"file:///host/project"}],
            "edit":{"changes":{"file:///host/project/a":[]}, "documentChanges":[{"oldUri":"file:///host/project/a", "newUri":"file:///host/project/b"}]},
            "relatedInformation":[{"location":{"uri":"file:///host/project/a"}}], "target":"file:///host/project/b",
            "configuration":[{"includePath":"/host/project/vendor"}], "text":"/host/project/a", "newText":"/host/project/b", "data":{"uri":"file:///host/project/a"}, "command":{"arguments":["/host/project/a"]}});
        let original = v.clone();
        m.rewrite(&mut v, Direction::ToTarget);
        assert_eq!(v["rootUri"], "file:///app");
        assert_eq!(v["rootPath"], "/app");
        assert!(v["edit"]["changes"].get("file:///app/a").is_some());
        assert_eq!(v["edit"]["documentChanges"][0]["newUri"], "file:///app/b");
        assert_eq!(v["relatedInformation"][0]["location"]["uri"], "file:///app/a");
        assert_eq!(v["configuration"][0]["includePath"], "/app/vendor");
        assert_eq!(v["data"], original["data"]);
        assert_eq!(v["command"], original["command"]);
        m.rewrite(&mut v, Direction::ToHost);
        assert_eq!(v, original);
    }
}
