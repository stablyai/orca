import { useCallback, useEffect, useMemo } from 'react'
import { deriveSourceControlPushRecovery } from '../sync/push-recovery'
import { isSourceControlSplitOpenModifier, type SourceControlRowOpenEvent } from './split-open'
import { useSourceControlSelection } from './use-selection'
import { useSourceControlSubmoduleStatus } from './use-submodule-status'
import type { SourceControlActionError } from '../sync/action-error'
import { useSourceControlBulkActions } from '../commit/use-bulk-actions'
import type { SourceControlPanelViewState } from '../panel/use-panel-view-state'
import { useSourceControlGitHistory } from '../sync/use-git-history'
import type { SourceControlStatusRefresh } from '../sync/use-status-refresh'
import { useSourceControlFileProjection } from './use-file-projection'
import { useSourceControlRowOpening } from './use-row-opening'
import type { SourceControlWorktreeContext } from './use-worktree-context'

/**
 * Projects git status and branch compare into the rows the panel renders, and layers the
 * interactions that operate on those rows: submodule expansion, diff opening, selection, bulk
 * staging and the git history feed.
 */
export function useSourceControlFileListing({
  activeRemoteActionSequence,
  activeRepoSettings,
  activeWorktreeId,
  branchEntries,
  branchName,
  branchSummary,
  collapsedSections,
  collapsedTreeDirs,
  compareBaseRef,
  entries,
  filterQuery,
  isBranchVisible,
  isFolder,
  isGitHistoryExpanded,
  isMac,
  refreshActiveGitStatusAfterMutation,
  remoteActionError,
  rightSidebarTab,
  sourceControlGroupOrder,
  sourceControlRef,
  sourceControlViewMode,
  worktreeMap,
  worktreePath
}: {
  activeRemoteActionSequence: number | null
  activeRepoSettings: SourceControlWorktreeContext['activeRepoSettings']
  activeWorktreeId: string | null
  branchEntries: SourceControlWorktreeContext['branchEntries']
  branchName: string
  branchSummary: SourceControlWorktreeContext['branchSummary']
  collapsedSections: Set<string>
  collapsedTreeDirs: Set<string>
  compareBaseRef: string | null
  entries: SourceControlWorktreeContext['entries']
  filterQuery: string
  isBranchVisible: boolean
  isFolder: boolean
  isGitHistoryExpanded: boolean
  isMac: boolean
  refreshActiveGitStatusAfterMutation: SourceControlStatusRefresh['refreshActiveGitStatusAfterMutation']
  remoteActionError: SourceControlActionError | null
  rightSidebarTab: SourceControlWorktreeContext['rightSidebarTab']
  sourceControlGroupOrder: SourceControlPanelViewState['sourceControlGroupOrder']
  sourceControlRef: SourceControlPanelViewState['sourceControlRef']
  sourceControlViewMode: SourceControlPanelViewState['sourceControlViewMode']
  worktreeMap: SourceControlWorktreeContext['worktreeMap']
  worktreePath: string | null
}) {
  const { expandedSubmoduleKeys, submoduleStatusByKey, toggleSubmodule } =
    useSourceControlSubmoduleStatus({
      activeWorktreeId,
      worktreePath,
      activeRepoSettings,
      entries
    })
  const {
    grouped,
    fileFilterState,
    normalizedFilter,
    isGitHistoryVisible,
    filteredGrouped,
    displaySections,
    unfilteredDisplaySectionsById,
    filteredBranchEntries,
    visibleTreeRowsBySection,
    visibleListRowsBySection,
    visibleBranchTreeRows,
    visibleSelectionEntries
  } = useSourceControlFileProjection({
    entries,
    branchEntries,
    filterQuery,
    sourceControlGroupOrder,
    activeWorktreeId,
    worktreePath,
    isFolder,
    collapsedTreeDirs,
    expandedSubmoduleKeys,
    submoduleStatusByKey,
    sourceControlViewMode,
    collapsedSections
  })
  const { gitHistoryState, refreshGitHistory, refreshGitHistoryRef } = useSourceControlGitHistory({
    activeRepoSettings,
    activeWorktreeId,
    worktreePath,
    compareBaseRef,
    isFolder,
    isBranchVisible,
    isGitHistoryExpanded,
    isGitHistoryVisible,
    worktreeMap
  })

  // Why: modifier-click keeps the current pane intact by opening the file in a fresh split to the right.
  const { resolveSplitTargetGroupId, activeOpenRowKeys, handleOpenDiff, openCommittedDiff } =
    useSourceControlRowOpening({
      isMac,
      activeWorktreeId,
      worktreePath,
      visibleSelectionEntries,
      branchSummary
    })

  const shouldOpenAsSplit = useCallback(
    (event: SourceControlRowOpenEvent) => isSourceControlSplitOpenModifier(event, isMac),
    [isMac]
  )
  const { selectedKeys, handleSelect, handleContextMenu, clearSelection } =
    useSourceControlSelection({
      flatEntries: visibleSelectionEntries,
      onOpenDiff: handleOpenDiff,
      shouldOpenAsSplit,
      containerRef: sourceControlRef
    })

  // clear selection on list/tree presentation change
  useEffect(() => {
    clearSelection()
  }, [sourceControlViewMode, clearSelection])

  // Clear selection on worktree or tab change
  useEffect(() => {
    clearSelection()
  }, [activeWorktreeId, rightSidebarTab, clearSelection])

  const flatEntriesByKey = useMemo(
    () => new Map(visibleSelectionEntries.map((entry) => [entry.key, entry])),
    [visibleSelectionEntries]
  )
  const {
    isExecutingBulk,
    setIsExecutingBulk,
    bulkStagePaths,
    bulkUnstagePaths,
    selectedKeySet,
    handleBulkStage,
    handleBulkUnstage,
    handleStageAllPaths,
    handleUnstagePaths,
    handleStageAllPrimary
  } = useSourceControlBulkActions({
    selectedKeys,
    flatEntriesByKey,
    activeRepoSettings,
    activeWorktreeId,
    worktreePath,
    grouped,
    clearSelection,
    refreshActiveGitStatusAfterMutation
  })
  const unresolvedConflicts = useMemo(
    () => entries.filter((entry) => entry.conflictStatus === 'unresolved' && entry.conflictKind),
    [entries]
  )
  const unresolvedConflictReviewEntries = useMemo(
    () =>
      unresolvedConflicts.map((entry) => ({
        path: entry.path,
        conflictKind: entry.conflictKind!
      })),
    [unresolvedConflicts]
  )
  const pushRecovery = useMemo(
    () =>
      deriveSourceControlPushRecovery({
        actionError: remoteActionError,
        currentBranchName: branchName || null,
        currentSequence: activeRemoteActionSequence
      }),
    [activeRemoteActionSequence, branchName, remoteActionError]
  )

  return {
    activeOpenRowKeys,
    bulkStagePaths,
    bulkUnstagePaths,
    clearSelection,
    displaySections,
    expandedSubmoduleKeys,
    fileFilterState,
    filteredBranchEntries,
    filteredGrouped,
    flatEntriesByKey,
    gitHistoryState,
    grouped,
    handleBulkStage,
    handleBulkUnstage,
    handleContextMenu,
    handleOpenDiff,
    handleSelect,
    handleStageAllPaths,
    handleStageAllPrimary,
    handleUnstagePaths,
    isExecutingBulk,
    isGitHistoryVisible,
    normalizedFilter,
    openCommittedDiff,
    pushRecovery,
    refreshGitHistory,
    refreshGitHistoryRef,
    resolveSplitTargetGroupId,
    selectedKeySet,
    selectedKeys,
    setIsExecutingBulk,
    submoduleStatusByKey,
    toggleSubmodule,
    unfilteredDisplaySectionsById,
    unresolvedConflictReviewEntries,
    unresolvedConflicts,
    visibleBranchTreeRows,
    visibleListRowsBySection,
    visibleSelectionEntries,
    visibleTreeRowsBySection
  }
}

export type SourceControlFileListing = ReturnType<typeof useSourceControlFileListing>
