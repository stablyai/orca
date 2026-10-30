import { splitPathSegments } from './path-tree'
import { fileExplorerListingToDirCache } from './file-explorer-dir-pages'
import { refreshFileExplorerExpandedDirs } from './file-explorer-expanded-dirs-refresh'
import { fileExplorerRefreshConcurrency } from './file-explorer-refresh-concurrency'
import type { Dispatch, SetStateAction } from 'react'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  DirCache,
  FileExplorerDirectoryReadOptions as ReadOptions
} from './file-explorer-types'
import { createFileExplorerDirLoadTracker } from './file-explorer-dir-load-tracker'
import {
  getFileExplorerOperationOwner,
  getFileExplorerOwnerUnresolvedMessage,
  getFileExplorerOperationRoute
} from './file-explorer-operation-owner'
import {
  keepOpenedDirectoryLinks,
  canFollowFolderLink,
  clearFailedOpenedDirectoryLinks,
  readFileExplorerDirectory
} from './file-explorer-directory-listing'
import { describeFileExplorerReadError } from './file-explorer-read-error'
import {
  clearFileExplorerDirsLoading,
  EMPTY_FILE_EXPLORER_LOADING_DIRS,
  markFileExplorerDirsLoading,
  withPendingFileExplorerDirCacheEntries
} from './file-explorer-dir-load-state'
import { decideExpandedDirLoad } from './file-explorer-stale-dir-cache'
import { statUserOpenedPath } from '@/lib/user-opened-local-path'

const FOLLOW_LINK = { followProjectFolderLink: true } as const

export type ReadOutcome = 'refreshed' | 'root-unreadable' | 'superseded'

export function useFileExplorerDirectoryLoads(
  worktreePath: string | null,
  expanded: Set<string>,
  activeWorktreeId: string | null | undefined,
  displayRootPath: string | null,
  loadRevision: number
) {
  const [dirCache, storeDirCache] = useState<Record<string, DirCache>>({})
  const [loadingDirPaths, setLoadingDirPaths] = useState<ReadonlySet<string>>(
    EMPTY_FILE_EXPLORER_LOADING_DIRS
  )
  const [rootError, setRootError] = useState<string | null>(null)
  const [sourceWorkspaceId, setSourceWorkspaceId] = useState<string | null>(null)
  const dirCacheRef = useRef(dirCache)
  const setDirCache: Dispatch<SetStateAction<Record<string, DirCache>>> = useCallback((update) => {
    const next = typeof update === 'function' ? update(dirCacheRef.current) : update
    dirCacheRef.current = next
    storeDirCache(next)
  }, [])
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
  const executionRef = useRef(new AbortController())
  const [dirLoadTrackerRef] = useState(() => ({
    current: createFileExplorerDirLoadTracker(() => {
      const execution = executionRef.current
      try {
        updateLoadingDirPaths(() => EMPTY_FILE_EXPLORER_LOADING_DIRS)
      } finally {
        execution.abort()
      }
    })
  }))
  // Reconciliation needs invalidation marks before the next cache/loading render.
  const staleDirsRef = useRef(new Set<string>())
  const readDir = useCallback(
    async (
      dirPath: string,
      depth: number,
      options: ReadOptions = {},
      canCommit?: () => boolean
    ): Promise<ReadOutcome> => {
      if (executionRef.current.signal.aborted) {
        executionRef.current = new AbortController()
      }
      const signal = executionRef.current.signal
      const tracker = dirLoadTrackerRef.current
      const token = tracker.begin(dirPath, () => {
        updateLoadingDirPaths((prev) => clearFileExplorerDirsLoading(prev, [dirPath]))
      })
      token.started = true
      const cached = dirCacheRef.current[dirPath]
      const execution = (async (): Promise<ReadOutcome> => {
        try {
          setDirCache((prev) => withPendingFileExplorerDirCacheEntries(prev, [dirPath]))
          updateLoadingDirPaths((prev) => markFileExplorerDirsLoading(prev, [dirPath]))
          const listing = await readFileExplorerDirectory(activeWorktreeId, worktreePath, dirPath, {
            wakeWslDistro: options.wakeWslDistro,
            paged: cached?.paged,
            minEntries: cached?.children.length,
            ...(canFollowFolderLink(dirCacheRef.current, dirPath, options.wakeWslDistro)
              ? FOLLOW_LINK
              : {})
          })
          if (!tracker.isCurrent(token) || signal.aborted || (canCommit && !canCommit())) {
            return 'superseded'
          }
          if (depth === -1) {
            setRootError(null)
            setSourceWorkspaceId(activeWorktreeId?.trim() || null)
          }
          const listed = fileExplorerListingToDirCache(listing, dirPath, depth, worktreePath)
          setDirCache((prev) => ({
            ...prev,
            [dirPath]: {
              ...listed,
              children: keepOpenedDirectoryLinks(prev[dirPath]?.children, listed.children, prev)
            }
          }))
          staleDirsRef.current.delete(dirPath)
          return 'refreshed'
        } catch (error) {
          if (!tracker.isCurrent(token) || signal.aborted) {
            return 'superseded'
          }
          if (depth === -1) {
            setRootError(describeFileExplorerReadError(error))
            setSourceWorkspaceId(null)
          }
          setDirCache((prev) => {
            const next = {
              ...prev,
              [dirPath]: {
                ...prev[dirPath],
                children: prev[dirPath]?.children ?? [],
                error: describeFileExplorerReadError(error)
              }
            }
            return canCommit && !canCommit()
              ? next
              : clearFailedOpenedDirectoryLinks(next, [dirPath])
          })
          staleDirsRef.current.delete(dirPath)
          return 'root-unreadable'
        }
      })()
      void execution
        .then(
          (outcome) => tracker.finish(token, outcome),
          () => tracker.retire(token)
        )
        .catch(() => tracker.retire(token))
      return token.promise
    },
    [activeWorktreeId, dirLoadTrackerRef, setDirCache, updateLoadingDirPaths, worktreePath]
  )

  const markPathAsDirectory = useCallback(
    (path: string) => {
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
    },
    [setDirCache]
  )

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

  const needsRead = useCallback(
    (path: string) =>
      !loadingDirPathsRef.current.has(path) &&
      (dirCacheRef.current[path]?.error === undefined || staleDirsRef.current.has(path)) &&
      decideExpandedDirLoad(dirCacheRef.current[path], staleDirsRef.current.has(path)) !== 'skip',
    []
  )

  const settleFailedOpenedDirectoryLinks = useCallback(() => {
    const current = dirCacheRef.current
    const next = clearFailedOpenedDirectoryLinks(
      current,
      Object.keys(current).filter((path) => current[path].error !== undefined)
    )
    if (next !== current) {
      setDirCache(next)
    }
  }, [setDirCache])

  const refreshDirs = useCallback(
    (paths: string[], canCommit?: () => boolean) => {
      const signal = executionRef.current.signal
      return refreshFileExplorerExpandedDirs({
        dirs: paths.map((dirPath) => ({
          dirPath,
          depth: splitPathSegments(dirPath.slice((worktreePath?.length ?? 0) + 1)).length - 1
        })),
        worktreePath: worktreePath!,
        dirLoadTracker: dirLoadTrackerRef.current,
        setDirCache,
        updateLoadingDirPaths,
        readDirectory: (dirPath) =>
          readFileExplorerDirectory(activeWorktreeId, worktreePath, dirPath, {
            paged: dirCacheRef.current[dirPath]?.paged,
            minEntries: dirCacheRef.current[dirPath]?.children.length,
            ...(canFollowFolderLink(dirCacheRef.current, dirPath, false) ? FOLLOW_LINK : {})
          }),
        maxConcurrentReads: fileExplorerRefreshConcurrency(
          getFileExplorerOperationOwner(activeWorktreeId)
        ),
        signal,
        canCommit,
        onDirCommitted: (dirPath) => {
          if (!signal.aborted) {
            staleDirsRef.current.delete(dirPath)
          }
        }
      })
    },
    [activeWorktreeId, dirLoadTrackerRef, setDirCache, updateLoadingDirPaths, worktreePath]
  )

  const visibleLoadingRef = useRef(loadingDirPaths)
  const visibleLoadingDirs = useMemo(() => {
    // Root notifications invalidate the ref-backed freshness and execution inputs.
    void loadRevision
    if (
      rootError !== null ||
      (displayRootPath && dirCache[displayRootPath]?.error !== undefined) ||
      executionRef.current.signal.aborted
    ) {
      return loadingDirPaths
    }
    const pending = Array.from(expanded).filter(
      (path) =>
        dirCache[path]?.error === undefined &&
        !loadingDirPaths.has(path) &&
        decideExpandedDirLoad(dirCache[path], staleDirsRef.current.has(path)) !== 'skip'
    )
    const next = markFileExplorerDirsLoading(loadingDirPaths, pending)
    const previous = visibleLoadingRef.current
    if (next.size === previous.size && Array.from(next).every((path) => previous.has(path))) {
      return previous
    }
    return next
  }, [dirCache, displayRootPath, expanded, loadingDirPaths, loadRevision, rootError])
  useLayoutEffect(() => {
    visibleLoadingRef.current = visibleLoadingDirs
  }, [visibleLoadingDirs])
  return {
    visibleLoadingDirs,
    dirCache,
    setDirCache,
    rootError,
    setRootError,
    sourceWorkspaceId,
    setSourceWorkspaceId,
    dirCacheRef,
    loadingDirPaths,
    loadingDirPathsRef,
    updateLoadingDirPaths,
    dirLoadTrackerRef,
    staleDirsRef,
    executionRef,
    readDir,
    markPathAsDirectory,
    statPath,
    needsRead,
    settleFailedOpenedDirectoryLinks,
    refreshDirs
  }
}
