import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { useSourceControlAi } from '../ai/use-ai'
import { useSourceControlFileListing } from '../listing/use-file-listing'
import { useSourceControlReviewContext } from '../review/use-review-context'
import { useSourceControlPanelState } from './use-panel-state'

/** Keep data foundation separate from action hooks so flows cannot become dependencies of the state they mutate. */
export function useSourceControlPanelFoundation() {
  const panelState = useSourceControlPanelState()
  const updateSettingsOrThrow = useAppStore((s) => s.updateSettingsOrThrow)
  const reviewContext = useSourceControlReviewContext(panelState)
  const {
    activeConnectionId,
    activeGroupId,
    activeRemoteActionSequence,
    activeRepo,
    activeRepoTarget,
    activeSourceControlLaunchPlatform,
    activeWorktreeId,
    branchEntries,
    branchName,
    branchSummary,
    collapsedSections,
    collapsedTreeDirs,
    commitError,
    commitMessage,
    conflictOperation,
    entries,
    filterQuery,
    isBranchVisible,
    isFolder,
    isGitHistoryExpanded,
    isMac,
    openSettingsPage,
    openSettingsTarget,
    refreshActiveGitStatusAfterMutation,
    remoteActionError,
    repositoryHuge,
    rightSidebarTab,
    sourceControlGroupOrder,
    sourceControlRef,
    sourceControlViewMode,
    updateRepo,
    updateSettings,
    worktreeMap,
    worktreePath
  } = panelState

  const listing = useSourceControlFileListing({
    activeRemoteActionSequence,
    activeRepoTarget,
    activeWorktreeId,
    branchEntries,
    branchName,
    branchSummary,
    collapsedSections,
    collapsedTreeDirs,
    compareBaseRef: reviewContext.compareBaseRef,
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
  })
  const ai = useSourceControlAi({
    settings: panelState.settings,
    target: activeRepoTarget,
    activeRepo: activeRepo ?? null,
    activeWorktreeId,
    activeConnectionId,
    activeGroupId,
    activeSourceControlLaunchPlatform,
    conflictOperation,
    unresolvedConflicts: listing.unresolvedConflicts,
    stagedEntries: listing.grouped.staged,
    worktreePath,
    commitMessage,
    commitError,
    pushRecoveryPrompt: listing.pushRecovery?.prompt ?? null,
    updateSettings,
    updateSettingsOrThrow,
    updateRepo,
    openSettingsTarget,
    openSettingsPage
  })
  const {
    setCommitGenerationDialogOpen,
    setPullRequestGenerationDialogOpen,
    setResolveConflictsComposerOpen,
    sourceControlAiActionsVisible
  } = ai

  useEffect(() => {
    if (sourceControlAiActionsVisible) {
      return
    }
    setResolveConflictsComposerOpen(false)
    setCommitGenerationDialogOpen(false)
    setPullRequestGenerationDialogOpen(false)
  }, [
    setCommitGenerationDialogOpen,
    setPullRequestGenerationDialogOpen,
    setResolveConflictsComposerOpen,
    sourceControlAiActionsVisible
  ])

  return { ...panelState, ...reviewContext, ...listing, ...ai }
}

export type SourceControlPanelFoundation = ReturnType<typeof useSourceControlPanelFoundation>
