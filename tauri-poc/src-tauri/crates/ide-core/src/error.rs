use serde::{Deserialize, Serialize};

pub type IdeResult<T> = Result<T, IdeError>;

/// The single error type that crosses the IPC boundary.
///
/// Crates keep rich internal errors and convert at their public edge; the UI
/// switches on `kind` and shows `message`.
#[derive(Clone, Debug, thiserror::Error, Serialize, Deserialize)]
#[error("{kind:?}: {message}")]
pub struct IdeError {
    pub kind: ErrorKind,
    pub message: String,
    /// Structured detail for errors the UI acts on; `null` for plain errors.
    pub data: Option<ErrorData>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ErrorData {
    Tool { tool: String, missing: bool },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    NotFound,
    AlreadyExists,
    PermissionDenied,
    InvalidInput,
    /// Document version mismatch; the UI must resync the full text.
    OutOfSync,
    Cancelled,
    TimedOut,
    /// A required external tool (language server, git, debugger) is unavailable.
    Unavailable,
    Io,
    Protocol,
    Internal,
}

impl IdeError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into(), data: None }
    }
    pub fn with_tool(mut self, tool: impl Into<String>) -> Self {
        if self.data.is_none() {
            self.data = Some(ErrorData::Tool { tool: tool.into(), missing: false });
        }
        self
    }
    pub fn missing_tool(tool: impl Into<String>) -> Self {
        let tool = tool.into();
        Self {
            kind: ErrorKind::NotFound,
            message: format!("{tool} is not installed"),
            data: Some(ErrorData::Tool { tool, missing: true }),
        }
    }
    pub fn not_found(m: impl Into<String>) -> Self {
        Self::new(ErrorKind::NotFound, m)
    }
    pub fn invalid(m: impl Into<String>) -> Self {
        Self::new(ErrorKind::InvalidInput, m)
    }
    pub fn internal(m: impl Into<String>) -> Self {
        Self::new(ErrorKind::Internal, m)
    }
    pub fn unavailable(m: impl Into<String>) -> Self {
        Self::new(ErrorKind::Unavailable, m)
    }
    pub fn cancelled() -> Self {
        Self::new(ErrorKind::Cancelled, "cancelled")
    }
}

impl From<std::io::Error> for IdeError {
    fn from(e: std::io::Error) -> Self {
        use std::io::ErrorKind as K;
        let kind = match e.kind() {
            K::NotFound => ErrorKind::NotFound,
            K::AlreadyExists => ErrorKind::AlreadyExists,
            K::PermissionDenied => ErrorKind::PermissionDenied,
            K::InvalidInput | K::InvalidData => ErrorKind::InvalidInput,
            _ => ErrorKind::Io,
        };
        Self::new(kind, e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_errors_round_trip_without_changing_diagnostics() {
        let message = "[error] file.css: Unexpected token\n  1 | }\n";
        let error = IdeError::invalid(message).with_tool("prettier");
        let decoded: IdeError = serde_json::from_str(&serde_json::to_string(&error).unwrap()).unwrap();
        assert_eq!(decoded.message, message);
        assert_eq!(decoded.data, Some(ErrorData::Tool { tool: "prettier".into(), missing: false }));
        let missing = IdeError::missing_tool("prettier").with_tool("prettier");
        assert_eq!(missing.kind, ErrorKind::NotFound);
        assert_eq!(missing.data, Some(ErrorData::Tool { tool: "prettier".into(), missing: true }));
    }

    #[test]
    fn legacy_errors_need_no_data() {
        let error: IdeError = serde_json::from_str(r#"{"kind":"unavailable","message":"no server"}"#).unwrap();
        assert!(error.data.is_none());
        assert_eq!(
            serde_json::to_value(error).unwrap(),
            serde_json::json!({"kind":"unavailable","message":"no server","data":null})
        );
    }
}
