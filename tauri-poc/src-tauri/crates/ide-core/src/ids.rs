use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU32, Ordering};

macro_rules! id_type {
    ($($(#[$doc:meta])* $name:ident),* $(,)?) => {$(
        $(#[$doc])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub u32);

        impl $name {
            /// Allocates a process-unique id.
            pub fn next() -> Self {
                static NEXT: AtomicU32 = AtomicU32::new(1);
                Self(NEXT.fetch_add(1, Ordering::Relaxed))
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "{}#{}", stringify!($name), self.0)
            }
        }
    )*};
}

id_type!(
    /// An open document buffer.
    DocId,
    /// A cancellable, streaming backend request issued by the UI.
    RequestId,
    /// An integrated terminal session.
    TerminalId,
    /// A process started from a run configuration.
    RunId,
    /// A debug adapter session.
    DebugSessionId,
    /// A running language server instance.
    ServerId,
    /// A long-running background task shown in the status bar.
    TaskId,
);

/// Language identifier, e.g. `rust`, `typescript`, `kotlin`. Matches LSP `languageId`.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct LanguageId(pub String);

impl LanguageId {
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
    pub fn plain_text() -> Self {
        Self::new("plaintext")
    }
}

impl std::fmt::Display for LanguageId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
