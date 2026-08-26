import { useState } from 'react'

import type { LinearProjectTab } from '@/components/task-page/linear/linear-issue-grouping'
import { translate } from '@/i18n/i18n'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type {
  LinearCustomViewSummary,
  LinearProjectSummary
} from '../../../../../shared/linear/project-types'
import type {
  LinearCollectionResult,
  LinearConnectionStatus
} from '../../../../../shared/linear/workspace-types'
import { LINEAR_ISSUE_LIST_MAX } from '../../../../../shared/linear/issue-read-limits'

export function useTaskPageLinearActiveCollection({
  settings,
  selectedLinearProject,
  linearProjectTab,
  linearProjectIssuesResult,
  selectedLinearCustomView,
  linearCustomViewIssuesResult,
  linearIssues,
  linearProjectIssuesLoading,
  linearCustomViewContentsLoading,
  linearLoading,
  linearStatus,
  linearProjectIssuesError,
  linearCustomViewContentsError,
  linearError,
  appliedLinearSearch,
  linearIssuesHasMore,
  linearIssueLimit,
  linearProjectIssueLimit,
  linearCustomViewIssueLimit,
  linearProjectIssuePage,
  linearCustomViewIssuePage,
  linearIssuePage,
  linearProjectIssueLoadingTargetPage,
  linearCustomViewIssueLoadingTargetPage,
  linearIssueLoadingTargetPage
}: {
  settings: GlobalSettings | null
  selectedLinearProject: LinearProjectSummary | null
  linearProjectTab: LinearProjectTab
  linearProjectIssuesResult: LinearCollectionResult<LinearIssue>
  selectedLinearCustomView: LinearCustomViewSummary | null
  linearCustomViewIssuesResult: LinearCollectionResult<LinearIssue>
  linearIssues: LinearIssue[]
  linearProjectIssuesLoading: boolean
  linearCustomViewContentsLoading: boolean
  linearLoading: boolean
  linearStatus: LinearConnectionStatus
  linearProjectIssuesError: string | null
  linearCustomViewContentsError: string | null
  linearError: string | null
  appliedLinearSearch: string
  linearIssuesHasMore: boolean
  linearIssueLimit: number
  linearProjectIssueLimit: number
  linearCustomViewIssueLimit: number
  linearProjectIssuePage: number
  linearCustomViewIssuePage: number
  linearIssuePage: number
  linearProjectIssueLoadingTargetPage: number | null
  linearCustomViewIssueLoadingTargetPage: number | null
  linearIssueLoadingTargetPage: number | null
}) {
  const defaultLinearTeamSelection = settings?.defaultLinearTeamSelection
  const [linearTeamSelection, setLinearTeamSelection] = useState<ReadonlySet<string>>(() => {
    if (!defaultLinearTeamSelection) {
      return new Set<string>()
    }
    return new Set(defaultLinearTeamSelection)
  })

  const activeLinearIssues =
    selectedLinearProject && linearProjectTab === 'issues'
      ? linearProjectIssuesResult.items
      : selectedLinearCustomView?.model === 'issue'
        ? linearCustomViewIssuesResult.items
        : linearIssues
  const activeLinearIssueLoading =
    selectedLinearProject && linearProjectTab === 'issues'
      ? linearProjectIssuesLoading
      : selectedLinearCustomView?.model === 'issue'
        ? linearCustomViewContentsLoading
        : linearLoading
  const activeLinearIssueError =
    linearStatus.credentialError ??
    (selectedLinearProject && linearProjectTab === 'issues'
      ? linearProjectIssuesError
      : selectedLinearCustomView?.model === 'issue'
        ? linearCustomViewContentsError
        : linearError)
  const activeLinearIssueCollectionErrors =
    selectedLinearProject && linearProjectTab === 'issues'
      ? linearProjectIssuesResult.errors
      : selectedLinearCustomView?.model === 'issue'
        ? linearCustomViewIssuesResult.errors
        : undefined
  const activeLinearIssueHasCollectionError = (activeLinearIssueCollectionErrors?.length ?? 0) > 0
  const activeLinearIssueContextLabel =
    selectedLinearProject && linearProjectTab === 'issues'
      ? translate(
          'auto.components.task.page.hooks.use.task.page.linear.active.collection.d8b3cd9488',
          'Project: {{value0}}',
          { value0: selectedLinearProject.name }
        )
      : selectedLinearCustomView?.model === 'issue'
        ? translate(
            'auto.components.task.page.hooks.use.task.page.linear.active.collection.68462f8b29',
            'View: {{value0}}',
            { value0: selectedLinearCustomView.name }
          )
        : null
  const canLoadMorePlainLinearIssues =
    !activeLinearIssueContextLabel &&
    appliedLinearSearch.trim().length === 0 &&
    linearIssuesHasMore &&
    linearIssueLimit < LINEAR_ISSUE_LIST_MAX
  const canLoadMoreLinearProjectIssues =
    selectedLinearProject !== null &&
    linearProjectTab === 'issues' &&
    Boolean(linearProjectIssuesResult.hasMore) &&
    linearProjectIssueLimit < LINEAR_ISSUE_LIST_MAX
  const canLoadMoreLinearCustomViewIssues =
    selectedLinearCustomView?.model === 'issue' &&
    Boolean(linearCustomViewIssuesResult.hasMore) &&
    linearCustomViewIssueLimit < LINEAR_ISSUE_LIST_MAX
  const activeLinearIssuePage =
    selectedLinearProject && linearProjectTab === 'issues'
      ? linearProjectIssuePage
      : selectedLinearCustomView?.model === 'issue'
        ? linearCustomViewIssuePage
        : linearIssuePage
  const activeLinearIssueLoadingTargetPage =
    selectedLinearProject && linearProjectTab === 'issues'
      ? linearProjectIssueLoadingTargetPage
      : selectedLinearCustomView?.model === 'issue'
        ? linearCustomViewIssueLoadingTargetPage
        : linearIssueLoadingTargetPage
  const activeLinearIssueCanLoadMore =
    selectedLinearProject && linearProjectTab === 'issues'
      ? canLoadMoreLinearProjectIssues
      : selectedLinearCustomView?.model === 'issue'
        ? canLoadMoreLinearCustomViewIssues
        : canLoadMorePlainLinearIssues
  const activeLinearIssueCanRequestMore =
    activeLinearIssueCanLoadMore && !activeLinearIssueHasCollectionError
  const activeLinearIssueLimit =
    selectedLinearProject && linearProjectTab === 'issues'
      ? linearProjectIssueLimit
      : selectedLinearCustomView?.model === 'issue'
        ? linearCustomViewIssueLimit
        : linearIssueLimit

  return {
    defaultLinearTeamSelection,
    linearTeamSelection,
    setLinearTeamSelection,
    activeLinearIssues,
    activeLinearIssueLoading,
    activeLinearIssueError,
    activeLinearIssueCollectionErrors,
    activeLinearIssueHasCollectionError,
    activeLinearIssueContextLabel,
    canLoadMorePlainLinearIssues,
    canLoadMoreLinearProjectIssues,
    canLoadMoreLinearCustomViewIssues,
    activeLinearIssuePage,
    activeLinearIssueLoadingTargetPage,
    activeLinearIssueCanLoadMore,
    activeLinearIssueCanRequestMore,
    activeLinearIssueLimit
  }
}
