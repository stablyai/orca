import type { Dispatch, SetStateAction } from 'react'
import type { DirCache } from './file-explorer-types'
import type { FileExplorerDirLoadTracker } from './file-explorer-dir-load-tracker'
import {
  fileExplorerEntriesToTreeNodes,
  keepOpenedDirectoryLinks,
  clearFailedOpenedDirectoryLink,
  type FileExplorerDirectoryListing
} from './file-explorer-directory-listing'
import { forEachWithConcurrency } from '../../../../shared/map-with-concurrency'
import { describeFileExplorerReadError } from './file-explorer-read-error'
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

/** Refreshes directories with bounded concurrency and load-token ownership, preserving cached children on read failure. */
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
  // Allocate all tokens before reading so newer loads/resets can supersede dirs still queued for a slot.
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
  // Concurrency workers lack cancellation; stop survivors after commit failure to prevent writes after rejection.
  let stopped = false

  const uniqueDirPaths = uniqueDirs.map((dir) => dir.dirPath)
  // Mark all dirs loading to prevent expansion effects bypassing the cap; preserve known cache identities to avoid redundant tree walks.
  setDirCache((prev) => withPendingFileExplorerDirCacheEntries(prev, uniqueDirPaths))
  updateLoadingDirPaths((prev) => markFileExplorerDirsLoading(prev, uniqueDirPaths))

  // Clear only owned marks; superseding loads own the rest.
  const clearOwnedLoadingMarks = (dirPaths: readonly string[]): void => {
    const owned = dirPaths.filter((dirPath) => dirLoadTracker.isCurrent(loadTokens.get(dirPath)!))
    if (owned.length > 0) {
      updateLoadingDirPaths((prev) => clearFileExplorerDirsLoading(prev, owned))
    }
  }

  /** Commits only still-owned reads so superseded refreshes cannot replace newer directory data. */
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
      let next = { ...prev }
      for (const result of currentResults) {
        next[result.dirPath] =
          result.cache.error !== undefined
            ? {
                ...prev[result.dirPath],
                children: prev[result.dirPath]?.children ?? [],
                error: result.cache.error
              }
            : {
                ...result.cache,
                children: keepOpenedDirectoryLinks(
                  prev[result.dirPath]?.children,
                  result.cache.children,
                  prev
                )
              }
      }
      // Clear links preserved by a parent before this wave discovered their target was gone.
      for (const result of currentResults) {
        if (result.cache.error !== undefined) {
          next = clearFailedOpenedDirectoryLink(next, result.dirPath)
        }
      }
      return next
    })
    clearOwnedLoadingMarks(currentResults.map((result) => result.dirPath))
    committedDirs += currentResults.length
    // Cache writes already landed; finish all staleness callbacks even if one throws.
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
      } catch (error) {
        if (dirLoadTracker.isCurrent(loadToken)) {
          cache = { children: [], error: describeFileExplorerReadError(error) }
        }
      }
      settleRead(cache ? { dirPath, cache } : undefined)
    })
    if (settledSinceCommit > 0) {
      commitPendingResults()
    }
  } finally {
    // Clear every remaining owned mark, including reads skipped after supersession or commit failure.
    clearOwnedLoadingMarks(uniqueDirPaths)
  }

  return committedDirs === uniqueDirs.length
}
