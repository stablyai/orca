//! Bounded, ordered process input. Only the worker touches the OS writer.

use std::collections::VecDeque;
use std::io::{self, Write};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
#[cfg(any(not(unix), test))]
use std::time::Duration;

const MAX_BYTES: usize = 4 * 1024 * 1024;
const MAX_WRITES: usize = 1024;
#[cfg(any(not(unix), test))]
const RETRY: Duration = Duration::from_millis(4);

#[derive(Default)]
struct State {
    queue: VecDeque<Vec<u8>>,
    bytes: usize,
    finished: bool,
    aborted: bool,
    error: Option<String>,
}

/// One worker per pipe/PTY. The byte budget includes the in-flight write.
/// Rejected writes enqueue nothing. Dropping this handle discards pending input
/// without joining the worker; `finish` instead drains accepted input before EOF.
pub struct InputWriter {
    shared: Arc<(Mutex<State>, Condvar)>,
    worker: Option<JoinHandle<()>>,
}

impl InputWriter {
    /// On Unix, pass the readiness hook returned by `nonblocking` for this writer.
    pub fn new(
        name: String,
        mut writer: Box<dyn Write + Send>,
        #[cfg(unix)] mut wait_writable: impl FnMut() -> io::Result<()> + Send + 'static,
        on_error: impl FnOnce(io::Error) + Send + 'static,
    ) -> io::Result<Self> {
        let shared = Arc::new((Mutex::new(State::default()), Condvar::new()));
        let worker_shared = shared.clone();
        let worker = std::thread::Builder::new().name(name).spawn(move || {
            let (lock, wake) = &*worker_shared;
            let result = (|| {
                loop {
                    let data = {
                        let mut state = lock.lock().unwrap();
                        while state.queue.is_empty() && !state.finished && !state.aborted {
                            state = wake.wait(state).unwrap();
                        }
                        if state.aborted {
                            return Ok(());
                        }
                        let Some(data) = state.queue.pop_front() else { return Ok(()) };
                        data
                    };
                    let mut offset = 0;
                    loop {
                        if lock.lock().unwrap().aborted {
                            return Ok(());
                        }
                        let flushing = offset == data.len();
                        let result = if !flushing {
                            writer.write(&data[offset..]).and_then(|n| {
                                if n == 0 {
                                    Err(io::ErrorKind::WriteZero.into())
                                } else {
                                    offset += n;
                                    Ok(())
                                }
                            })
                        } else {
                            writer.flush()
                        };
                        match result {
                            Ok(()) if flushing => break,
                            Ok(()) => {}
                            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                                #[cfg(unix)]
                                match wait_writable() {
                                    Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                                    result => result?,
                                }
                                #[cfg(not(unix))]
                                {
                                    let state = lock.lock().unwrap();
                                    if state.aborted {
                                        return Ok(());
                                    }
                                    drop(wake.wait_timeout(state, RETRY).unwrap());
                                }
                            }
                            Err(e) => return Err(e),
                        }
                    }
                    let len = data.len();
                    drop(data);
                    let mut state = lock.lock().unwrap();
                    state.bytes = state.bytes.saturating_sub(len);
                }
            })();
            if let Err(e) = result {
                let mut state = lock.lock().unwrap();
                if state.aborted {
                    return;
                }
                state.error = Some(e.to_string());
                state.queue.clear();
                state.bytes = 0;
                drop(state);
                on_error(e);
            }
        })?;
        Ok(Self { shared, worker: Some(worker) })
    }

    pub fn write(&self, data: &[u8]) -> io::Result<()> {
        let (lock, wake) = &*self.shared;
        let mut state = lock.lock().unwrap();
        if let Some(error) = &state.error {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, error.clone()));
        }
        if state.finished || state.aborted {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "stdin is closed"));
        }
        if data.is_empty() {
            return Ok(());
        }
        if data.len() > MAX_BYTES.saturating_sub(state.bytes) || state.queue.len() >= MAX_WRITES {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "Input queue is full (4 MiB or 1024 writes); input was not sent.",
            ));
        }
        state.bytes += data.len();
        state.queue.push_back(data.to_vec());
        wake.notify_one();
        Ok(())
    }

    /// Send EOF after the accepted writes, without waiting for the child to read.
    pub fn finish(&self) {
        let (lock, wake) = &*self.shared;
        lock.lock().unwrap().finished = true;
        wake.notify_one();
    }

    pub fn close(&self) {
        let (lock, wake) = &*self.shared;
        let mut state = lock.lock().unwrap();
        state.aborted = true;
        state.queue.clear();
        wake.notify_one();
    }
}

impl Drop for InputWriter {
    fn drop(&mut self) {
        self.close();
        let Some(worker) = self.worker.take() else { return };
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            // A cancellation can race with entry into WriteFile, so retry off
            // the caller's thread until the worker observes the closed queue.
            let _ = std::thread::Builder::new().name("openidea-input-cancel".into()).spawn(move || {
                while !worker.is_finished() {
                    unsafe {
                        windows_sys::Win32::System::IO::CancelSynchronousIo(worker.as_raw_handle());
                    }
                    std::thread::sleep(RETRY);
                }
                let _ = worker.join();
            });
        }
        #[cfg(not(windows))]
        drop(worker);
    }
}

/// Make a writer nonblocking and return its readiness hook. PTY clones share file
/// status flags, so readers must also handle WouldBlock.
#[cfg(unix)]
pub fn nonblocking(fd: std::os::fd::RawFd) -> io::Result<impl FnMut() -> io::Result<()> + Send> {
    let wait = readiness(fd, libc::POLLOUT)?;
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags == -1 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(wait)
}

/// Wait for output from a nonblocking PTY without delaying the child's next read.
#[cfg(unix)]
pub fn readable(fd: std::os::fd::RawFd) -> io::Result<impl FnMut() -> io::Result<()> + Send> {
    readiness(fd, libc::POLLIN)
}

#[cfg(unix)]
fn readiness(fd: std::os::fd::RawFd, events: libc::c_short) -> io::Result<impl FnMut() -> io::Result<()> + Send> {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

    // Own a duplicate so the hook remains valid if the caller closes its fd.
    let duplicate = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
    if duplicate == -1 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fcntl returned a new, owned descriptor.
    let fd = unsafe { OwnedFd::from_raw_fd(duplicate) };
    Ok(move || {
        let mut pollfd = libc::pollfd { fd: fd.as_raw_fd(), events, revents: 0 };
        // Readiness wakes immediately; the timeout only bounds abort latency.
        if unsafe { libc::poll(&mut pollfd, 1, 50) } == -1 {
            return Err(io::Error::last_os_error());
        }
        if pollfd.revents & libc::POLLNVAL != 0 {
            return Err(io::Error::from_raw_os_error(libc::EBADF));
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    #[cfg(unix)]
    use std::time::Instant;

    struct SlowWriter {
        ready: Arc<AtomicBool>,
        output: Arc<Mutex<Vec<u8>>>,
        dropped: mpsc::Sender<()>,
    }

    impl Write for SlowWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if !self.ready.load(Ordering::Acquire) {
                return Err(io::ErrorKind::WouldBlock.into());
            }
            let n = bytes.len().min(7);
            self.output.lock().unwrap().extend_from_slice(&bytes[..n]);
            Ok(n)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl Drop for SlowWriter {
        fn drop(&mut self) {
            let _ = self.dropped.send(());
        }
    }

    #[test]
    fn bounds_include_inflight_bytes_and_reject_whole_writes() {
        let ready = Arc::new(AtomicBool::new(false));
        let output = Arc::new(Mutex::new(Vec::new()));
        let (tx, rx) = mpsc::channel();
        let writer = InputWriter::new(
            "test-input".into(),
            Box::new(SlowWriter { ready: ready.clone(), output: output.clone(), dropped: tx }),
            #[cfg(unix)]
            || {
                std::thread::sleep(RETRY);
                Ok(())
            },
            |e| panic!("{e}"),
        )
        .unwrap();
        let bytes = vec![b'x'; MAX_BYTES];
        writer.write(&bytes).unwrap();
        std::thread::sleep(RETRY * 2);
        assert_eq!(writer.write(b"rejected").unwrap_err().kind(), io::ErrorKind::WouldBlock);
        writer.close();
        rx.recv_timeout(Duration::from_secs(1)).expect("worker stops while peer still refuses input");
        assert!(output.lock().unwrap().is_empty());
        assert!(writer.write(b"closed").is_err());
        assert!(writer.shared.0.lock().unwrap().queue.is_empty());
    }

    #[test]
    fn partial_writes_preserve_order_and_finish_drains_before_eof() {
        let ready = Arc::new(AtomicBool::new(false));
        let output = Arc::new(Mutex::new(Vec::new()));
        let (tx, rx) = mpsc::channel();
        let writer = InputWriter::new(
            "test-input".into(),
            Box::new(SlowWriter { ready: ready.clone(), output: output.clone(), dropped: tx }),
            #[cfg(unix)]
            || {
                std::thread::sleep(RETRY);
                Ok(())
            },
            |e| panic!("{e}"),
        )
        .unwrap();
        let paste = "abé".repeat(1024);
        writer.write(paste.as_bytes()).unwrap();
        writer.write(b"tail").unwrap();
        writer.finish();
        assert!(writer.write(b"after EOF").is_err());
        ready.store(true, Ordering::Release);
        rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(*output.lock().unwrap(), format!("{paste}tail").as_bytes());
    }

    #[cfg(unix)]
    #[test]
    fn readiness_errors_are_reported_and_reject_following_writes() {
        let (dropped, _rx) = mpsc::channel();
        let (errors, error) = mpsc::channel();
        let writer = InputWriter::new(
            "test-error-input".into(),
            Box::new(SlowWriter { ready: Arc::new(AtomicBool::new(false)), output: Arc::default(), dropped }),
            || Err(io::Error::from_raw_os_error(libc::EBADF)),
            move |e| errors.send(e.raw_os_error()).unwrap(),
        )
        .unwrap();
        writer.write(b"input").unwrap();
        assert_eq!(error.recv_timeout(Duration::from_secs(1)).unwrap(), Some(libc::EBADF));
        assert_eq!(writer.write(b"later").unwrap_err().kind(), io::ErrorKind::BrokenPipe);
        let state = writer.shared.0.lock().unwrap();
        assert!(state.queue.is_empty());
        assert_eq!(state.bytes, 0);
    }

    #[test]
    fn tiny_writes_are_also_bounded() {
        let shared = Arc::new((Mutex::new(State::default()), Condvar::new()));
        let writer = InputWriter { shared, worker: None };
        for _ in 0..MAX_WRITES {
            writer.write(b"x").unwrap();
        }
        assert_eq!(writer.write(b"x").unwrap_err().kind(), io::ErrorKind::WouldBlock);
    }

    #[cfg(unix)]
    #[test]
    fn writable_input_resumes_without_timer_delays() {
        use std::io::Read;
        use std::os::fd::AsRawFd;
        use std::os::unix::net::UnixStream;

        let (pipe, mut peer) = UnixStream::pair().unwrap();
        let capacity: libc::c_int = 1024;
        // Keep the OS buffer small enough that a timer per buffer takes seconds.
        assert_eq!(
            unsafe {
                libc::setsockopt(
                    pipe.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_SNDBUF,
                    (&capacity as *const libc::c_int).cast(),
                    std::mem::size_of_val(&capacity) as libc::socklen_t,
                )
            },
            0
        );
        peer.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let wait_writable = nonblocking(pipe.as_raw_fd()).unwrap();
        let writer =
            InputWriter::new("test-ready-input".into(), Box::new(pipe), wait_writable, |e| panic!("{e}")).unwrap();
        let bytes = vec![b'x'; MAX_BYTES];
        writer.write(&bytes).unwrap();
        writer.finish();
        // Start with a full buffer, then make the fd writable from another thread.
        std::thread::sleep(Duration::from_millis(50));
        let (tx, rx) = mpsc::channel();
        let started = Instant::now();
        let reader = std::thread::spawn(move || {
            let mut output = Vec::new();
            peer.read_to_end(&mut output).unwrap();
            tx.send(output).unwrap();
        });
        let output = rx.recv_timeout(Duration::from_secs(1)).expect("input resumes as soon as the fd is writable");
        assert_eq!(output, bytes);
        reader.join().unwrap();
        eprintln!("4 MiB input drained in {:?}", started.elapsed());
    }

    #[cfg(unix)]
    #[test]
    fn close_interrupts_a_full_os_pipe_while_the_peer_stays_open() {
        use std::os::fd::AsRawFd;
        use std::os::unix::net::UnixStream;
        let (pipe, _peer) = UnixStream::pair().unwrap();
        let wait_writable = nonblocking(pipe.as_raw_fd()).unwrap();
        let mut writer =
            InputWriter::new("test-pipe-input".into(), Box::new(pipe), wait_writable, |e| panic!("{e}")).unwrap();
        writer.write(&vec![b'x'; MAX_BYTES]).unwrap();
        std::thread::sleep(Duration::from_millis(50));
        assert!(!writer.worker.as_ref().unwrap().is_finished());
        let started = Instant::now();
        writer.close();
        writer.worker.take().unwrap().join().unwrap();
        assert!(started.elapsed() < Duration::from_millis(250));
    }
}
