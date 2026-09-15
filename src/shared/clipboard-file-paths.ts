import { getRuntimePathBasename, isRuntimePathAbsolute } from './cross-platform-path'
import { fileUriToFilesystemPath } from './file-uri-path'
import { NATIVE_FILE_DROP_MAX_PATHS } from './native-file-drop'

// A copied file name stays well under any filesystem limit; the cap only keeps
// the name-shaped clipboard probe off large text payloads.
const MAX_COPIED_FILE_NAME_LENGTH = 255

export const CLIPBOARD_FILE_PATH_MAX_ENTRIES = NATIVE_FILE_DROP_MAX_PATHS

// macOS file *reference* URLs (`file:///.file/id=6571367.71479400`) name an
// inode, not a location. Finder's `public.file-url` is always one, and it
// resolves through no shell, so only the real path flavors are usable.
const MACOS_FILE_REFERENCE_PREFIX = '/.file/'

function toClipboardFilePath(fileUri: string): string | null {
  let url: URL
  try {
    url = new URL(fileUri)
  } catch {
    return null
  }
  const path = fileUriToFilesystemPath(url)
  if (!path || !isRuntimePathAbsolute(path) || path.startsWith(MACOS_FILE_REFERENCE_PREFIX)) {
    return null
  }
  return path
}

/**
 * Parse a `text/uri-list` payload, including the GNOME `x-special/copied-files`
 * variant whose first line is the `copy` / `cut` verb rather than a URI.
 */
export function parseClipboardFileUriList(payload: string): string[] {
  const paths: string[] = []
  for (const line of payload.split(/\r?\n/)) {
    const entry = line.trim()
    // `#` starts a comment in the uri-list spec; the verb line has no scheme.
    if (!entry || entry.startsWith('#') || !entry.includes(':')) {
      continue
    }
    const path = toClipboardFilePath(entry)
    if (path) {
      paths.push(path)
    }
  }
  return paths.slice(0, CLIPBOARD_FILE_PATH_MAX_ENTRIES)
}

const PROPERTY_LIST_STRING_ENTRY = /<string>([\s\S]*?)<\/string>/g
const XML_ENTITY = /&(amp|lt|gt|quot|apos|#(\d+));/g

function decodeXmlEntities(value: string): string {
  return value.replace(XML_ENTITY, (match, name: string, codePoint?: string) => {
    if (codePoint) {
      const parsed = Number.parseInt(codePoint, 10)
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : match
    }
    switch (name) {
      case 'amp':
        return '&'
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'quot':
        return '"'
      case 'apos':
        return "'"
      default:
        return match
    }
  })
}

/**
 * Parse the `NSFilenamesPboardType` XML property list macOS writes alongside
 * `public.file-url`. Electron exposes only the first pasteboard item, so this
 * list is the sole way to see every file in a multi-file Finder copy.
 */
export function parseMacOsFilenamesPropertyList(payload: string): string[] {
  if (!payload.includes('<array>')) {
    return []
  }
  const paths: string[] = []
  for (const [, entry] of payload.matchAll(PROPERTY_LIST_STRING_ENTRY)) {
    const path = decodeXmlEntities(entry).trim()
    if (path && isRuntimePathAbsolute(path)) {
      paths.push(path)
    }
  }
  return paths.slice(0, CLIPBOARD_FILE_PATH_MAX_ENTRIES)
}

/**
 * True when the clipboard text could be the display names macOS/Explorer put
 * beside a copied file, so only those pastes pay for the file-path IPC probe.
 */
export function couldClipboardTextBeCopiedFileNames(text: string): boolean {
  if (text === '') {
    return true
  }
  const lines = text.split('\n')
  if (lines.length > CLIPBOARD_FILE_PATH_MAX_ENTRIES) {
    return false
  }
  return lines.every(
    (line) =>
      line.length > 0 &&
      line.length <= MAX_COPIED_FILE_NAME_LENGTH &&
      !/[\\/\t]/.test(line) &&
      line.trim() === line
  )
}

/**
 * True when the clipboard text is just the copied files' display names, so
 * replacing it with the full paths cannot discard real text a user copied.
 */
export function clipboardTextIsCopiedFileNames(text: string, paths: readonly string[]): boolean {
  if (text === '') {
    return true
  }
  const names = new Set(paths.map((path) => getRuntimePathBasename(path)))
  const lines = text.split('\n')
  return lines.length <= paths.length && lines.every((line) => names.has(line))
}
