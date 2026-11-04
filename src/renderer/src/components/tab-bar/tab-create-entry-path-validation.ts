import { translate } from '@/i18n/i18n'
import { normalizeAbsolutePath } from '../../../../shared/terminal-path-normalization'
import { isAbsolutePathLike } from '../editor/editor-panel-file-mode'

export type TabEntryLocalPlatform = 'posix' | 'windows'

export function isTabEntryAbsolutePathLike(query: string): boolean {
  return isAbsolutePathLike(query.trim())
}

function assertTabEntryPathHasNoControlCharacters(trimmed: string): void {
  if (Array.from(trimmed).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    throw new Error(
      translate(
        'auto.components.tab.bar.tabCreateEntryPath.filePathsCannotContainControlCharacters',
        'File paths cannot contain control characters.'
      )
    )
  }
}

export function validateNewTabEntryAbsolutePath(
  query: string,
  localPlatform?: TabEntryLocalPlatform
): string {
  const trimmed = query.trim()
  if (!trimmed) {
    throw new Error(
      translate(
        'auto.components.tab.bar.tabCreateEntryPath.enterAUrlOrFilePath',
        'Enter a URL or file path.'
      )
    )
  }
  assertTabEntryPathHasNoControlCharacters(trimmed)
  if (trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    throw new Error(
      translate(
        'auto.components.tab.bar.tabCreateEntryPath.homeRelativePathsAreNotSupported',
        'Home-relative paths are not supported here.'
      )
    )
  }
  if (/[\\/]$/.test(trimmed)) {
    throw new Error(
      translate(
        'auto.components.tab.bar.tabCreateEntryPath.enterAFilePathNotA',
        'Enter a file path, not a directory path.'
      )
    )
  }
  if (!isAbsolutePathLike(trimmed)) {
    throw new Error(
      translate(
        'auto.components.tab.bar.tabCreateEntryPath.enterAnAbsoluteFilePath',
        'Enter an absolute file path.'
      )
    )
  }
  const normalized = normalizeAbsolutePath(trimmed)
  if (!normalized) {
    throw new Error(
      translate(
        'auto.components.tab.bar.tabCreateEntryPath.enterAnAbsoluteFilePath',
        'Enter an absolute file path.'
      )
    )
  }
  const rootMatchesLocalPlatform =
    localPlatform === undefined ||
    (localPlatform === 'posix' && normalized.rootKind === 'posix') ||
    (localPlatform === 'windows' &&
      (normalized.rootKind === 'windows' || normalized.rootKind === 'unc'))
  if (!rootMatchesLocalPlatform) {
    throw new Error(
      translate(
        'auto.components.tab.bar.tabCreateEntryPath.enterAnAbsolutePathForThis',
        'Enter an absolute path for this computer.'
      )
    )
  }
  return normalized.normalized
}

export function validateNewTabEntryRelativePath(query: string): string {
  // Keep new-file paths workspace-relative; absolute/home/traversal/UNC syntax follows separate routes.
  const trimmed = query.trim()
  if (!trimmed) {
    throw new Error(
      translate(
        'auto.components.tab.bar.tabCreateEntryPath.enterAUrlOrFilePath',
        'Enter a URL or file path.'
      )
    )
  }
  assertTabEntryPathHasNoControlCharacters(trimmed)
  if (trimmed.startsWith('/')) {
    throw new Error(
      translate(
        'auto.components.tab.bar.tabCreateEntryPath.enterARelativeFilePath',
        'Enter a relative file path.'
      )
    )
  }
  if (/^[A-Za-z]:/.test(trimmed)) {
    throw new Error(
      translate(
        'auto.components.tab.bar.tabCreateEntryPath.windowsDrivePathsAreNotSupported',
        'Windows drive paths are not supported here.'
      )
    )
  }
  if (/^[\\/]{2}/.test(trimmed)) {
    throw new Error(
      translate(
        'auto.components.tab.bar.tabCreateEntryPath.uncPathsAreNotSupportedHere',
        'UNC paths are not supported here.'
      )
    )
  }
  if (trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    throw new Error(
      translate(
        'auto.components.tab.bar.tabCreateEntryPath.homeRelativePathsAreNotSupported',
        'Home-relative paths are not supported here.'
      )
    )
  }
  if (/[\\/]$/.test(trimmed)) {
    throw new Error(
      translate(
        'auto.components.tab.bar.tabCreateEntryPath.enterAFilePathNotA',
        'Enter a file path, not a directory path.'
      )
    )
  }
  if (trimmed.split(/[\\/]/).some((segment) => segment.length === 0)) {
    throw new Error(
      translate(
        'auto.components.tab.bar.tabCreateEntryPath.filePathsCannotContainEmptySegments',
        'File paths cannot contain empty segments.'
      )
    )
  }

  const normalized = trimmed.replace(/\\/g, '/')
  const segments = normalized.split('/')
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error(
      translate(
        'auto.components.tab.bar.tabCreateEntryPath.filePathsCannotContainDotSegments',
        'File paths cannot contain . or .. segments.'
      )
    )
  }
  if (segments.some((segment) => segment === '~')) {
    throw new Error(
      translate(
        'auto.components.tab.bar.tabCreateEntryPath.filePathsCannotContainTildeSegments',
        'File paths cannot contain ~ segments.'
      )
    )
  }
  return normalized
}
