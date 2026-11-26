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
import type { NameMatch, NameMatchResults } from './name-match-results'
import type { NameMatchRowActions } from './use-name-match-row-actions'

export type FileExplorerSearchControl = { clear: () => void }

/** Show all can list thousands of names; only the first screenful is checked against .gitignore. */
const IGNORE_CHECK_WINDOW = 50

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
  const [initial] = useState(() => getInitialSearchDraft(activeWorktreeId))
  const [query, setQuery] = useState(initial.text)
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
  // Bounded to the rows a user can reach soon, and stable across pauses that keep the same rows.
  const renderedNameKey =
    nameMatches?.matches
      .slice(0, IGNORE_CHECK_WINDOW)
      .map((match) => match.relativePath)
      .join('\0') ?? ''
  const renderedNamePaths = useMemo(
    () => (renderedNameKey ? renderedNameKey.split('\0') : []),
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
    onShowAllNames: showAllNameMatches,
    initial
  })
  const { clearQuery, inputRef } = search
  // The row menu keeps focus where it was (the tree relies on that), so hand it back to the field.
  const restoreFieldFocus = useCallback(() => {
    requestAnimationFrame(() => {
      if (document.activeElement === document.body || document.activeElement === null) {
        inputRef.current?.focus()
      }
    })
  }, [inputRef])
  useImperativeHandle(controlRef, () => ({ clear: clearQuery }), [clearQuery])
  useClearNameFilterForReveal({ activeWorktreeId, hasQuery, clearQuery })

  return (
    <>
      <CombinedSearchStrip
        inputRef={search.inputRef}
        field={search.field}
        filters={search.filters}
        scopeLabel={scopeLabel}
      />
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
              onMenuClosed={restoreFieldFocus}
            />
          </div>
        ) : null}
      </div>
    </>
  )
})
