//! Trimmed shared vocabulary from OpenIDEA `ide-core` (Apache-2.0) for `ide-dap`.

pub mod error;
pub mod event;
pub mod ids;
pub mod input;
pub mod ipc_path;
pub mod jsonc;
pub mod output_encoding;
pub mod path_mapping;
pub mod process;
pub mod task;
pub mod tool_path;
pub mod version_managers;

pub use error::{IdeError, IdeResult};
pub use event::{DebugEvent, EventSink, IdeEvent, NullSink, SharedSink};
pub use ids::*;
pub use ipc_path::IpcPath;
pub use tokio_util::sync::CancellationToken;
