//! Keep a suspended JVM stopped until Kotlin's adapter has installed its listeners.
//! The official 0.4.4 adapter resumes VMStart while constructing its debuggee, before
//! installing breakpoint hooks. DAP attach completes only after those hooks exist.
use ide_core::IdeResult;
use std::{io, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::oneshot,
    task::JoinHandle,
};

pub(crate) struct StartupRelay {
    release: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
}

impl StartupRelay {
    pub async fn start(host: String, port: u16) -> IdeResult<(Self, u16)> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let local = listener.local_addr()?.port();
        let (release, ready) = oneshot::channel();
        let task = tokio::spawn(async move {
            let connect = async {
                let (adapter, _) = listener.accept().await?;
                let jvm = TcpStream::connect((host.as_str(), port)).await?;
                adapter.set_nodelay(true)?;
                jvm.set_nodelay(true)?;
                Ok::<_, io::Error>((adapter, jvm))
            };
            if let Ok(Ok((adapter, jvm))) = tokio::time::timeout(Duration::from_secs(60), connect).await {
                let (mut ar, mut aw) = adapter.into_split();
                let (mut jr, mut jw) = jvm.into_split();
                let upstream = forward(&mut ar, &mut jw, ready);
                let downstream = tokio::io::copy(&mut jr, &mut aw);
                // Close both sockets as soon as either side disconnects.
                tokio::select! {
                    r = upstream => if let Err(e) = r { tracing::debug!("Kotlin JDWP relay: {e}"); },
                    _ = downstream => {},
                }
            }
        });
        Ok((Self { release: Some(release), task }, local))
    }

    pub fn release(&mut self) {
        if let Some(ready) = self.release.take() {
            let _ = ready.send(());
        }
    }
}

impl Drop for StartupRelay {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn packet(reader: &mut (impl AsyncRead + Unpin)) -> io::Result<Vec<u8>> {
    let mut header = [0; 11];
    reader.read_exact(&mut header).await?;
    let len = u32::from_be_bytes(header[..4].try_into().unwrap()) as usize;
    if !(11..=16 * 1024 * 1024).contains(&len) {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "Invalid JDWP packet length"));
    }
    let mut packet = vec![0; len];
    packet[..11].copy_from_slice(&header);
    reader.read_exact(&mut packet[11..]).await?;
    Ok(packet)
}

async fn forward(
    reader: &mut (impl AsyncRead + Unpin),
    writer: &mut (impl AsyncWrite + Unpin),
    mut ready: oneshot::Receiver<()>,
) -> io::Result<()> {
    let mut handshake = [0; 14];
    reader.read_exact(&mut handshake).await?;
    if &handshake != b"JDWP-Handshake" {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "Invalid JDWP handshake"));
    }
    writer.write_all(&handshake).await?;
    let mut released = false;
    let mut held: Vec<Vec<u8>> = Vec::new();
    loop {
        // Retain the in-flight read when attach completes, including partial packets.
        let read = packet(reader);
        tokio::pin!(read);
        let packet = tokio::select! {
            result = &mut read => result?,
            result = &mut ready, if !released => {
                result.map_err(|_| io::Error::new(io::ErrorKind::ConnectionAborted, "Kotlin attach cancelled"))?;
                released = true;
                for packet in held.drain(..) {
                    writer.write_all(&packet).await?;
                }
                read.await?
            }
        };
        // JDWP VirtualMachine.Resume (1/9), ThreadReference.Resume (11/3).
        // Other commands must proceed: attach itself queries threads and installs requests.
        if !released && packet[8] == 0 && matches!((packet[9], packet[10]), (1, 9) | (11, 3)) {
            if held.len() >= 1024 {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "Too many pending JDWP resumes"));
            }
            held.push(packet);
        } else {
            writer.write_all(&packet).await?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(id: u8, set: u8, cmd: u8) -> Vec<u8> {
        vec![0, 0, 0, 11, 0, 0, 0, id, 0, set, cmd]
    }

    #[tokio::test]
    async fn holds_resumes_but_allows_setup_and_preserves_partial_reads() {
        let (mut adapter, mut reader) = tokio::io::duplex(4096);
        let (mut writer, mut jvm) = tokio::io::duplex(4096);
        let (release, ready) = oneshot::channel();
        let task = tokio::spawn(async move { forward(&mut reader, &mut writer, ready).await });
        adapter.write_all(b"JDWP-Handshake").await.unwrap();
        let mut handshake = [0; 14];
        jvm.read_exact(&mut handshake).await.unwrap();
        assert_eq!(&handshake, b"JDWP-Handshake");
        let resume = command(1, 1, 9);
        let thread_resume = command(2, 11, 3);
        let setup = command(3, 1, 4);
        adapter.write_all(&resume).await.unwrap();
        adapter.write_all(&thread_resume).await.unwrap();
        adapter.write_all(&setup).await.unwrap();
        assert_eq!(packet(&mut jvm).await.unwrap(), setup);
        let next = command(4, 1, 9);
        adapter.write_all(&next[..6]).await.unwrap();
        release.send(()).unwrap();
        assert_eq!(packet(&mut jvm).await.unwrap(), resume);
        assert_eq!(packet(&mut jvm).await.unwrap(), thread_resume);
        adapter.write_all(&next[6..]).await.unwrap();
        assert_eq!(packet(&mut jvm).await.unwrap(), next);
        drop(adapter);
        assert!(task.await.unwrap().is_err());
    }

    #[tokio::test]
    async fn dropping_session_closes_relay() {
        let (relay, port) = StartupRelay::start("127.0.0.1".into(), 1).await.unwrap();
        let mut adapter = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        drop(relay);
        let result = tokio::time::timeout(Duration::from_secs(1), adapter.read_u8()).await.unwrap();
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn rejects_invalid_packet_lengths() {
        for len in [0_u32, 10, 16 * 1024 * 1024 + 1] {
            let mut bytes = command(1, 1, 9);
            bytes[..4].copy_from_slice(&len.to_be_bytes());
            assert_eq!(packet(&mut bytes.as_slice()).await.unwrap_err().kind(), io::ErrorKind::InvalidData);
        }
    }
}
