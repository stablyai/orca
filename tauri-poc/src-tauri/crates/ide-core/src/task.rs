//! Cancelling background tasks the backend reports itself ([`IdeEvent::Task`](crate::IdeEvent)
//! with `cancellable`), such as a language server's work-done progress. Requests the UI
//! starts are cancelled through their `RequestId` instead.

use crate::TaskId;
use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

type Cancel = Box<dyn FnOnce() + Send>;

static CANCELS: Mutex<Option<HashMap<TaskId, Cancel>>> = Mutex::new(None);

fn cancels() -> MutexGuard<'static, Option<HashMap<TaskId, Cancel>>> {
    CANCELS.lock().unwrap_or_else(|e| e.into_inner())
}

/// Keeps task `id` cancellable with [`cancel`] until dropped (when the task ends).
#[must_use = "the task stops being cancellable when this is dropped"]
pub struct CancelHandle(TaskId);

impl Drop for CancelHandle {
    fn drop(&mut self) {
        if let Some(map) = cancels().as_mut() {
            map.remove(&self.0);
        }
    }
}

/// Makes task `id` cancellable: [`cancel`] runs `f` once, while the handle lives.
pub fn on_cancel(id: TaskId, f: impl FnOnce() + Send + 'static) -> CancelHandle {
    cancels().get_or_insert_with(HashMap::new).insert(id, Box::new(f));
    CancelHandle(id)
}

/// Cancels task `id`; false when it is not cancellable (or already ended / cancelled).
pub fn cancel(id: TaskId) -> bool {
    let f = cancels().as_mut().and_then(|map| map.remove(&id));
    match f {
        Some(f) => {
            f();
            true
        }
        None => false,
    }
}

/// A progress title a tool reported, made readable: a leading absolute executable path
/// (rust-analyzer reports `/…/bin/cargo check`) shows as its program name (`cargo check`).
pub fn display_title(title: &str) -> String {
    let is_sep = |c: char| c == '/' || c == '\\';
    let b = title.as_bytes();
    let absolute = title.starts_with(is_sep)
        || (b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && is_sep(b[2] as char));
    if !absolute {
        return title.to_owned();
    }
    // The path runs on through spaces (`Application Support/…`) while the next word still
    // continues it; the first word without a separator, an option or a new path ends it.
    let mut end = title.find(' ').unwrap_or(title.len());
    while end < title.len() {
        let rest = &title[end + 1..];
        let word = rest.split(' ').next().unwrap_or_default();
        if word.is_empty() || !word.contains(is_sep) || word.starts_with(is_sep) || word.starts_with('-') {
            break;
        }
        end += 1 + word.len();
    }
    let (path, rest) = title.split_at(end);
    let name = path.rsplit(is_sep).next().unwrap_or(path);
    let name = [".exe", ".cmd", ".bat"]
        .iter()
        .find_map(|ext| {
            let cut = name.len().checked_sub(ext.len())?;
            (name.is_char_boundary(cut) && name[cut..].eq_ignore_ascii_case(ext)).then(|| &name[..cut])
        })
        .unwrap_or(name);
    if name.is_empty() { title.to_owned() } else { format!("{name}{rest}") }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn cancel_runs_the_callback_once_while_the_handle_lives() {
        let hits = Arc::new(AtomicUsize::new(0));
        let id = TaskId::next();
        let h = hits.clone();
        let handle = on_cancel(id, move || {
            h.fetch_add(1, Ordering::SeqCst);
        });
        assert!(cancel(id));
        assert!(!cancel(id));
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        drop(handle);

        let other = TaskId::next();
        let h = hits.clone();
        drop(on_cancel(other, move || {
            h.fetch_add(1, Ordering::SeqCst);
        }));
        assert!(!cancel(other), "an ended task is not cancelled");
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn display_title_shows_a_leading_executable_path_as_its_name() {
        for (title, shown) in [
            ("/Users/thomas/Library/Application Support/mbx/bin/cargo check", "cargo check"),
            ("/home/me/.cargo/bin/cargo clippy (#2)", "cargo clippy (#2)"),
            (
                "/opt/my tools/bin/cargo check --manifest-path /x/Cargo.toml",
                "cargo check --manifest-path /x/Cargo.toml",
            ),
            (r"C:\Users\me\.cargo\bin\cargo.exe check", "cargo check"),
            (r"C:\Program Files\Rust\bin\cargo.EXE check", "cargo check"),
            (r"\\server\share\tools\x.cmd build", "x build"),
            ("/usr/bin/make", "make"),
            ("cargo check", "cargo check"),
            ("Indexing", "Indexing"),
            ("Building compile-time-deps", "Building compile-time-deps"),
            ("Loading /src/app (2/3)", "Loading /src/app (2/3)"),
            ("/", "/"),
            ("", ""),
        ] {
            assert_eq!(display_title(title), shown, "{title:?}");
        }
    }
}
