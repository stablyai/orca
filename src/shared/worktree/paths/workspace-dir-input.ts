import { isRuntimePathAbsolute } from '../../cross-platform-path'

/** Leading whitespace before an absolute or home path makes readers resolve it inside every repo (STA-14308). */
export function normalizeWorkspaceDirInput(value: string, isWindowsHost: boolean): string {
  const start = value.trimStart()
  // Trailing characters and relative values stay byte-exact: they can be part of a real folder name.
  return isRuntimePathAbsolute(start, isWindowsHost ? 'windows' : 'posix') ||
    isHomePrefixedPath(start, isWindowsHost)
    ? start
    : value
}

// Only the shapes main expands; ~\ is a home path on Windows alone.
function isHomePrefixedPath(value: string, isWindowsHost: boolean): boolean {
  return value === '~' || value.startsWith('~/') || (isWindowsHost && value.startsWith('~\\'))
}
