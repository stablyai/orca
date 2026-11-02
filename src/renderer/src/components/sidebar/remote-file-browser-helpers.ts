import { translate } from '@/i18n/i18n'
import { shouldHandleTextControlPaste } from '@/lib/text-control-paste'
import { isClipboardTextByteLengthOverLimit } from '../../../../shared/clipboard-text'
import type { FilesystemPathFlavor } from '../../../../shared/filesystem-entry-types'
import {
  driveRootOf,
  isDrivePath,
  joinDrivePath,
  parentOfDrivePath
} from './remote-file-browser-drive-paths'
export type DirEntry = {
  name: string
  isDirectory: boolean
}

export const REMOTE_FILE_BROWSER_FILTER_QUERY_MAX_BYTES = 2 * 1024

export function isRemoteFileBrowserFilterQueryTooLarge(
  query: string,
  maxBytes = REMOTE_FILE_BROWSER_FILTER_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

export function filterEntries(entries: DirEntry[], filter: string): DirEntry[] {
  if (isRemoteFileBrowserFilterQueryTooLarge(filter)) {
    return []
  }
  const trimmedFilter = filter.trim()
  if (!trimmedFilter) {
    return entries
  }
  const q = trimmedFilter.toLowerCase()
  return entries.filter((e) => e.name.toLowerCase().includes(q))
}

// Enter prefers a unique folder; otherwise a unique file shows a hint, and ambiguous matches do nothing.
export type EnterAction =
  | { type: 'navigate'; name: string }
  | { type: 'fileHint' }
  | { type: 'noop' }

export function decideEnterAction(filteredEntries: DirEntry[]): EnterAction {
  const folders = filteredEntries.filter((e) => e.isDirectory)
  if (folders.length === 1) {
    return { type: 'navigate', name: folders[0].name }
  }
  if (folders.length === 0 && filteredEntries.length > 0) {
    return { type: 'fileHint' }
  }
  return { type: 'noop' }
}

export type EscAction = { type: 'clearFilter' } | { type: 'cancel' }

export function decideEscAction(filter: string): EscAction {
  return filter.length > 0 ? { type: 'clearFilter' } : { type: 'cancel' }
}

export function joinPath(
  resolvedPath: string,
  name: string,
  pathFlavor: FilesystemPathFlavor = 'posix'
): string {
  // Drive rows in a Windows host-root listing are already absolute (`M:\`).
  if (pathFlavor === 'win32' && resolvedPath === '/' && isDrivePath(name)) {
    return driveRootOf(name)
  }
  if (pathFlavor === 'win32' && isDrivePath(resolvedPath)) {
    return joinDrivePath(resolvedPath, name)
  }
  return resolvedPath === '/' ? `/${name}` : `${resolvedPath}/${name}`
}

export function parentPath(p: string, pathFlavor: FilesystemPathFlavor = 'posix'): string {
  if (pathFlavor === 'win32' && isDrivePath(p)) {
    return parentOfDrivePath(p)
  }
  if (p === '/' || p === '') {
    return '/'
  }
  const parent = p.replace(/\/[^/]+\/?$/, '')
  return parent || '/'
}

export type ParsedInput =
  | { mode: 'filter'; filter: string }
  | {
      mode: 'path'
      // Resolve against the filesystem root, remote home, current directory, or Windows drive root.
      base: 'root' | 'home' | 'cwd' | 'drive'
      // Canonical `M:\` root; only set when `base` is 'drive'.
      driveRoot?: string
      // Committed segments exclude empty entries; repeated separators are invalid.
      committedSegments: string[]
      // Text after the final separator filters the preview listing.
      trailingFilter: string
      // Report repeated separators here; resolve-time errors can name the failing segment.
      invalid?: string
    }

export function isPathMode(raw: string, pathFlavor: FilesystemPathFlavor = 'posix'): boolean {
  if (raw.includes('/')) {
    return true
  }
  if (pathFlavor === 'win32' && isDrivePath(raw)) {
    return true
  }
  return raw === '~' || raw === '.' || raw === '..'
}

export function isRemoteFileBrowserPathResolveTextTooLarge(text: string): boolean {
  return shouldHandleTextControlPaste(text)
}

export function shouldDeferRemoteFileBrowserPasteResolve(text: string): boolean {
  return isRemoteFileBrowserPathResolveTextTooLarge(text)
}

export function parsePathInput(
  raw: string,
  pathFlavor: FilesystemPathFlavor = 'posix'
): ParsedInput {
  if (!isPathMode(raw, pathFlavor)) {
    // Keep the displayed input intact; filterEntries trims only for matching.
    return { mode: 'filter', filter: raw }
  }

  if (raw === '~') {
    return { mode: 'path', base: 'home', committedSegments: [], trailingFilter: '' }
  }
  if (raw === '.') {
    return { mode: 'path', base: 'cwd', committedSegments: [], trailingFilter: '' }
  }
  if (raw === '..') {
    return { mode: 'path', base: 'cwd', committedSegments: ['..'], trailingFilter: '' }
  }

  let base: 'root' | 'home' | 'cwd' | 'drive'
  let driveRoot: string | undefined
  let remainder: string
  if (pathFlavor === 'win32' && isDrivePath(raw)) {
    base = 'drive'
    driveRoot = driveRootOf(raw)
    remainder = raw.slice(2).replace(/^[\\/]/, '')
  } else if (raw.startsWith('/')) {
    base = 'root'
    remainder = raw.slice(1)
  } else if (raw.startsWith('~/')) {
    base = 'home'
    remainder = raw.slice(2)
  } else {
    base = 'cwd'
    remainder = raw
  }

  // Reject repeated separators so the resolved path agrees with the visible input.
  const hasRepeatedSeparators =
    base === 'drive' ? /[\\/]{2,}/.test(remainder) : remainder.includes('//')
  if (hasRepeatedSeparators) {
    return {
      mode: 'path',
      base,
      driveRoot,
      committedSegments: [],
      trailingFilter: '',
      invalid: translate(
        'auto.components.sidebar.RemoteFileBrowser.invalidPathRepeatedSeparators',
        'Invalid path: repeated separators'
      )
    }
  }

  // Reject controls before directory resolution: quoting alone cannot protect line-based listings or NUL boundaries.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F]/.test(remainder)) {
    return {
      mode: 'path',
      base,
      driveRoot,
      committedSegments: [],
      trailingFilter: '',
      invalid: translate(
        'auto.components.sidebar.RemoteFileBrowser.invalidPathControlCharacters',
        'Invalid path: control characters are not allowed'
      )
    }
  }

  // A trailing separator is the only legal empty segment and means no trailing filter.
  const parts =
    remainder === '' ? [''] : base === 'drive' ? remainder.split(/[\\/]/) : remainder.split('/')
  const trailingFilter = parts.at(-1) ?? ''
  const committedSegments = parts.slice(0, -1)

  return { mode: 'path', base, driveRoot, committedSegments, trailingFilter }
}

export type SegmentOutcome =
  | { type: 'stay' }
  | { type: 'descend'; name: string }
  | { type: 'error'; message: string }

export function resolveSegmentStep(
  segment: string,
  basePath: string,
  baseEntries: DirEntry[]
): SegmentOutcome {
  if (segment === '.') {
    return { type: 'stay' }
  }
  if (segment === '..') {
    return { type: 'stay' } // caller turns this into parent navigation
  }
  // On case-sensitive hosts, literal spelling wins when entries differ only by case.
  const exact = baseEntries.find((e) => e.name === segment)
  if (exact) {
    if (exact.isDirectory) {
      return { type: 'descend', name: exact.name }
    }
    // An exact file match must not fall through to a similarly named folder.
    return {
      type: 'error',
      message: translate(
        'auto.components.sidebar.remote.file.browser.helpers.4dbd72a7d7',
        "{{value0}} isn't a directory in {{value1}}",
        { value0: segment, value1: basePath }
      )
    }
  }
  // When literal matching fails, align path resolution with the case-insensitive filter.
  const segLower = segment.toLowerCase()
  const ciExact = baseEntries.find((e) => e.name.toLowerCase() === segLower)
  if (ciExact) {
    if (ciExact.isDirectory) {
      return { type: 'descend', name: ciExact.name }
    }
    return {
      type: 'error',
      message: translate(
        'auto.components.sidebar.remote.file.browser.helpers.4dbd72a7d7',
        "{{value0}} isn't a directory in {{value1}}",
        { value0: segment, value1: basePath }
      )
    }
  }
  const dirMatches = baseEntries.filter(
    (e) => e.isDirectory && e.name.toLowerCase().startsWith(segLower)
  )
  if (dirMatches.length === 1) {
    return { type: 'descend', name: dirMatches[0].name }
  }
  if (dirMatches.length > 1) {
    return {
      type: 'error',
      message: translate(
        'auto.components.sidebar.remote.file.browser.helpers.be266af66c',
        '{{value0}} matches multiple directories in {{value1}}',
        { value0: segment, value1: basePath }
      )
    }
  }
  return {
    type: 'error',
    message: translate(
      'auto.components.sidebar.remote.file.browser.helpers.4dbd72a7d7',
      "{{value0}} isn't a directory in {{value1}}",
      { value0: segment, value1: basePath }
    )
  }
}
