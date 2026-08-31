import React from 'react'

import { LinearCollectionNotice } from '@/components/linear-project-view-surfaces'
import { translate } from '@/i18n/i18n'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type {
  LinearCustomViewSummary,
  LinearProjectSummary
} from '../../../../../shared/linear/project-types'
import type { LinearCollectionResult } from '../../../../../shared/linear/workspace-types'
import type { LinearViewMode } from '@/components/task-page-localized-options'
import { PaginationBar } from '../pagination/pagination-bar'
import type { LinearProjectTab } from './linear-issue-grouping'
import { LinearIssueBoard } from './linear-issue-board'
import { LinearIssueEmptyStates } from './linear-issue-empty-states'
import { LinearIssueGroupedList } from './linear-issue-grouped-list'
import { LinearIssueToolbar } from './linear-issue-toolbar'

export type LinearIssueListHostProps = {
  toolbar: Omit<React.ComponentProps<typeof LinearIssueToolbar>, 'pagedLinearIssuesCount'>
  empty: React.ComponentProps<typeof LinearIssueEmptyStates>
  board: React.ComponentProps<typeof LinearIssueBoard>
  list: React.ComponentProps<typeof LinearIssueGroupedList>
  linearViewMode: LinearViewMode
  selectedLinearProject: LinearProjectSummary | null
  linearProjectTab: LinearProjectTab
  selectedLinearCustomView: LinearCustomViewSummary | null
  linearProjectIssuesResult: LinearCollectionResult<LinearIssue>
  linearCustomViewIssuesResult: LinearCollectionResult<LinearIssue>
  linearIssues: readonly LinearIssue[]
  showLinearEmptyFilteredLoadMore: boolean
  handleLinearEmptyFilteredLoadMore: () => void
  activeLinearIssueLoading: boolean
  showLinearIssuePagination: boolean
  visibleLinearIssuePage: number
  linearIssueTotalPages: number
  activeLinearIssueLoadingTargetPage: number | null
  handleLinearIssuePageChange: (page: number) => void
  pagedLinearIssuesCount: number
}

export function LinearIssueListHost({
  toolbar,
  empty,
  board,
  list,
  linearViewMode,
  selectedLinearProject,
  linearProjectTab,
  selectedLinearCustomView,
  linearProjectIssuesResult,
  linearCustomViewIssuesResult,
  linearIssues,
  showLinearEmptyFilteredLoadMore,
  handleLinearEmptyFilteredLoadMore,
  activeLinearIssueLoading,
  showLinearIssuePagination,
  visibleLinearIssuePage,
  linearIssueTotalPages,
  activeLinearIssueLoadingTargetPage,
  handleLinearIssuePageChange,
  pagedLinearIssuesCount
}: LinearIssueListHostProps): React.JSX.Element {
  const pagination = showLinearIssuePagination ? (
    <div className="flex-none border-t border-border/50 bg-muted/50">
      <PaginationBar
        currentPage={visibleLinearIssuePage}
        totalPages={linearIssueTotalPages}
        loadingTarget={activeLinearIssueLoadingTargetPage}
        onPageChange={handleLinearIssuePageChange}
      />
    </div>
  ) : null

  const collectionNotice =
    selectedLinearProject && linearProjectTab === 'issues'
      ? {
          errors: linearProjectIssuesResult.errors,
          count: linearProjectIssuesResult.items.length,
          label: translate('auto.components.TaskPage.67662ade50', 'project issues')
        }
      : selectedLinearCustomView?.model === 'issue'
        ? {
            errors: linearCustomViewIssuesResult.errors,
            count: linearCustomViewIssuesResult.items.length,
            label: translate('auto.components.TaskPage.be8cf68d9f', 'view issues')
          }
        : {
            errors: undefined,
            count: linearIssues.length,
            label: translate('auto.components.TaskPage.d1e243795c', 'issues')
          }

  return (
    <div className="flex min-h-0 max-h-full flex-col overflow-hidden rounded-md rounded-t-none border border-t-0 border-border/50 bg-background shadow-sm">
      <LinearIssueToolbar {...toolbar} pagedLinearIssuesCount={pagedLinearIssuesCount} />
      <div
        className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek"
        style={{ scrollbarGutter: 'stable' }}
      >
        <LinearIssueEmptyStates {...empty} />
        {linearViewMode === 'board' ? (
          <LinearIssueBoard {...board} />
        ) : (
          <LinearIssueGroupedList {...list} />
        )}
      </div>
      <LinearCollectionNotice
        errors={collectionNotice.errors}
        hasMore={showLinearEmptyFilteredLoadMore}
        count={collectionNotice.count}
        label={collectionNotice.label}
        onLoadMore={handleLinearEmptyFilteredLoadMore}
        loading={activeLinearIssueLoading}
        loadMoreLabel={translate('auto.components.TaskPage.linearFetchMore', 'Fetch more')}
      />
      {pagination}
    </div>
  )
}
