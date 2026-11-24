//! Text a server process writes outside the protocol: stderr, and stray stdout
//! lines (a launcher script's or the runtime's own messages) before a message.
//!
//! Such text is often not UTF-8: on Windows, `cmd.exe`, batch files and native
//! launchers write in the system code page (GBK on a Chinese system).

use encoding_rs::Encoding;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};

/// `bytes` as text: UTF-8 when valid, else (on Windows) the console / ANSI code
/// page, else UTF-8 with replacement characters.
pub fn decode(bytes: &[u8]) -> String {
    decode_with(bytes, &native_code_pages())
}

/// [`decode`] trying the given Windows code pages, in order, after UTF-8.
pub fn decode_with(bytes: &[u8], code_pages: &[u32]) -> String {
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_owned();
    }
    for enc in code_pages.iter().filter_map(|&cp| encoding_for_code_page(cp)) {
        let (text, had_errors) = enc.decode_without_bom_handling(bytes);
        if !had_errors {
            return text.into_owned();
        }
    }
    String::from_utf8_lossy(bytes).into_owned()
}

/// The `encoding_rs` encoding of a Windows code page, when it has one.
pub fn encoding_for_code_page(cp: u32) -> Option<&'static Encoding> {
    Some(match cp {
        65001 => encoding_rs::UTF_8,
        936 => encoding_rs::GBK,
        54936 => encoding_rs::GB18030,
        950 => encoding_rs::BIG5,
        932 => encoding_rs::SHIFT_JIS,
        949 => encoding_rs::EUC_KR,
        866 => encoding_rs::IBM866,
        874 => encoding_rs::WINDOWS_874,
        1250 => encoding_rs::WINDOWS_1250,
        1251 => encoding_rs::WINDOWS_1251,
        1252 => encoding_rs::WINDOWS_1252,
        1253 => encoding_rs::WINDOWS_1253,
        1254 => encoding_rs::WINDOWS_1254,
        1255 => encoding_rs::WINDOWS_1255,
        1256 => encoding_rs::WINDOWS_1256,
        1257 => encoding_rs::WINDOWS_1257,
        1258 => encoding_rs::WINDOWS_1258,
        20866 => encoding_rs::KOI8_R,
        21866 => encoding_rs::KOI8_U,
        _ => return None,
    })
}

/// The OEM (console) and ANSI code pages: console programs and batch files write in
/// the former, GUI-subsystem and Java launchers in the latter.
#[cfg(windows)]
fn native_code_pages() -> [u32; 2] {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetOEMCP() -> u32;
        fn GetACP() -> u32;
    }
    // SAFETY: argument-less Win32 queries.
    unsafe { [GetOEMCP(), GetACP()] }
}

#[cfg(not(windows))]
fn native_code_pages() -> [u32; 0] {
    []
}

/// Removes a trailing `\n` / `\r\n` (and stray `\r`s before it).
pub fn trim_line_end(line: &[u8]) -> &[u8] {
    let mut end = line.len();
    while end > 0 && matches!(line[end - 1], b'\n' | b'\r') {
        end -= 1;
    }
    &line[..end]
}

/// Reads `stream` to its end, calling `on_line` with each line decoded by [`decode`].
/// Unlike `AsyncBufReadExt::lines`, a line that is not UTF-8 does not end the stream.
pub async fn read_lines<R: AsyncRead + Unpin>(stream: R, mut on_line: impl FnMut(String)) {
    let mut reader = BufReader::new(stream);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line).await {
            Ok(0) | Err(_) => break,
            Ok(_) => on_line(decode(trim_line_end(&line))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `请按任意键继续. . .`, what `pause` prints on a Chinese Windows (code page 936).
    const PAUSE_GBK: &[u8] = b"\xc7\xeb\xb0\xb4\xc8\xce\xd2\xe2\xbc\xfc\xbc\xcc\xd0\xf8. . .";

    #[test]
    fn utf8_passes_through() {
        assert_eq!(decode_with("héllo 中文".as_bytes(), &[936]), "héllo 中文");
    }

    #[test]
    fn code_page_text_is_decoded() {
        assert_eq!(decode_with(PAUSE_GBK, &[936, 936]), "请按任意键继续. . .");
        // The first code page that decodes cleanly wins.
        assert_eq!(decode_with(PAUSE_GBK, &[437, 936]), "请按任意键继续. . .");
        assert_eq!(decode_with(b"caf\xe9", &[1252]), "café");
    }

    #[test]
    fn undecodable_text_is_lossy_utf8() {
        let out = decode_with(PAUSE_GBK, &[]);
        assert!(out.contains('\u{FFFD}') && out.ends_with(". . ."), "{out}");
        assert_eq!(decode_with(b"a\xffb", &[65001]), "a\u{FFFD}b");
    }

    #[tokio::test]
    async fn read_lines_survives_non_utf8_lines() {
        let mut input = b"first\r\n".to_vec();
        input.extend_from_slice(b"\xff\xfe broken\n");
        input.extend_from_slice(b"last");
        let mut lines = Vec::new();
        read_lines(&input[..], |l| lines.push(l)).await;
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0], "first");
        assert!(lines[1].ends_with(" broken"));
        assert_eq!(lines[2], "last");
    }
}
