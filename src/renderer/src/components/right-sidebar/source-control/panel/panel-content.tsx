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

/** The scrolling surface: status, commit affordances, the file sections and the history dock. */
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
    filteredGrouped,
    gitHistoryState,
    handleAbortOperationForConflict,
    handleCommitAction,
    handleContextMenu,
    handleOpenDiff,
    handleResolveConflictsWithAI,
    handleSelect,
    handleStage,
    handleStageAllPaths,
    handleUnstage,
    handleUnstagePaths,
    hasUncommittedEntries,
    isAbortingOperation,
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

  const hasFilteredUncommittedEntries =
    filteredGrouped.staged.length > 0 ||
    filteredGrouped.unstaged.length > 0 ||
    filteredGrouped.untracked.length > 0
  const hasFilteredBranchEntries = filteredBranchEntries.length > 0
  const showGenericEmptyState =
    !hasUncommittedEntries && branchSummary?.status === 'ready' && branchEntries.length === 0

  return (
    <>
      <SourceControlContentStatus
        unresolvedConflictCount={unresolvedConflictReviewEntries.length}
        conflictOperation={conflictOperation}
        sourceControlAiActionsVisible={sourceControlAiActionsVisible}
        isAbortingOperation={isAbortingOperation}
        onAbortOperation={handleAbortOperationForConflict}
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
        worktreeId={currentWorktreeId}
        onRetryStatus={refreshActiveGitStatus}
        showGenericEmptyState={showGenericEmptyState}
        normalizedFilter={normalizedFilter}
        branchBaseRef={branchSummary?.baseRef ?? null}
        filterTooLarge={fileFilterState.tooLarge}
        hasFilteredUncommittedEntries={hasFilteredUncommittedEntries}
        hasFilteredBranchEntries={hasFilteredBranchEntries}
        filterQuery={filterQuery}
      />

      {/* Why: keep CommitArea mounted across normal states — gating on hasUncommittedEntries (#1448) would unmount the action surface on clean worktrees and mid-commit as the staged list clears. Active merge/rebase/cherry-pick is the exception. */}
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
          branchSummary={branchSummary}
          filteredBranchEntries={filteredBranchEntries}
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
        // Why: the graph is reference context, so keep it docked at the bottom as the pane scrolls.
        <div className="sticky bottom-0 z-10 mt-auto shrink-0 border-t border-border bg-sidebar/95 backdrop-blur-sm">
          <GitHistoryPanel
            state={gitHistoryState}
            collapsed={collapsedSections.has('history')}
            onToggle={() => toggleSection('history')}
            onRefresh={() => void refreshGitHistory()}
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
