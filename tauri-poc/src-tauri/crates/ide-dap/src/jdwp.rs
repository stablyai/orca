//! "Listen to remote JVM" (IDEA's Remote JVM Debug in listen mode): the IDE listens,
//! the remote JVM (`-agentlib:jdwp=…,server=n,address=<ide-host>:<port>`) connects to
//! it. java-debug can only attach, so the connection is relayed: once the JVM has
//! connected, java-debug attaches to a one-shot loopback port that forwards the JDWP
//! stream (handshake included) both ways.

use ide_core::{CancellationToken, IdeError, IdeResult};
use std::io::ErrorKind;
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};

/// How long the relay waits for java-debug to attach once the JVM is connected.
const ATTACH_TIMEOUT: Duration = Duration::from_secs(60);

/// The address to listen on for `host`: the interface it names, or every interface when
/// it is not one of this machine's (a DNS name or a NAT address the JVM connects to).
async fn bind(host: &str, port: u16) -> IdeResult<TcpListener> {
    let host = host.trim();
    let host = if host.is_empty() { "0.0.0.0" } else { host.trim_start_matches('[').trim_end_matches(']') };
    match TcpListener::bind((host, port)).await {
        Ok(l) => Ok(l),
        Err(e) if e.kind() == ErrorKind::AddrNotAvailable || e.kind() == ErrorKind::Other => {
            TcpListener::bind(("0.0.0.0", port))
                .await
                .map_err(|e| IdeError::unavailable(format!("cannot listen on port {port}: {e}")))
        }
        Err(e) => Err(IdeError::unavailable(format!("cannot listen on {host}:{port}: {e}"))),
    }
}

/// Waits for a JVM to connect to `host:port`, then returns a loopback port that relays
/// to it (accepts one connection). Cancelled through `cancel` while waiting.
pub async fn listen_for_jvm(host: &str, port: u16, cancel: CancellationToken) -> IdeResult<u16> {
    let listener = bind(host, port).await?;
    let jvm = tokio::select! {
        _ = cancel.cancelled() => return Err(IdeError::cancelled()),
        accepted = listener.accept() => accepted.map_err(IdeError::from)?.0,
    };
    drop(listener);
    let _ = jvm.set_nodelay(true);
    let relay = TcpListener::bind(("127.0.0.1", 0)).await?;
    let local = relay.local_addr()?.port();
    tokio::spawn(relay_one(relay, jvm));
    Ok(local)
}

async fn relay_one(relay: TcpListener, mut jvm: TcpStream) {
    let debugger = match tokio::time::timeout(ATTACH_TIMEOUT, relay.accept()).await {
        Ok(Ok((s, _))) => s,
        _ => return,
    };
    drop(relay);
    let _ = debugger.set_nodelay(true);
    let mut debugger = debugger;
    if let Err(e) = tokio::io::copy_bidirectional(&mut debugger, &mut jvm).await {
        tracing::debug!(target: "ide_dap::jdwp", "JDWP relay closed: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn relays_the_jdwp_handshake_both_ways() {
        let port = TcpListener::bind(("127.0.0.1", 0)).await.unwrap().local_addr().unwrap().port();
        let waiting = tokio::spawn(listen_for_jvm("127.0.0.1", port, CancellationToken::new()));
        // The remote JVM (`server=n`) connects to the IDE.
        let mut jvm = loop {
            if let Ok(s) = TcpStream::connect(("127.0.0.1", port)).await {
                break s;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        let local = waiting.await.unwrap().unwrap();
        // java-debug attaches to the relay and starts the handshake.
        let mut debugger = TcpStream::connect(("127.0.0.1", local)).await.unwrap();
        debugger.write_all(b"JDWP-Handshake").await.unwrap();
        let mut buf = [0u8; 14];
        jvm.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"JDWP-Handshake");
        jvm.write_all(b"JDWP-Handshake").await.unwrap();
        debugger.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"JDWP-Handshake");
    }

    #[tokio::test]
    async fn waiting_is_cancellable() {
        let cancel = CancellationToken::new();
        let waiting = tokio::spawn(listen_for_jvm("127.0.0.1", 0, cancel.clone()));
        tokio::time::sleep(Duration::from_millis(50)).await;
        cancel.cancel();
        let err = waiting.await.unwrap().unwrap_err();
        assert_eq!(err.kind, ide_core::error::ErrorKind::Cancelled);
    }
}
