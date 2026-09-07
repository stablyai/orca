import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import { TaskPageLinearIssueToolbar } from './IssueToolbar'
import { translate } from '@/i18n/i18n'
import { TaskPageLinearIssueRows } from './IssueRows'
import { LinearCollectionNotice } from '@/components/linear-project-view-surfaces'
import { PaginationBar } from '../PaginationBar'
export function TaskPageLinearIssueList({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const {
    linearIssues,
    linearViewMode,
    linearGroupBy,
    selectedLinearProject,
    linearProjectTab,
    linearProjectIssuesResult,
    selectedLinearCustomView,
    linearCustomViewIssuesResult,
    activeLinearIssueLoading,
    activeLinearIssueLoadingTargetPage,
    linearIssueTotalPages,
    visibleLinearIssuePage,
    showLinearIssuePagination,
    handleLinearIssuePageChange,
    showLinearEmptyFilteredLoadMore,
    handleLinearEmptyFilteredLoadMore,
    effectiveLinearDisplayProperties,
    linearIssueGridStyle
  } = model
  return (
    <div className="flex min-h-0 max-h-full flex-col overflow-hidden rounded-md rounded-t-none border border-t-0 border-border/50 bg-background shadow-sm">
      <TaskPageLinearIssueToolbar model={model} />

      {linearViewMode === 'list' && linearGroupBy === 'none' ? (
        <div
          className="grid h-8 flex-none items-center gap-3 border-b border-border/50 bg-muted/25 px-3 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground max-lg:!hidden lg:grid-cols-[var(--linear-grid-template)] [&>span]:min-w-0 [&>span]:truncate"
          style={linearIssueGridStyle}
        >
          <span>{translate('auto.components.TaskPage.37e7ee311e', 'Key')}</span>
          <span>{translate('auto.components.TaskPage.b1eaa18ace', 'Issue')}</span>
          {effectiveLinearDisplayProperties.has('labels') ? (
            <span>{translate('auto.components.TaskPage.d0ca4aa1d0', 'Labels')}</span>
          ) : null}
          {effectiveLinearDisplayProperties.has('team') ? (
            <span>{translate('auto.components.TaskPage.a98cbe7664', 'Team')}</span>
          ) : null}
          {effectiveLinearDisplayProperties.has('state') ? (
            <span>{translate('auto.components.TaskPage.154b0fa623', 'Status')}</span>
          ) : null}
          {effectiveLinearDisplayProperties.has('assignee') ? (
            <span className="text-center">
              {translate('auto.components.TaskPage.d2a876ca53', 'Assignee')}
            </span>
          ) : null}
          {effectiveLinearDisplayProperties.has('updated') ? (
            <span>{translate('auto.components.TaskPage.f362667d55', 'Updated')}</span>
          ) : null}
          <span>{translate('auto.components.TaskPage.linearWorktreesColumn', 'Workspaces')}</span>
        </div>
      ) : null}

      <TaskPageLinearIssueRows model={model} />
      {selectedLinearProject && linearProjectTab === 'issues' ? (
        <>
          <LinearCollectionNotice
            errors={linearProjectIssuesResult.errors}
            hasMore={showLinearEmptyFilteredLoadMore}
            count={linearProjectIssuesResult.items.length}
            label={translate('auto.components.TaskPage.67662ade50', 'project issues')}
            onLoadMore={handleLinearEmptyFilteredLoadMore}
            loading={activeLinearIssueLoading}
            loadMoreLabel="Fetch more"
          />
          {showLinearIssuePagination ? (
            <div className="flex-none border-t border-border/50 bg-muted/50">
              <PaginationBar
                currentPage={visibleLinearIssuePage}
                totalPages={linearIssueTotalPages}
                loadingTarget={activeLinearIssueLoadingTargetPage}
                onPageChange={handleLinearIssuePageChange}
              />
            </div>
          ) : null}
        </>
      ) : selectedLinearCustomView?.model === 'issue' ? (
        <>
          <LinearCollectionNotice
            errors={linearCustomViewIssuesResult.errors}
            hasMore={showLinearEmptyFilteredLoadMore}
            count={linearCustomViewIssuesResult.items.length}
            label={translate('auto.components.TaskPage.be8cf68d9f', 'view issues')}
            onLoadMore={handleLinearEmptyFilteredLoadMore}
            loading={activeLinearIssueLoading}
            loadMoreLabel="Fetch more"
          />
          {showLinearIssuePagination ? (
            <div className="flex-none border-t border-border/50 bg-muted/50">
              <PaginationBar
                currentPage={visibleLinearIssuePage}
                totalPages={linearIssueTotalPages}
                loadingTarget={activeLinearIssueLoadingTargetPage}
                onPageChange={handleLinearIssuePageChange}
              />
            </div>
          ) : null}
        </>
      ) : (
        <>
          <LinearCollectionNotice
            hasMore={showLinearEmptyFilteredLoadMore}
            count={linearIssues.length}
            label={translate('auto.components.TaskPage.d1e243795c', 'issues')}
            onLoadMore={handleLinearEmptyFilteredLoadMore}
            loading={activeLinearIssueLoading}
            loadMoreLabel="Fetch more"
          />
          {showLinearIssuePagination ? (
            <div className="flex-none border-t border-border/50 bg-muted/50">
              <PaginationBar
                currentPage={visibleLinearIssuePage}
                totalPages={linearIssueTotalPages}
                loadingTarget={activeLinearIssueLoadingTargetPage}
                onPageChange={handleLinearIssuePageChange}
              />
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
