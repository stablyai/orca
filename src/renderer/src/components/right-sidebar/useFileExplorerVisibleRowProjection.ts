import { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import { isDotfileRelativePath } from './file-explorer-entries'
import type { DirCache, TreeNode } from './file-explorer-types'
import {
  createFileExplorerRowProjectionFromParts,
  type FileExplorerRowProjection
} from './file-explorer-row-projection'
import { buildIgnoredSet, isPathIgnored } from './status-display'
import {
  createNameFilteredFileExplorerProjection,
  getFileExplorerNameFilterExpandedPaths,
  getFileExplorerNameFilterIgnoredQueryRelativePaths,
  type FileExplorerNameFilterProjectionSource
} from './file-explorer-name-filter-projection'
import { useFileExplorerIgnoredPaths } from './use-file-explorer-ignored-paths'

const EMPTY_RELATIVE_PATHS: string[] = []

type VisibleFileExplorerRowProjectionOptions = {
  ignoredSet: Set<string>
  nameFilter?: FileExplorerNameFilterProjectionSource | null
  nameFilterCollapsedPaths?: ReadonlySet<string> | null
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
  if (options.nameFilter) {
    return createNameFilteredFileExplorerProjection({
      collapsedPaths: options.nameFilterCollapsedPaths ?? undefined,
      ignoredSet: options.ignoredSet,
      nameFilter: options.nameFilter,
      showDotfiles: options.showDotfiles,
      showGitIgnoredFiles: options.showGitIgnoredFiles,
      worktreePath
    })
  }

  const shouldHideRow = (row: TreeNode): boolean => {
    if (!options.showDotfiles && isDotfileRelativePath(row.relativePath)) {
      return true
    }
    return !options.showGitIgnoredFiles && isPathIgnored(options.ignoredSet, row.relativePath)
  }

  const visitChildren = (parentPath: string): void => {
    const cached = dirCache[parentPath]
    if (!cached?.children) {
      return
    }
    for (const row of cached.children) {
      if (shouldHideRow(row)) {
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

/**
 * Holds the array identity while its contents are unchanged.
 *
 * Why: a tree refresh commits dirCache once per read wave, and every commit
 * rebuilds this list. Each new identity would re-issue the uncancellable git
 * check-ignore over the whole visible tree — the remote round trips the wave cap
 * exists to bound.
 */
function useContentStableRelativePaths(relativePaths: string[], enabled: boolean): string[] {
  // Why: filters need fresh identities per keystroke and must not evict the tree signature.
  // Why: NUL cannot occur in paths, so the signature can reconstruct the list losslessly.
  const signature = useMemo(
    () => (enabled ? relativePaths.join('\u0000') : null),
    [enabled, relativePaths]
  )
  const stableTreePaths = useMemo(
    () => (signature ? signature.split('\u0000') : EMPTY_RELATIVE_PATHS),
    [signature]
  )
  return enabled ? stableTreePaths : relativePaths
}

export function useFileExplorerVisibleRowProjection(
  activeWorktreeId: string | null,
  worktreePath: string | null,
  dirCache: Record<string, DirCache>,
  expanded: Set<string>,
  activeRepoSupportsGit: boolean,
  showDotfiles: boolean,
  nameFilter: FileExplorerNameFilterProjectionSource | null,
  nameFilterCollapsedPaths: ReadonlySet<string> | null = null
): {
  rowProjection: FileExplorerRowProjection
  ignoredByRelativePath: Set<string>
  showGitIgnoredFiles: boolean
  nameFilterExpandedPaths: Set<string>
  toggleGitIgnoredFiles: () => void
} {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const showGitIgnoredFiles = settings?.showGitIgnoredFiles ?? true
  const rebuiltRelativePaths = useMemo(
    () =>
      activeRepoSupportsGit
        ? nameFilter
          ? getFileExplorerNameFilterIgnoredQueryRelativePaths(nameFilter, showDotfiles)
          : getFileExplorerIgnoredQueryRelativePaths(
              { dirCache, expanded, worktreePath },
              showDotfiles
            )
        : EMPTY_RELATIVE_PATHS,
    [activeRepoSupportsGit, dirCache, expanded, nameFilter, showDotfiles, worktreePath]
  )
  // Why: the name-filter list is debounced per keystroke, so it must keep a fresh
  // identity; only the dirCache-derived list needs stability across wave commits.
  const relativePaths = useContentStableRelativePaths(rebuiltRelativePaths, !nameFilter)
  const canLoadIgnoredPaths =
    activeRepoSupportsGit &&
    Boolean(activeWorktreeId) &&
    Boolean(worktreePath) &&
    relativePaths.length > 0
  const shouldDebounceIgnoredQuery = nameFilter !== null
  const effectiveIgnoredPaths = useFileExplorerIgnoredPaths({
    activeWorktreeId,
    canLoadIgnoredPaths,
    relativePaths,
    shouldDebounceIgnoredQuery,
    worktreePath
  })
  const ignoredSet = useMemo(() => buildIgnoredSet(effectiveIgnoredPaths), [effectiveIgnoredPaths])
  const rowProjection = useMemo(
    () =>
      createVisibleFileExplorerRowProjection(
        { dirCache, expanded, worktreePath },
        {
          ignoredSet,
          nameFilter,
          nameFilterCollapsedPaths,
          showDotfiles,
          showGitIgnoredFiles
        }
      ),
    [
      dirCache,
      expanded,
      ignoredSet,
      nameFilter,
      nameFilterCollapsedPaths,
      showDotfiles,
      showGitIgnoredFiles,
      worktreePath
    ]
  )
  const nameFilterExpandedPaths = useMemo(
    () => getFileExplorerNameFilterExpandedPaths(rowProjection, nameFilter?.query ?? ''),
    [nameFilter?.query, rowProjection]
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
    nameFilterExpandedPaths,
    toggleGitIgnoredFiles
  }
}
