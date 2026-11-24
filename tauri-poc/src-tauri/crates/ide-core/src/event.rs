//! Backend -> consumer event bus (trimmed from OpenIDEA `ide-core` for `ide-dap`).

use crate::{DebugSessionId, TaskId};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum IdeEvent {
    /// Progress of a background task; `fraction` is `None` when indeterminate.
    Task {
        id: TaskId,
        title: String,
        message: Option<String>,
        fraction: Option<f32>,
        done: bool,
        cancellable: bool,
    },
    Debug {
        session: DebugSessionId,
        event: DebugEvent,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DebugEvent {
    /// First event of every session (only build output of a root session's
    /// `cargo` step can precede it). `parent` is set for adapter-started child sessions.
    Started {
        name: String,
        adapter: String,
        parent: Option<DebugSessionId>,
    },
    Initialized,
    Stopped {
        thread_id: i64,
        reason: String,
        description: Option<String>,
        all_threads_stopped: bool,
    },
    Continued {
        thread_id: i64,
        all_threads_continued: bool,
    },
    Output {
        category: String,
        output: String,
    },
    Thread {
        thread_id: i64,
        started: bool,
    },
    /// The program runs in a terminal the IDE gave it (`runInTerminal`): what is typed for it
    /// in the debug console reaches its input.
    ProgramInput,
    BreakpointsChanged {
        path: crate::IpcPath,
    },
    Terminated,
    Exited {
        code: i32,
    },
    /// java-debug's `hotcodereplace` event.
    HotCodeReplace {
        change_type: String,
        message: String,
    },
}

/// Where backend crates publish [`IdeEvent`]s. Cheap to clone via `Arc`.
pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, event: IdeEvent);
}

impl<F: Fn(IdeEvent) + Send + Sync + 'static> EventSink for F {
    fn emit(&self, event: IdeEvent) {
        self(event)
    }
}

pub type SharedSink = Arc<dyn EventSink>;

/// Discards events; for tests and headless tools.
pub struct NullSink;

impl EventSink for NullSink {
    fn emit(&self, _: IdeEvent) {}
}
