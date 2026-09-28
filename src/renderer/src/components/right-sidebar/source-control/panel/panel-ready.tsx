import { BulkActionBar } from '../commit/bulk-action-bar'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { SourceControlFileFilterMenu } from './file-filter-menu'
import { SourceControlHeaderToolbar } from './header-toolbar'
import { SourceControlNotesShelf } from '../notes/notes-shelf'
import { SourceControlPanelContent } from './panel-content'
import { SourceControlPanelDialogs } from './panel-dialogs'
import type { SourceControlPanelReadyProps } from './panel-props'

/** The panel chrome: toolbar, notes shelf, the scrolling file surface, bulk bar and dialog layer. */
export function SourceControlPanelReady(props: SourceControlPanelReadyProps) {
  const { model, worktreePath } = props
  const {
    activeGroupId,
    activeWorktreeId,
    branchLineTotal,
    branchSummary,
    bulkStagePaths,
    bulkUnstagePaths,
    clearSelection,
    compareBaseRef,
    deleteDiffComment,
    diffCommentCount,
    diffCommentsCopied,
    diffCommentsExpanded,
    diffCommentsForActive,
    filterExpanded,
    filterQuery,
    excludedExtensions,
    extensionCounts,
    fileGroups,
    fileGroupsFailed,
    hasFileVisibilityFilter,
    hiddenFileCount,
    hiddenFileGroups,
    refreshFileGroups,
    setExcludedExtensions,
    setHiddenFileGroups,
    gitIdentityDisplay,
    handleBulkStage,
    handleBulkUnstage,
    handleCopyDiffComments,
    handleCreatePrHeaderClick,
    handleOpenComment,
    handleRelinkSuppressedGitHubPR,
    handleSourceControlKeyDown,
    handleToggleSourceControlViewMode,
    hostedReview,
    isCreatePrIntentInFlight,
    isCreatingPr,
    isExecutingBulk,
    manualReviewUrl,
    openHostedReviewInChecks,
    prGenerating,
    refreshBranchCompare,
    selectedKeys,
    setBaseRefDialogOpen,
    setDiffCommentsExpanded,
    setFileListScrollElement,
    setFilterExpanded,
    setFilterQuery,
    setPendingDiffCommentsClear,
    setSourceControlRoot,
    settings,
    sourceControlViewMode,
    suppressedGitHubPRState,
    visibleCreatePrHeaderAction
  } = model
  const isFiltering = Boolean(filterQuery) || hasFileVisibilityFilter
  const resetFilters = () => {
    setFilterQuery('')
    setExcludedExtensions(new Set())
    setHiddenFileGroups(new Set())
  }

  return (
    <>
      <div
        ref={setSourceControlRoot}
        data-testid="source-control-panel"
        className="relative flex h-full flex-col overflow-hidden"
        onKeyDown={handleSourceControlKeyDown}
      >
        <SourceControlHeaderToolbar
          fileFilters={
            <SourceControlFileFilterMenu
              extensionCounts={extensionCounts}
              excludedExtensions={excludedExtensions}
              onExcludedExtensionsChange={setExcludedExtensions}
              fileGroups={fileGroups}
              hiddenFileGroups={hiddenFileGroups}
              onHiddenFileGroupsChange={setHiddenFileGroups}
              fileGroupsFailed={fileGroupsFailed}
              onOpen={refreshFileGroups}
              onReset={resetFilters}
              isFiltering={isFiltering}
            />
          }
          filterQuery={filterQuery}
          filterExpanded={filterExpanded}
          onFilterQueryChange={setFilterQuery}
          onFilterExpandedChange={setFilterExpanded}
          visibleCreatePrHeaderAction={visibleCreatePrHeaderAction}
          hostedReview={hostedReview}
          isCreatePrIntentInFlight={isCreatePrIntentInFlight}
          isCreatingPr={isCreatingPr || prGenerating}
          onCreatePrHeaderClick={handleCreatePrHeaderClick}
          onOpenHostedReviewInChecks={openHostedReviewInChecks}
          suppressedGitHubPRNumber={
            suppressedGitHubPRState?.status === 'matched' ? suppressedGitHubPRState.number : null
          }
          onRelinkSuppressedGitHubPR={handleRelinkSuppressedGitHubPR}
          sourceControlViewMode={sourceControlViewMode}
          viewModeToggleDisabled={settings === null}
          onToggleViewMode={handleToggleSourceControlViewMode}
          onChangeBaseRef={() => setBaseRefDialogOpen(true)}
          onRefreshBranchCompare={() => void refreshBranchCompare()}
          branchCompareRefreshDisabled={!branchSummary || branchSummary.status === 'loading'}
          diffCommentCount={diffCommentCount}
          onExpandNotes={() => setDiffCommentsExpanded(true)}
          branchSummary={branchSummary}
          branchLineTotal={branchLineTotal}
          compareBaseRef={compareBaseRef}
          headDisplay={gitIdentityDisplay}
          manualReviewUrl={manualReviewUrl}
        />

        {hiddenFileCount > 0 && (
          <div className="flex items-center gap-2 px-3 py-1 text-xs text-muted-foreground">
            <span role="status">
              {translate('sourceControl.fileFilters.hidden', 'Hidden files: {{count}}', {
                count: hiddenFileCount
              })}
            </span>
            <Button variant="link" size="xs" onClick={resetFilters}>
              {translate('sourceControl.fileFilters.reset', 'Reset filters')}
            </Button>
          </div>
        )}

        {/* Why: hidden when count is 0 — notes are created from the diff view, so an empty Notes shelf here is pure chrome. */}
        {activeWorktreeId && worktreePath && diffCommentCount > 0 && (
          <SourceControlNotesShelf
            activeWorktreeId={activeWorktreeId}
            activeGroupId={activeGroupId}
            diffCommentsForActive={diffCommentsForActive}
            diffCommentCount={diffCommentCount}
            diffCommentsExpanded={diffCommentsExpanded}
            setDiffCommentsExpanded={setDiffCommentsExpanded}
            diffCommentsCopied={diffCommentsCopied}
            handleCopyDiffComments={handleCopyDiffComments}
            setPendingDiffCommentsClear={setPendingDiffCommentsClear}
            deleteDiffComment={deleteDiffComment}
            handleOpenComment={handleOpenComment}
          />
        )}

        <div
          ref={setFileListScrollElement}
          className="relative flex flex-1 flex-col overflow-auto scrollbar-sleek pt-1"
          style={{ paddingBottom: selectedKeys.size > 0 ? 50 : undefined }}
        >
          <SourceControlPanelContent {...props} />
        </div>

        {selectedKeys.size > 0 && (
          <BulkActionBar
            selectedCount={selectedKeys.size}
            stageableCount={bulkStagePaths.length}
            unstageableCount={bulkUnstagePaths.length}
            onStage={handleBulkStage}
            onUnstage={handleBulkUnstage}
            onClear={clearSelection}
            isExecuting={isExecutingBulk}
          />
        )}
      </div>

      <SourceControlPanelDialogs {...props} />
    </>
  )
}
