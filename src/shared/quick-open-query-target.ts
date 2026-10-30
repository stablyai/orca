import { isWindowsAbsolutePathLike } from './cross-platform-path'
import { isQuickOpenQueryTooLarge } from './quick-open-path-search'

export type QuickOpenQueryTarget = { pathQuery: string; line?: number; column?: number }

export function parseQuickOpenQueryTarget(query: string): QuickOpenQueryTarget {
  if (isQuickOpenQueryTooLarge(query)) {
    return { pathQuery: query }
  }
  const trimmed = query.trim()
  const match = /^(.*?):([0-9]+)(?::([0-9]+))?$/.exec(trimmed)
  if (!match || !match[1] || /^[A-Za-z]$/.test(match[1]) || match[1].endsWith(':')) {
    return { pathQuery: trimmed }
  }
  const line = Number(match[2])
  const column = match[3] === undefined ? undefined : Number(match[3])
  if (
    !Number.isSafeInteger(line) ||
    line < 1 ||
    (column !== undefined && (!Number.isSafeInteger(column) || column < 1))
  ) {
    return { pathQuery: trimmed }
  }
  return { pathQuery: match[1], line, ...(column === undefined ? {} : { column }) }
}

export function isQuickOpenAbsolutePath(query: string): boolean {
  return (
    !isQuickOpenQueryTooLarge(query) &&
    !query.includes('\0') &&
    (query.startsWith('/') || isWindowsAbsolutePathLike(query))
  )
}
