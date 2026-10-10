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
    handleLinearEmptyFilteredLoadMore
  } = model
  return (
    <div className="flex min-h-0 max-h-full flex-col overflow-hidden rounded-md rounded-t-none border border-t-0 border-border/50 bg-background shadow-sm">
      <TaskPageLinearIssueToolbar model={model} />

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
