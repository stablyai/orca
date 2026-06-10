import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { getConnectionId } from '@/lib/connection-context'
import { getRuntimeGitIgnoredPaths } from '@/runtime/runtime-git-client'
import { isDotfileRelativePath } from './file-explorer-entries'
import type { DirCache, TreeNode } from './file-explorer-types'
import {
  createFileExplorerRowProjectionFromParts,
  type FileExplorerRowProjection
} from './file-explorer-row-projection'
import { buildIgnoredSet, isPathIgnored } from './status-display'

const EMPTY_IGNORED_PATHS: readonly string[] = []
const EMPTY_RELATIVE_PATHS: string[] = []

export type IgnoredPathResult = {
  activeWorktreeId: string
  paths: string[]
  relativePaths: readonly string[]
  worktreePath: string
}

type VisibleFileExplorerRowProjectionOptions = {
  ignoredSet: Set<string>
  showDotfiles: boolean
  showGitIgnoredFiles: boolean
}

type VisibleFileExplorerRowProjectionInput = {
  dirCache: Record<string, DirCache>
  expanded: Set<string>
  worktreePath: string | null
}

export function getFileExplorerIgnoredQueryRelativePaths(
  input: VisibleFileExplorerRowProjectionInput,
  showDotfiles: boolean
): string[] {
  const { dirCache, expanded, worktreePath } = input
  if (!worktreePath) {
    return []
  }

  const relativePaths: string[] = []
  const visitChildren = (parentPath: string): void => {
    const cached = dirCache[parentPath]
    if (!cached?.children) {
      return
    }
    for (const row of cached.children) {
      if (!showDotfiles && isDotfileRelativePath(row.relativePath)) {
        continue
      }
      relativePaths.push(row.relativePath)
      if (row.isDirectory && expanded.has(row.path)) {
        visitChildren(row.path)
      }
    }
  }
  visitChildren(worktreePath)
  return relativePaths
}

export function createVisibleFileExplorerRowProjection(
  input: VisibleFileExplorerRowProjectionInput,
  options: VisibleFileExplorerRowProjectionOptions
): FileExplorerRowProjection {
  const { dirCache, expanded, worktreePath } = input
  const visibleFlatRows: TreeNode[] = []
  const rowsByPath = new Map<string, TreeNode>()
  if (!worktreePath) {
    return createFileExplorerRowProjectionFromParts(visibleFlatRows, rowsByPath)
  }

  const visitChildren = (parentPath: string): void => {
    const cached = dirCache[parentPath]
    if (!cached?.children) {
      return
    }
    for (const row of cached.children) {
      if (!options.showDotfiles && isDotfileRelativePath(row.relativePath)) {
        continue
      }
      if (!options.showGitIgnoredFiles && isPathIgnored(options.ignoredSet, row.relativePath)) {
        continue
      }
      visibleFlatRows.push(row)
      rowsByPath.set(row.path, row)
      if (row.isDirectory && expanded.has(row.path)) {
        visitChildren(row.path)
      }
    }
  }
  visitChildren(worktreePath)

  return createFileExplorerRowProjectionFromParts(visibleFlatRows, rowsByPath)
}

export function getEffectiveFileExplorerIgnoredPaths({
  activeWorktreeId,
  canLoadIgnoredPaths,
  ignoredPathResult,
  worktreePath
}: {
  activeWorktreeId: string | null
  canLoadIgnoredPaths: boolean
  ignoredPathResult: IgnoredPathResult | null
  worktreePath: string | null
}): readonly string[] {
  const ignoredPathResultMatchesCurrentWorktree =
    ignoredPathResult?.activeWorktreeId === activeWorktreeId &&
    ignoredPathResult.worktreePath === worktreePath

  if (!canLoadIgnoredPaths || !ignoredPathResultMatchesCurrentWorktree) {
    return EMPTY_IGNORED_PATHS
  }

  // Why: expanding folders changes the query before the async ignored refresh returns.
  // Keep same-worktree answers so known ignored rows do not flash as normal text.
  return ignoredPathResult.paths
}

export function useFileExplorerVisibleRowProjection(
  activeWorktreeId: string | null,
  worktreePath: string | null,
  dirCache: Record<string, DirCache>,
  expanded: Set<string>,
  activeRepoSupportsGit: boolean,
  showDotfiles: boolean
): {
  rowProjection: FileExplorerRowProjection
  ignoredByRelativePath: Set<string>
  showGitIgnoredFiles: boolean
  toggleGitIgnoredFiles: () => void
} {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const showGitIgnoredFiles = settings?.showGitIgnoredFiles ?? true
  const [ignoredPathResult, setIgnoredPathResult] = useState<IgnoredPathResult | null>(null)
  const relativePaths = useMemo(
    () =>
      activeRepoSupportsGit
        ? getFileExplorerIgnoredQueryRelativePaths(
            { dirCache, expanded, worktreePath },
            showDotfiles
          )
        : EMPTY_RELATIVE_PATHS,
    [activeRepoSupportsGit, dirCache, expanded, showDotfiles, worktreePath]
  )
  const canLoadIgnoredPaths =
    activeRepoSupportsGit &&
    Boolean(activeWorktreeId) &&
    Boolean(worktreePath) &&
    relativePaths.length > 0

  useEffect(() => {
    if (!canLoadIgnoredPaths || !activeWorktreeId || !worktreePath) {
      return
    }

    let canceled = false
    const connectionId = getConnectionId(activeWorktreeId) ?? undefined
    void getRuntimeGitIgnoredPaths(
      {
        settings: useAppStore.getState().settings,
        worktreeId: activeWorktreeId,
        worktreePath,
        connectionId
      },
      relativePaths
    )
      .then((nextIgnoredPaths) => {
        if (!canceled) {
          setIgnoredPathResult({
            activeWorktreeId,
            paths: nextIgnoredPaths,
            relativePaths,
            worktreePath
          })
        }
      })
      .catch(() => {
        if (!canceled) {
          setIgnoredPathResult({
            activeWorktreeId,
            paths: [],
            relativePaths,
            worktreePath
          })
        }
      })

    return () => {
      canceled = true
    }
  }, [activeWorktreeId, canLoadIgnoredPaths, relativePaths, worktreePath])

  const effectiveIgnoredPaths = getEffectiveFileExplorerIgnoredPaths({
    activeWorktreeId,
    canLoadIgnoredPaths,
    ignoredPathResult,
    worktreePath
  })
  const ignoredSet = useMemo(() => buildIgnoredSet(effectiveIgnoredPaths), [effectiveIgnoredPaths])
  const rowProjection = useMemo(
    () =>
      createVisibleFileExplorerRowProjection(
        { dirCache, expanded, worktreePath },
        {
          ignoredSet,
          showDotfiles,
          showGitIgnoredFiles
        }
      ),
    [dirCache, expanded, ignoredSet, showDotfiles, showGitIgnoredFiles, worktreePath]
  )
  const ignoredByRelativePath = useMemo(
    () => (showGitIgnoredFiles ? ignoredSet : new Set<string>()),
    [ignoredSet, showGitIgnoredFiles]
  )
  const toggleGitIgnoredFiles = useCallback(() => {
    void updateSettings({ showGitIgnoredFiles: !showGitIgnoredFiles })
  }, [showGitIgnoredFiles, updateSettings])

  return {
    rowProjection,
    ignoredByRelativePath,
    showGitIgnoredFiles,
    toggleGitIgnoredFiles
  }
}
