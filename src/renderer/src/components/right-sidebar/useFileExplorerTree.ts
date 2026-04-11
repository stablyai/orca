import type React from 'react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { joinPath, normalizeRelativePath } from '@/lib/path'
import type { DirCache, TreeNode } from './file-explorer-types'
import { splitPathSegments } from './path-tree'
import { shouldIncludeFileExplorerEntry } from './file-explorer-entries'

type UseFileExplorerTreeResult = {
  dirCache: Record<string, DirCache>
  setDirCache: React.Dispatch<React.SetStateAction<Record<string, DirCache>>>
  flatRows: TreeNode[]
  rowsByPath: Map<string, TreeNode>
  rootCache: DirCache | undefined
  rootError: string | null
  loadDir: (dirPath: string, depth: number, options?: { force?: boolean }) => Promise<void>
  refreshTree: () => Promise<void>
  refreshDir: (dirPath: string) => Promise<void>
  resetAndLoad: () => void
}

export function useFileExplorerTree(
  worktreePath: string | null,
  expanded: Set<string>
): UseFileExplorerTreeResult {
  const [dirCache, setDirCache] = useState<Record<string, DirCache>>({})
  const [rootError, setRootError] = useState<string | null>(null)
  const dirCacheRef = useRef(dirCache)
  dirCacheRef.current = dirCache

  const loadDir = useCallback(
    async (dirPath: string, depth: number, options?: { force?: boolean }) => {
      const cache = dirCacheRef.current
      if (!options?.force && (cache[dirPath]?.children.length > 0 || cache[dirPath]?.loading)) {
        return
      }
      // Why: when force-reloading a directory (e.g. after a file is created,
      // duplicated, or deleted), keep the previous children visible while the
      // fresh listing loads. Clearing to [] would momentarily shrink flatRows,
      // causing the virtualizer to lose scroll position and jump to the top.
      setDirCache((prev) => ({
        ...prev,
        [dirPath]: {
          children: prev[dirPath]?.children ?? [],
          loading: true
        }
      }))
      try {
        const entries = await window.api.fs.readDir({ dirPath })
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
            depth: depth + 1
          }))
        setDirCache((prev) => ({ ...prev, [dirPath]: { children, loading: false } }))
      } catch (error) {
        if (depth === -1) {
          // Why: the old implementation collapsed root read failures into an
          // empty tree, which made authorization/path bugs look like a real
          // empty worktree. Preserve the message so the UI can distinguish
          // "no files" from "could not read this worktree".
          setRootError(error instanceof Error ? error.message : String(error))
        }
        setDirCache((prev) => ({ ...prev, [dirPath]: { children: [], loading: false } }))
      }
    },
    [worktreePath]
  )

  const refreshTree = useCallback(async () => {
    if (!worktreePath) {
      return
    }
    // Why: clearing the entire dirCache here would momentarily empty flatRows,
    // causing the virtualizer scroll position to jump to the top. Instead we
    // rely on the force-reload inside loadDir which keeps existing children
    // visible until the fresh listing arrives.
    await loadDir(worktreePath, -1, { force: true })
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

  const flatRows = useMemo(() => {
    if (!worktreePath) {
      return []
    }
    const result: TreeNode[] = []
    const addChildren = (parentPath: string): void => {
      const cached = dirCache[parentPath]
      if (!cached?.children) {
        return
      }
      for (const child of cached.children) {
        result.push(child)
        if (child.isDirectory && expanded.has(child.path)) {
          addChildren(child.path)
        }
      }
    }
    addChildren(worktreePath)
    return result
  }, [worktreePath, dirCache, expanded])

  const rowsByPath = useMemo(() => new Map(flatRows.map((row) => [row.path, row])), [flatRows])
  const rootCache = worktreePath ? dirCache[worktreePath] : undefined

  const resetAndLoad = useCallback(() => {
    setDirCache({})
    setRootError(null)
    if (worktreePath) {
      void loadDir(worktreePath, -1, { force: true })
    }
  }, [worktreePath, loadDir])

  return {
    dirCache,
    setDirCache,
    flatRows,
    rowsByPath,
    rootCache,
    rootError,
    loadDir,
    refreshTree,
    refreshDir,
    resetAndLoad
  }
}
