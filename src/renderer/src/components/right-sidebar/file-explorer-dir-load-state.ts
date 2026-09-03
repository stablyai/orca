import type { DirCache } from './file-explorer-types'

/**
 * Directories with a directory read in flight.
 *
 * Why this is not a `dirCache` field: every `dirCache` identity change re-walks and re-flattens the
 * whole visible tree (the ignored-path query plus the row projection). A read that starts and a read
 * that lands would each pay for that, and the first one commits a byte-identical row set because the
 * spinner is the only thing that changed. Keeping the flag in a sibling set lets `dirCache` change
 * only when `children` do.
 */
export const EMPTY_FILE_EXPLORER_LOADING_DIRS: ReadonlySet<string> = new Set<string>()

/**
 * Applies one mark/clear to the loading set.
 *
 * Why not `Dispatch<SetStateAction<…>>`: the owner keeps the set in a ref as well as in state, and
 * the ref must be current the moment a mark is made — a refresh wave marks every expanded dir
 * before the render that would refresh a mirrored copy.
 */
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

/**
 * Adds an empty listing for dirs a read is about to populate for the first time.
 *
 * Why: a `dirCache` key is what tells the watcher reconciler that a path is a directory the
 * Explorer tracks. Without the placeholder, a create/delete arriving while the very first read of
 * that dir is still in flight resolves to no cached dir and is dropped, leaving the listing stale.
 * Returns `prev` unchanged once every dir is known, which is the common case.
 */
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
