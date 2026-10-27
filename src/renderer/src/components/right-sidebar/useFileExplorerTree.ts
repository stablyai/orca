import type { Dispatch, SetStateAction } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DirCache, FileExplorerTreeRefreshOutcome } from './file-explorer-types'
import { splitPathSegments } from './path-tree'
import { createFileExplorerDirLoadTracker } from './file-explorer-dir-load-tracker'
import {
  getFileExplorerOperationOwner,
  getFileExplorerOwnerUnresolvedMessage,
  getFileExplorerOperationRoute
} from './file-explorer-operation-owner'
import {
  fileExplorerEntriesToTreeNodes,
  keepOpenedDirectoryLinks,
  clearFailedOpenedDirectoryLink,
  readFileExplorerDirectory
} from './file-explorer-directory-listing'
import { refreshFileExplorerExpandedDirs } from './file-explorer-expanded-dirs-refresh'
import { collectStaleDirCachePaths } from './file-explorer-stale-dir-cache'
import { fileExplorerRefreshConcurrency } from './file-explorer-refresh-concurrency'
import { describeFileExplorerReadError } from './file-explorer-read-error'
import {
  clearFileExplorerDirsLoading,
  EMPTY_FILE_EXPLORER_LOADING_DIRS,
  markFileExplorerDirsLoading,
  withPendingFileExplorerDirCacheEntries
} from './file-explorer-dir-load-state'
import { statUserOpenedPath, type UserOpenedPathStat } from '@/lib/user-opened-local-path'

type UseFileExplorerTreeResult = {
  dirCache: Record<string, DirCache>
  setDirCache: Dispatch<SetStateAction<Record<string, DirCache>>>
  /** Workspace whose committed root listing owns the rendered cache. */
  sourceWorkspaceId: string | null
  /** Dirs with a read in flight — kept out of dirCache so the row projection does not rebuild. */
  loadingDirPaths: ReadonlySet<string>
  rootCache: DirCache | undefined
  rootError: string | null
  loadDir: (
    dirPath: string,
    depth: number,
    options?: { force?: boolean; failOnError?: boolean; wakeWslDistro?: boolean }
  ) => Promise<boolean>
  statPath: (path: string) => Promise<UserOpenedPathStat>
  markPathAsDirectory: (path: string) => void
  refreshTree: () => Promise<FileExplorerTreeRefreshOutcome>
  /** `wakeWslDistro` only for a user act: it may start a stopped WSL distro. */
  refreshDir: (dirPath: string, options?: { wakeWslDistro?: boolean }) => Promise<void>
  /** True while a dir's cached listing predates the last full refresh that skipped it. */
  isDirStale: (dirPath: string) => boolean
  resetAndLoad: (options?: { wakeWslDistro?: boolean }) => void
}

/** Owns worktree-addressed directory caches and load tokens; display scoping changes traversal rather than cache identity. */
export function useFileExplorerTree(
  worktreePath: string | null,
  expanded: Set<string>,
  activeWorktreeId?: string | null
): UseFileExplorerTreeResult {
  const [dirCache, setDirCache] = useState<Record<string, DirCache>>({})
  const [loadingDirPaths, setLoadingDirPaths] = useState<ReadonlySet<string>>(
    EMPTY_FILE_EXPLORER_LOADING_DIRS
  )
  const [rootError, setRootError] = useState<string | null>(null)
  const [sourceWorkspaceId, setSourceWorkspaceId] = useState<string | null>(null)
  const dirCacheRef = useRef(dirCache)
  dirCacheRef.current = dirCache
  // Keep this ref authoritative: render writes may be discarded, and state mirrors lag long enough to admit duplicate reads.
  const loadingDirPathsRef = useRef<ReadonlySet<string>>(EMPTY_FILE_EXPLORER_LOADING_DIRS)
  const updateLoadingDirPaths = useCallback(
    (update: (prev: ReadonlySet<string>) => ReadonlySet<string>) => {
      const next = update(loadingDirPathsRef.current)
      if (next === loadingDirPathsRef.current) {
        return
      }
      loadingDirPathsRef.current = next
      setLoadingDirPaths(next)
    },
    []
  )
  const dirLoadTrackerRef = useRef<ReturnType<typeof createFileExplorerDirLoadTracker>>(undefined!)
  dirLoadTrackerRef.current ??= createFileExplorerDirLoadTracker()
  // Expansion effects need marks from refreshes newer than their render; state would lag one render.
  const staleDirsRef = useRef(new Set<string>())
  const refreshGenerationRef = useRef(0)
  // Distinguish root failure from supersession because loadDir returns false for both.
  const rootReadFailedRef = useRef(false)

  useEffect(() => {
    const tracker = dirLoadTrackerRef.current
    const refreshGeneration = refreshGenerationRef
    return () => {
      // A replaced host must not keep launching the old tree's queued directory reads.
      refreshGeneration.current++
      tracker?.reset()
    }
  }, [])

  const loadDir = useCallback(
    async (
      dirPath: string,
      depth: number,
      options?: { force?: boolean; failOnError?: boolean; wakeWslDistro?: boolean }
    ) => {
      const cache = dirCacheRef.current
      if (
        !options?.force &&
        (cache[dirPath]?.children.length > 0 || loadingDirPathsRef.current.has(dirPath))
      ) {
        return true
      }
      const loadToken = dirLoadTrackerRef.current.begin(dirPath)
      // Reads started after stale marking can verify that listing.
      staleDirsRef.current.delete(dirPath)
      // Retain cached children while loading so projection shrinkage cannot jump the virtualizer.
      setDirCache((prev) => withPendingFileExplorerDirCacheEntries(prev, [dirPath]))
      updateLoadingDirPaths((prev) => markFileExplorerDirsLoading(prev, [dirPath]))
      try {
        const listing = await readFileExplorerDirectory(activeWorktreeId, worktreePath, dirPath, {
          wakeWslDistro: options?.wakeWslDistro
        })
        // Only the current read may clear loading; superseded reads must preserve their replacement’s spinner.
        if (!dirLoadTrackerRef.current.isCurrent(loadToken)) {
          return false
        }
        if (depth === -1) {
          setRootError(null)
          setSourceWorkspaceId(activeWorktreeId?.trim() || null)
        }
        const children = fileExplorerEntriesToTreeNodes(
          listing.entries,
          dirPath,
          depth,
          worktreePath,
          listing.operationOwner
        )
        setDirCache((prev) => ({
          ...prev,
          [dirPath]: {
            children: keepOpenedDirectoryLinks(prev[dirPath]?.children, children, prev),
            operationOwner: listing.operationOwner
          }
        }))
        updateLoadingDirPaths((prev) => clearFileExplorerDirsLoading(prev, [dirPath]))
        return true
      } catch (error) {
        if (!dirLoadTrackerRef.current.isCurrent(loadToken)) {
          return false
        }
        if (depth === -1) {
          // Preserve root errors so authorization/path failures cannot look like empty worktrees.
          setRootError(describeFileExplorerReadError(error))
          setSourceWorkspaceId(null)
          rootReadFailedRef.current = true
        }
        setDirCache((prev) =>
          clearFailedOpenedDirectoryLink(
            {
              ...prev,
              [dirPath]: {
                ...prev[dirPath],
                children: prev[dirPath]?.children ?? [],
                error: describeFileExplorerReadError(error)
              }
            },
            dirPath
          )
        )
        updateLoadingDirPaths((prev) => clearFileExplorerDirsLoading(prev, [dirPath]))
        return !options?.failOnError
      }
    },
    [activeWorktreeId, updateLoadingDirPaths, worktreePath]
  )

  const markPathAsDirectory = useCallback((path: string) => {
    setDirCache((prev) => {
      let changed = false
      const next: Record<string, DirCache> = {}
      for (const [dirPath, cache] of Object.entries(prev)) {
        let cacheChanged = false
        const children = cache.children.map((child) => {
          if (child.path !== path || child.isDirectory) {
            return child
          }
          changed = true
          cacheChanged = true
          return {
            ...child,
            isDirectory: true,
            isDirectoryFromOpenedLink: child.isSymlink === true
          }
        })
        next[dirPath] = cacheChanged ? { ...cache, children } : cache
      }
      return changed ? next : prev
    })
  }, [])

  const statPath = useCallback(
    async (path: string) => {
      const operationOwner = getFileExplorerOperationOwner(activeWorktreeId)
      const route = getFileExplorerOperationRoute(operationOwner)
      if (!route) {
        throw new Error(getFileExplorerOwnerUnresolvedMessage())
      }
      return statUserOpenedPath(
        {
          target: route.target,
          worktreeId: activeWorktreeId,
          worktreePath,
          connectionId: route.connectionId
        },
        path
      )
    },
    [activeWorktreeId, worktreePath]
  )

  const refreshTree = useCallback(async (): Promise<FileExplorerTreeRefreshOutcome> => {
    if (!worktreePath) {
      // No read means superseded; root-unreadable tells callers to drop pending refreshes.
      return 'superseded'
    }
    const refreshGeneration = ++refreshGenerationRef.current
    // Retain children to prevent virtualizer jumps; union stale marks before reading because supersession may skip verification, and prune uncached paths to bound marks.
    for (const dirPath of staleDirsRef.current) {
      if (dirCacheRef.current[dirPath] === undefined) {
        staleDirsRef.current.delete(dirPath)
      }
    }
    // Callers use the latest callback, so expanded reflects the current traversal.
    for (const dirPath of collectStaleDirCachePaths(dirCacheRef.current, worktreePath, expanded)) {
      staleDirsRef.current.add(dirPath)
    }
    const refreshSession = dirLoadTrackerRef.current.getSession()
    rootReadFailedRef.current = false
    // Propagate root failure before expanded waves; 200 dead dirs would otherwise impose about 50 sequential transport timeouts.
    const rootLoadCompleted = await loadDir(worktreePath, -1, { force: true, failOnError: true })
    if (!rootLoadCompleted || !dirLoadTrackerRef.current.isSessionCurrent(refreshSession)) {
      // Callers handle root failure and supersession differently; neither verified the expanded dirs.
      return rootReadFailedRef.current ? 'root-unreadable' : 'superseded'
    }
    // Exclude the root already force-loaded above to avoid reading it twice.
    const expandedDirs = Array.from(expanded)
      .filter((dirPath) => dirPath !== worktreePath)
      .map((dirPath) => ({
        dirPath,
        depth: splitPathSegments(dirPath.slice(worktreePath.length + 1)).length - 1
      }))
    const allDirsCommitted = await refreshFileExplorerExpandedDirs({
      dirs: expandedDirs,
      worktreePath,
      dirLoadTracker: dirLoadTrackerRef.current,
      setDirCache,
      updateLoadingDirPaths,
      readDirectory: (dirPath) =>
        readFileExplorerDirectory(activeWorktreeId, worktreePath, dirPath),
      maxConcurrentReads: fileExplorerRefreshConcurrency(
        getFileExplorerOperationOwner(activeWorktreeId)
      ),
      onDirCommitted: (dirPath) => {
        // An older expanded read must not clear a newer collapsed-directory stale mark.
        if (refreshGenerationRef.current === refreshGeneration) {
          staleDirsRef.current.delete(dirPath)
        }
      }
    })
    return allDirsCommitted ? 'refreshed' : 'superseded'
  }, [activeWorktreeId, expanded, loadDir, updateLoadingDirPaths, worktreePath])

  const refreshDir = useCallback(
    async (dirPath: string, options?: { wakeWslDistro?: boolean }) => {
      if (!worktreePath) {
        return
      }
      const depth =
        dirPath === worktreePath
          ? -1
          : splitPathSegments(dirPath.slice(worktreePath.length + 1)).length - 1
      await loadDir(dirPath, depth, { force: true, wakeWslDistro: options?.wakeWslDistro })
    },
    [worktreePath, loadDir]
  )

  const isDirStale = useCallback((dirPath: string) => staleDirsRef.current.has(dirPath), [])

  const rootCache = worktreePath ? dirCache[worktreePath] : undefined

  const resetAndLoad = useCallback(
    (options?: { wakeWslDistro?: boolean }) => {
      refreshGenerationRef.current++
      // Reset tokens so previous-worktree responses cannot repopulate the cleared tree.
      dirLoadTrackerRef.current.reset()
      staleDirsRef.current.clear()
      setDirCache({})
      setSourceWorkspaceId(null)
      updateLoadingDirPaths(() => EMPTY_FILE_EXPLORER_LOADING_DIRS)
      setRootError(null)
      if (worktreePath) {
        void loadDir(worktreePath, -1, { force: true, wakeWslDistro: options?.wakeWslDistro })
      }
    },
    [worktreePath, loadDir, updateLoadingDirPaths]
  )

  return {
    dirCache,
    setDirCache,
    sourceWorkspaceId,
    loadingDirPaths,
    rootCache,
    rootError,
    loadDir,
    statPath,
    markPathAsDirectory,
    refreshTree,
    refreshDir,
    isDirStale,
    resetAndLoad
  }
}
