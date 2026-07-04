import type { Dispatch, SetStateAction } from 'react'
import { useCallback, useRef, useState } from 'react'
import { joinPath, normalizeRelativePath } from '@/lib/path'
import { getConnectionId } from '@/lib/connection-context'
import type { DirEntry } from '../../../../shared/types'
import type { DirCache, TreeNode } from './file-explorer-types'
import { splitPathSegments } from './path-tree'
import { shouldIncludeFileExplorerEntry } from './file-explorer-entries'
import { readRuntimeDirectory, statRuntimePath } from '@/runtime/runtime-file-client'
import {
  createFileExplorerDirLoadTracker,
  type FileExplorerDirLoadTracker
} from './file-explorer-dir-load-tracker'
import { getRightSidebarWorktreeRuntimeSettings } from './file-explorer-runtime-owner'

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

type RefreshFileExplorerTreeDir = {
  dirPath: string
  depth: number
}

type RefreshFileExplorerExpandedDirsParams = {
  dirs: RefreshFileExplorerTreeDir[]
  worktreePath: string
  dirLoadTracker: FileExplorerDirLoadTracker
  setDirCache: Dispatch<SetStateAction<Record<string, DirCache>>>
  readDirectory: (dirPath: string) => Promise<DirEntry[]>
}

function entriesToTreeNodes(
  entries: DirEntry[],
  dirPath: string,
  depth: number,
  worktreePath: string | null
): TreeNode[] {
  return entries.filter(shouldIncludeFileExplorerEntry).map((entry) => {
    const path = joinPath(dirPath, entry.name)
    return {
      name: entry.name,
      path,
      relativePath: worktreePath
        ? normalizeRelativePath(path.slice(worktreePath.length + 1))
        : entry.name,
      isDirectory: entry.isDirectory,
      isSymlink: entry.isSymlink,
      depth: depth + 1
    }
  })
}

export async function refreshFileExplorerExpandedDirs({
  dirs,
  worktreePath,
  dirLoadTracker,
  setDirCache,
  readDirectory
}: RefreshFileExplorerExpandedDirsParams): Promise<boolean> {
  if (dirs.length === 0) {
    return true
  }

  const uniqueDirs = Array.from(new Map(dirs.map((dir) => [dir.dirPath, dir])).values())
  const loadTokens = new Map(
    uniqueDirs.map((dir) => [dir.dirPath, dirLoadTracker.begin(dir.dirPath)])
  )

  // Why: expanded refresh can touch many directories; commit the loading and
  // result states in two batched setDirCache writes (rather than per-directory)
  // so refreshing large worktrees stays O(N) instead of O(N²) cache spreads.
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

  const results = await Promise.all(
    uniqueDirs.map(async ({ dirPath, depth }) => {
      const loadToken = loadTokens.get(dirPath)!
      try {
        const entries = await readDirectory(dirPath)
        if (!dirLoadTracker.isCurrent(loadToken)) {
          return { current: false as const }
        }
        return {
          current: true as const,
          dirPath,
          cache: {
            children: entriesToTreeNodes(entries, dirPath, depth, worktreePath),
            loading: false
          }
        }
      } catch {
        if (!dirLoadTracker.isCurrent(loadToken)) {
          return { current: false as const }
        }
        return {
          current: true as const,
          dirPath,
          cache: { children: [], loading: false }
        }
      }
    })
  )

  // Why: the batch commits only after the slowest read, so a dir can be
  // superseded (watcher refreshDir, worktree reset) after its own read
  // resolved. Re-check tokens at commit time so the batched write never
  // clobbers a newer load — preserving the old per-dir commit ordering.
  const currentResults = results.filter(
    (result): result is Extract<typeof result, { current: true }> =>
      result.current && dirLoadTracker.isCurrent(loadTokens.get(result.dirPath)!)
  )
  if (currentResults.length === 0) {
    return false
  }

  setDirCache((prev) => {
    const next = { ...prev }
    for (const result of currentResults) {
      next[result.dirPath] = result.cache
    }
    return next
  })

  return currentResults.length === uniqueDirs.length
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
        const children = entriesToTreeNodes(entries, dirPath, depth, worktreePath)
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
    // Why: root (worktreePath) was just force-loaded above; exclude it here so
    // refreshFileExplorerExpandedDirs doesn't queue a duplicate read of root.
    const expandedDirs = Array.from(expanded)
      .filter((dirPath) => dirPath !== worktreePath)
      .map((dirPath) => ({
        dirPath,
        depth: splitPathSegments(dirPath.slice(worktreePath.length + 1)).length - 1
      }))
    await refreshFileExplorerExpandedDirs({
      dirs: expandedDirs,
      worktreePath,
      dirLoadTracker: dirLoadTrackerRef.current,
      setDirCache,
      readDirectory: async (dirPath) => {
        const connectionId = getConnectionId(activeWorktreeId ?? null) ?? undefined
        return readRuntimeDirectory(
          {
            settings: getRightSidebarWorktreeRuntimeSettings(activeWorktreeId),
            worktreeId: activeWorktreeId,
            worktreePath,
            connectionId
          },
          dirPath
        )
      }
    })
  }, [activeWorktreeId, expanded, loadDir, worktreePath])

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
