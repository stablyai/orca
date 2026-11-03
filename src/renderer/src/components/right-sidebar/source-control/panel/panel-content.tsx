import { GitHistoryPanel } from '../sync/git-history-panel'
import { shouldShowSourceControlCompareUnavailableCard } from './header-toolbar'
import { shouldRenderCommitArea } from '../commit/component-gates'
import { SourceControlBranchSection } from '../listing/branch-section'
import { SourceControlContentStatus } from '../listing/content-status'
import { SourceControlUncommittedSections } from '../listing/uncommitted-sections'
import { CompareUnavailable } from '../sync/compare-summary'
import { SourceControlCommitSurface } from './commit-surface'
import { SourceControlForkPushNotice } from './fork-push-notice'
import type { SourceControlPanelReadyProps } from './panel-props'

export function SourceControlPanelContent(props: SourceControlPanelReadyProps) {
  const { activeWorktree, currentWorktreeId, model, worktreePath } = props
  const {
    activeConnectionId,
    activeOpenRowKeys,
    branchEntries,
    branchSummary,
    collapsedSections,
    collapsedTreeDirs,
    conflictOperation,
    diffCommentCountByPath,
    displaySections,
    expandedSubmoduleKeys,
    fileFilterState,
    fileListScrollElement,
    filterQuery,
    filteredBranchEntries,
    gitHistoryState,
    handleAbortOperationForConflict,
    handleCommitAction,
    handleCompleteMerge,
    handleContextMenu,
    handleOpenDiff,
    handleResolveConflictsWithAI,
    handleSelect,
    handleResolveConflict,
    handleStage,
    handleStageAllPaths,
    handleStageSectionPaths,
    handleStageWorktreeChanges,
    handleUnstage,
    handleUnstagePaths,
    hasUncommittedEntries,
    isResolvingConflictsWithAI,
    isAbortingOperation,
    isCheckingRecoveryAdmission,
    isCommitting,
    isExecutingBulk,
    isGitHistoryVisible,
    loadCommitFiles,
    normalizedFilter,
    openAllDiffs,
    openBranchAllDiffs,
    openCommitFile,
    openCommittedDiff,
    openConflictReview,
    openHistoryCommitDiff,
    refreshActiveGitStatus,
    refreshBranchCompare,
    refreshGitHistory,
    repositoryHuge,
    requestDiscardAllInArea,
    requestDiscardEntry,
    requestDiscardPaths,
    revealInExplorer,
    selectedKeySet,
    setBaseRefDialogOpen,
    sourceControlAiActionsVisible,
    sourceControlViewMode,
    statusReadError,
    toggleSection,
    toggleSubmodule,
    toggleTreeDir,
    unresolvedConflictReviewEntries,
    unresolvedConflicts,
    unfilteredDisplaySectionsById,
    visibleBranchTreeRows,
    visibleListRowsBySection,
    visibleTreeRowsBySection
  } = model

  const hasFilteredUncommittedEntries = displaySections.length > 0
  const hasFilteredBranchEntries = filteredBranchEntries.length > 0
  const showGenericEmptyState =
    statusReadError === undefined &&
    !hasUncommittedEntries &&
    branchSummary?.status === 'ready' &&
    branchEntries.length === 0

  return (
    <>
      <SourceControlContentStatus
        unresolvedConflictCount={unresolvedConflictReviewEntries.length}
        conflictOperation={conflictOperation}
        sourceControlAiActionsVisible={sourceControlAiActionsVisible}
        isRecoveryBusy={isCheckingRecoveryAdmission || isResolvingConflictsWithAI}
        isAbortingOperation={isAbortingOperation}
        onAbortOperation={handleAbortOperationForConflict}
        isCompletingMerge={isCommitting}
        onCompleteMerge={() => void handleCompleteMerge()}
        onResolveWithAi={() => void handleResolveConflictsWithAI()}
        onReviewConflicts={() => {
          openConflictReview(
            currentWorktreeId,
            worktreePath,
            unresolvedConflictReviewEntries,
            'live-summary'
          )
        }}
        repositoryHuge={repositoryHuge}
        statusReadError={statusReadError}
        worktreeId={currentWorktreeId}
        onRetryStatus={refreshActiveGitStatus}
        onStageAllChanges={handleStageWorktreeChanges}
        isExecutingBulk={isExecutingBulk}
        showGenericEmptyState={showGenericEmptyState}
        normalizedFilter={normalizedFilter}
        branchBaseRef={branchSummary?.baseRef ?? null}
        filterTooLarge={fileFilterState.tooLarge}
        hasFilteredUncommittedEntries={hasFilteredUncommittedEntries}
        hasFilteredBranchEntries={hasFilteredBranchEntries}
        filterQuery={filterQuery}
      />

      {/* Keep CommitArea through clean/mid-commit states (#1448); only active conflict operations replace the action surface. */}
      <SourceControlForkPushNotice pushTarget={activeWorktree.pushTarget ?? null} />

      {shouldRenderCommitArea(unresolvedConflicts.length, conflictOperation) && (
        <SourceControlCommitSurface {...props} showGenericEmptyState={showGenericEmptyState} />
      )}

      {hasFilteredUncommittedEntries && (
        <SourceControlUncommittedSections
          displaySections={displaySections}
          unfilteredDisplaySectionsById={unfilteredDisplaySectionsById}
          normalizedFilter={normalizedFilter}
          collapsedSections={collapsedSections}
          toggleSection={toggleSection}
          onViewSection={(sectionViewAction) => {
            if (sectionViewAction.kind === 'conflict-review') {
              openConflictReview(
                currentWorktreeId,
                worktreePath,
                sectionViewAction.entries,
                'live-summary'
              )
            } else {
              openAllDiffs(
                currentWorktreeId,
                worktreePath,
                undefined,
                sectionViewAction.area,
                sectionViewAction.entries
              )
            }
          }}
          isExecutingBulk={isExecutingBulk}
          requestDiscardAllInArea={requestDiscardAllInArea}
          handleStageAllPaths={handleStageAllPaths}
          handleStageSectionPaths={handleStageSectionPaths}
          handleUnstagePaths={handleUnstagePaths}
          sourceControlViewMode={sourceControlViewMode}
          visibleTreeRowsBySection={visibleTreeRowsBySection}
          visibleListRowsBySection={visibleListRowsBySection}
          fileListScrollElement={fileListScrollElement}
          collapsedTreeDirs={collapsedTreeDirs}
          toggleTreeDir={toggleTreeDir}
          requestDiscardPaths={requestDiscardPaths}
          expandedSubmoduleKeys={expandedSubmoduleKeys}
          toggleSubmodule={toggleSubmodule}
          currentWorktreeId={currentWorktreeId}
          worktreePath={worktreePath}
          selectedKeySet={selectedKeySet}
          activeOpenRowKeys={activeOpenRowKeys}
          handleSelect={handleSelect}
          handleContextMenu={handleContextMenu}
          revealInExplorer={revealInExplorer}
          activeConnectionId={activeConnectionId}
          handleOpenDiff={handleOpenDiff}
          handleStage={handleStage}
          handleResolveConflict={handleResolveConflict}
          handleUnstage={handleUnstage}
          requestDiscardEntry={requestDiscardEntry}
          diffCommentCountByPath={diffCommentCountByPath}
        />
      )}

      {shouldShowSourceControlCompareUnavailableCard(
        branchSummary,
        hasUncommittedEntries,
        branchEntries.length > 0,
        Boolean(normalizedFilter)
      ) && branchSummary ? (
        <CompareUnavailable
          summary={branchSummary}
          onChangeBaseRef={() => setBaseRefDialogOpen(true)}
          onRetry={() => void refreshBranchCompare()}
        />
      ) : null}

      {branchSummary?.status === 'ready' && hasFilteredBranchEntries && (
        <SourceControlBranchSection
          activeOpenRowKeys={activeOpenRowKeys}
          branchSummary={branchSummary}
          filteredBranchEntries={filteredBranchEntries}
          totalBranchEntryCount={branchEntries.length}
          collapsedSections={collapsedSections}
          toggleSection={toggleSection}
          sourceControlViewMode={sourceControlViewMode}
          visibleBranchTreeRows={visibleBranchTreeRows}
          fileListScrollElement={fileListScrollElement}
          collapsedTreeDirs={collapsedTreeDirs}
          toggleTreeDir={toggleTreeDir}
          currentWorktreeId={currentWorktreeId}
          worktreePath={worktreePath}
          revealInExplorer={revealInExplorer}
          activeConnectionId={activeConnectionId}
          openCommittedDiff={openCommittedDiff}
          openBranchAllDiffs={openBranchAllDiffs}
          diffCommentCountByPath={diffCommentCountByPath}
        />
      )}

      {isGitHistoryVisible && (
        // Dock history as reference context while the rest of the pane scrolls.
        <div className="sticky bottom-0 z-10 mt-auto shrink-0 border-t border-border bg-sidebar/95 backdrop-blur-sm">
          <GitHistoryPanel
            state={gitHistoryState}
            collapsed={collapsedSections.has('history')}
            onToggle={() => toggleSection('history')}
            onRefresh={() => void refreshGitHistory({ wakeWslDistro: true })}
            onOpenCommit={(item) => void openHistoryCommitDiff(item)}
            onLoadCommitFiles={loadCommitFiles}
            onOpenCommitFile={openCommitFile}
            onCommitAction={handleCommitAction}
          />
        </div>
      )}
    </>
  )
}
