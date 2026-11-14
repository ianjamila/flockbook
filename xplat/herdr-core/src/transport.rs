//! Blocking NDJSON over a byte transport (port of LineSocket.swift).
//!
//! The transport is a small trait: a Unix socket (`cfg(unix)`) or, on Windows, the named pipe herdr-core listens on
//! there (`\\.\pipe\herdr-core-…`; `cfg(windows)`).

use crate::error::HerdrError;
use std::io::{self, Read, Write};
use std::time::Duration;

/// A connected byte stream. `shutdown` must unblock a reader on another thread.
pub trait Transport: Read + Write + Send {
    fn shutdown(&mut self);
}

/// Opens a transport to a herdr server. `timeout` applies to each read and write; `None` blocks forever (event streams).
pub trait Connector: Send + Sync {
    fn connect(&self, timeout: Option<Duration>) -> Result<Box<dyn Transport>, HerdrError>;
}

/// Line framing over a transport: `write_line` appends `\n`; `read_line` returns one line without it.
pub struct LineSocket {
    inner: Box<dyn Transport>,
    buf: Vec<u8>,
}

impl LineSocket {
    pub fn new(inner: Box<dyn Transport>) -> Self {
        LineSocket { inner, buf: Vec::new() }
    }

    pub fn connect(c: &dyn Connector, timeout: Option<Duration>) -> Result<Self, HerdrError> {
        Ok(Self::new(c.connect(timeout)?))
    }

    pub fn write_line(&mut self, data: &[u8]) -> Result<(), HerdrError> {
        let mut out = Vec::with_capacity(data.len() + 1);
        out.extend_from_slice(data);
        out.push(b'\n');
        self.inner.write_all(&out).map_err(|e| HerdrError::Socket(format!("write: {e}")))?;
        self.inner.flush().map_err(|e| HerdrError::Socket(format!("write: {e}")))
    }

    /// Next full line, or `Closed` at EOF.
    pub fn read_line(&mut self) -> Result<Vec<u8>, HerdrError> {
        loop {
            if let Some(nl) = self.buf.iter().position(|b| *b == b'\n') {
                let line = self.buf[..nl].to_vec();
                self.buf.drain(..=nl);
                return Ok(line);
            }
            let mut chunk = [0u8; 65536];
            match self.inner.read(&mut chunk) {
                Ok(0) => return Err(HerdrError::Closed),
                Ok(n) => self.buf.extend_from_slice(&chunk[..n]),
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                // Ran past the read timeout: the request may still take effect.
                Err(e) if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => {
                    return Err(HerdrError::Timeout("read".into()))
                }
                Err(e) => return Err(HerdrError::Socket(format!("read: {e}"))),
            }
        }
    }

    pub fn close(&mut self) {
        self.inner.shutdown();
    }
}

#[cfg(unix)]
pub use unix::UnixConnector;

#[cfg(unix)]
mod unix {
    use super::*;
    use std::net::Shutdown;
    use std::os::unix::net::UnixStream;

    /// Connects to a herdr Unix socket by path.
    #[derive(Debug, Clone)]
    pub struct UnixConnector {
        pub path: String,
    }

    struct UnixTransport(UnixStream);

    impl Read for UnixTransport {
        fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
            self.0.read(b)
        }
    }
    impl Write for UnixTransport {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            self.0.write(b)
        }
        fn flush(&mut self) -> io::Result<()> {
            self.0.flush()
        }
    }
    impl Transport for UnixTransport {
        fn shutdown(&mut self) {
            let _ = self.0.shutdown(Shutdown::Both);
        }
    }

    impl Connector for UnixConnector {
        fn connect(&self, timeout: Option<Duration>) -> Result<Box<dyn Transport>, HerdrError> {
            let s = UnixStream::connect(&self.path).map_err(|e| HerdrError::Socket(format!("connect {} failed: {e}", self.path)))?;
            s.set_read_timeout(timeout).map_err(|e| HerdrError::Socket(format!("set timeout: {e}")))?;
            s.set_write_timeout(timeout).map_err(|e| HerdrError::Socket(format!("set timeout: {e}")))?;
            Ok(Box::new(UnixTransport(s)))
        }
    }
}

#[cfg(windows)]
pub use pipe::{PipeConnector, PIPE_PREFIX};

/// Windows: herdr-core's endpoint is a named pipe (`\\.\pipe\herdr-core-…`, found by `hc::session`). Overlapped I/O,
/// so a read or write gives up at the timeout like a Unix socket's, and a timed-out read is cancelled before the
/// next write (a synchronous pipe handle would queue that write behind the pending read).
#[cfg(windows)]
mod pipe {
    use super::*;
    use std::fs::{File, OpenOptions};
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
    use std::time::Instant;
    use windows_sys::Win32::Foundation::{
        ERROR_BROKEN_PIPE, ERROR_IO_PENDING, ERROR_MORE_DATA, ERROR_NO_DATA, ERROR_OPERATION_ABORTED, ERROR_PIPE_BUSY,
        ERROR_PIPE_NOT_CONNECTED, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::Storage::FileSystem::{ReadFile, WriteFile, FILE_FLAG_OVERLAPPED};
    use windows_sys::Win32::System::Threading::{CreateEventW, WaitForSingleObject, INFINITE};
    use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

    /// Every named pipe's path starts with this.
    pub const PIPE_PREFIX: &str = r"\\.\pipe\";

    /// How long `connect` keeps trying while every instance of the pipe is busy (ERROR_PIPE_BUSY).
    const BUSY_WAIT: Duration = Duration::from_secs(2);

    /// Connects to a named pipe by its full path (`\\.\pipe\name`).
    #[derive(Debug, Clone)]
    pub struct PipeConnector {
        pub path: String,
    }

    struct PipeTransport {
        file: File,
        /// Manual-reset event for the one overlapped operation in flight (calls never overlap: `&mut self`).
        event: OwnedHandle,
        timeout: Option<Duration>,
        closed: bool,
    }

    fn code(e: &io::Error) -> u32 {
        e.raw_os_error().map(|c| c as u32).unwrap_or(0)
    }

    impl PipeTransport {
        /// One overlapped read or write, waited for up to the timeout. A timed-out operation is cancelled and waited
        /// out, so nothing stays in flight; what it moved before the cancel still counts.
        fn io(&mut self, write: bool, ptr: *mut u8, len: usize) -> io::Result<usize> {
            if self.closed {
                return if write { Err(io::Error::new(io::ErrorKind::BrokenPipe, "pipe closed")) } else { Ok(0) };
            }
            let h = self.file.as_raw_handle();
            let len = len.min(u32::MAX as usize) as u32;
            // SAFETY: zeroed OVERLAPPED is its documented initial state; the event is a valid manual-reset event.
            let mut ov: OVERLAPPED = unsafe { std::mem::zeroed() };
            ov.hEvent = self.event.as_raw_handle() as _;
            // SAFETY: `ptr`/`len` describe the caller's buffer, alive until this call returns; `ov` too, and this call
            // does not return before the operation is finished or cancelled and waited out.
            let started = unsafe {
                if write {
                    WriteFile(h as _, ptr as *const u8, len, std::ptr::null_mut(), &mut ov)
                } else {
                    ReadFile(h as _, ptr, len, std::ptr::null_mut(), &mut ov)
                }
            };
            let mut timed_out = false;
            if started == 0 {
                let e = io::Error::last_os_error();
                match code(&e) {
                    ERROR_IO_PENDING => {
                        let ms = self.timeout.map(|d| d.as_millis().clamp(1, (INFINITE - 1) as u128) as u32).unwrap_or(INFINITE);
                        // SAFETY: a valid event handle.
                        if unsafe { WaitForSingleObject(self.event.as_raw_handle() as _, ms) } == WAIT_TIMEOUT {
                            timed_out = true;
                            // SAFETY: cancels only this operation (its OVERLAPPED) on this handle.
                            unsafe { CancelIoEx(h as _, &ov) };
                        }
                    }
                    ERROR_MORE_DATA if !write => {} // a message-mode pipe: the rest comes with the next read
                    ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED | ERROR_NO_DATA if !write => return Ok(0),
                    _ => return Err(e),
                }
            }
            let mut n: u32 = 0;
            // SAFETY: waits (bWait = TRUE) for this handle's operation described by `ov`, finished or cancelled.
            if unsafe { GetOverlappedResult(h as _, &ov, &mut n, 1) } == 0 {
                let e = io::Error::last_os_error();
                return match code(&e) {
                    ERROR_MORE_DATA if !write => Ok(n as usize),
                    ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED | ERROR_NO_DATA if !write => Ok(0),
                    ERROR_OPERATION_ABORTED if timed_out && n == 0 => Err(io::Error::new(io::ErrorKind::TimedOut, "pipe timed out")),
                    ERROR_OPERATION_ABORTED if n > 0 => Ok(n as usize),
                    _ => Err(e),
                };
            }
            Ok(n as usize)
        }
    }

    impl Read for PipeTransport {
        fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
            if b.is_empty() {
                return Ok(0);
            }
            self.io(false, b.as_mut_ptr(), b.len())
        }
    }
    impl Write for PipeTransport {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            if b.is_empty() {
                return Ok(0);
            }
            self.io(true, b.as_ptr() as *mut u8, b.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    impl Transport for PipeTransport {
        fn shutdown(&mut self) {
            self.closed = true;
            // SAFETY: cancels whatever this handle still has in flight (nothing, as calls wait theirs out).
            unsafe { CancelIoEx(self.file.as_raw_handle() as _, std::ptr::null()) };
        }
    }

    impl Connector for PipeConnector {
        fn connect(&self, timeout: Option<Duration>) -> Result<Box<dyn Transport>, HerdrError> {
            let fail = |e: io::Error| HerdrError::Socket(format!("connect {} failed: {e}", self.path));
            let until = Instant::now() + timeout.map_or(BUSY_WAIT, |t| t.min(BUSY_WAIT));
            let file = loop {
                match OpenOptions::new().read(true).write(true).custom_flags(FILE_FLAG_OVERLAPPED).open(&self.path) {
                    Ok(f) => break f,
                    // Every instance is serving someone: the core makes a new one as it accepts.
                    Err(e) if code(&e) == ERROR_PIPE_BUSY && Instant::now() < until => std::thread::sleep(Duration::from_millis(20)),
                    Err(e) => return Err(fail(e)),
                }
            };
            // SAFETY: plain manual-reset, initially unset, unnamed event; null is checked before it is owned.
            let ev = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
            if ev.is_null() {
                return Err(fail(io::Error::last_os_error()));
            }
            // SAFETY: a fresh handle nothing else owns.
            let event = unsafe { OwnedHandle::from_raw_handle(ev as RawHandle) };
            Ok(Box::new(PipeTransport { file, event, timeout, closed: false }))
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::transport::LineSocket;
        use std::io::{Read as _, Write as _};
        use windows_sys::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
        use windows_sys::Win32::System::Pipes::{ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_WAIT};

        /// A one-client pipe server (synchronous handle) at `path`, created before this returns.
        fn server(path: &str) -> File {
            let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
            // SAFETY: a NUL-terminated name; default security; the handle is checked before use.
            let h = unsafe {
                CreateNamedPipeW(wide.as_ptr(), PIPE_ACCESS_DUPLEX, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT, 4, 65536, 65536, 0, std::ptr::null())
            };
            assert!(!h.is_null() && h as isize != -1, "CreateNamedPipeW failed: {}", io::Error::last_os_error());
            // SAFETY: a fresh handle nothing else owns.
            unsafe { File::from_raw_handle(h as RawHandle) }
        }

        fn accept(f: &File) {
            // SAFETY: a valid synchronous server handle; a client that came first gives ERROR_PIPE_CONNECTED (fine).
            unsafe { ConnectNamedPipe(f.as_raw_handle() as _, std::ptr::null_mut()) };
        }

        fn name(what: &str) -> String {
            format!(r"\\.\pipe\herdr-core-test-{what}-{}", std::process::id())
        }

        #[test]
        fn round_trip_one_line() {
            let path = name("rt");
            let srv = server(&path);
            let t = std::thread::spawn(move || {
                accept(&srv);
                let mut buf = Vec::new();
                let mut b = [0u8; 256];
                while !buf.contains(&b'\n') {
                    let n = (&srv).read(&mut b).unwrap();
                    assert!(n > 0);
                    buf.extend_from_slice(&b[..n]);
                }
                assert_eq!(buf, b"{\"id\":1}\n");
                (&srv).write_all(b"{\"id\":1,\"result\":{}}\n").unwrap();
            });
            let c = PipeConnector { path: path.clone() };
            let mut s = LineSocket::connect(&c, Some(Duration::from_secs(5))).unwrap();
            s.write_line(b"{\"id\":1}").unwrap();
            assert_eq!(s.read_line().unwrap(), b"{\"id\":1,\"result\":{}}");
            s.close();
            t.join().unwrap();
        }

        #[test]
        fn read_times_out_and_a_write_still_goes_through() {
            let path = name("to");
            let srv = server(&path);
            let (tx, rx) = std::sync::mpsc::channel::<()>();
            let t = std::thread::spawn(move || {
                accept(&srv);
                // Says nothing until the client wrote after its timed-out read.
                let mut b = [0u8; 64];
                let n = (&srv).read(&mut b).unwrap();
                assert_eq!(&b[..n], b"late\n");
                (&srv).write_all(b"ok\n").unwrap();
                let _ = rx.recv();
            });
            let c = PipeConnector { path };
            let mut s = LineSocket::connect(&c, Some(Duration::from_millis(150))).unwrap();
            let t0 = Instant::now();
            assert!(matches!(s.read_line(), Err(HerdrError::Timeout(_))));
            assert!(t0.elapsed() < Duration::from_secs(3));
            s.write_line(b"late").unwrap();
            assert_eq!(s.read_line().unwrap(), b"ok");
            tx.send(()).unwrap();
            t.join().unwrap();
        }

        #[test]
        fn closed_server_reads_as_closed() {
            let path = name("eof");
            let srv = server(&path);
            let t = std::thread::spawn(move || {
                accept(&srv);
                (&srv).write_all(b"bye\n").unwrap();
                // Waits until the client read it: closing first could drop what it has not read yet.
                srv.sync_all().unwrap();
                drop(srv);
            });
            let c = PipeConnector { path };
            let mut s = LineSocket::connect(&c, Some(Duration::from_secs(5))).unwrap();
            assert_eq!(s.read_line().unwrap(), b"bye");
            t.join().unwrap();
            assert!(matches!(s.read_line(), Err(HerdrError::Closed)));
        }

        #[test]
        fn missing_pipe_is_a_socket_error() {
            let c = PipeConnector { path: name("none") };
            assert!(matches!(c.connect(Some(Duration::from_millis(100))), Err(HerdrError::Socket(_))));
        }
    }
}
