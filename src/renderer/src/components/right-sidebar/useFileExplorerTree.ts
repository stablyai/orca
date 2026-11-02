import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  FileExplorerTreeRefreshOutcome as ReadOutcome,
  UseFileExplorerTreeResult,
  FileExplorerDirectoryReadOptions as ReadOptions
} from './file-explorer-types'
import { useFileExplorerRevealObservation } from './use-file-explorer-reveal-observation'
import { getDirectoryReadDepth, getDirectoriesToRead } from './file-explorer-paths'
import { useFileExplorerLoadMoreDir } from './use-file-explorer-load-more'
import { decideExpandedDirLoad } from './file-explorer-stale-dir-cache'
import { useFileExplorerDirectoryLoads } from './use-file-explorer-directory-loads'

/** Owns worktree-addressed directory caches and load tokens; display scoping changes traversal rather than cache identity. */
export function useFileExplorerTree(
  worktreePath: string | null,
  expanded: Set<string>,
  activeWorktreeId?: string | null,
  displayRootPath: string | null = worktreePath
): UseFileExplorerTreeResult {
  const [loadRevision, setLoadRevision] = useState(0)
  const {
    dirCache,
    setDirCache,
    rootError,
    setRootError,
    sourceWorkspaceId,
    setSourceWorkspaceId,
    dirCacheRef,
    visibleLoadingDirs,
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
  } = useFileExplorerDirectoryLoads(
    worktreePath,
    expanded,
    activeWorktreeId,
    displayRootPath,
    loadRevision
  )
  const automaticCanCommitRef = useRef<() => boolean>(() => true)
  const rootObservationRef = useRef<{ promise: Promise<ReadOutcome> } | null>(null)
  const retireView = useCallback(() => {
    try {
      dirLoadTrackerRef.current.reset()
    } finally {
      rootObservationRef.current = null
      setLoadRevision((revision) => revision + 1)
    }
  }, [dirLoadTrackerRef])
  const invalidateTree = useCallback(() => {
    retireView()
    executionRef.current = new AbortController()
    for (const path of staleDirsRef.current) {
      if (!dirCacheRef.current[path]) {
        staleDirsRef.current.delete(path)
      }
    }
    for (const path of Object.keys(dirCacheRef.current)) {
      staleDirsRef.current.add(path)
    }
    if (worktreePath) {
      staleDirsRef.current.add(worktreePath)
    }
  }, [dirCacheRef, executionRef, retireView, staleDirsRef, worktreePath])

  useEffect(() => {
    const tracker = dirLoadTrackerRef.current
    return () => {
      try {
        tracker.reset()
      } finally {
        rootObservationRef.current = null
      }
    }
  }, [dirLoadTrackerRef])

  const observeRoot = useCallback(
    (options?: ReadOptions, canCommit?: () => boolean, onSuccess?: () => void) => {
      if (rootObservationRef.current || loadingDirPathsRef.current.size > 0) {
        retireView()
      }
      const promise: Promise<ReadOutcome> = readDir(worktreePath!, -1, options, canCommit).then(
        (outcome) => {
          if (rootObservationRef.current?.promise === promise) {
            try {
              if (outcome === 'refreshed') {
                onSuccess?.()
              }
            } finally {
              rootObservationRef.current = null
              setLoadRevision((revision) => revision + 1)
            }
          } else {
            return 'superseded'
          }
          return outcome
        }
      )
      rootObservationRef.current = { promise }
      return promise
    },
    [loadingDirPathsRef, readDir, retireView, worktreePath]
  )

  const { observeDirForReveal, getRevealAuthority } = useFileExplorerRevealObservation({
    worktreePath,
    dirCacheRef,
    loadingDirPathsRef,
    staleDirsRef,
    executionRef,
    dirLoadTrackerRef,
    automaticCanCommitRef,
    rootObservationRef,
    observeRoot,
    readDir
  })

  const loadDir = useCallback(
    async (dirPath: string, depth: number, options?: ReadOptions) => {
      if (
        !options?.force &&
        (loadingDirPathsRef.current.has(dirPath) ||
          decideExpandedDirLoad(dirCacheRef.current[dirPath], staleDirsRef.current.has(dirPath)) ===
            'skip')
      ) {
        return true
      }
      const outcome = await (dirPath === worktreePath
        ? observeRoot(options)
        : readDir(dirPath, depth, options))
      return outcome === 'refreshed' || (outcome === 'root-unreadable' && !options?.failOnError)
    },
    [dirCacheRef, loadingDirPathsRef, observeRoot, readDir, staleDirsRef, worktreePath]
  )

  const refreshTree = useCallback(async (): Promise<ReadOutcome> => {
    if (!worktreePath) {
      return 'superseded'
    }
    invalidateTree()
    let children: Promise<boolean> = Promise.resolve(false)
    const canCommit = () => automaticCanCommitRef.current()
    if (!canCommit()) {
      return 'superseded'
    }
    const outcome = await observeRoot(undefined, canCommit, () => {
      children = refreshDirs(getDirectoriesToRead(expanded, worktreePath, needsRead), canCommit)
    })
    if (outcome !== 'refreshed') {
      return outcome
    }
    return (await children) ? 'refreshed' : 'superseded'
  }, [expanded, invalidateTree, needsRead, observeRoot, refreshDirs, worktreePath])

  const reconcileView = useCallback(
    (
      requiredDirs: Set<string>,
      canCommit: () => boolean,
      viewError: string | null,
      displayRootPath?: string | null
    ) => {
      automaticCanCommitRef.current = canCommit
      if (!worktreePath || !canCommit()) {
        return
      }
      settleFailedOpenedDirectoryLinks()
      if (rootObservationRef.current) {
        return
      }
      if (staleDirsRef.current.has(worktreePath)) {
        void observeRoot(undefined, canCommit)
        return
      }
      if (rootError !== null || loadingDirPathsRef.current.has(worktreePath)) {
        return
      }
      if (displayRootPath && displayRootPath !== worktreePath) {
        if (needsRead(displayRootPath)) {
          void refreshDirs([displayRootPath], canCommit)
          return
        }
        if (
          loadingDirPathsRef.current.has(displayRootPath) ||
          dirCacheRef.current[displayRootPath]?.error !== undefined
        ) {
          return
        }
      }
      if (viewError !== null) {
        return
      }
      const paths = getDirectoriesToRead(requiredDirs, worktreePath, needsRead)
      if (paths.length) {
        void refreshDirs(paths, canCommit)
      }
    },
    [
      dirCacheRef,
      loadingDirPathsRef,
      needsRead,
      observeRoot,
      refreshDirs,
      rootError,
      settleFailedOpenedDirectoryLinks,
      staleDirsRef,
      worktreePath
    ]
  )

  const requestDir = useCallback(
    (dirPath: string) => {
      if (
        worktreePath &&
        (needsRead(dirPath) ||
          loadingDirPathsRef.current.has(dirPath) ||
          dirCacheRef.current[dirPath]?.error !== undefined)
      ) {
        const depth = getDirectoryReadDepth(worktreePath, dirPath)
        // A genuine request may retry a failure or supersede unfinished passive work.
        void loadDir(dirPath, depth, { force: true, wakeWslDistro: true })
      }
    },
    [dirCacheRef, loadDir, loadingDirPathsRef, needsRead, worktreePath]
  )

  const refreshDir = useCallback(
    async (dirPath: string, options?: { wakeWslDistro?: boolean }) => {
      if (!worktreePath) {
        return
      }
      const depth = getDirectoryReadDepth(worktreePath, dirPath)
      const canCommit = options?.wakeWslDistro ? undefined : () => automaticCanCommitRef.current()
      staleDirsRef.current.add(dirPath)
      setLoadRevision((revision) => revision + 1)
      if (canCommit && !canCommit()) {
        return
      }
      await (dirPath === worktreePath
        ? observeRoot(options, canCommit)
        : readDir(dirPath, depth, options, canCommit))
    },
    [observeRoot, readDir, staleDirsRef, worktreePath]
  )

  const loadMoreDir = useFileExplorerLoadMoreDir({
    activeWorktreeId,
    worktreePath,
    dirCacheRef,
    loadingDirPathsRef,
    dirLoadTrackerRef,
    setDirCache,
    updateLoadingDirPaths
  })

  const isDirStale = useCallback(
    (dirPath: string) => staleDirsRef.current.has(dirPath),
    [staleDirsRef]
  )

  const resetAndLoad = useCallback(
    (options?: { wakeWslDistro?: boolean }) => {
      retireView()
      executionRef.current = new AbortController()
      staleDirsRef.current.clear()
      setDirCache({})
      setSourceWorkspaceId(null)
      setRootError(null)
      if (worktreePath) {
        void loadDir(worktreePath, -1, { force: true, wakeWslDistro: options?.wakeWslDistro })
      }
    },
    [
      executionRef,
      worktreePath,
      loadDir,
      retireView,
      setDirCache,
      setRootError,
      setSourceWorkspaceId,
      staleDirsRef
    ]
  )

  return {
    dirCache,
    setDirCache,
    sourceWorkspaceId,
    loadingDirPaths: visibleLoadingDirs,
    rootCache: worktreePath ? dirCache[worktreePath] : undefined,
    rootError,
    loadDir,
    observeDirForReveal,
    getRevealAuthority,
    statPath,
    markPathAsDirectory,
    refreshTree,
    refreshDir,
    loadMoreDir,
    isDirStale,
    invalidateTree,
    reconcileView,
    retireView,
    requestDir,
    loadRevision,
    resetAndLoad
  }
}
