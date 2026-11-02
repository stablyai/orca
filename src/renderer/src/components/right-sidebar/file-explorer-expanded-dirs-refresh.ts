import type { Dispatch, SetStateAction } from 'react'
import type { DirCache } from './file-explorer-types'
import { fileExplorerListingToDirCache } from './file-explorer-dir-pages'
import type {
  FileExplorerDirLoadToken,
  FileExplorerDirLoadTracker
} from './file-explorer-dir-load-tracker'
import {
  keepOpenedDirectoryLinks,
  clearFailedOpenedDirectoryLinks,
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

export type RefreshFileExplorerTreeDir = { dirPath: string; depth: number }
export type RefreshFileExplorerExpandedDirsParams = {
  dirs: RefreshFileExplorerTreeDir[]
  worktreePath: string
  dirLoadTracker: FileExplorerDirLoadTracker
  setDirCache: Dispatch<SetStateAction<Record<string, DirCache>>>
  updateLoadingDirPaths: FileExplorerLoadingDirsUpdater
  readDirectory: (dirPath: string) => Promise<FileExplorerDirectoryListing>
  maxConcurrentReads: number
  signal?: AbortSignal
  canCommit?: () => boolean
  onDirCommitted?: (dirPath: string) => void
}

/** Bounded directory execution; each observation completes after its own publication and cleanup. */
export async function refreshFileExplorerExpandedDirs({
  dirs,
  worktreePath,
  dirLoadTracker,
  setDirCache,
  updateLoadingDirPaths,
  readDirectory,
  maxConcurrentReads,
  signal,
  canCommit,
  onDirCommitted
}: RefreshFileExplorerExpandedDirsParams): Promise<boolean> {
  if (signal?.aborted || dirs.length === 0) {
    return !signal?.aborted
  }
  const uniqueDirs = Array.from(new Map(dirs.map((dir) => [dir.dirPath, dir])).values())
  const pendingResults: { dirPath: string; cache: DirCache }[] = []
  const commitBatchSize =
    maxConcurrentReads === Number.POSITIVE_INFINITY
      ? Math.max(1, uniqueDirs.length)
      : Number.isFinite(maxConcurrentReads)
        ? Math.max(1, Math.floor(maxConcurrentReads))
        : 1
  let settledSinceCommit = 0
  let committedDirs = 0
  let stopped = false
  let commitFailure: { error: unknown } | undefined
  let retire!: () => void
  const retired = new Promise<void>((resolve) => {
    retire = resolve
  })
  const clearLoading = (paths: readonly string[]): void => {
    updateLoadingDirPaths((prev) => clearFileExplorerDirsLoading(prev, paths))
  }
  // Reserve synchronously; observer interest belongs to this execution, never to demand/freshness.
  const loadTokens = new Map(
    uniqueDirs.map(({ dirPath }) => [
      dirPath,
      dirLoadTracker.begin(
        dirPath,
        () => clearLoading([dirPath]),
        () => {
          if (pendingResults.some((result) => result.dirPath === dirPath)) {
            commitPendingResults()
          }
        }
      )
    ])
  )
  const retireTokens = (owned: FileExplorerDirLoadToken[]): void => {
    let failure: { error: unknown } | undefined
    try {
      clearLoading(owned.map((token) => token.dirPath))
    } catch (error) {
      failure = { error }
    }
    for (const token of owned) {
      try {
        dirLoadTracker.retire(token)
      } catch (error) {
        failure ??= { error }
      }
    }
    if (failure) {
      throw failure.error
    }
  }
  const finishRemaining = (): void =>
    retireTokens([...loadTokens.values()].filter(dirLoadTracker.isCurrent))
  const onAbort = (): void => {
    stopped = true
    try {
      finishRemaining()
    } catch (error) {
      commitFailure ??= { error }
    } finally {
      retire()
    }
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  function commitPendingResults(): void {
    if (stopped) {
      return
    }
    try {
      settledSinceCommit = 0
      const ready = pendingResults
        .splice(0)
        .filter((result) => dirLoadTracker.isCurrent(loadTokens.get(result.dirPath)!))
      const current: typeof ready = []
      const declined: FileExplorerDirLoadToken[] = []
      for (const result of ready) {
        if (result.cache.error !== undefined || !canCommit || canCommit()) {
          current.push(result)
        } else {
          declined.push(loadTokens.get(result.dirPath)!)
        }
      }
      if (declined.length) {
        retireTokens(declined)
      }
      if (current.length === 0) {
        return
      }
      setDirCache((prev) => {
        const next = { ...prev }
        for (const result of current) {
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
        return canCommit && !canCommit()
          ? next
          : clearFailedOpenedDirectoryLinks(
              next,
              current
                .filter((result) => result.cache.error !== undefined)
                .map((result) => result.dirPath)
            )
      })
      committedDirs += current.length
      // A callback failure must not leave another published directory's stale mark or waiter behind.
      let callbackFailure: { error: unknown } | undefined
      for (const result of current) {
        try {
          onDirCommitted?.(result.dirPath)
        } catch (error) {
          callbackFailure ??= { error }
        }
      }
      clearLoading(
        current
          .filter((result) => dirLoadTracker.isCurrent(loadTokens.get(result.dirPath)!))
          .map((result) => result.dirPath)
      )
      for (const result of current) {
        dirLoadTracker.finish(
          loadTokens.get(result.dirPath)!,
          callbackFailure
            ? 'superseded'
            : result.cache.error === undefined
              ? 'refreshed'
              : 'root-unreadable'
        )
      }
      if (callbackFailure) {
        throw callbackFailure.error
      }
    } catch (error) {
      commitFailure = { error }
      stopped = true
      try {
        finishRemaining()
      } catch (cleanupError) {
        commitFailure ??= { error: cleanupError }
      } finally {
        retire()
      }
    }
  }
  const settleRead = (result?: { dirPath: string; cache: DirCache }): void => {
    if (stopped) {
      return
    }
    if (result) {
      pendingResults.push(result)
    }
    settledSinceCommit++
    if (
      settledSinceCommit >= commitBatchSize ||
      (result && loadTokens.get(result.dirPath)!.observed)
    ) {
      commitPendingResults()
    }
  }
  try {
    const paths = uniqueDirs.map((dir) => dir.dirPath)
    setDirCache((prev) => withPendingFileExplorerDirCacheEntries(prev, paths))
    updateLoadingDirPaths((prev) => markFileExplorerDirsLoading(prev, paths))
    const execution = forEachWithConcurrency(
      uniqueDirs,
      maxConcurrentReads,
      async ({ dirPath, depth }) => {
        const token = loadTokens.get(dirPath)!
        if (stopped || signal?.aborted || !dirLoadTracker.isCurrent(token)) {
          dirLoadTracker.retire(token)
          settleRead()
          return
        }
        if (canCommit && !canCommit()) {
          retireTokens(
            [...loadTokens.values()].filter(
              (claim) => !claim.started && dirLoadTracker.isCurrent(claim)
            )
          )
          settleRead()
          return
        }
        token.started = true
        let cache: DirCache
        try {
          const listing = await readDirectory(dirPath)
          if (
            stopped ||
            signal?.aborted ||
            !dirLoadTracker.isCurrent(token) ||
            (canCommit && !canCommit())
          ) {
            dirLoadTracker.retire(token)
            settleRead()
            return
          }
          cache = fileExplorerListingToDirCache(listing, dirPath, depth, worktreePath)
        } catch (error) {
          cache = { children: [], error: describeFileExplorerReadError(error) }
        }
        if (stopped || !dirLoadTracker.isCurrent(token)) {
          settleRead()
          return
        }
        if (signal?.aborted || (cache.error === undefined && canCommit && !canCommit())) {
          dirLoadTracker.retire(token)
          settleRead()
          return
        }
        settleRead({ dirPath, cache })
      }
    )
    await Promise.race([execution, retired])
    if (settledSinceCommit > 0) {
      commitPendingResults()
    }
  } catch (error) {
    commitFailure ??= { error }
  } finally {
    stopped = true
    signal?.removeEventListener('abort', onAbort)
    try {
      finishRemaining()
    } catch (error) {
      commitFailure ??= { error }
    }
  }
  if (commitFailure) {
    throw commitFailure.error
  }
  return !signal?.aborted && committedDirs === uniqueDirs.length
}
