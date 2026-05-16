import { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import type { TreeNode } from './file-explorer-types'
import { buildIgnoredSet, isPathIgnored } from './status-display'

export function useFileExplorerGitIgnoredRows(
  activeWorktreeId: string | null,
  flatRows: TreeNode[]
): {
  visibleFlatRows: TreeNode[]
  rowsByPath: Map<string, TreeNode>
  ignoredByRelativePath: Set<string>
  showGitIgnoredFiles: boolean
  toggleGitIgnoredFiles: () => void
} {
  const gitIgnoredPathsByWorktree = useAppStore((s) => s.gitIgnoredPathsByWorktree)
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const showGitIgnoredFiles = settings?.showGitIgnoredFiles ?? true

  const ignoredSet = useMemo(
    () =>
      buildIgnoredSet(activeWorktreeId ? (gitIgnoredPathsByWorktree[activeWorktreeId] ?? []) : []),
    [activeWorktreeId, gitIgnoredPathsByWorktree]
  )
  const visibleFlatRows = useMemo(
    () =>
      showGitIgnoredFiles
        ? flatRows
        : flatRows.filter((row) => !isPathIgnored(ignoredSet, row.relativePath)),
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
