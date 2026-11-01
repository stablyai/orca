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

export function useSourceControlFileListing({
  activeRemoteActionSequence,
  activeRepoTarget,
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
  repositoryHuge,
  rightSidebarTab,
  sourceControlGroupOrder,
  sourceControlRef,
  sourceControlViewMode,
  worktreeMap,
  worktreePath
}: {
  activeRemoteActionSequence: number | null
  activeRepoTarget: SourceControlWorktreeContext['activeRepoTarget']
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
  repositoryHuge: SourceControlWorktreeContext['repositoryHuge']
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
      activeRepoTarget,
      entries
    })
  const {
    grouped,
    fileFilterState,
    normalizedFilter,
    isGitHistoryVisible,
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
    activeRepoTarget,
    activeWorktreeId,
    worktreePath,
    compareBaseRef,
    isFolder,
    isBranchVisible,
    isGitHistoryExpanded,
    isGitHistoryVisible,
    worktreeMap
  })

  const visibleBranchRowKeys = useMemo(() => {
    if (collapsedSections.has('branch')) {
      return []
    }
    return sourceControlViewMode === 'tree'
      ? visibleBranchTreeRows.filter((node) => node.type === 'file').map((node) => node.key)
      : filteredBranchEntries.map((entry) => `branch::${entry.path}`)
  }, [collapsedSections, sourceControlViewMode, visibleBranchTreeRows, filteredBranchEntries])

  // Modifier-click opens a right split to preserve the current pane.
  const { resolveSplitTargetGroupId, activeOpenRowKeys, handleOpenDiff, openCommittedDiff } =
    useSourceControlRowOpening({
      isMac,
      activeWorktreeId,
      worktreePath,
      visibleSelectionEntries,
      visibleBranchRowKeys,
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

  useEffect(() => {
    clearSelection()
  }, [sourceControlViewMode, clearSelection])

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
    handleStageSectionPaths,
    handleUnstagePaths,
    handleStageAllPrimary,
    handleStageWorktreeChanges
  } = useSourceControlBulkActions({
    selectedKeys,
    flatEntriesByKey,
    activeRepoTarget,
    activeWorktreeId,
    worktreePath,
    grouped,
    isStatusTruncated: repositoryHuge !== undefined,
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
    handleStageSectionPaths,
    handleStageWorktreeChanges,
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
