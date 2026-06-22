import { IMAGE_FILE_EXTENSIONS } from '../../../../shared/image-file-extensions'
import type { TerminalTargetShell } from './terminal-drop-shell'

// Why: dropped image files should be handed to terminal TUIs (Claude Code,
// Codex, etc.) as image attachments, which those tools detect from a
// *bracketed paste* of the file path — exactly how clipboard screenshot paste
// already works in Orca (see terminal-clipboard-paste.ts + issue #2842).
const IMAGE_DROP_EXTENSIONS = new Set(IMAGE_FILE_EXTENSIONS)
const POSIX_RAW_IMAGE_DROP_UNSAFE_RE = /["'`$;&|<>(){}[\]*?!#\\]/
const WINDOWS_RAW_IMAGE_DROP_UNSAFE_RE = /["'`$;&|<>(){}[\]*?!#^%]/

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
  if (hasControlByte(path)) {
    return false
  }
  const unsafeRe =
    targetShell === 'windows' ? WINDOWS_RAW_IMAGE_DROP_UNSAFE_RE : POSIX_RAW_IMAGE_DROP_UNSAFE_RE
  return !unsafeRe.test(path)
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
