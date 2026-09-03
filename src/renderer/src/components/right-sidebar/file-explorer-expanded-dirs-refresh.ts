import type { Dispatch, SetStateAction } from 'react'
import type { DirCache } from './file-explorer-types'
import type { FileExplorerDirLoadTracker } from './file-explorer-dir-load-tracker'
import {
  fileExplorerEntriesToTreeNodes,
  type FileExplorerDirectoryListing
} from './file-explorer-directory-listing'
import { forEachWithConcurrency } from '../../../../shared/map-with-concurrency'
import {
  clearFileExplorerDirsLoading,
  markFileExplorerDirsLoading,
  withPendingFileExplorerDirCacheEntries,
  type FileExplorerLoadingDirsUpdater
} from './file-explorer-dir-load-state'

export type RefreshFileExplorerTreeDir = {
  dirPath: string
  depth: number
}

export type RefreshFileExplorerExpandedDirsParams = {
  dirs: RefreshFileExplorerTreeDir[]
  worktreePath: string
  dirLoadTracker: FileExplorerDirLoadTracker
  setDirCache: Dispatch<SetStateAction<Record<string, DirCache>>>
  updateLoadingDirPaths: FileExplorerLoadingDirsUpdater
  readDirectory: (dirPath: string) => Promise<FileExplorerDirectoryListing>
  maxConcurrentReads: number
  /** Called per dir whose fresh listing was committed, so callers can clear a staleness mark. */
  onDirCommitted?: (dirPath: string) => void
}

export async function refreshFileExplorerExpandedDirs({
  dirs,
  worktreePath,
  dirLoadTracker,
  setDirCache,
  updateLoadingDirPaths,
  readDirectory,
  maxConcurrentReads,
  onDirCommitted
}: RefreshFileExplorerExpandedDirsParams): Promise<boolean> {
  if (dirs.length === 0) {
    return true
  }

  const uniqueDirs = Array.from(new Map(dirs.map((dir) => [dir.dirPath, dir])).values())
  // Why: begin every token before the first read so a concurrent refreshDir or
  // worktree reset supersedes dirs still waiting for a concurrency slot.
  const loadTokens = new Map(
    uniqueDirs.map((dir) => [dir.dirPath, dirLoadTracker.begin(dir.dirPath)])
  )
  const commitBatchSize =
    maxConcurrentReads === Number.POSITIVE_INFINITY
      ? Math.max(1, uniqueDirs.length)
      : Number.isFinite(maxConcurrentReads)
        ? Math.max(1, Math.floor(maxConcurrentReads))
        : 1
  const pendingResults: { dirPath: string; cache: DirCache }[] = []
  let settledSinceCommit = 0
  let committedDirs = 0
  // Why: forEachWithConcurrency has no cancel hook, so a failed commit must stop the surviving
  // workers itself — otherwise a later batch commits after the caller already saw this reject.
  let stopped = false

  const uniqueDirPaths = uniqueDirs.map((dir) => dir.dirPath)
  // Why: mark every dir loading up front — FileExplorer's auto-load
  // effect re-runs on any `expanded` change and fans out an unbounded loadDir per
  // dir that is neither cached nor loading, which would defeat the concurrency cap.
  // Why this no longer touches dirCache for known dirs: the pre-mark used to rebuild the whole
  // visible tree once per refresh before a single fresh listing existed.
  setDirCache((prev) => withPendingFileExplorerDirCacheEntries(prev, uniqueDirPaths))
  updateLoadingDirPaths((prev) => markFileExplorerDirsLoading(prev, uniqueDirPaths))

  // Why: only dirs this refresh still owns — a superseding load owns the flag for the rest.
  const clearOwnedLoadingMarks = (dirPaths: readonly string[]): void => {
    const owned = dirPaths.filter((dirPath) => dirLoadTracker.isCurrent(loadTokens.get(dirPath)!))
    if (owned.length > 0) {
      updateLoadingDirPaths((prev) => clearFileExplorerDirsLoading(prev, owned))
    }
  }

  const commitPendingResults = (): void => {
    if (stopped) {
      return
    }
    settledSinceCommit = 0
    const currentResults = pendingResults
      .splice(0)
      .filter((result) => dirLoadTracker.isCurrent(loadTokens.get(result.dirPath)!))
    if (currentResults.length === 0) {
      return
    }

    setDirCache((prev) => {
      const next = { ...prev }
      for (const result of currentResults) {
        next[result.dirPath] = result.cache
      }
      return next
    })
    clearOwnedLoadingMarks(currentResults.map((result) => result.dirPath))
    committedDirs += currentResults.length
    // Why: the cache write above already landed for every result, so a throwing callback must not
    // strand the rest of the batch with a staleness mark no later commit will clear.
    let firstCommitError: unknown
    let commitFailed = false
    for (const result of currentResults) {
      try {
        onDirCommitted?.(result.dirPath)
      } catch (error) {
        if (!commitFailed) {
          commitFailed = true
          firstCommitError = error
        }
      }
    }
    if (commitFailed) {
      stopped = true
      throw firstCommitError
    }
  }

  const settleRead = (result?: { dirPath: string; cache: DirCache }): void => {
    if (result) {
      pendingResults.push(result)
    }
    settledSinceCommit++
    if (settledSinceCommit >= commitBatchSize) {
      commitPendingResults()
    }
  }

  try {
    await forEachWithConcurrency(uniqueDirs, maxConcurrentReads, async ({ dirPath, depth }) => {
      if (stopped) {
        return
      }
      const loadToken = loadTokens.get(dirPath)!
      // A superseding load owns this dir now; do not spend a round trip on a result we must drop.
      if (!dirLoadTracker.isCurrent(loadToken)) {
        settleRead()
        return
      }
      let cache: DirCache | undefined
      try {
        const listing = await readDirectory(dirPath)
        if (dirLoadTracker.isCurrent(loadToken)) {
          cache = {
            children: fileExplorerEntriesToTreeNodes(
              listing.entries,
              dirPath,
              depth,
              worktreePath,
              listing.operationOwner
            ),
            operationOwner: listing.operationOwner
          }
        }
      } catch {
        if (dirLoadTracker.isCurrent(loadToken)) {
          cache = { children: [] }
        }
      }
      settleRead(cache ? { dirPath, cache } : undefined)
    })
    if (settledSinceCommit > 0) {
      commitPendingResults()
    }
  } finally {
    // Why: no dir this refresh still owns may keep a spinner once the wave ends, including the
    // ones a failed commit or a superseded read left uncommitted.
    clearOwnedLoadingMarks(uniqueDirPaths)
  }

  return committedDirs === uniqueDirs.length
}
