import type { Dispatch, SetStateAction } from 'react'
import { useCallback, useRef, useState } from 'react'
import type { DirCache, FileExplorerTreeRefreshOutcome } from './file-explorer-types'
import { splitPathSegments } from './path-tree'
import { statRuntimePath } from '@/runtime/runtime-file-client'
import { createFileExplorerDirLoadTracker } from './file-explorer-dir-load-tracker'
import {
  getFileExplorerOperationOwner,
  getFileExplorerOwnerUnresolvedMessage,
  getFileExplorerOperationRoute
} from './file-explorer-operation-owner'
import {
  fileExplorerEntriesToTreeNodes,
  readFileExplorerDirectory
} from './file-explorer-directory-listing'
import { refreshFileExplorerExpandedDirs } from './file-explorer-expanded-dirs-refresh'
import { collectStaleDirCachePaths } from './file-explorer-stale-dir-cache'
import { fileExplorerRefreshConcurrency } from './file-explorer-refresh-concurrency'
import {
  clearFileExplorerDirsLoading,
  EMPTY_FILE_EXPLORER_LOADING_DIRS,
  markFileExplorerDirsLoading,
  withPendingFileExplorerDirCacheEntries
} from './file-explorer-dir-load-state'

type UseFileExplorerTreeResult = {
  dirCache: Record<string, DirCache>
  setDirCache: Dispatch<SetStateAction<Record<string, DirCache>>>
  /** Dirs with a read in flight — kept out of dirCache so the row projection does not rebuild. */
  loadingDirPaths: ReadonlySet<string>
  rootCache: DirCache | undefined
  rootError: string | null
  loadDir: (
    dirPath: string,
    depth: number,
    options?: { force?: boolean; failOnError?: boolean }
  ) => Promise<boolean>
  statPath: (path: string) => Promise<{ isDirectory: boolean }>
  markPathAsDirectory: (path: string) => void
  refreshTree: () => Promise<FileExplorerTreeRefreshOutcome>
  refreshDir: (dirPath: string) => Promise<void>
  /** True while a dir's cached listing predates the last full refresh that skipped it. */
  isDirStale: (dirPath: string) => boolean
  resetAndLoad: () => void
}

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
  const dirCacheRef = useRef(dirCache)
  dirCacheRef.current = dirCache
  // Why the ref is authoritative rather than a render mirror: writing it during render is unsafe
  // (React may discard that render), and a mirror would leave loadDir's in-flight guard reading a
  // set one commit stale — long enough for a second read of the same dir to slip through.
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
  // Why: a ref, not state — the expansion effect must read the mark set by a refresh that landed
  // after the effect's render, and a state write would only be visible one render too late.
  const staleDirsRef = useRef(new Set<string>())
  // Why: separates a failed root read from a superseded one — loadDir returns false for both.
  const rootReadFailedRef = useRef(false)

  const loadDir = useCallback(
    async (
      dirPath: string,
      depth: number,
      options?: { force?: boolean; failOnError?: boolean }
    ) => {
      const cache = dirCacheRef.current
      if (
        !options?.force &&
        (cache[dirPath]?.children.length > 0 || loadingDirPathsRef.current.has(dirPath))
      ) {
        return true
      }
      const loadToken = dirLoadTrackerRef.current.begin(dirPath)
      // Why: this read starts after the refresh that marked the dir, so its result is current.
      staleDirsRef.current.delete(dirPath)
      // Why: an already-cached dir keeps its children visible for the whole read — clearing to []
      // would momentarily shrink the visible projection and jump the virtualizer to the top.
      setDirCache((prev) => withPendingFileExplorerDirCacheEntries(prev, [dirPath]))
      updateLoadingDirPaths((prev) => markFileExplorerDirsLoading(prev, [dirPath]))
      try {
        const listing = await readFileExplorerDirectory(activeWorktreeId, worktreePath, dirPath)
        // Why: only the current owner may clear the flag — a superseded read clearing it would
        // drop the spinner while the load that replaced it is still in flight.
        if (!dirLoadTrackerRef.current.isCurrent(loadToken)) {
          return false
        }
        if (depth === -1) {
          setRootError(null)
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
          [dirPath]: { children, operationOwner: listing.operationOwner }
        }))
        updateLoadingDirPaths((prev) => clearFileExplorerDirsLoading(prev, [dirPath]))
        return true
      } catch (error) {
        if (!dirLoadTrackerRef.current.isCurrent(loadToken)) {
          return false
        }
        if (depth === -1) {
          // Why: the old implementation collapsed root read failures into an
          // empty tree, which made authorization/path bugs look like a real
          // empty worktree. Preserve the message so the UI can distinguish
          // "no files" from "could not read this worktree".
          setRootError(error instanceof Error ? error.message : String(error))
          rootReadFailedRef.current = true
        }
        setDirCache((prev) => ({ ...prev, [dirPath]: { children: [] } }))
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
          return { ...child, isDirectory: true }
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
      return statRuntimePath(
        {
          settings: route.settings,
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
      // Why: not 'root-unreadable' — no read was attempted, and that outcome tells callers to DROP
      // their pending refreshes. Report the refresh as not-done so they keep them instead.
      return 'superseded'
    }
    // Why: clearing the entire dirCache here would momentarily empty the
    // visible projection and jump the virtualizer to the top. Instead we rely
    // on force-reload keeping existing children visible until fresh data lands.
    // Why: mark before the first read, against the live expanded set — a dir expanded after this
    // point loads through the expansion effect, which would otherwise trust a listing this refresh
    // never re-read.
    // Why: union, not replace. This refresh can bail below without re-reading a single expanded
    // dir, so replacing would erase an earlier mark for a dir nothing has verified since. Marks are
    // cleared only where a read actually lands: loadDir, and onDirCommitted per committed wave.
    // Why: prune first — a mark only means anything while the dir still has a cached listing to
    // distrust, and unioning without this would accumulate every path visited in the session.
    for (const dirPath of staleDirsRef.current) {
      if (dirCacheRef.current[dirPath] === undefined) {
        staleDirsRef.current.delete(dirPath)
      }
    }
    // Why: callers use the latest refreshTree identity, so this closure has the live expanded set.
    for (const dirPath of collectStaleDirCachePaths(dirCacheRef.current, worktreePath, expanded)) {
      staleDirsRef.current.add(dirPath)
    }
    const refreshSession = dirLoadTrackerRef.current.getSession()
    rootReadFailedRef.current = false
    // Why: failOnError, else a dead transport reports a completed root read and we fan out one
    // doomed wave per 4 expanded dirs — 200 dirs is ~50 sequential 15s timeouts, and the watch
    // scheduler cannot start another refresh for that entire window.
    const rootLoadCompleted = await loadDir(worktreePath, -1, { force: true, failOnError: true })
    if (!rootLoadCompleted || !dirLoadTrackerRef.current.isSessionCurrent(refreshSession)) {
      // Why: the expanded dirs below were never re-read either way, but the two reasons want
      // opposite handling from callers — see FileExplorerTreeRefreshOutcome.
      return rootReadFailedRef.current ? 'root-unreadable' : 'superseded'
    }
    // Why: root (worktreePath) was just force-loaded above; exclude it here so
    // refreshFileExplorerExpandedDirs doesn't queue a duplicate read of root.
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
      onDirCommitted: (dirPath) => staleDirsRef.current.delete(dirPath)
    })
    return allDirsCommitted ? 'refreshed' : 'superseded'
  }, [activeWorktreeId, expanded, loadDir, updateLoadingDirPaths, worktreePath])

  const refreshDir = useCallback(
    async (dirPath: string) => {
      if (!worktreePath) {
        return
      }
      const depth =
        dirPath === worktreePath
          ? -1
          : splitPathSegments(dirPath.slice(worktreePath.length + 1)).length - 1
      await loadDir(dirPath, depth, { force: true })
    },
    [worktreePath, loadDir]
  )

  const isDirStale = useCallback((dirPath: string) => staleDirsRef.current.has(dirPath), [])

  const rootCache = worktreePath ? dirCache[worktreePath] : undefined

  const resetAndLoad = useCallback(() => {
    // Why: stale readDir responses from the previous worktree/reset session
    // must not repopulate the explorer after the tree has been cleared.
    dirLoadTrackerRef.current.reset()
    staleDirsRef.current.clear()
    setDirCache({})
    updateLoadingDirPaths(() => EMPTY_FILE_EXPLORER_LOADING_DIRS)
    setRootError(null)
    if (worktreePath) {
      void loadDir(worktreePath, -1, { force: true })
    }
  }, [worktreePath, loadDir, updateLoadingDirPaths])

  return {
    dirCache,
    setDirCache,
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
