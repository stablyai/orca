import type React from 'react'
import { useCallback, useRef, useState } from 'react'
import { joinPath, normalizeRelativePath } from '@/lib/path'
import { getConnectionId } from '@/lib/connection-context'
import type { DirCache, TreeNode } from './file-explorer-types'
import { splitPathSegments } from './path-tree'
import { shouldIncludeFileExplorerEntry } from './file-explorer-entries'
import { readRuntimeDirectory, statRuntimePath } from '@/runtime/runtime-file-client'
import { createFileExplorerDirLoadTracker } from './file-explorer-dir-load-tracker'
import { getRightSidebarWorktreeRuntimeSettings } from './file-explorer-runtime-owner'

type UseFileExplorerTreeResult = {
  dirCache: Record<string, DirCache>
  setDirCache: React.Dispatch<React.SetStateAction<Record<string, DirCache>>>
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
  activeWorktreeId?: string | null
): UseFileExplorerTreeResult {
  const [dirCache, setDirCache] = useState<Record<string, DirCache>>({})
  const [rootError, setRootError] = useState<string | null>(null)
  const dirCacheRef = useRef(dirCache)
  dirCacheRef.current = dirCache
  const dirLoadTrackerRef = useRef(createFileExplorerDirLoadTracker())

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
        const connectionId = getConnectionId(activeWorktreeId ?? null) ?? undefined
        const entries = await readRuntimeDirectory(
          {
            settings: getRightSidebarWorktreeRuntimeSettings(activeWorktreeId),
            worktreeId: activeWorktreeId,
            worktreePath,
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
        const children: TreeNode[] = entries
          .filter(shouldIncludeFileExplorerEntry)
          .map((entry) => ({
            name: entry.name,
            path: joinPath(dirPath, entry.name),
            relativePath: worktreePath
              ? normalizeRelativePath(joinPath(dirPath, entry.name).slice(worktreePath.length + 1))
              : entry.name,
            isDirectory: entry.isDirectory,
            isSymlink: entry.isSymlink,
            depth: depth + 1
          }))
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
      const connectionId = getConnectionId(activeWorktreeId ?? null) ?? undefined
      return statRuntimePath(
        {
          settings: getRightSidebarWorktreeRuntimeSettings(activeWorktreeId),
          worktreeId: activeWorktreeId,
          worktreePath,
          connectionId
        },
        path
      )
    },
    [activeWorktreeId, worktreePath]
  )

  const refreshTree = useCallback(async () => {
    if (!worktreePath) {
      return
    }
    // Why: clearing the entire dirCache here would momentarily empty the
    // visible projection and jump the virtualizer to the top. Instead we rely
    // on force-reload keeping existing children visible until fresh data lands.
    const refreshSession = dirLoadTrackerRef.current.getSession()
    const rootLoadCompleted = await loadDir(worktreePath, -1, { force: true })
    if (!rootLoadCompleted || !dirLoadTrackerRef.current.isSessionCurrent(refreshSession)) {
      return
    }
    await Promise.all(
      Array.from(expanded).map(async (dirPath) => {
        const depth = splitPathSegments(dirPath.slice(worktreePath.length + 1)).length - 1
        await loadDir(dirPath, depth, { force: true })
      })
    )
  }, [expanded, loadDir, worktreePath])

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

  const rootCache = worktreePath ? dirCache[worktreePath] : undefined

  const resetAndLoad = useCallback(() => {
    // Why: stale readDir responses from the previous worktree/reset session
    // must not repopulate the explorer after the tree has been cleared.
    dirLoadTrackerRef.current.reset()
    setDirCache({})
    setRootError(null)
    if (worktreePath) {
      void loadDir(worktreePath, -1, { force: true })
    }
  }, [worktreePath, loadDir])

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
