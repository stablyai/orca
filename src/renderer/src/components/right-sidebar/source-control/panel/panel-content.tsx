import type React from 'react'
import { useGitCommitActionsSupport } from '@/runtime/source-control/git/git-commit-actions-capability'
import { shouldShowSourceControlCompareUnavailableCard } from './header-toolbar'
import { shouldRenderCommitArea } from '../commit/component-gates'
import { SourceControlBranchSection, branchSectionCountTitle } from '../listing/branch-section'
import { SourceControlContentStatus } from '../listing/content-status'
import { SourceControlUncommittedSections } from '../listing/uncommitted-sections'
import { CompareUnavailable } from '../sync/compare-summary'
import { SourceControlCommitSurface } from './commit-surface'
import { SourceControlForkPushNotice } from './fork-push-notice'
import type { SourceControlPanelReadyProps } from './panel-props'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { SourceControlCommitScopeFiles } from './change-scope'

const NO_COMMENT_COUNTS = new Map<string, number>()

export function SourceControlPanelContent(props: SourceControlPanelReadyProps) {
  const { activeWorktree, currentWorktreeId, model, worktreePath } = props
  const t = useTranslate()
  const {
    activeConnectionId,
    activeOpenRowKeys,
    branchEntries,
    branchSummary,
    changeScope,
    collapsedSections,
    commitScopeFiles,
    collapsedTreeDirs,
    conflictOperation,
    diffCommentCountByPath,
    displaySections,
    expandedSubmoduleKeys,
    fileFilterState,
    fileListScrollElement,
    filterQuery,
    filteredBranchEntries,
    handleAbortOperationForConflict,
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
    normalizedFilter,
    openAllDiffs,
    openBranchAllDiffs,
    openCommitFile,
    openCommittedDiff,
    openConflictReview,
    refreshActiveGitStatus,
    refreshBranchCompare,
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

  const recovery = useGitCommitActionsSupport(
    conflictOperation === 'revert' ? model.activeRepoTarget : null
  )
  const hasFilteredUncommittedEntries = displaySections.length > 0
  const hasFilteredBranchEntries = filteredBranchEntries.length > 0
  const scopeKind = changeScope.kind
  const currentCommitFiles =
    changeScope.kind === 'commit' && commitScopeFiles?.commitId === changeScope.commit.id
      ? commitScopeFiles
      : null
  // A commit's files still loading must not read as "No matching files" under a filter.
  const commitFilesPending = scopeKind === 'commit' && currentCommitFiles?.status !== 'ready'
  const showGenericEmptyState =
    scopeKind === 'all' &&
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
        hasFilteredBranchEntries={hasFilteredBranchEntries || commitFilesPending}
        filterQuery={filterQuery}
      />

      {/* Keep CommitArea through clean/mid-commit states (#1448); only active conflict operations replace the action surface. */}
      <SourceControlForkPushNotice pushTarget={activeWorktree.pushTarget ?? null} />

      {scopeKind !== 'commit' &&
        shouldRenderCommitArea(
          unresolvedConflicts.length,
          conflictOperation,
          recovery.supported
        ) && <SourceControlCommitSurface {...props} showGenericEmptyState={showGenericEmptyState} />}

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

      {scopeKind === 'uncommitted' &&
      !hasUncommittedEntries &&
      !normalizedFilter &&
      statusReadError === undefined ? (
        <div className="px-4 py-3 text-xs text-muted-foreground">
          {t(
            'auto.components.right.sidebar.SourceControl.scopeNoUncommitted',
            'No uncommitted changes.'
          )}
        </div>
      ) : null}

      {scopeKind === 'all' &&
      shouldShowSourceControlCompareUnavailableCard(
        branchSummary,
        hasUncommittedEntries,
        branchEntries.length > 0,
        Boolean(normalizedFilter)
      ) &&
      branchSummary ? (
        <CompareUnavailable
          summary={branchSummary}
          onChangeBaseRef={() => setBaseRefDialogOpen(true)}
          onRetry={() => void refreshBranchCompare()}
        />
      ) : null}

      {scopeKind === 'all' && branchSummary?.status === 'ready' && hasFilteredBranchEntries && (
        <SourceControlBranchSection
          label={t('auto.components.right.sidebar.SourceControl.d7ae61269b', 'Committed on Branch')}
          countTitle={branchSectionCountTitle(
            t,
            branchSummary,
            filteredBranchEntries.length,
            branchEntries.length
          )}
          sectionKey="branch"
          onViewAll={() => openBranchAllDiffs(currentWorktreeId, worktreePath, branchSummary)}
          activeOpenRowKeys={activeOpenRowKeys}
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
          openEntry={openCommittedDiff}
          diffCommentCountByPath={diffCommentCountByPath}
        />
      )}

      {changeScope.kind === 'commit' ? (
        <SourceControlBranchSection
          label={t('auto.components.right.sidebar.SourceControl.scopeCommitFiles', 'Files')}
          sectionKey="commit"
          activeOpenRowKeys={activeOpenRowKeys}
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
          openEntry={(entry, event) => openCommitFile(changeScope.commit, entry, event)}
          // Review notes belong to working-tree diffs, not to a past commit's rows.
          diffCommentCountByPath={NO_COMMENT_COUNTS}
        >
          {commitScopeFilesStatus(
            t,
            currentCommitFiles,
            hasFilteredBranchEntries || Boolean(normalizedFilter)
          )}
        </SourceControlBranchSection>
      ) : null}
    </>
  )
}

/** Undefined lets the section render its rows. */
function commitScopeFilesStatus(
  t: Translate,
  files: SourceControlCommitScopeFiles | null,
  rowsOrFilterNotice: boolean
): React.JSX.Element | undefined {
  if (!files || files.status === 'loading') {
    return <div className="h-6" aria-busy="true" />
  }
  if (files.status === 'error') {
    return (
      <div className="px-4 py-2 text-xs text-destructive" title={files.error}>
        {files.error}
      </div>
    )
  }
  // The content status already explains a filter that hides every row.
  if (rowsOrFilterNotice) {
    return undefined
  }
  return (
    <div className="px-4 py-2 text-xs text-muted-foreground">
      {t(
        'auto.components.right.sidebar.GitHistoryCommitFiles.b2c3d4e5f6',
        'No file changes in this commit'
      )}
    </div>
  )
}
