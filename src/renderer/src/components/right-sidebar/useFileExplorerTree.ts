import type { Dispatch, SetStateAction } from 'react'
import { useCallback, useRef, useState } from 'react'
import type { DirCache, FileExplorerRoot } from './file-explorer-types'
import { readRuntimeDirectory, statRuntimePath } from '@/runtime/runtime-file-client'
import { createFileExplorerDirLoadTracker } from './file-explorer-dir-load-tracker'
import { getRightSidebarWorktreeRuntimeSettings } from './file-explorer-runtime-owner'
import { relativePathInsideRoot } from '../../../../shared/cross-platform-path'
import {
  createRootedFileExplorerChildren,
  createWorkspaceRootNode,
  findRootForPath,
  getDirectoryNodeDepth,
  resolveRootContext
} from './file-explorer-workspace-roots'
import {
  refreshFileExplorerExpandedDirs,
  type RefreshFileExplorerTreeDir
} from './file-explorer-expanded-refresh'

export const FILE_EXPLORER_MULTI_ROOT_CACHE_KEY = '__orca_file_explorer_multi_root__'

type UseFileExplorerTreeResult = {
  dirCache: Record<string, DirCache>
  setDirCache: Dispatch<SetStateAction<Record<string, DirCache>>>
  rootCache: DirCache | undefined
  rootError: string | null
  loadDir: (
    dirPath: string,
    depth: number,
    options?: { force?: boolean; failOnError?: boolean }
  ) => Promise<boolean>
  statPath: (path: string) => Promise<{ isDirectory: boolean }>
  markPathAsDirectory: (path: string) => void
  refreshTree: () => Promise<void>
  refreshDir: (dirPath: string) => Promise<void>
  resetAndLoad: () => void
}

export function useFileExplorerTree(
  worktreePath: string | null,
  expanded: Set<string>,
  activeWorktreeId?: string | null,
  roots: readonly FileExplorerRoot[] = []
): UseFileExplorerTreeResult {
  const [dirCache, setDirCache] = useState<Record<string, DirCache>>({})
  const [rootError, setRootError] = useState<string | null>(null)
  const dirCacheRef = useRef(dirCache)
  dirCacheRef.current = dirCache
  const rootsRef = useRef(roots)
  rootsRef.current = roots
  const dirLoadTrackerRef = useRef(createFileExplorerDirLoadTracker())
  const hasMultipleRoots = roots.length > 1
  const rootCacheKey = hasMultipleRoots ? FILE_EXPLORER_MULTI_ROOT_CACHE_KEY : worktreePath

  const loadDir = useCallback(
    async (
      dirPath: string,
      depth: number,
      options?: { force?: boolean; failOnError?: boolean }
    ) => {
      const cache = dirCacheRef.current
      if (!options?.force && (cache[dirPath]?.children.length > 0 || cache[dirPath]?.loading)) {
        return true
      }
      const loadToken = dirLoadTrackerRef.current.begin(dirPath)
      if (dirPath === FILE_EXPLORER_MULTI_ROOT_CACHE_KEY) {
        setDirCache((prev) => ({
          ...prev,
          [dirPath]: {
            children: rootsRef.current.map((root) => createWorkspaceRootNode(root)),
            loading: false
          }
        }))
        setRootError(null)
        return true
      }
      // Why: when force-reloading a directory (e.g. after a file is created,
      // duplicated, or deleted), keep the previous children visible while the
      // fresh listing loads. Clearing to [] would momentarily shrink the
      // visible projection and make the virtualizer jump to the top.
      setDirCache((prev) => ({
        ...prev,
        [dirPath]: {
          children: prev[dirPath]?.children ?? [],
          loading: true
        }
      }))
      try {
        const {
          root,
          worktreeId: rootWorktreeId,
          worktreePath: rootPath,
          connectionId
        } = resolveRootContext(rootsRef.current, dirPath, worktreePath, activeWorktreeId)
        const entries = await readRuntimeDirectory(
          {
            settings: getRightSidebarWorktreeRuntimeSettings(rootWorktreeId),
            worktreeId: rootWorktreeId,
            worktreePath: rootPath,
            connectionId
          },
          dirPath
        )
        if (!dirLoadTrackerRef.current.isCurrent(loadToken)) {
          return false
        }
        if (depth === -1) {
          setRootError(null)
        }
        const children = createRootedFileExplorerChildren(entries, dirPath, depth, root, rootPath)
        setDirCache((prev) => ({ ...prev, [dirPath]: { children, loading: false } }))
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
        }
        setDirCache((prev) => ({ ...prev, [dirPath]: { children: [], loading: false } }))
        return !options?.failOnError
      }
    },
    [activeWorktreeId, worktreePath]
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
      const {
        worktreeId: rootWorktreeId,
        worktreePath: rootPath,
        connectionId
      } = resolveRootContext(rootsRef.current, path, worktreePath, activeWorktreeId)
      return statRuntimePath(
        {
          settings: getRightSidebarWorktreeRuntimeSettings(rootWorktreeId),
          worktreeId: rootWorktreeId,
          worktreePath: rootPath,
          connectionId
        },
        path
      )
    },
    [activeWorktreeId, worktreePath]
  )

  const refreshTree = useCallback(async () => {
    if (!rootCacheKey) {
      return
    }
    // Why: clearing the entire dirCache here would momentarily empty the
    // visible projection and jump the virtualizer to the top. Instead we rely
    // on force-reload keeping existing children visible until fresh data lands.
    const refreshSession = dirLoadTrackerRef.current.getSession()
    const rootLoadCompleted = await loadDir(rootCacheKey, -1, { force: true })
    if (!rootLoadCompleted || !dirLoadTrackerRef.current.isSessionCurrent(refreshSession)) {
      return
    }
    const expandedDirs = Array.from(expanded)
      .map((dirPath): RefreshFileExplorerTreeDir | null => {
        const root = findRootForPath(rootsRef.current, dirPath, worktreePath, activeWorktreeId)
        const rootPath = root?.path ?? worktreePath
        if (!rootPath || dirPath === rootPath) {
          return null
        }
        const relativePath = relativePathInsideRoot(rootPath, dirPath) ?? ''
        return {
          dirPath,
          depth: getDirectoryNodeDepth(relativePath, rootsRef.current.length > 1)
        }
      })
      .filter((dir): dir is RefreshFileExplorerTreeDir => dir !== null)
    await refreshFileExplorerExpandedDirs({
      dirs: expandedDirs,
      worktreePath,
      dirLoadTracker: dirLoadTrackerRef.current,
      setDirCache,
      readDirectory: (dirPath) => {
        const {
          worktreeId: rootWorktreeId,
          worktreePath: rootPath,
          connectionId
        } = resolveRootContext(rootsRef.current, dirPath, worktreePath, activeWorktreeId)
        return readRuntimeDirectory(
          {
            settings: getRightSidebarWorktreeRuntimeSettings(rootWorktreeId),
            worktreeId: rootWorktreeId,
            worktreePath: rootPath,
            connectionId
          },
          dirPath
        )
      },
      createChildren: (entries, { dirPath, depth }) => {
        const root = findRootForPath(rootsRef.current, dirPath, worktreePath, activeWorktreeId)
        const rootPath = root?.path ?? worktreePath
        return createRootedFileExplorerChildren(entries, dirPath, depth, root, rootPath)
      }
    })
  }, [activeWorktreeId, expanded, loadDir, rootCacheKey, worktreePath])

  const refreshDir = useCallback(
    async (dirPath: string) => {
      const root = findRootForPath(rootsRef.current, dirPath, worktreePath, activeWorktreeId)
      const rootPath = root?.path ?? worktreePath
      if (!rootPath) {
        return
      }
      const depth =
        dirPath === rootPath
          ? rootsRef.current.length > 1
            ? 0
            : -1
          : getDirectoryNodeDepth(
              relativePathInsideRoot(rootPath, dirPath) ?? '',
              rootsRef.current.length > 1
            )
      await loadDir(dirPath, depth, { force: true })
    },
    [activeWorktreeId, worktreePath, loadDir]
  )

  const rootCache = rootCacheKey ? dirCache[rootCacheKey] : undefined

  const resetAndLoad = useCallback(() => {
    // Why: stale readDir responses from the previous worktree/reset session
    // must not repopulate the explorer after the tree has been cleared.
    dirLoadTrackerRef.current.reset()
    setDirCache({})
    setRootError(null)
    if (rootCacheKey) {
      void loadDir(rootCacheKey, -1, { force: true })
    }
  }, [rootCacheKey, loadDir])

  return {
    dirCache,
    setDirCache,
    rootCache,
    rootError,
    loadDir,
    statPath,
    markPathAsDirectory,
    refreshTree,
    refreshDir,
    resetAndLoad
  }
}
