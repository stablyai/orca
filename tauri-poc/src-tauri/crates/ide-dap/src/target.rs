//! DAP path fields only: output, expressions, environment and program arguments are opaque.
use ide_core::path_mapping::{Direction, PathMapping, file_path, file_uri};
use serde_json::Value;

#[derive(Clone, Debug)]
pub struct TargetMapping {
    pub paths: PathMapping,
    pub external_prefix: String,
}

impl TargetMapping {
    pub fn rewrite(&self, value: &mut Value, direction: Direction) {
        match value {
            Value::Array(items) => items.iter_mut().for_each(|v| self.rewrite(v, direction)),
            Value::Object(fields) => {
                for (key, value) in fields {
                    if key == "pathMappings" {
                        continue;
                    }
                    if matches!(key.as_str(), "path" | "program" | "cwd" | "localRoot" | "remoteRoot") {
                        if let Some(path) = value.as_str() {
                            if matches!(direction, Direction::ToTarget) && path.starts_with(&self.external_prefix) {
                                if let Some(decoded) =
                                    file_path(&format!("file:///{}", path.trim_start_matches(&self.external_prefix)))
                                {
                                    *value = decoded.into();
                                }
                            } else if let Some(mapped) = self.paths.map(path, direction) {
                                *value = mapped.into();
                            } else if matches!(direction, Direction::ToHost) && key == "path" && path.starts_with('/') {
                                *value = format!(
                                    "{}{}",
                                    self.external_prefix,
                                    file_uri(path).trim_start_matches("file:///")
                                )
                                .into();
                            }
                        }
                    } else if !matches!(key.as_str(), "args" | "env" | "output" | "expression" | "value") {
                        self.rewrite(value, direction);
                    }
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn maps_protocol_paths_without_changing_user_data_or_adapter_mappings() {
        let m = TargetMapping {
            paths: PathMapping::new("C:/project", "/app"),
            external_prefix: "openidea-target://test/0/".into(),
        };
        let mut request = json!({"arguments":{"source":{"path":"C:/project/a.py"},"program":"C:/project/a.py","cwd":"C:/project", "args":["C:/project/text"],"env":{"path":"C:/project/text"},"pathMappings":[{"localRoot":"/app","remoteRoot":"/app"}]}});
        m.rewrite(&mut request, Direction::ToTarget);
        assert_eq!(request["arguments"]["source"]["path"], "/app/a.py");
        assert_eq!(request["arguments"]["cwd"], "/app");
        assert_eq!(request["arguments"]["args"][0], "C:/project/text");
        assert_eq!(request["arguments"]["env"]["path"], "C:/project/text");
        let mut response = json!({"body":{"stackFrames":[{"source":{"path":"/app/a.py"}},{"source":{"path":"/usr/lib/a.py"}}],"sources":[{"path":"/app/b.py"}],"output":"/app/a.py"}});
        m.rewrite(&mut response, Direction::ToHost);
        assert_eq!(response["body"]["stackFrames"][0]["source"]["path"], "C:\\project\\a.py");
        assert_eq!(response["body"]["sources"][0]["path"], "C:\\project\\b.py");
        assert_eq!(response["body"]["stackFrames"][1]["source"]["path"], "openidea-target://test/0/usr/lib/a.py");
        assert_eq!(response["body"]["output"], "/app/a.py");
    }
}
