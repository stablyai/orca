import { IMAGE_FILE_EXTENSIONS } from './image-file-extensions'
import { shellEscapePath } from './shell-path-quoting'

type TerminalTargetShell = 'posix' | 'windows'

// Terminal TUIs recognize bracketed file-path pastes as image attachments, matching clipboard screenshots (#2842).
const IMAGE_DROP_EXTENSIONS = new Set(IMAGE_FILE_EXTENSIONS)
// Why: an ASCII space is unsafe because Codex shlex-splits a raw spaced path into several tokens.
const POSIX_RAW_IMAGE_DROP_UNSAFE_RE = /[ "'`$;&|<>(){}[\]*?!#\\]/
const WINDOWS_RAW_IMAGE_DROP_UNSAFE_RE = /[ "'`$;&|<>(){}[\]*?!#^%]/

/** Match image extensions case-insensitively within POSIX/Windows basenames; dots in parent directories do not count. */
export function isImageDropPath(path: string): boolean {
  const lastDot = path.lastIndexOf('.')
  if (lastDot === -1) {
    return false
  }
  const lastSeparator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (lastDot < lastSeparator) {
    return false
  }
  return IMAGE_DROP_EXTENSIONS.has(path.slice(lastDot).toLowerCase())
}

export function canPasteImageDropPathRaw(path: string, targetShell: TerminalTargetShell): boolean {
  if (hasControlByte(path)) {
    return false
  }
  const unsafeRe =
    targetShell === 'windows' ? WINDOWS_RAW_IMAGE_DROP_UNSAFE_RE : POSIX_RAW_IMAGE_DROP_UNSAFE_RE
  return !unsafeRe.test(path)
}

/** Bracketed-paste text, or null when paste framing would rewrite control bytes and alter the path. */
export function formatImageDropPasteText(
  path: string,
  targetShell: TerminalTargetShell
): string | null {
  if (hasControlByte(path)) {
    return null
  }
  if (canPasteImageDropPathRaw(path, targetShell)) {
    return path
  }
  // Claude strips only one quote pair, so POSIX splice quoting leaks into paths; backslash escapes round-trip across Claude/Codex/shells.
  return targetShell === 'windows'
    ? shellEscapePath(path, 'windows')
    : backslashEscapePosixPath(path)
}

function backslashEscapePosixPath(path: string): string {
  return path.replace(/[^a-zA-Z0-9_./@:\-\u0080-\uffff]/g, '\\$&')
}

function hasControlByte(path: string): boolean {
  for (let i = 0; i < path.length; i += 1) {
    const code = path.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) {
      return true
    }
  }
  return false
}
