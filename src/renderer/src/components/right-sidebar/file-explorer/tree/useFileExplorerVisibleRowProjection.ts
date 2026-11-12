import type { ExplorerRepositorySource } from './file-explorer-repository-observer'
import {
  partitionExplorerRepositoryDemand,
  type ExplorerRepositoryDemand
} from './file-explorer-repository-paths'
import type { RepositoryIgnoredPathSet } from '../../../../lib/source-control/paths/git-path-decoration'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store/index'
import { isDotfileRelativePath } from './file-explorer-entries'
import type { DirCache, TreeNode } from './file-explorer-types'
import {
  createFileExplorerRowProjectionFromParts,
  type FileExplorerRowProjection
} from './file-explorer-row-projection'
import {
  buildIgnoredSet,
  isPathIgnored
} from '../../../../lib/source-control/paths/git-path-decoration'
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
  displayRootPath?: string | null
}

/** Collects worktree-relative paths beneath the displayed root, respecting expanded folders and dotfile visibility. */
export function getFileExplorerIgnoredQueryRelativePaths(
  input: VisibleFileExplorerRowProjectionInput,
  showDotfiles: boolean
): string[] {
  const { dirCache, expanded, worktreePath, displayRootPath = worktreePath } = input
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
      if (!showDotfiles && isDotfileRelativePath(row.relativePath, worktreePath)) {
        continue
      }
      relativePaths.push(row.relativePath)
      if (row.isDirectory && expanded.has(row.path)) {
        visitChildren(row.path)
      }
    }
  }
  if (displayRootPath) {
    visitChildren(displayRootPath)
  }
  return relativePaths
}

/** Projects the displayed subtree without rebasing row paths, including when filename filtering synthesizes nodes. */
export function createVisibleFileExplorerRowProjection(
  input: VisibleFileExplorerRowProjectionInput,
  options: VisibleFileExplorerRowProjectionOptions
): FileExplorerRowProjection {
  const { dirCache, expanded, worktreePath, displayRootPath = worktreePath } = input
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
      worktreePath,
      displayRootPath: displayRootPath ?? worktreePath
    })
  }

  const shouldHideRow = (row: TreeNode): boolean => {
    if (!options.showDotfiles && isDotfileRelativePath(row.relativePath, worktreePath)) {
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
  if (displayRootPath) {
    visitChildren(displayRootPath)
  }

  return createFileExplorerRowProjectionFromParts(visibleFlatRows, rowsByPath)
}

function relativePathListsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false
    }
  }
  return true
}

/** Retain equal path-list identity across dirCache wave commits to avoid repeated uncancellable whole-tree ignore queries. */
function useContentStableRelativePaths(relativePaths: string[], enabled: boolean): string[] {
  // Why: filters need fresh identities per keystroke and must not evict the tree signature.
  const prevRef = useRef<string[] | null>(null)
  const prev = prevRef.current
  // Publish the returned stable identity; publishing input leaves a one-commit lag that recreates wave churn.
  const stable =
    enabled && prev && relativePathListsEqual(prev, relativePaths) ? prev : relativePaths
  // Publish after commit to keep render pure; new lists may lose stability, never freshness.
  useEffect(() => {
    prevRef.current = stable
  }, [stable])
  return stable
}

/** Combines scoped rows with host-aware ignore checks while retaining worktree-relative Git query paths. */
export function useFileExplorerVisibleRowProjection(
  activeWorktreeId: string | null,
  worktreePath: string | null,
  dirCache: Record<string, DirCache>,
  expanded: Set<string>,
  activeRepoSupportsGit: boolean,
  showDotfiles: boolean,
  nameFilter: FileExplorerNameFilterProjectionSource | null,
  nameFilterCollapsedPaths: ReadonlySet<string> | null = null,
  displayRootPath: string | null = worktreePath,
  repositories?: {
    sources: readonly ExplorerRepositorySource[]
    setDemand: (paths: readonly string[], partition?: ExplorerRepositoryDemand) => void
  }
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
  const hasRepositoryObserver = Boolean(repositories?.sources.length)
  const rebuiltRelativePaths = useMemo(
    () =>
      activeRepoSupportsGit || hasRepositoryObserver
        ? nameFilter
          ? getFileExplorerNameFilterIgnoredQueryRelativePaths(
              nameFilter,
              showDotfiles,
              worktreePath
            )
          : getFileExplorerIgnoredQueryRelativePaths(
              { dirCache, expanded, worktreePath, displayRootPath },
              showDotfiles
            )
        : EMPTY_RELATIVE_PATHS,
    [
      activeRepoSupportsGit,
      hasRepositoryObserver,
      dirCache,
      expanded,
      nameFilter,
      showDotfiles,
      worktreePath,
      displayRootPath
    ]
  )
  // Keep filter-keystroke identities fresh; only tree wave commits need content stability.
  const relativePaths = useContentStableRelativePaths(rebuiltRelativePaths, !nameFilter)
  const rootsKey = JSON.stringify(repositories?.sources.map((source) => source.path) ?? [])
  const partition = useMemo(
    () => partitionExplorerRepositoryDemand(new Set<string>(JSON.parse(rootsKey)), relativePaths),
    [relativePaths, rootsKey]
  )
  const rootRelativePaths = partition.rootPaths
  const setDemand = repositories?.setDemand
  useEffect(() => {
    if (worktreePath) {
      setDemand?.(relativePaths, partition)
    }
  }, [relativePaths, partition, setDemand, worktreePath])
  const canLoadIgnoredPaths =
    activeRepoSupportsGit &&
    Boolean(activeWorktreeId) &&
    Boolean(worktreePath) &&
    rootRelativePaths.length > 0
  const shouldDebounceIgnoredQuery = nameFilter !== null
  const effectiveIgnoredPaths = useFileExplorerIgnoredPaths({
    activeWorktreeId,
    canLoadIgnoredPaths,
    relativePaths: rootRelativePaths,
    shouldDebounceIgnoredQuery,
    worktreePath
  })
  const nextOwnIgnore = new Map(
    repositories?.sources.map((source) => [source.path, source.ignored])
  )
  const [ownIgnore, setOwnIgnore] = useState(nextOwnIgnore)
  if (
    nextOwnIgnore.size !== ownIgnore.size ||
    [...nextOwnIgnore].some(([path, ignored]) => ownIgnore.get(path) !== ignored)
  ) {
    setOwnIgnore(nextOwnIgnore)
  }
  const ignoredSet = useMemo(() => {
    const set: RepositoryIgnoredPathSet = buildIgnoredSet(effectiveIgnoredPaths, worktreePath)
    if (ownIgnore.size) {
      set.repositories = ownIgnore
    }
    return set
  }, [effectiveIgnoredPaths, worktreePath, ownIgnore])
  const rowProjection = useMemo(
    () =>
      createVisibleFileExplorerRowProjection(
        { dirCache, expanded, worktreePath, displayRootPath },
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
      worktreePath,
      displayRootPath
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
