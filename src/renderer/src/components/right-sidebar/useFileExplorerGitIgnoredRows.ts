import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { getConnectionId } from '@/lib/connection-context'
import { getRuntimeGitIgnoredPaths } from '@/runtime/runtime-git-client'
import type { TreeNode } from './file-explorer-types'
import { buildIgnoredSet, isPathIgnored } from './status-display'

export function getVisibleFileExplorerRows(
  flatRows: TreeNode[],
  ignoredSet: Set<string>,
  showGitIgnoredFiles: boolean
): TreeNode[] {
  return showGitIgnoredFiles
    ? flatRows
    : flatRows.filter((row) => !isPathIgnored(ignoredSet, row.relativePath))
}

export function useFileExplorerGitIgnoredRows(
  activeWorktreeId: string | null,
  worktreePath: string | null,
  flatRows: TreeNode[],
  activeRepoSupportsGit: boolean
): {
  visibleFlatRows: TreeNode[]
  rowsByPath: Map<string, TreeNode>
  ignoredByRelativePath: Set<string>
  showGitIgnoredFiles: boolean
  toggleGitIgnoredFiles: () => void
} {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const showGitIgnoredFiles = settings?.showGitIgnoredFiles ?? true
  const [ignoredPaths, setIgnoredPaths] = useState<string[]>([])
  const relativePaths = useMemo(() => flatRows.map((row) => row.relativePath), [flatRows])

  useEffect(() => {
    if (
      !activeRepoSupportsGit ||
      !activeWorktreeId ||
      !worktreePath ||
      relativePaths.length === 0
    ) {
      setIgnoredPaths([])
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
          setIgnoredPaths(nextIgnoredPaths)
        }
      })
      .catch(() => {
        if (!canceled) {
          setIgnoredPaths([])
        }
      })

    return () => {
      canceled = true
    }
  }, [activeRepoSupportsGit, activeWorktreeId, relativePaths, worktreePath])

  const ignoredSet = useMemo(() => buildIgnoredSet(ignoredPaths), [ignoredPaths])
  const visibleFlatRows = useMemo(
    () => getVisibleFileExplorerRows(flatRows, ignoredSet, showGitIgnoredFiles),
    [flatRows, ignoredSet, showGitIgnoredFiles]
  )
  const rowsByPath = useMemo(
    () => new Map(visibleFlatRows.map((row) => [row.path, row])),
    [visibleFlatRows]
  )
  const ignoredByRelativePath = useMemo(
    () => (showGitIgnoredFiles ? ignoredSet : new Set<string>()),
    [ignoredSet, showGitIgnoredFiles]
  )
  const toggleGitIgnoredFiles = useCallback(() => {
    void updateSettings({ showGitIgnoredFiles: !showGitIgnoredFiles })
  }, [showGitIgnoredFiles, updateSettings])

  return {
    visibleFlatRows,
    rowsByPath,
    ignoredByRelativePath,
    showGitIgnoredFiles,
    toggleGitIgnoredFiles
  }
}
