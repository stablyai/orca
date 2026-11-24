//! One DAP wire connection: `Content-Length` framing (shared with LSP via
//! `ide_jsonrpc::framing`), sequence numbers, request/response correlation,
//! and delivery of events and reverse requests to the session task.
//!
//! DAP is not JSON-RPC: every message is `{seq, type, ...}` where `type` is
//! `request` (`command`, `arguments`), `response` (`request_seq`, `success`,
//! `command`, `message`, `body`) or `event` (`event`, `body`).

use ide_jsonrpc::framing;
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite, BufReader};
use tokio::sync::{mpsc, oneshot};

#[derive(Debug, Clone)]
pub enum DapError {
    /// The adapter answered `success: false`.
    Failed {
        command: String,
        message: String,
    },
    Closed,
    Timeout(String),
    Protocol(String),
}

impl std::fmt::Display for DapError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Failed { command, message } => write!(f, "{command} failed: {message}"),
            Self::Closed => f.write_str("debug adapter connection closed"),
            Self::Timeout(command) => write!(f, "debug adapter did not answer `{command}` in time"),
            Self::Protocol(m) => write!(f, "invalid debug adapter message: {m}"),
        }
    }
}

impl From<DapError> for ide_core::IdeError {
    fn from(e: DapError) -> Self {
        use ide_core::error::ErrorKind;
        let kind = match e {
            DapError::Closed => ErrorKind::Unavailable,
            DapError::Failed { .. } => ErrorKind::InvalidInput,
            DapError::Timeout(_) | DapError::Protocol(_) => ErrorKind::Protocol,
        };
        ide_core::IdeError::new(kind, e.to_string())
    }
}

/// Adapter-initiated traffic, delivered in arrival order.
#[derive(Debug)]
pub enum Incoming {
    Event {
        event: String,
        body: Value,
    },
    /// Reverse request (`runInTerminal`, `startDebugging`); answer with [`Connection::respond`].
    Request {
        seq: i64,
        command: String,
        arguments: Value,
    },
    /// The transport is gone; always the last message.
    Closed,
}

type Pending = HashMap<i64, (String, oneshot::Sender<Result<Value, DapError>>)>;

struct Inner {
    mapping: Option<crate::target::TargetMapping>,
    out: mpsc::UnboundedSender<Vec<u8>>,
    pending: Mutex<Pending>,
    seq: AtomicI64,
    closed: AtomicBool,
    cancel: ide_core::CancellationToken,
}

impl Inner {
    fn close(&self) {
        self.closed.store(true, Ordering::Release);
        for (_, (_, tx)) in std::mem::take(&mut *self.pending.lock()) {
            let _ = tx.send(Err(DapError::Closed));
        }
    }
}

/// A connected adapter. Cloning shares the connection.
#[derive(Clone)]
pub struct Connection {
    inner: Arc<Inner>,
}

impl Connection {
    /// Starts reader/writer tasks over `reader`/`writer`. Must be called inside a Tokio runtime.
    pub fn start<R, W>(reader: R, writer: W) -> (Self, mpsc::UnboundedReceiver<Incoming>)
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        Self::start_with_output(reader, writer, Box::new(|_| {}))
    }

    /// [`start`](Self::start) that hands lines outside the protocol (an adapter's
    /// own output on stdout, decoded) to `on_output`.
    pub fn start_with_output<R, W>(
        reader: R,
        writer: W,
        on_output: Box<dyn Fn(String) + Send + Sync>,
    ) -> (Self, mpsc::UnboundedReceiver<Incoming>)
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        Self::start_with_target(reader, writer, on_output, None)
    }

    pub fn start_with_target<R, W>(
        reader: R,
        mut writer: W,
        on_output: Box<dyn Fn(String) + Send + Sync>,
        target: Option<crate::target::TargetMapping>,
    ) -> (Self, mpsc::UnboundedReceiver<Incoming>)
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let (in_tx, in_rx) = mpsc::unbounded_channel();
        let inner = Arc::new(Inner {
            mapping: target,
            out: out_tx,
            pending: Mutex::new(HashMap::new()),
            seq: AtomicI64::new(1),
            closed: false.into(),
            cancel: ide_core::CancellationToken::new(),
        });

        let weak = Arc::downgrade(&inner);
        let cancel = inner.cancel.clone();
        tokio::spawn(async move {
            loop {
                let body = tokio::select! {
                    body = out_rx.recv() => body,
                    _ = cancel.cancelled() => None,
                };
                let Some(body) = body else { break };
                if let Err(e) = framing::write_message(&mut writer, &body).await {
                    tracing::debug!("dap write failed: {e}");
                    if let Some(inner) = weak.upgrade() {
                        inner.close();
                    }
                    break;
                }
            }
            let _ = tokio::io::AsyncWriteExt::shutdown(&mut writer).await;
        });

        let reader_inner = inner.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(reader);
            let mut noise = |line: &[u8]| {
                let text = ide_jsonrpc::output::decode(line);
                tracing::warn!("dap: output outside the protocol: {text}");
                on_output(text);
            };
            loop {
                let msg = tokio::select! {
                    msg = framing::read_message_or_noise(&mut reader, &mut noise) => msg,
                    _ = reader_inner.cancel.cancelled() => break,
                };
                match msg {
                    Ok(Some(body)) => dispatch(&reader_inner, &in_tx, &body),
                    Ok(None) => break,
                    Err(e) => {
                        tracing::warn!("dap read failed: {e}");
                        break;
                    }
                }
            }
            reader_inner.close();
            let _ = in_tx.send(Incoming::Closed);
        });

        (Self { inner }, in_rx)
    }

    /// Drops the transport; pending requests fail and the incoming stream ends.
    pub fn close(&self) {
        self.inner.close();
        self.inner.cancel.cancel();
    }

    pub fn is_closed(&self) -> bool {
        self.inner.closed.load(Ordering::Acquire)
    }

    fn send(&self, value: &Value) -> Result<(), DapError> {
        if self.is_closed() {
            return Err(DapError::Closed);
        }
        let mut value = value.clone();
        if let Some(mapping) = self.inner.mapping.as_ref() {
            mapping.rewrite(&mut value, ide_core::path_mapping::Direction::ToTarget);
        }
        let body = serde_json::to_vec(&value).map_err(|e| DapError::Protocol(e.to_string()))?;
        tracing::trace!(target: "ide_dap::wire", "--> {}", String::from_utf8_lossy(&body));
        self.inner.out.send(body).map_err(|_| DapError::Closed)
    }

    /// Sends a request and returns a receiver for its response body, without waiting.
    pub fn send_request(
        &self,
        command: &str,
        arguments: Value,
    ) -> Result<oneshot::Receiver<Result<Value, DapError>>, DapError> {
        let seq = self.inner.seq.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.inner.pending.lock().insert(seq, (command.to_owned(), tx));
        let mut msg = json!({ "seq": seq, "type": "request", "command": command });
        if !arguments.is_null() {
            msg["arguments"] = arguments;
        }
        if let Err(e) = self.send(&msg) {
            self.inner.pending.lock().remove(&seq);
            return Err(e);
        }
        Ok(rx)
    }

    /// Sends a request and waits for the response body (`null` when absent).
    pub async fn request(&self, command: &str, arguments: Value) -> Result<Value, DapError> {
        let rx = self.send_request(command, arguments)?;
        rx.await.unwrap_or(Err(DapError::Closed))
    }

    pub async fn request_timeout(&self, command: &str, arguments: Value, timeout: Duration) -> Result<Value, DapError> {
        match tokio::time::timeout(timeout, self.request(command, arguments)).await {
            Ok(r) => r,
            Err(_) => Err(DapError::Timeout(command.to_owned())),
        }
    }

    /// Answers a reverse request.
    pub fn respond(&self, request_seq: i64, command: &str, result: Result<Value, String>) -> Result<(), DapError> {
        let seq = self.inner.seq.fetch_add(1, Ordering::Relaxed);
        let mut msg = json!({
            "seq": seq,
            "type": "response",
            "request_seq": request_seq,
            "command": command,
            "success": result.is_ok(),
        });
        match result {
            Ok(body) if !body.is_null() => msg["body"] = body,
            Ok(_) => {}
            Err(message) => msg["message"] = Value::String(message),
        }
        self.send(&msg)
    }
}

fn dispatch(inner: &Inner, incoming: &mpsc::UnboundedSender<Incoming>, body: &[u8]) {
    tracing::trace!(target: "ide_dap::wire", "<-- {}", String::from_utf8_lossy(body));
    let mut msg: Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("dap: unparsable message: {e}");
            return;
        }
    };
    if let Some(mapping) = inner.mapping.as_ref() {
        mapping.rewrite(&mut msg, ide_core::path_mapping::Direction::ToHost);
    }
    match msg.get("type").and_then(Value::as_str) {
        Some("response") => {
            let Some(request_seq) = msg.get("request_seq").and_then(Value::as_i64) else {
                tracing::warn!("dap: response without request_seq");
                return;
            };
            let Some((command, tx)) = inner.pending.lock().remove(&request_seq) else {
                tracing::debug!("dap: response for unknown request {request_seq}");
                return;
            };
            let result = if msg.get("success").and_then(Value::as_bool).unwrap_or(false) {
                Ok(msg.get("body").cloned().unwrap_or(Value::Null))
            } else {
                Err(DapError::Failed { command, message: error_message(&msg) })
            };
            let _ = tx.send(result);
        }
        Some("event") => {
            let event = msg.get("event").and_then(Value::as_str).unwrap_or_default().to_owned();
            let body = msg.get("body").cloned().unwrap_or(Value::Null);
            let _ = incoming.send(Incoming::Event { event, body });
        }
        Some("request") => {
            let seq = msg.get("seq").and_then(Value::as_i64).unwrap_or_default();
            let command = msg.get("command").and_then(Value::as_str).unwrap_or_default().to_owned();
            let arguments = msg.get("arguments").cloned().unwrap_or(Value::Null);
            let _ = incoming.send(Incoming::Request { seq, command, arguments });
        }
        other => tracing::warn!("dap: unknown message type {other:?}"),
    }
}

/// `message`, or the formatted `body.error` (`{format, variables}`) when present.
fn error_message(msg: &Value) -> String {
    if let Some(err) = msg.pointer("/body/error")
        && let Some(format) = err.get("format").and_then(Value::as_str)
    {
        let mut text = format.to_owned();
        if let Some(vars) = err.get("variables").and_then(Value::as_object) {
            for (k, v) in vars {
                let v = v.as_str().map(str::to_owned).unwrap_or_else(|| v.to_string());
                text = text.replace(&format!("{{{k}}}"), &v);
            }
        }
        return text;
    }
    msg.get("message").and_then(Value::as_str).unwrap_or("request failed").to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_structured_errors() {
        let msg =
            json!({"message": "x", "body": {"error": {"format": "cannot find {file}", "variables": {"file": "a.py"}}}});
        assert_eq!(error_message(&msg), "cannot find a.py");
        assert_eq!(error_message(&json!({"message": "nope"})), "nope");
    }
}
