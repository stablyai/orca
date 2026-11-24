//! Transport shared by the LSP and DAP clients.
//!
//! * [`framing`]: `Content-Length` header framing over any async byte stream
//!   (used by both protocols), and newline-delimited JSON ([`Framing::Lines`],
//!   the Agent Client Protocol).
//! * [`Peer`]: a JSON-RPC 2.0 endpoint with request/response correlation,
//!   cancellation (`$/cancelRequest`) and handlers for server→client traffic.

pub mod output;

pub mod framing {
    use crate::output::trim_line_end as trim_line;
    use std::io::{Error, ErrorKind};
    use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt};

    /// Upper bound for one message body; anything larger is treated as a corrupt stream.
    pub const MAX_MESSAGE_LEN: usize = 256 * 1024 * 1024;
    /// Upper bound for one header line.
    const MAX_HEADER_LINE: u64 = 8 * 1024;

    /// Reads one framed message body.
    ///
    /// Returns `Ok(None)` on a clean EOF between messages. Header names are
    /// matched case-insensitively, unknown headers (e.g. `Content-Type`) are
    /// ignored, and both `\r\n` and bare `\n` line endings are accepted.
    pub async fn read_message<R: AsyncBufRead + Unpin>(reader: &mut R) -> std::io::Result<Option<Vec<u8>>> {
        read_message_or_noise(reader, &mut |line| {
            tracing::warn!("jsonrpc: ignoring output outside the protocol: {}", crate::output::decode(line));
        })
        .await
    }

    /// [`read_message`] that hands lines which can't start a message header (a
    /// launcher's or runtime's own output on stdout, in any encoding) to `on_noise`
    /// and skips them, instead of failing on them.
    pub async fn read_message_or_noise<R: AsyncBufRead + Unpin>(
        reader: &mut R,
        on_noise: &mut (dyn FnMut(&[u8]) + Send),
    ) -> std::io::Result<Option<Vec<u8>>> {
        let mut content_length: Option<usize> = None;
        let mut saw_any = false;
        let mut line = Vec::with_capacity(64);
        loop {
            line.clear();
            let n = (&mut *reader).take(MAX_HEADER_LINE).read_until(b'\n', &mut line).await?;
            if n == 0 {
                if saw_any {
                    return Err(Error::new(ErrorKind::UnexpectedEof, "EOF inside message header"));
                }
                return Ok(None);
            }
            // A UTF-16LE line break is `\n\0`: the cut after `\n` leaves a NUL at the start of the
            // next line, which would turn the `Content-Length` after it into noise.
            let nuls = line.iter().take_while(|&&b| b == 0).count();
            line.drain(..nuls);
            if line.last() != Some(&b'\n') {
                if n as u64 >= MAX_HEADER_LINE {
                    return Err(Error::new(ErrorKind::InvalidData, "header line too long"));
                }
                if !saw_any && header(&line).is_none() {
                    // Output without a final newline, then EOF (`pause` waiting for a key).
                    on_noise(trim_line(&line));
                    return Ok(None);
                }
                return Err(Error::new(ErrorKind::UnexpectedEof, "EOF inside message header"));
            }
            let text = trim_line(&line);
            if text.is_empty() {
                if content_length.is_some() {
                    break;
                }
                if saw_any {
                    return Err(Error::new(ErrorKind::InvalidData, "message header without Content-Length"));
                }
                // Tolerate stray blank lines between messages.
                continue;
            }
            let Some((name, value)) = header(text) else {
                if !saw_any {
                    on_noise(text);
                    continue;
                }
                return Err(Error::new(
                    ErrorKind::InvalidData,
                    format!("malformed header line: {:?}", crate::output::decode(text)),
                ));
            };
            saw_any = true;
            if name.eq_ignore_ascii_case("content-length") {
                let len: usize = value
                    .trim()
                    .parse()
                    .map_err(|_| Error::new(ErrorKind::InvalidData, format!("invalid Content-Length: {value:?}")))?;
                if len > MAX_MESSAGE_LEN {
                    return Err(Error::new(ErrorKind::InvalidData, format!("message too large: {len} bytes")));
                }
                content_length = Some(len);
            }
        }
        let len = content_length.unwrap_or_default();
        let mut body = vec![0u8; len];
        reader.read_exact(&mut body).await?;
        Ok(Some(body))
    }

    /// `name: value` with a header-like name (a token, no spaces), else `None`.
    fn header(line: &[u8]) -> Option<(&str, &str)> {
        let text = std::str::from_utf8(trim_line(line)).ok()?;
        let (name, value) = text.split_once(':')?;
        let token = !name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
        token.then_some((name, value))
    }

    /// Writes one framed message and flushes once.
    pub async fn write_message<W: AsyncWrite + Unpin>(writer: &mut W, body: &[u8]) -> std::io::Result<()> {
        let header = format!("Content-Length: {}\r\n\r\n", body.len());
        let mut buf = Vec::with_capacity(header.len() + body.len());
        buf.extend_from_slice(header.as_bytes());
        buf.extend_from_slice(body);
        writer.write_all(&buf).await?;
        writer.flush().await
    }

    /// Reads one newline-terminated message, skipping blank lines.
    pub async fn read_line_message<R: AsyncBufRead + Unpin>(reader: &mut R) -> std::io::Result<Option<Vec<u8>>> {
        let mut line = Vec::new();
        loop {
            line.clear();
            let n = (&mut *reader).take(MAX_MESSAGE_LEN as u64 + 1).read_until(b'\n', &mut line).await?;
            if n == 0 {
                return Ok(None);
            }
            if line.len() > MAX_MESSAGE_LEN {
                return Err(Error::new(ErrorKind::InvalidData, "message too large"));
            }
            let text = trim_line(&line);
            if !text.iter().all(u8::is_ascii_whitespace) {
                return Ok(Some(text.to_vec()));
            }
        }
    }

    /// Writes one message followed by `\n` and flushes once.
    pub async fn write_line_message<W: AsyncWrite + Unpin>(writer: &mut W, body: &[u8]) -> std::io::Result<()> {
        let mut buf = Vec::with_capacity(body.len() + 1);
        buf.extend_from_slice(body);
        buf.push(b'\n');
        writer.write_all(&buf).await?;
        writer.flush().await
    }
}

use parking_lot::Mutex;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use tokio::io::{AsyncRead, AsyncWrite, BufReader};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

#[derive(Debug, thiserror::Error)]
pub enum RpcError {
    #[error("server error {code}: {message}")]
    Server { code: i64, message: String, data: Option<Value> },
    #[error("request cancelled")]
    Cancelled,
    #[error("connection closed")]
    Closed,
    #[error("timed out")]
    Timeout,
    #[error("invalid message: {0}")]
    Protocol(String),
}

impl From<RpcError> for ide_core::IdeError {
    fn from(e: RpcError) -> Self {
        use ide_core::error::ErrorKind;
        let kind = match e {
            RpcError::Cancelled => ErrorKind::Cancelled,
            RpcError::Closed => ErrorKind::Unavailable,
            _ => ErrorKind::Protocol,
        };
        ide_core::IdeError::new(kind, e.to_string())
    }
}

/// Standard JSON-RPC / LSP error codes.
pub mod codes {
    pub const PARSE_ERROR: i64 = -32700;
    pub const INVALID_REQUEST: i64 = -32600;
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const INVALID_PARAMS: i64 = -32602;
    pub const INTERNAL_ERROR: i64 = -32603;
    /// LSP `ServerCancelled`.
    pub const SERVER_CANCELLED: i64 = -32802;
    /// LSP `ContentModified`.
    pub const CONTENT_MODIFIED: i64 = -32801;
    /// LSP `RequestCancelled`.
    pub const REQUEST_CANCELLED: i64 = -32800;
}

/// Handles messages initiated by the remote side.
///
/// Calls run on blocking-capable threads, never on the reader task, so a slow
/// handler cannot stall response delivery. Notifications are delivered one at
/// a time in arrival order; requests run concurrently, each once every
/// notification that arrived before it has been handled. So `on_notification`
/// must not wait for the remote side (a response to our request may depend on
/// its request to us, which would then never start); hand such work to a task.
pub trait Handler: Send + Sync + 'static {
    fn on_notification(&self, method: &str, params: Value);
    /// Respond to a server→client request (e.g. `workspace/configuration`).
    fn on_request(&self, method: &str, params: Value) -> Result<Value, (i64, String)>;

    /// [`on_request`](Self::on_request) for handlers whose errors carry `data`. This is the
    /// one the connection calls.
    fn on_request_with_data(&self, method: &str, params: Value) -> Result<Value, (i64, String, Option<Value>)> {
        self.on_request(method, params).map_err(|(code, message)| (code, message, None))
    }

    /// Called once the response to a `method` request is queued: what it sends follows the response.
    fn after_response(&self, _method: &str) {}
}

/// A [`Handler`] that ignores notifications and rejects requests.
pub struct NoopHandler;

impl Handler for NoopHandler {
    fn on_notification(&self, _: &str, _: Value) {}
    fn on_request(&self, method: &str, _: Value) -> Result<Value, (i64, String)> {
        Err((codes::METHOD_NOT_FOUND, format!("unhandled method {method}")))
    }
}

type Pending = HashMap<i64, oneshot::Sender<Result<Value, RpcError>>>;

struct Inner {
    out: mpsc::UnboundedSender<Vec<u8>>,
    pending: Mutex<Pending>,
    next_id: AtomicI64,
    /// Set once the transport is gone; new requests fail fast.
    transport_closed: AtomicBool,
    /// `None` while open; `Some(exit code)` once fully closed.
    closed: watch::Sender<Option<Option<i32>>>,
    /// Fired by [`Peer::kill`]; stops tasks and kills the child.
    kill: CancellationToken,
    pid: Option<u32>,
    transform: Option<Arc<dyn MessageTransform>>,
    /// Fired when the reader task has stopped (EOF, error or kill).
    reader_done: CancellationToken,
    /// Fired once the child process has exited and been reaped (after [`Peer::kill`],
    /// also what it started); at once when there is no child.
    exited: CancellationToken,
}

/// Translates protocol values before serialization and after parsing, including
/// responses to requests initiated by the server.
pub trait MessageTransform: Send + Sync + 'static {
    fn outgoing(&self, value: &mut Value);
    fn incoming(&self, value: &mut Value);
}

#[derive(Default)]
pub struct TransportOptions {
    pub framing: Framing,
    pub transform: Option<Arc<dyn MessageTransform>>,
}

impl From<Framing> for TransportOptions {
    fn from(framing: Framing) -> Self {
        Self { framing, transform: None }
    }
}

impl Inner {
    fn send_value(&self, value: &Value) -> Result<(), RpcError> {
        if self.transport_closed.load(Ordering::Acquire) {
            return Err(RpcError::Closed);
        }
        let mut translated;
        let value = if let Some(transform) = &self.transform {
            translated = value.clone();
            transform.outgoing(&mut translated);
            &translated
        } else {
            value
        };
        let body = serde_json::to_vec(value).map_err(|e| RpcError::Protocol(e.to_string()))?;
        tracing::trace!(target: "ide_jsonrpc::wire", "--> {}", String::from_utf8_lossy(&body));
        self.out.send(body).map_err(|_| RpcError::Closed)
    }

    /// Fails every in-flight request and refuses new ones.
    fn close_transport(&self) {
        self.transport_closed.store(true, Ordering::Release);
        let pending = std::mem::take(&mut *self.pending.lock());
        for (_, tx) in pending {
            let _ = tx.send(Err(RpcError::Closed));
        }
    }

    fn mark_closed(&self, code: Option<i32>) {
        self.close_transport();
        self.closed.send_if_modified(|state| {
            if state.is_none() {
                *state = Some(code);
                true
            } else {
                false
            }
        });
    }
}

/// How messages are delimited on the wire.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Framing {
    /// `Content-Length` headers (LSP, DAP).
    #[default]
    ContentLength,
    /// One JSON message per line (Agent Client Protocol).
    Lines,
}

impl Framing {
    async fn read<R: tokio::io::AsyncBufRead + Unpin>(
        self,
        reader: &mut R,
        on_noise: &mut (dyn FnMut(&[u8]) + Send),
    ) -> std::io::Result<Option<Vec<u8>>> {
        match self {
            Framing::ContentLength => framing::read_message_or_noise(reader, on_noise).await,
            Framing::Lines => loop {
                let Some(line) = framing::read_line_message(reader).await? else { return Ok(None) };
                match line.iter().find(|b| !b.is_ascii_whitespace()) {
                    Some(b'{' | b'[') => return Ok(Some(line)),
                    _ => on_noise(&line),
                }
            },
        }
    }

    async fn write<W: AsyncWrite + Unpin>(self, writer: &mut W, body: &[u8]) -> std::io::Result<()> {
        match self {
            Framing::ContentLength => framing::write_message(writer, body).await,
            Framing::Lines => framing::write_line_message(writer, body).await,
        }
    }
}

/// How long a process that exited is given for its last output to be read.
const OUTPUT_DRAIN: std::time::Duration = std::time::Duration::from_secs(1);

/// A connected JSON-RPC peer. Cloning shares the connection.
#[derive(Clone)]
pub struct Peer {
    inner: Arc<Inner>,
    _owner: Arc<KillOnDrop>,
}

/// Tears the connection down once the last [`Peer`] clone is dropped.
struct KillOnDrop(CancellationToken);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

/// The program [`Peer::spawn_framed`] runs: a bare name resolved against the
/// child's `PATH` (a caller's `env` PATH, else the login shell's, else ours), so
/// that on Windows `PATHEXT` names (`codex` → `codex.cmd`) start; anything else
/// is kept as given.
pub fn resolve_spawn_program(command: &str, env: &[(String, String)]) -> std::path::PathBuf {
    let path = std::path::Path::new(command);
    if path.components().count() > 1 || path.is_absolute() {
        return path.to_path_buf();
    }
    let search = env
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("PATH"))
        .map(|(_, v)| std::ffi::OsString::from(v))
        .or_else(|| ide_core::process::shell_env().find(|(k, _)| k == "PATH").map(|(_, v)| v))
        .or_else(|| ide_core::process::host_var_os("PATH"))
        .unwrap_or_default();
    ide_core::process::find_executable(command, &search).unwrap_or_else(|| path.to_path_buf())
}

impl Peer {
    /// Spawns `command` and speaks JSON-RPC over its stdio. Stderr lines, and
    /// stdout lines that are not part of a message (a launcher's own output), are
    /// decoded (see [`output::decode`]) and forwarded to `tracing` and to `on_stderr`.
    ///
    /// Must be called from within a Tokio runtime.
    pub fn spawn(
        command: &str,
        args: &[String],
        cwd: &std::path::Path,
        env: &[(String, String)],
        handler: Arc<dyn Handler>,
        on_stderr: Box<dyn Fn(String) + Send + Sync>,
    ) -> std::io::Result<Self> {
        Self::spawn_framed(command, args, cwd, env, handler, on_stderr, Framing::ContentLength)
    }

    /// [`spawn`](Self::spawn) with the given wire framing.
    pub fn spawn_framed(
        command: &str,
        args: &[String],
        cwd: &std::path::Path,
        env: &[(String, String)],
        handler: Arc<dyn Handler>,
        on_stderr: Box<dyn Fn(String) + Send + Sync>,
        framing: Framing,
    ) -> std::io::Result<Self> {
        Self::spawn_transport(command, args, cwd, env, handler, on_stderr, framing.into())
    }

    /// Starts a stdio peer with message translation installed before any IO.
    pub fn spawn_transport(
        command: &str,
        args: &[String],
        cwd: &std::path::Path,
        env: &[(String, String)],
        handler: Arc<dyn Handler>,
        on_stderr: Box<dyn Fn(String) + Send + Sync>,
        options: TransportOptions,
    ) -> std::io::Result<Self> {
        use std::process::Stdio;
        // Windows resolves a bare name only as `.exe`; find the file a child
        // would (`PATH` × `PATHEXT`, e.g. `codex` → `codex.cmd`) first.
        let resolved = resolve_spawn_program(command, env);
        let mut cmd = tokio::process::Command::new(&resolved);
        ide_core::process::prepare(cmd.as_std_mut());
        // Wrappers (`npx`, `codex.cmd`, launcher scripts) start the real server as a child:
        // stopping the connection stops the whole tree.
        ide_core::process::own_group(cmd.as_std_mut());
        cmd.args(args)
            .current_dir(cwd)
            .envs(ide_core::process::shell_env())
            .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd.spawn()?;
        let stdin = child.stdin.take().ok_or_else(|| std::io::Error::other("child stdin unavailable"))?;
        let stdout = child.stdout.take().ok_or_else(|| std::io::Error::other("child stdout unavailable"))?;
        let stderr = child.stderr.take();
        let pid = child.id();

        let on_output: Arc<dyn Fn(String) + Send + Sync> = Arc::from(on_stderr);
        let peer = Self::start(stdout, stdin, handler, false, pid, options, Some(on_output.clone()));

        let stderr_task = stderr.map(|stderr| {
            let name = command.to_owned();
            tokio::spawn(output::read_lines(stderr, move |text| {
                tracing::debug!(target: "ide_jsonrpc::stderr", "[{name}] {text}");
                on_output(text);
            }))
        });

        peer.supervise(child, stderr_task);
        Ok(peer)
    }

    /// Kills `child` when the connection is torn down; closes the connection when it exits.
    /// After an exit of its own, the connection is reported closed only once what the
    /// process wrote last (stderr, stray stdout) has been read, so a crash report has it.
    fn supervise(&self, mut child: tokio::process::Child, stderr_task: Option<tokio::task::JoinHandle<()>>) {
        let inner = self.inner.clone();
        tokio::spawn(async move {
            let (status, killed) = tokio::select! {
                status = child.wait() => (status.ok(), false),
                _ = inner.kill.cancelled() => {
                    if let Some(pid) = child.id() {
                        let _ = tokio::task::spawn_blocking(move || ide_core::process::kill_tree_of(pid)).await;
                    }
                    let _ = child.start_kill();
                    (child.wait().await.ok(), true)
                }
            };
            inner.exited.cancel();
            if !killed {
                // Bounded: a grandchild may keep the pipes open.
                let drained = async {
                    if let Some(task) = stderr_task {
                        let _ = task.await;
                    }
                    inner.reader_done.cancelled().await;
                };
                let _ = tokio::time::timeout(OUTPUT_DRAIN, drained).await;
            }
            inner.mark_closed(status.and_then(|s| s.code()));
        });
    }

    /// Speaks JSON-RPC over arbitrary byte streams (in-memory pipes in tests, TCP sockets).
    /// The connection is considered closed when `reader` reaches EOF.
    ///
    /// Must be called from within a Tokio runtime.
    pub fn connect<R, W>(reader: R, writer: W, handler: Arc<dyn Handler>) -> Self
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        Self::start(reader, writer, handler, true, None, Framing::ContentLength.into(), None)
    }

    /// [`connect`](Self::connect) with the given wire framing.
    pub fn connect_framed<R, W>(reader: R, writer: W, handler: Arc<dyn Handler>, framing: Framing) -> Self
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        Self::start(reader, writer, handler, true, None, framing.into(), None)
    }

    /// [`Peer::connect`] over streams served by `child` (a server reached over a socket
    /// it listens on): the child is killed with the connection, and its exit closes it.
    ///
    /// Must be called from within a Tokio runtime.
    pub fn connect_with_child<R, W>(
        reader: R,
        writer: W,
        handler: Arc<dyn Handler>,
        child: tokio::process::Child,
    ) -> Self
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let peer = Self::start(reader, writer, handler, true, child.id(), Framing::ContentLength.into(), None);
        peer.supervise(child, None);
        peer
    }

    fn start<R, W>(
        reader: R,
        mut writer: W,
        handler: Arc<dyn Handler>,
        close_on_eof: bool,
        pid: Option<u32>,
        options: TransportOptions,
        on_noise: Option<Arc<dyn Fn(String) + Send + Sync>>,
    ) -> Self
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let TransportOptions { framing, transform } = options;
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let (closed, _) = watch::channel(None);
        let inner = Arc::new(Inner {
            out: out_tx,
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicI64::new(1),
            transport_closed: AtomicBool::new(false),
            closed,
            kill: CancellationToken::new(),
            pid,
            transform,
            reader_done: CancellationToken::new(),
            exited: CancellationToken::new(),
        });
        if pid.is_none() {
            inner.exited.cancel();
        }

        // Writer: a single task drains the queue so messages never interleave.
        {
            let kill = inner.kill.clone();
            let weak = Arc::downgrade(&inner);
            tokio::spawn(async move {
                loop {
                    let body = tokio::select! {
                        body = out_rx.recv() => body,
                        _ = kill.cancelled() => None,
                    };
                    let Some(body) = body else { break };
                    if let Err(e) = framing.write(&mut writer, &body).await {
                        tracing::debug!("jsonrpc write failed: {e}");
                        if let Some(inner) = weak.upgrade() {
                            inner.close_transport();
                        }
                        break;
                    }
                }
                let _ = tokio::io::AsyncWriteExt::shutdown(&mut writer).await;
            });
        }

        // Notifications are delivered in order on a dedicated thread. Requests start from the same
        // queue, so a request handler sees every notification that arrived before it, and responses
        // complete from it, so a caller sees the notifications sent before its response (a streamed
        // result's last values).
        let (notif_tx, notif_rx) = std::sync::mpsc::channel::<Incoming>();
        {
            let handler = handler.clone();
            let inner = inner.clone();
            let runtime = tokio::runtime::Handle::current();
            std::thread::Builder::new()
                .name("jsonrpc-notify".into())
                .spawn(move || {
                    while let Ok(msg) = notif_rx.recv() {
                        match msg {
                            Incoming::Notification(method, params) => {
                                let h = handler.clone();
                                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                    h.on_notification(&method, params)
                                }));
                                if result.is_err() {
                                    tracing::error!("jsonrpc notification handler panicked on {method}");
                                }
                            }
                            Incoming::Request(id, method, params) => {
                                runtime.spawn(handle_request(inner.clone(), handler.clone(), id, method, params));
                            }
                            Incoming::Response(tx, result) => {
                                let _ = tx.send(result);
                            }
                        }
                    }
                })
                .expect("spawn jsonrpc notification thread");
        }

        // Reader: parses and dispatches; never runs handler code itself.
        {
            let inner = inner.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(reader);
                let seen_message = AtomicBool::new(false);
                let mut noise = |line: &[u8]| {
                    let text = output::decode(line);
                    if seen_message.load(Ordering::Relaxed) {
                        tracing::debug!("jsonrpc: output outside the protocol: {text}");
                    } else {
                        tracing::warn!("jsonrpc: output before the first message: {text}");
                    }
                    if let Some(f) = &on_noise {
                        f(text);
                    }
                };
                loop {
                    let msg = tokio::select! {
                        msg = framing.read(&mut reader, &mut noise) => msg,
                        _ = inner.kill.cancelled() => break,
                    };
                    match msg {
                        Ok(Some(body)) => {
                            seen_message.store(true, Ordering::Relaxed);
                            dispatch(&inner, &notif_tx, &body);
                        }
                        Ok(None) => break,
                        Err(e) => {
                            tracing::warn!("jsonrpc read failed: {e}");
                            if let Some(f) = &on_noise {
                                f(format!("invalid protocol output: {e}"));
                            }
                            break;
                        }
                    }
                }
                inner.reader_done.cancel();
                inner.close_transport();
                if close_on_eof || inner.kill.is_cancelled() {
                    inner.mark_closed(None);
                    inner.kill.cancel();
                } else {
                    // The process closed stdout; give it a moment to exit on its own.
                    let kill = inner.kill.clone();
                    let mut rx = inner.closed.subscribe();
                    tokio::spawn(async move {
                        let exited =
                            tokio::time::timeout(std::time::Duration::from_secs(5), rx.wait_for(|s| s.is_some()));
                        if exited.await.is_err() {
                            kill.cancel();
                        }
                    });
                }
            });
        }

        let owner = Arc::new(KillOnDrop(inner.kill.clone()));
        Self { inner, _owner: owner }
    }

    /// Sends a request; dropping the future or cancelling `cancel` sends `$/cancelRequest`.
    pub async fn request<P: Serialize, R: DeserializeOwned>(
        &self,
        method: &str,
        params: P,
        cancel: Option<ide_core::CancellationToken>,
    ) -> Result<R, RpcError> {
        if cancel.as_ref().is_some_and(|t| t.is_cancelled()) {
            return Err(RpcError::Cancelled);
        }
        let params = serde_json::to_value(params).map_err(|e| RpcError::Protocol(e.to_string()))?;
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.inner.pending.lock().insert(id, tx);
        let mut guard = PendingGuard { inner: &self.inner, id, armed: true };

        let mut msg = json!({ "jsonrpc": "2.0", "id": id, "method": method });
        if !params.is_null() {
            msg["params"] = params;
        }
        if let Err(e) = self.inner.send_value(&msg) {
            guard.armed = false;
            self.inner.pending.lock().remove(&id);
            return Err(e);
        }

        let response = match cancel {
            // Cancellation wins over a response arriving at the same time.
            Some(token) => tokio::select! {
                biased;
                _ = token.cancelled() => return Err(RpcError::Cancelled), // guard sends $/cancelRequest
                r = rx => r,
            },
            None => rx.await,
        };
        guard.armed = false;
        let value = response.map_err(|_| RpcError::Closed)??;
        serde_json::from_value(value).map_err(|e| RpcError::Protocol(format!("{method}: {e}")))
    }

    pub fn notify<P: Serialize>(&self, method: &str, params: P) -> Result<(), RpcError> {
        let params = serde_json::to_value(params).map_err(|e| RpcError::Protocol(e.to_string()))?;
        let mut msg = json!({ "jsonrpc": "2.0", "method": method });
        if !params.is_null() {
            msg["params"] = params;
        }
        self.inner.send_value(&msg)
    }

    /// Resolves when the connection closes (process exit or EOF), with the exit code if known.
    pub async fn closed(&self) -> Option<i32> {
        let mut rx = self.inner.closed.subscribe();
        match rx.wait_for(|s| s.is_some()).await {
            Ok(state) => state.flatten(),
            Err(_) => None,
        }
    }

    /// Whether the transport is gone (requests fail with [`RpcError::Closed`]).
    pub fn is_closed(&self) -> bool {
        self.inner.transport_closed.load(Ordering::Acquire)
    }

    /// OS process id when this peer owns a child process.
    pub fn pid(&self) -> Option<u32> {
        self.inner.pid
    }

    /// Kills the child process (if any) and tears down the connection.
    pub fn kill(&self) {
        self.inner.close_transport();
        self.inner.kill.cancel();
    }

    /// Resolves once the child process is gone: exited on its own, or killed with what it
    /// started and reaped. [`closed`](Self::closed) can come earlier, at EOF. Until then the
    /// child may still hold files open, which on Windows can't be deleted.
    pub async fn exited(&self) {
        self.inner.exited.cancelled().await;
    }
}

/// Removes the pending entry and tells the remote side to stop when a request
/// future is dropped or cancelled before its response arrives.
struct PendingGuard<'a> {
    inner: &'a Arc<Inner>,
    id: i64,
    armed: bool,
}

impl Drop for PendingGuard<'_> {
    fn drop(&mut self) {
        if self.armed && self.inner.pending.lock().remove(&self.id).is_some() {
            let _ = self
                .inner
                .send_value(&json!({ "jsonrpc": "2.0", "method": "$/cancelRequest", "params": { "id": self.id } }));
        }
    }
}

fn parse_id(id: &Value) -> Option<i64> {
    match id {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

enum Incoming {
    Notification(String, Value),
    Request(Value, String, Value),
    Response(oneshot::Sender<Result<Value, RpcError>>, Result<Value, RpcError>),
}

async fn handle_request(inner: Arc<Inner>, handler: Arc<dyn Handler>, id: Value, method: String, params: Value) {
    let m = method.clone();
    let h = handler.clone();
    let result = tokio::task::spawn_blocking(move || h.on_request_with_data(&m, params)).await;
    let reply = match result {
        Ok(Ok(result)) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Ok(Err((code, message, data))) => {
            let mut error = json!({ "code": code, "message": message });
            if let Some(data) = data {
                error["data"] = data;
            }
            json!({ "jsonrpc": "2.0", "id": id, "error": error })
        }
        Err(_) => json!({
            "jsonrpc": "2.0", "id": id,
            "error": { "code": codes::INTERNAL_ERROR, "message": format!("handler for {method} panicked") }
        }),
    };
    if inner.send_value(&reply).is_ok() {
        handler.after_response(&method);
    }
}

fn dispatch(inner: &Arc<Inner>, notif_tx: &std::sync::mpsc::Sender<Incoming>, body: &[u8]) {
    tracing::trace!(target: "ide_jsonrpc::wire", "<-- {}", String::from_utf8_lossy(body));
    let mut msg: Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("jsonrpc: unparsable message: {e}");
            return;
        }
    };
    if let Some(transform) = &inner.transform {
        transform.incoming(&mut msg);
    }
    let Value::Object(mut obj) = msg else {
        tracing::warn!("jsonrpc: ignoring non-object message");
        return;
    };
    let id = obj.remove("id");
    match obj.remove("method") {
        Some(Value::String(method)) => {
            let params = obj.remove("params").unwrap_or(Value::Null);
            match id {
                Some(id) if !id.is_null() => {
                    let _ = notif_tx.send(Incoming::Request(id, method, params));
                }
                _ => {
                    let _ = notif_tx.send(Incoming::Notification(method, params));
                }
            }
        }
        Some(_) => tracing::warn!("jsonrpc: non-string method"),
        None => {
            let Some(id) = id.as_ref().and_then(parse_id) else {
                if let Some(err) = obj.get("error") {
                    tracing::warn!("jsonrpc: error response without id: {err}");
                }
                return;
            };
            let Some(tx) = inner.pending.lock().remove(&id) else {
                tracing::debug!("jsonrpc: response for unknown request {id}");
                return;
            };
            let result = match obj.remove("error") {
                Some(err) if !err.is_null() => {
                    let code = err.get("code").and_then(Value::as_i64).unwrap_or(codes::INTERNAL_ERROR);
                    if code == codes::REQUEST_CANCELLED || code == codes::SERVER_CANCELLED {
                        Err(RpcError::Cancelled)
                    } else {
                        Err(RpcError::Server {
                            code,
                            message: err.get("message").and_then(Value::as_str).unwrap_or_default().to_owned(),
                            data: err.get("data").cloned(),
                        })
                    }
                }
                _ => Ok(obj.remove("result").unwrap_or(Value::Null)),
            };
            let _ = notif_tx.send(Incoming::Response(tx, result));
        }
    }
}

#[cfg(test)]
mod tests;
