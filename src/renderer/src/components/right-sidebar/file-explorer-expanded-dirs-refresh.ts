import type { Dispatch, SetStateAction } from 'react'
import type { DirCache } from './file-explorer-types'
import type { FileExplorerDirLoadTracker } from './file-explorer-dir-load-tracker'
import {
  fileExplorerEntriesToTreeNodes,
  type FileExplorerDirectoryListing
} from './file-explorer-directory-listing'
import { forEachWithConcurrency } from '../../../../shared/map-with-concurrency'

export type RefreshFileExplorerTreeDir = {
  dirPath: string
  depth: number
}

export type RefreshFileExplorerExpandedDirsParams = {
  dirs: RefreshFileExplorerTreeDir[]
  worktreePath: string
  dirLoadTracker: FileExplorerDirLoadTracker
  setDirCache: Dispatch<SetStateAction<Record<string, DirCache>>>
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

  // Why: mark every dir loading up front — FileExplorer's auto-load
  // effect re-runs on any `expanded` change and fans out an unbounded loadDir per
  // dir that is neither cached nor loading, which would defeat the concurrency cap.
  setDirCache((prev) => {
    const next = { ...prev }
    for (const { dirPath } of uniqueDirs) {
      next[dirPath] = {
        children: prev[dirPath]?.children ?? [],
        loading: true
      }
    }
    return next
  })

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
          loading: false,
          operationOwner: listing.operationOwner
        }
      }
    } catch {
      if (dirLoadTracker.isCurrent(loadToken)) {
        cache = { children: [], loading: false }
      }
    }
    settleRead(cache ? { dirPath, cache } : undefined)
  })
  if (settledSinceCommit > 0) {
    commitPendingResults()
  }

  return committedDirs === uniqueDirs.length
}
