import { IMAGE_FILE_EXTENSIONS } from '../../../../shared/image-file-extensions'
import type { TerminalTargetShell } from './terminal-drop-shell'
import {
  hasTerminalDropControlByte,
  isWindowsDoubleQuoteLiteralPath
} from './terminal-drop-path-quoting'

// Why: dropped image files should be handed to terminal TUIs (Claude Code,
// Codex, etc.) as image attachments, which those tools detect from a
// *bracketed paste* of the file path — exactly how clipboard screenshot paste
// already works in Orca (see terminal-clipboard-paste.ts + issue #2842).
const IMAGE_DROP_EXTENSIONS = new Set(IMAGE_FILE_EXTENSIONS)
// Why: an ASCII space is unsafe because Codex shlex-splits a raw spaced path into several tokens.
const POSIX_RAW_IMAGE_DROP_UNSAFE_RE = /[ "'`$;&|<>(){}[\]*?!#\\]/
const WINDOWS_RAW_IMAGE_DROP_UNSAFE_RE = /[ "'`$;&|<>(){}[\]*?!#^%]/

/**
 * Returns true when `path` looks like a local/remote image file based on its
 * extension. Handles POSIX (`/`) and Windows (`\`) separators and is
 * case-insensitive. The extension must be part of the basename, so directory
 * components with dots (e.g. `/home/jane.doe/photo`) are not misclassified.
 */
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
  if (hasTerminalDropControlByte(path)) {
    return false
  }
  const unsafeRe =
    targetShell === 'windows' ? WINDOWS_RAW_IMAGE_DROP_UNSAFE_RE : POSIX_RAW_IMAGE_DROP_UNSAFE_RE
  return !unsafeRe.test(path)
}

/**
 * Text to bracketed-paste for a dropped image, or null when a paste would alter
 * the path (control bytes are rewritten by the paste frame).
 */
export function formatImageDropPasteText(
  path: string,
  targetShell: TerminalTargetShell
): string | null {
  if (hasTerminalDropControlByte(path)) {
    return null
  }
  if (canPasteImageDropPathRaw(path, targetShell)) {
    return path
  }
  // Why: Claude Code strips only one outer quote pair, so a POSIX `'\''` splice
  // leaks quotes into the path; backslash escapes round-trip in Claude, Codex, and shells.
  return targetShell === 'windows' ? `"${path}"` : backslashEscapePosixPath(path)
}

function backslashEscapePosixPath(path: string): string {
  return path.replace(/[^a-zA-Z0-9_./@:\-\u0080-\uffff]/g, '\\$&')
}

/**
 * formatImageDropPasteText for a terminal pane, where a shell prompt may read
 * the pasted line: null when the Windows spelling would not stay literal there
 * (`$(…)`, `%VAR%`), so the caller types the path quoted for the pane's shell.
 */
export function formatTerminalImageDropPasteText(
  path: string,
  targetShell: TerminalTargetShell
): string | null {
  if (targetShell === 'windows' && !isWindowsDoubleQuoteLiteralPath(path)) {
    return null
  }
  return formatImageDropPasteText(path, targetShell)
}
