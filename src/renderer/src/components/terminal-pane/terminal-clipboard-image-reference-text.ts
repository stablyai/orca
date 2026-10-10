import { isImageDropPath } from './terminal-drop-image-path'

// Why: keep the check bounded so an oversized clipboard string never turns the
// text fast path into a scan. The raw cap is applied before trimming, so a
// clipboard padded with megabytes of whitespace cannot force a full pass.
const MAX_IMAGE_REFERENCE_TEXT_LENGTH = 2048
const MAX_IMAGE_REFERENCE_RAW_TEXT_LENGTH = 4096
const LOCAL_IMAGE_PATH_PREFIX_RE = /^(?:~\/|\/|\\\\|[A-Za-z]:[\\/])/

/**
 * True when clipboard text is nothing but a reference to an image: a local
 * path, a `file://` URL, or an `http(s)` URL whose last path segment names an
 * image file.
 *
 * Why: some sources put BOTH an image and a text description of that image on
 * the clipboard — a browser "Copy Image" adds the source URL, a file manager
 * adds the file path. The text fast path in `pasteTerminalClipboard` then wins
 * and the bitmap is dropped, so Cmd/Ctrl+V injects a URL the agent reads as
 * text instead of the screenshot the user copied. Text that merely *names* the
 * image is never the payload the user meant to paste, so the image may win.
 * Ordinary text keeps the untouched text fast path, including rich copies from
 * spreadsheets and slide editors that carry a TIFF flavor alongside the cells.
 *
 * Deliberately narrow: relative paths (`Desktop/photo.png`) and extensions that
 * live only in a URL query string or fragment are not treated as references, so
 * those clipboards still paste their text. Over-matching prose would be the
 * worse failure, since it would replace text the user meant to paste.
 */
export function isImageReferenceOnlyClipboardText(text: string): boolean {
  if (!text || text.length > MAX_IMAGE_REFERENCE_RAW_TEXT_LENGTH) {
    return false
  }
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > MAX_IMAGE_REFERENCE_TEXT_LENGTH) {
    return false
  }
  if (/[\r\n\t]/.test(trimmed)) {
    return false
  }
  // Why: check the path shape first — a Windows path (`C:\…`) also parses as a
  // URL with a one-letter scheme, so URL parsing must not claim it. Requiring a
  // path-shaped prefix also keeps prose that happens to end in an image
  // filename ("see screenshot.png") from counting as a reference.
  if (LOCAL_IMAGE_PATH_PREFIX_RE.test(trimmed)) {
    return isImageDropPath(trimmed)
  }
  const url = parseAbsoluteUrl(trimmed)
  if (!url) {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'file:') {
    return false
  }
  return isImageDropPath(decodeUrlPathname(url.pathname))
}

function parseAbsoluteUrl(text: string): URL | null {
  try {
    return new URL(text)
  } catch {
    return null
  }
}

function decodeUrlPathname(pathname: string): string {
  try {
    return decodeURIComponent(pathname)
  } catch {
    return pathname
  }
}
