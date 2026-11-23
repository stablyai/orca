import type { DirCache } from './file-explorer-types'

/** Track loading outside dirCache so spinner changes do not rebuild the entire tree projection. */
export const EMPTY_FILE_EXPLORER_LOADING_DIRS: ReadonlySet<string> = new Set<string>()

/** Update the owner ref synchronously as well as state; refresh waves mark all expanded dirs before the next render. */
export type FileExplorerLoadingDirsUpdater = (
  update: (prev: ReadonlySet<string>) => ReadonlySet<string>
) => void

/** Returns `prev` unchanged when every path is already marked, so subscribers do not re-render. */
export function markFileExplorerDirsLoading(
  prev: ReadonlySet<string>,
  dirPaths: readonly string[]
): ReadonlySet<string> {
  if (dirPaths.every((dirPath) => prev.has(dirPath))) {
    return prev
  }
  const next = new Set(prev)
  for (const dirPath of dirPaths) {
    next.add(dirPath)
  }
  return next
}

/** Returns `prev` unchanged when no path was marked, so subscribers do not re-render. */
export function clearFileExplorerDirsLoading(
  prev: ReadonlySet<string>,
  dirPaths: readonly string[]
): ReadonlySet<string> {
  if (!dirPaths.some((dirPath) => prev.has(dirPath))) {
    return prev
  }
  const next = new Set(prev)
  for (const dirPath of dirPaths) {
    next.delete(dirPath)
  }
  return next.size === 0 ? EMPTY_FILE_EXPLORER_LOADING_DIRS : next
}

/** Register first-read placeholders so watcher changes during the read are recognized; preserve identity for known dirs. */
export function withPendingFileExplorerDirCacheEntries(
  prev: Record<string, DirCache>,
  dirPaths: readonly string[]
): Record<string, DirCache> {
  const missing = dirPaths.filter((dirPath) => prev[dirPath] === undefined)
  if (missing.length === 0) {
    return prev
  }
  const next = { ...prev }
  for (const dirPath of missing) {
    next[dirPath] = { children: [] }
  }
  return next
}
