import { useRef, type ReactNode } from 'react'
import { useStickyFilterScroll } from './filter-results-scroll'
import { useGitCommitActionsSupport } from '@/runtime/source-control/git/git-commit-actions-capability'
import { shouldShowSourceControlCompareUnavailableCard } from './header-toolbar'
import { shouldRenderCommitArea } from '../commit/component-gates'
import { SourceControlBranchSection, branchSectionCountTitle } from '../listing/branch-section'
import { SourceControlContentStatus, SourceControlFilterFeedback } from '../listing/content-status'
import { SourceControlUncommittedSections } from '../listing/uncommitted-sections'
import { CompareUnavailable } from '../sync/compare-summary'
import { SourceControlCommitSurface } from './commit-surface'
import { SourceControlForkPushNotice } from './fork-push-notice'
import type { SourceControlPanelReadyProps } from './panel-props'
import { useTranslate } from '@/i18n/use-translate'
import { CommitScopeFilesStatus } from './commit-scope-files-status'
import { useSourceControlScope } from './worktree-scope'
import { cn } from '@/lib/class-names'

const NO_COMMENT_COUNTS = new Map<string, number>()

export function SourceControlPanelContent({
  fileListHeader = null,
  ...props
}: SourceControlPanelReadyProps & { fileListHeader?: ReactNode }) {
  const { activeWorktree, currentWorktreeId, model, worktreePath } = props
  const embedded = useSourceControlScope() !== null
  const t = useTranslate()
  const commitFilesHeaderRef = useRef<HTMLButtonElement>(null)
  const fileListHeaderRef = useRef<HTMLDivElement>(null)
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
    filterExpanded,
    filterQuery,
    filteredBranchEntries,
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
    isCheckingRecoveryAdmission,
    isExecutingBulk,
    normalizedFilter,
    openAllDiffs,
    openBranchAllDiffs,
    openCommitFile,
    openCommittedDiff,
    openHistoryCommitDiff,
    openConflictReview,
    refreshActiveGitStatus,
    refreshBranchCompare,
    repositoryHuge,
    requestDiscardAllInArea,
    requestDiscardEntry,
    requestDiscardPaths,
    retryCommitScopeFiles,
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
  const stickyFileListHeader = fileListHeader !== null && !embedded
  const stickyFilterActive = stickyFileListHeader && Boolean(normalizedFilter || filterExpanded)
  const filterSpacerRef = useStickyFilterScroll(
    fileListHeaderRef,
    fileListScrollElement,
    normalizedFilter,
    stickyFilterActive
  )
  const commitSurfaceShown =
    scopeKind !== 'commit' &&
    shouldRenderCommitArea(unresolvedConflicts.length, conflictOperation, recovery.supported)
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
        filterFeedbackInline={!fileListHeader}
      />

      {/* Keep CommitArea through clean/mid-commit states (#1448); only active conflict operations replace the action surface. */}
      <SourceControlForkPushNotice pushTarget={activeWorktree.pushTarget ?? null} />

      {commitSurfaceShown && (
        <SourceControlCommitSurface {...props} showGenericEmptyState={showGenericEmptyState} />
      )}

      {fileListHeader ? (
        <div
          ref={fileListHeaderRef}
          // Marks where the scroller's scroll-margin rule starts (see panel-ready).
          data-file-list-header={embedded ? undefined : ''}
          className={cn(
            // Sticky in the selected panel so its tools stay in reach while the list scrolls;
            // -top-1 cancels the scroller's pt-1 so rows cannot show above it.
            !embedded && 'sticky -top-1 z-10 bg-sidebar',
            commitSurfaceShown && 'border-t border-border'
          )}
        >
          {fileListHeader}
        </div>
      ) : null}

      {fileListHeader ? (
        <SourceControlFilterFeedback
          normalizedFilter={normalizedFilter}
          filterTooLarge={fileFilterState.tooLarge}
          hasFilteredUncommittedEntries={hasFilteredUncommittedEntries}
          hasFilteredBranchEntries={hasFilteredBranchEntries || commitFilesPending}
          filterQuery={filterQuery}
        />
      ) : null}

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
          headerButtonRef={commitFilesHeaderRef}
          // The whole-commit diff, as View all opens it for the other sections.
          onViewAll={
            currentCommitFiles?.status === 'ready' && currentCommitFiles.entries.length > 0
              ? () => void openHistoryCommitDiff(changeScope.commit)
              : undefined
          }
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
          {commitFilesPending || (!hasFilteredBranchEntries && !normalizedFilter) ? (
            <CommitScopeFilesStatus
              files={currentCommitFiles}
              onRetry={(button) =>
                retryCommitScopeFiles(() => {
                  if (button.ownerDocument.activeElement === button) {
                    commitFilesHeaderRef.current?.focus({ preventScroll: true })
                  }
                })
              }
            />
          ) : null}
        </SourceControlBranchSection>
      ) : null}

      {stickyFilterActive ? (
        // Height is fitted by useStickyFilterScroll so the stuck header never moves while filtering.
        <div ref={filterSpacerRef} aria-hidden="true" className="shrink-0" />
      ) : null}
    </>
  )
}
