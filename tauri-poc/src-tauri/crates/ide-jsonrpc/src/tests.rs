use super::*;
use std::time::Duration;
use tokio::io::{AsyncWriteExt, duplex};

mod framing_tests {
    use super::framing::*;
    use tokio::io::BufReader;

    async fn read_all(input: &[u8]) -> std::io::Result<Vec<Vec<u8>>> {
        let mut reader = BufReader::new(input);
        let mut out = Vec::new();
        while let Some(msg) = read_message(&mut reader).await? {
            out.push(msg);
        }
        Ok(out)
    }

    #[tokio::test]
    async fn parses_multiple_messages_and_ignores_extra_headers() {
        let input = b"Content-Length: 2\r\n\r\n{}content-length:  7\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n[1,2,3]";
        let msgs = read_all(input).await.unwrap();
        assert_eq!(msgs, vec![b"{}".to_vec(), b"[1,2,3]".to_vec()]);
    }

    #[tokio::test]
    async fn accepts_bare_newlines_and_leading_blank_lines() {
        let msgs = read_all(b"\r\n\nCONTENT-LENGTH: 4\n\nnull").await.unwrap();
        assert_eq!(msgs, vec![b"null".to_vec()]);
    }

    #[tokio::test]
    async fn clean_eof_is_none() {
        assert!(read_all(b"").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn rejects_bad_input() {
        assert!(read_all(b"Content-Length: 10\r\n\r\n{}").await.is_err(), "truncated body");
        assert!(read_all(b"Content-Length: 2\r\n").await.is_err(), "truncated header");
        assert!(read_all(b"Content-Type: x\r\n\r\n{}").await.is_err(), "missing length");
        assert!(read_all(b"Content-Length: abc\r\n\r\n").await.is_err(), "bad length");
        assert!(read_all(b"Content-Length: 99999999999\r\n\r\n").await.is_err(), "absurd length");
        let long = format!("X-Junk: {}\r\n", "a".repeat(20_000));
        assert!(read_all(long.as_bytes()).await.is_err(), "header too long");
    }

    async fn read_with_noise(input: &[u8]) -> (std::io::Result<Vec<Vec<u8>>>, Vec<String>) {
        let mut reader = BufReader::new(input);
        let mut noise = Vec::new();
        let mut out = Vec::new();
        let result = loop {
            match read_message_or_noise(&mut reader, &mut |l| noise.push(crate::output::decode(l))).await {
                Ok(Some(msg)) => out.push(msg),
                Ok(None) => break Ok(out),
                Err(e) => break Err(e),
            }
        };
        (result, noise)
    }

    #[tokio::test]
    async fn output_between_messages_is_reported_and_skipped() {
        let input = b"OpenJDK 64-Bit Server VM warning: Sharing is only supported\r\n\xc7\xeb\xb0\xb4 \xff\n\
            Content-Length: 2\r\n\r\n{}Picked up JAVA_TOOL_OPTIONS: -Dx\nContent-Length: 4\r\n\r\nnull";
        let (msgs, noise) = read_with_noise(input).await;
        assert_eq!(msgs.unwrap(), vec![b"{}".to_vec(), b"null".to_vec()]);
        assert_eq!(noise.len(), 3, "{noise:?}");
        assert_eq!(noise[0], "OpenJDK 64-Bit Server VM warning: Sharing is only supported");
        assert_eq!(noise[2], "Picked up JAVA_TOOL_OPTIONS: -Dx");
    }

    #[tokio::test]
    async fn utf16_output_of_wsl_exe_before_a_message_does_not_swallow_it() {
        // `wsl.exe` reports its own errors as UTF-16LE with a BOM; the real server only starts
        // after it, so the first message must still be read whole.
        let notice = "The Windows Subsystem for Linux instance has terminated.";
        let mut input: Vec<u8> = [0xff, 0xfe].into();
        input.extend(format!("{notice}\r\n").encode_utf16().flat_map(u16::to_le_bytes));
        input.extend(b"Content-Length: 2\r\n\r\n{}");
        let (msgs, noise) = read_with_noise(&input).await;
        assert_eq!(msgs.unwrap(), vec![b"{}".to_vec()]);
        // The text is kept for the error shown to the user, whatever the BOM decodes to.
        let ascii: String = noise.concat().chars().filter(char::is_ascii).filter(|c| *c != '\0').collect();
        assert_eq!(ascii.trim(), notice);
    }

    #[tokio::test]
    async fn unterminated_output_then_eof_is_reported() {
        // `pause` prints its prompt without a newline and the process is gone.
        let (msgs, noise) = read_with_noise(b"Press any key to continue . . . ").await;
        assert!(msgs.unwrap().is_empty());
        assert_eq!(noise, ["Press any key to continue . . . "]);
    }

    #[tokio::test]
    async fn garbage_inside_a_header_is_still_an_error() {
        let (msgs, _) = read_with_noise(b"Content-Length: 2\r\nnot a header\r\n\r\n{}").await;
        let e = msgs.unwrap_err();
        assert!(e.to_string().contains("not a header"), "{e}");
    }

    #[tokio::test]
    async fn handles_partial_reads() {
        let (mut client, server) = tokio::io::duplex(4);
        let writer = tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            for chunk in [&b"Conte"[..], b"nt-Len", b"gth: 5\r", b"\n\r\nhel", b"lo"] {
                client.write_all(chunk).await.unwrap();
                tokio::task::yield_now().await;
            }
        });
        let mut reader = BufReader::new(server);
        assert_eq!(read_message(&mut reader).await.unwrap().unwrap(), b"hello");
        writer.await.unwrap();
        assert!(read_message(&mut reader).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn write_then_read_round_trips() {
        let mut buf = Vec::new();
        write_message(&mut buf, "{\"a\":\"é\"}".as_bytes()).await.unwrap();
        assert!(buf.starts_with(b"Content-Length: 10\r\n\r\n"));
        assert_eq!(read_all(&buf).await.unwrap(), vec!["{\"a\":\"é\"}".as_bytes().to_vec()]);
    }
}

/// Records notifications and answers `echo` / `fail` / `slow` requests.
#[derive(Default)]
struct Recorder {
    notifications: Mutex<Vec<(String, Value)>>,
}

impl Handler for Recorder {
    fn on_notification(&self, method: &str, params: Value) {
        self.notifications.lock().push((method.to_owned(), params));
    }
    fn on_request(&self, method: &str, params: Value) -> Result<Value, (i64, String)> {
        match method {
            "echo" => Ok(params),
            "slow" => {
                std::thread::sleep(Duration::from_millis(200));
                Ok(json!("slow-done"))
            }
            _ => Err((codes::METHOD_NOT_FOUND, method.to_owned())),
        }
    }
}

fn pair(a: Arc<dyn Handler>, b: Arc<dyn Handler>) -> (Peer, Peer) {
    let (a_io, b_io) = duplex(64 * 1024);
    let (ar, aw) = tokio::io::split(a_io);
    let (br, bw) = tokio::io::split(b_io);
    (Peer::connect(ar, aw, a), Peer::connect(br, bw, b))
}

async fn eventually(mut f: impl FnMut() -> bool) {
    for _ in 0..200 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("condition not reached");
}

#[tokio::test(flavor = "multi_thread")]
async fn request_response_and_errors() {
    let (client, _server) = pair(Arc::new(NoopHandler), Arc::new(Recorder::default()));
    let v: Value = client.request("echo", json!({"x": 1}), None).await.unwrap();
    assert_eq!(v, json!({"x": 1}));
    let err = client.request::<_, Value>("nope", (), None).await.unwrap_err();
    assert!(matches!(err, RpcError::Server { code: codes::METHOD_NOT_FOUND, .. }), "{err:?}");
    // Result type mismatch is a protocol error.
    let err = client.request::<_, u32>("echo", "str", None).await.unwrap_err();
    assert!(matches!(err, RpcError::Protocol(_)));
}

#[tokio::test]
async fn line_framing_round_trips_and_skips_blank_lines() {
    let mut buf = Vec::new();
    framing::write_line_message(&mut buf, br#"{"a":1}"#).await.unwrap();
    buf.extend_from_slice(b"\r\n\n{\"b\":2}\r\n");
    let mut reader = tokio::io::BufReader::new(&buf[..]);
    assert_eq!(framing::read_line_message(&mut reader).await.unwrap().unwrap(), br#"{"a":1}"#);
    assert_eq!(framing::read_line_message(&mut reader).await.unwrap().unwrap(), br#"{"b":2}"#);
    assert!(framing::read_line_message(&mut reader).await.unwrap().is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn line_framed_peers_talk() {
    let (a_io, b_io) = duplex(64 * 1024);
    let (ar, aw) = tokio::io::split(a_io);
    let (br, bw) = tokio::io::split(b_io);
    let client = Peer::connect_framed(ar, aw, Arc::new(NoopHandler), Framing::Lines);
    let _server = Peer::connect_framed(br, bw, Arc::new(Recorder::default()), Framing::Lines);
    let v: Value = client.request("echo", json!({"x": "line\nbreak"}), None).await.unwrap();
    assert_eq!(v, json!({"x": "line\nbreak"}));
}

#[tokio::test(flavor = "multi_thread")]
async fn notifications_arrive_in_order() {
    let rec = Arc::new(Recorder::default());
    let (client, _server) = pair(Arc::new(NoopHandler), rec.clone());
    for i in 0..50 {
        client.notify("tick", json!(i)).unwrap();
    }
    client.notify("bare", ()).unwrap();
    eventually(|| rec.notifications.lock().len() == 51).await;
    let got = rec.notifications.lock();
    for (i, (m, p)) in got.iter().take(50).enumerate() {
        assert_eq!(m, "tick");
        assert_eq!(p, &json!(i));
    }
    assert_eq!(got[50], ("bare".to_owned(), Value::Null));
}

/// A raw scripted server: reads frames, answers out of order, sends string ids.
#[tokio::test(flavor = "multi_thread")]
async fn out_of_order_responses_and_string_ids() {
    let (client_io, server_io) = duplex(64 * 1024);
    let (cr, cw) = tokio::io::split(client_io);
    let client = Peer::connect(cr, cw, Arc::new(NoopHandler));
    let (sr, mut sw) = tokio::io::split(server_io);
    let server = tokio::spawn(async move {
        let mut reader = tokio::io::BufReader::new(sr);
        let mut ids = Vec::new();
        for _ in 0..3 {
            let body = framing::read_message(&mut reader).await.unwrap().unwrap();
            let v: Value = serde_json::from_slice(&body).unwrap();
            ids.push((v["id"].clone(), v["params"].clone()));
        }
        for (id, params) in ids.into_iter().rev() {
            // Answer the second request with a stringified id.
            let id = if params == json!(2) { json!(id.as_i64().unwrap().to_string()) } else { id };
            let msg = json!({"jsonrpc": "2.0", "id": id, "result": params});
            framing::write_message(&mut sw, msg.to_string().as_bytes()).await.unwrap();
        }
        sw
    });
    let (a, b, c) = tokio::join!(
        client.request::<_, i32>("m", 1, None),
        client.request::<_, i32>("m", 2, None),
        client.request::<_, i32>("m", 3, None),
    );
    assert_eq!((a.unwrap(), b.unwrap(), c.unwrap()), (1, 2, 3));
    let _keep = server.await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn server_to_client_request() {
    struct Client;
    impl Handler for Client {
        fn on_notification(&self, _: &str, _: Value) {}
        fn on_request(&self, method: &str, params: Value) -> Result<Value, (i64, String)> {
            match method {
                "workspace/configuration" => Ok(json!([params["items"][0]["section"]])),
                _ => Err((codes::METHOD_NOT_FOUND, "no".into())),
            }
        }
    }
    let (_client, server) = pair(Arc::new(Client), Arc::new(NoopHandler));
    let v: Value =
        server.request("workspace/configuration", json!({"items": [{"section": "rust"}]}), None).await.unwrap();
    assert_eq!(v, json!(["rust"]));
    let err = server.request::<_, Value>("other", (), None).await.unwrap_err();
    assert!(matches!(err, RpcError::Server { code: codes::METHOD_NOT_FOUND, .. }));
}

#[tokio::test(flavor = "multi_thread")]
async fn after_response_messages_follow_the_response() {
    #[derive(Default)]
    struct Client(std::sync::OnceLock<Peer>);
    impl Handler for Client {
        fn on_notification(&self, _: &str, _: Value) {}
        fn on_request(&self, _: &str, _: Value) -> Result<Value, (i64, String)> {
            Ok(json!("answer"))
        }
        fn after_response(&self, method: &str) {
            self.0.get().unwrap().notify("after", method).unwrap();
        }
    }
    let client = Arc::new(Client::default());
    let (client_io, server_io) = duplex(64 * 1024);
    let (cr, cw) = tokio::io::split(client_io);
    assert!(client.0.set(Peer::connect(cr, cw, client.clone())).is_ok());
    let (sr, mut sw) = tokio::io::split(server_io);
    let request = br#"{"jsonrpc":"2.0","id":1,"method":"workspace/configuration","params":{}}"#;
    framing::write_message(&mut sw, request).await.unwrap();
    let mut reader = tokio::io::BufReader::new(sr);
    let mut next = async || -> Value {
        serde_json::from_slice(&framing::read_message(&mut reader).await.unwrap().unwrap()).unwrap()
    };
    assert_eq!(next().await, json!({ "jsonrpc": "2.0", "id": 1, "result": "answer" }));
    assert_eq!(next().await, json!({ "jsonrpc": "2.0", "method": "after", "params": "workspace/configuration" }));
}

#[tokio::test(flavor = "multi_thread")]
async fn requests_start_after_the_notifications_before_them() {
    // `seen` answers with the notifications handled so far; handling one is slow.
    struct Server(Recorder);
    impl Handler for Server {
        fn on_notification(&self, method: &str, params: Value) {
            std::thread::sleep(Duration::from_millis(20));
            self.0.on_notification(method, params)
        }
        fn on_request(&self, _: &str, _: Value) -> Result<Value, (i64, String)> {
            Ok(json!(self.0.notifications.lock().len()))
        }
    }
    let (client, _server) = pair(Arc::new(NoopHandler), Arc::new(Server(Recorder::default())));
    for n in 1..=5 {
        client.notify("open", n).unwrap();
        let seen: usize = client.request("seen", (), None).await.unwrap();
        assert_eq!(seen, n);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn slow_handler_does_not_block_responses() {
    // The client handles a slow server→client request while its own request completes.
    let (client, server) = pair(Arc::new(Recorder::default()), Arc::new(Recorder::default()));
    let slow = tokio::spawn({
        let server = server.clone();
        async move { server.request::<_, Value>("slow", (), None).await }
    });
    tokio::time::sleep(Duration::from_millis(20)).await;
    let started = std::time::Instant::now();
    let v: Value = client.request("echo", 5, None).await.unwrap();
    assert_eq!(v, json!(5));
    assert!(started.elapsed() < Duration::from_millis(150));
    assert_eq!(slow.await.unwrap().unwrap(), json!("slow-done"));
}

#[tokio::test(flavor = "multi_thread")]
async fn cancellation_sends_cancel_request() {
    // A server that never answers "hang" and records `$/cancelRequest`.
    struct Hang(Arc<Recorder>);
    impl Handler for Hang {
        fn on_notification(&self, method: &str, params: Value) {
            self.0.on_notification(method, params)
        }
        fn on_request(&self, _: &str, _: Value) -> Result<Value, (i64, String)> {
            std::thread::sleep(Duration::from_secs(2));
            Ok(Value::Null)
        }
    }
    let rec = Arc::new(Recorder::default());
    let (client, _server) = pair(Arc::new(NoopHandler), Arc::new(Hang(rec.clone())));

    let token = CancellationToken::new();
    let fut = client.request::<_, Value>("hang", (), Some(token.clone()));
    let canceller = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(30)).await;
        token.cancel();
    });
    assert!(matches!(fut.await, Err(RpcError::Cancelled)));
    canceller.await.unwrap();
    eventually(|| rec.notifications.lock().iter().any(|(m, p)| m == "$/cancelRequest" && p["id"] == json!(1))).await;

    // Dropping the future (e.g. a timeout) also cancels.
    let r = tokio::time::timeout(Duration::from_millis(30), client.request::<_, Value>("hang", (), None)).await;
    assert!(r.is_err());
    eventually(|| rec.notifications.lock().iter().any(|(m, p)| m == "$/cancelRequest" && p["id"] == json!(2))).await;
    assert!(client.inner.pending.lock().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn server_cancelled_error_maps_to_cancelled() {
    let (client_io, server_io) = duplex(4096);
    let (cr, cw) = tokio::io::split(client_io);
    let client = Peer::connect(cr, cw, Arc::new(NoopHandler));
    let (sr, mut sw) = tokio::io::split(server_io);
    tokio::spawn(async move {
        let mut reader = tokio::io::BufReader::new(sr);
        let body = framing::read_message(&mut reader).await.unwrap().unwrap();
        let v: Value = serde_json::from_slice(&body).unwrap();
        let msg = json!({"jsonrpc": "2.0", "id": v["id"], "error": {"code": -32800, "message": "cancelled"}});
        framing::write_message(&mut sw, msg.to_string().as_bytes()).await.unwrap();
        tokio::time::sleep(Duration::from_secs(1)).await;
    });
    assert!(matches!(client.request::<_, Value>("x", (), None).await, Err(RpcError::Cancelled)));
}

#[tokio::test(flavor = "multi_thread")]
async fn closed_fails_pending_and_resolves() {
    let (client_io, server_io) = duplex(4096);
    let (cr, cw) = tokio::io::split(client_io);
    let client = Peer::connect(cr, cw, Arc::new(NoopHandler));
    let pending = tokio::spawn({
        let client = client.clone();
        async move { client.request::<_, Value>("x", (), None).await }
    });
    tokio::time::sleep(Duration::from_millis(20)).await;
    drop(server_io);
    assert!(matches!(pending.await.unwrap(), Err(RpcError::Closed)));
    assert_eq!(tokio::time::timeout(Duration::from_secs(1), client.closed()).await.unwrap(), None);
    assert!(client.is_closed());
    assert!(matches!(client.notify("x", ()), Err(RpcError::Closed)));
    assert!(matches!(client.request::<_, Value>("x", (), None).await, Err(RpcError::Closed)));
}

#[tokio::test(flavor = "multi_thread")]
async fn kill_closes_both_sides() {
    let (client, server) = pair(Arc::new(NoopHandler), Arc::new(Recorder::default()));
    server.kill();
    tokio::time::timeout(Duration::from_secs(1), client.closed()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(1), server.closed()).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn garbage_message_is_skipped() {
    let (client_io, server_io) = duplex(4096);
    let (cr, cw) = tokio::io::split(client_io);
    let client = Peer::connect(cr, cw, Arc::new(NoopHandler));
    let (sr, mut sw) = tokio::io::split(server_io);
    tokio::spawn(async move {
        let mut reader = tokio::io::BufReader::new(sr);
        let body = framing::read_message(&mut reader).await.unwrap().unwrap();
        let v: Value = serde_json::from_slice(&body).unwrap();
        framing::write_message(&mut sw, b"not json").await.unwrap();
        framing::write_message(&mut sw, json!({"jsonrpc":"2.0","id":v["id"],"result":7}).to_string().as_bytes())
            .await
            .unwrap();
        sw.flush().await.unwrap();
        tokio::time::sleep(Duration::from_secs(1)).await;
    });
    assert_eq!(client.request::<_, i32>("x", (), None).await.unwrap(), 7);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn spawn_process_reports_exit_code_and_stderr() {
    let lines = Arc::new(Mutex::new(Vec::new()));
    let sink = lines.clone();
    let peer = Peer::spawn(
        "sh",
        &["-c".into(), "echo oops >&2; exit 3".into()],
        &std::env::temp_dir(),
        &[],
        Arc::new(NoopHandler),
        Box::new(move |l| sink.lock().push(l)),
    )
    .unwrap();
    assert!(peer.pid().is_some());
    assert_eq!(tokio::time::timeout(Duration::from_secs(5), peer.closed()).await.unwrap(), Some(3));
    eventually(|| lines.lock().iter().any(|l| l == "oops")).await;
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn kill_terminates_process() {
    let peer =
        Peer::spawn("sleep", &["30".into()], &std::env::temp_dir(), &[], Arc::new(NoopHandler), Box::new(|_| {}))
            .unwrap();
    peer.kill();
    tokio::time::timeout(Duration::from_secs(5), peer.closed()).await.unwrap();
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exited_resolves_once_the_killed_process_is_reaped() {
    let peer =
        Peer::spawn("sleep", &["30".into()], &std::env::temp_dir(), &[], Arc::new(NoopHandler), Box::new(|_| {}))
            .unwrap();
    let pid = peer.pid().unwrap().to_string();
    let exited = tokio::time::timeout(Duration::from_millis(200), peer.exited()).await;
    assert!(exited.is_err(), "running until killed");
    peer.kill();
    tokio::time::timeout(Duration::from_secs(5), peer.exited()).await.unwrap();
    let alive = std::process::Command::new("kill").args(["-0", &pid]).status().unwrap().success();
    assert!(!alive, "reaped, not even a zombie");
}

#[tokio::test(flavor = "multi_thread")]
async fn exited_resolves_at_once_without_a_process() {
    let (client, _server) = pair(Arc::new(NoopHandler), Arc::new(Recorder::default()));
    tokio::time::timeout(Duration::from_secs(1), client.exited()).await.unwrap();
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn exited_waits_for_a_windows_descendant_to_release_its_file() {
    use std::os::windows::fs::OpenOptionsExt;
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(
        tmp.path().join("hold.ps1"),
        "$f=[IO.File]::Open('locked.txt','Create','ReadWrite','None'); [IO.File]::WriteAllText('ready.txt','ready'); Start-Sleep 30",
    )
    .unwrap();
    let peer = Peer::spawn(
        "cmd",
        &[
            "/D".into(),
            "/C".into(),
            "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File hold.ps1".into(),
        ],
        tmp.path(),
        &[],
        Arc::new(NoopHandler),
        Box::new(|_| {}),
    )
    .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        while !tmp.path().join("ready.txt").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let open = || std::fs::OpenOptions::new().read(true).share_mode(0).open(tmp.path().join("locked.txt"));
    assert_eq!(open().unwrap_err().raw_os_error(), Some(32));
    assert!(tokio::time::timeout(Duration::from_millis(200), peer.exited()).await.is_err());
    peer.kill();
    tokio::time::timeout(Duration::from_secs(5), peer.exited()).await.unwrap();
    drop(open().expect("exited must wait for the descendant's file handle to close"));
}

/// A launcher that prints in the system code page and exits before speaking the
/// protocol: `jdtls.bat` on a Chinese Windows when its Python step fails, then
/// `pause` prints `请按任意键继续. . .` in GBK on stdout.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn output_before_the_handshake_is_reported_not_dropped() {
    let lines = Arc::new(Mutex::new(Vec::new()));
    let sink = lines.clone();
    let script = r"printf 'python: not found\n' >&2; printf '\307\353\260\264\310\316\322\342\274\374\274\314\320\370. . .\r\n'; exit 1";
    let peer = Peer::spawn(
        "sh",
        &["-c".into(), script.into()],
        &std::env::temp_dir(),
        &[],
        Arc::new(NoopHandler),
        Box::new(move |l| sink.lock().push(l)),
    )
    .unwrap();
    let init = peer.request::<_, Value>("initialize", json!({}), None).await;
    assert!(matches!(init, Err(RpcError::Closed)), "{init:?}");
    assert_eq!(tokio::time::timeout(Duration::from_secs(5), peer.closed()).await.unwrap(), Some(1));
    // Everything the process wrote is in by the time the close is reported.
    let lines = lines.lock().clone();
    assert!(lines.iter().any(|l| l == "python: not found"), "{lines:?}");
    assert!(lines.iter().any(|l| l.ends_with(". . .") && l.len() > 6), "{lines:?}");
}
