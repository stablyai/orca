import { isRuntimePathAbsolute } from '../cross-platform-path'

/** Leading whitespace before an absolute or home path makes readers resolve it inside every repo (STA-14308). */
export function normalizeWorkspaceDirInput(value: string): string {
  const start = value.trimStart()
  // Trailing characters and relative values stay byte-exact: they can be part of a real folder name.
  return isRuntimePathAbsolute(start, 'windows') || isHomePrefixedPath(start) ? start : value
}

function isHomePrefixedPath(value: string): boolean {
  return value === '~' || value.startsWith('~/') || value.startsWith('~\\')
}
