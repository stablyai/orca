import React, { useCallback, useImperativeHandle, useMemo, useState } from 'react'
import { joinPath } from '@/lib/path'
import { useFileExplorerNameFilter } from '../panel/use-file-explorer-name-filter'
import { useClearNameFilterForReveal } from '../navigation/use-clear-name-filter-for-reveal'
import { useFileExplorerIgnoredPaths } from '../tree/use-file-explorer-ignored-paths'
import type { TreeNode } from '../tree/file-explorer-types'
import {
  buildIgnoredSet,
  isPathIgnored
} from '../../../../../../shared/git/status/git-path-decoration'
import { CombinedSearchStrip } from './CombinedSearchStrip'
import { CombinedSearchResults } from './CombinedSearchResults'
import { useCombinedSearch } from './useCombinedSearch'
import { getInitialSearchDraft } from './use-search-draft-lifecycle'
import {
  NAME_MATCH_PREVIEW_LIMIT,
  type NameMatch,
  type NameMatchResults
} from './name-match-results'
import type { NameMatchRowActions } from './use-name-match-row-actions'

export type FileExplorerSearchControl = { clear: () => void }

function toTreeNode(
  match: NameMatch,
  worktreePath: string,
  operationOwner: TreeNode['operationOwner']
): TreeNode {
  return {
    name: match.name,
    path: joinPath(worktreePath, match.relativePath),
    relativePath: match.relativePath,
    isDirectory: false,
    depth: match.relativePath.split('/').length - 1,
    operationOwner
  }
}

/** Owns the query so a keystroke re-renders only the search field and results, never the tree beneath. */
export const FileExplorerSearchPane = React.memo(function FileExplorerSearchPane({
  controlRef,
  activeWorktreeId,
  worktreePath,
  displayRootPath,
  showDotfiles,
  showGitIgnoredFiles,
  activeRepoSupportsGit,
  scopeLabel,
  rowActions,
  tree
}: {
  controlRef: React.Ref<FileExplorerSearchControl>
  activeWorktreeId: string | null
  worktreePath: string | null
  displayRootPath: string | null
  showDotfiles: boolean
  showGitIgnoredFiles: boolean
  activeRepoSupportsGit: boolean
  scopeLabel?: string
  rowActions: NameMatchRowActions
  tree: React.ReactNode
}): React.JSX.Element {
  const [query, setQuery] = useState(() => getInitialSearchDraft(activeWorktreeId))
  const hasQuery = query.trim().length > 0

  const { nameFilterFiles, nameMatches, showAllNameMatches } = useFileExplorerNameFilter({
    query,
    activeWorktreeId,
    worktreePath,
    displayRootPath,
    showDotfiles
  })
  const operationOwner = nameFilterFiles.operationOwner

  // Check-ignore runs over the rendered rows only, never the whole match set.
  // Bounded to the preview rows, and stable across pauses that keep the same rows.
  const renderedNameKey =
    nameMatches?.matches
      .slice(0, NAME_MATCH_PREVIEW_LIMIT)
      .map((match) => match.relativePath)
      .join('\n') ?? ''
  const renderedNamePaths = useMemo(
    () => (renderedNameKey ? renderedNameKey.split('\n') : []),
    [renderedNameKey]
  )
  const ignoredPaths = useFileExplorerIgnoredPaths({
    activeWorktreeId,
    canLoadIgnoredPaths: activeRepoSupportsGit && renderedNamePaths.length > 0,
    relativePaths: renderedNamePaths,
    shouldDebounceIgnoredQuery: true,
    worktreePath
  })
  const visibleNameMatches = useMemo((): (NameMatchResults & { truncated?: boolean }) | null => {
    if (!nameMatches) {
      return null
    }
    const ignoredSet = buildIgnoredSet(ignoredPaths, worktreePath)
    const matches = nameMatches.matches.map((match) =>
      isPathIgnored(ignoredSet, match.relativePath) ? { ...match, ignored: true } : match
    )
    // Why: legacy runtimes ignore includeIgnored, so hidden ignored files can still arrive here.
    const shown = showGitIgnoredFiles ? matches : matches.filter((match) => !match.ignored)
    return {
      total: nameMatches.total - (matches.length - shown.length),
      matches: shown,
      truncated: nameFilterFiles.truncated === true
    }
  }, [ignoredPaths, nameFilterFiles.truncated, nameMatches, showGitIgnoredFiles, worktreePath])

  const { open } = rowActions
  const handleOpenName = useCallback(
    (match: NameMatch, permanent: boolean) => {
      if (worktreePath) {
        open(toTreeNode(match, worktreePath, operationOwner), permanent)
      }
    },
    [open, operationOwner, worktreePath]
  )
  const toNode = useCallback(
    (match: NameMatch) => (worktreePath ? toTreeNode(match, worktreePath, operationOwner) : null),
    [operationOwner, worktreePath]
  )

  const search = useCombinedSearch({
    activeWorktreeId,
    worktreePath,
    query,
    setQuery,
    nameMatches: visibleNameMatches,
    namesLoading: nameFilterFiles.loading,
    namesError: nameFilterFiles.loadError,
    onOpenName: handleOpenName,
    onShowAllNames: showAllNameMatches
  })
  const { clearQuery } = search
  useImperativeHandle(controlRef, () => ({ clear: clearQuery }), [clearQuery])
  useClearNameFilterForReveal({ activeWorktreeId, hasQuery, clearQuery })

  return (
    <>
      <CombinedSearchStrip field={search.field} filters={search.filters} scopeLabel={scopeLabel} />
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {tree}
        {hasQuery ? (
          <div
            className="absolute inset-0 flex min-h-0 flex-col bg-sidebar"
            data-ignore-file-explorer-keys="true"
          >
            <CombinedSearchResults
              {...search.results}
              scopeLabel={scopeLabel}
              rowActions={rowActions}
              toNode={toNode}
              workspaceId={activeWorktreeId}
            />
          </div>
        ) : null}
      </div>
    </>
  )
})
