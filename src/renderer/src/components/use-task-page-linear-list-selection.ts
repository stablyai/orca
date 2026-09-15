import type { TaskPageGitLabLoadingModel } from './use-task-page-gitlab-loading'
import { useState, useMemo, useEffect } from 'react'
import { LINEAR_ISSUE_LIST_MAX } from '../../../shared/linear/issue-read-limits'
import { findTaskPageLinearIssue } from '@/components/task-page-cache-selectors'
import type { LinearTeam } from '../../../shared/linear/workspace-types'
import {
  buildLinearTeamUrl,
  getLinearOrganizationUrlKeyFromIssueUrl
} from '../../../shared/linear/links'
import { reconcileLinearTeamSelection } from '@/components/task-page-linear-team-selection'
import { useTaskPageLinearFilterSelection } from './use-task-page-linear-filter-selection'
export type TaskPageLinearListSelectionPreludeModel = ReturnType<
  typeof useTaskPageLinearListSelectionPrelude
>
export function useTaskPageLinearListSelectionPrelude(model: TaskPageGitLabLoadingModel) {
  const {
    settings,
    linearStatus,
    linearCacheSnapshot,
    linearIssues,
    linearIssueLimit,
    linearIssuePage,
    linearIssueLoadingTargetPage,
    linearIssuesHasMore,
    linearLoading,
    linearError,
    appliedLinearSearch,
    selectedLinearProject,
    linearProjectTab,
    linearProjectIssuesResult,
    linearProjectIssueLimit,
    linearProjectIssuePage,
    linearProjectIssueLoadingTargetPage,
    linearProjectIssuesLoading,
    linearProjectIssuesError,
    selectedLinearCustomView,
    linearCustomViewIssuesResult,
    linearCustomViewIssueLimit,
    linearCustomViewIssuePage,
    linearCustomViewIssueLoadingTargetPage,
    linearCustomViewContentsLoading,
    linearCustomViewContentsError,
    availableTeams
  } = model
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
  const activeLinearIssueContextLabel = selectedLinearProject
    ? `Project: ${selectedLinearProject.name}`
    : selectedLinearCustomView?.model === 'issue'
      ? `View: ${selectedLinearCustomView.name}`
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
  const displayedLinearIssues = useMemo(
    () =>
      activeLinearIssues.map(
        (issue) =>
          findTaskPageLinearIssue(
            linearCacheSnapshot.issueCache,
            linearCacheSnapshot.searchCache,
            linearCacheSnapshot.listCache,
            issue.id
          ) ?? issue
      ),
    [
      activeLinearIssues,
      linearCacheSnapshot.issueCache,
      linearCacheSnapshot.listCache,
      linearCacheSnapshot.searchCache
    ]
  )
  const linearIssueTeams = useMemo(() => {
    const seen = new Set<string>()
    const teams: LinearTeam[] = []
    for (const issue of displayedLinearIssues) {
      if (!issue.team.id || seen.has(issue.team.id)) {
        continue
      }
      seen.add(issue.team.id)
      teams.push({
        id: issue.team.id,
        workspaceId: issue.workspaceId,
        workspaceName: issue.workspaceName,
        name: issue.team.name,
        key: issue.team.key,
        url:
          buildLinearTeamUrl({
            organizationUrlKey: getLinearOrganizationUrlKeyFromIssueUrl(issue.url),
            teamKey: issue.team.key
          }) ?? undefined
      })
    }
    return teams.sort((a, b) => a.name.localeCompare(b.name))
  }, [displayedLinearIssues])

  // Why: the full team fetch is async and briefly empty; keep the selector usable from issue metadata until the list lands.
  const linearTeamOptions = useMemo(() => {
    if (availableTeams.length === 0) {
      return linearIssueTeams
    }
    const issueTeamById = new Map(linearIssueTeams.map((team) => [team.id, team]))
    return availableTeams.map((team) => {
      if (team.url) {
        return team
      }
      return {
        ...team,
        url: issueTeamById.get(team.id)?.url
      }
    })
  }, [availableTeams, linearIssueTeams])

  // Why: team IDs belong to one workspace, so a workspace switch must not leave the list filtered by stale team IDs.
  useEffect(() => {
    if (linearTeamOptions.length === 0) {
      return
    }
    setLinearTeamSelection(
      reconcileLinearTeamSelection(linearTeamOptions, defaultLinearTeamSelection)
    )
  }, [linearTeamOptions, defaultLinearTeamSelection])
  const nextModel = model as typeof model & {
    defaultLinearTeamSelection: typeof defaultLinearTeamSelection
    linearTeamSelection: typeof linearTeamSelection
    setLinearTeamSelection: typeof setLinearTeamSelection
    activeLinearIssues: typeof activeLinearIssues
    activeLinearIssueLoading: typeof activeLinearIssueLoading
    activeLinearIssueError: typeof activeLinearIssueError
    activeLinearIssueCollectionErrors: typeof activeLinearIssueCollectionErrors
    activeLinearIssueHasCollectionError: typeof activeLinearIssueHasCollectionError
    activeLinearIssueContextLabel: typeof activeLinearIssueContextLabel
    canLoadMorePlainLinearIssues: typeof canLoadMorePlainLinearIssues
    canLoadMoreLinearProjectIssues: typeof canLoadMoreLinearProjectIssues
    canLoadMoreLinearCustomViewIssues: typeof canLoadMoreLinearCustomViewIssues
    activeLinearIssuePage: typeof activeLinearIssuePage
    activeLinearIssueLoadingTargetPage: typeof activeLinearIssueLoadingTargetPage
    activeLinearIssueCanLoadMore: typeof activeLinearIssueCanLoadMore
    activeLinearIssueCanRequestMore: typeof activeLinearIssueCanRequestMore
    activeLinearIssueLimit: typeof activeLinearIssueLimit
    displayedLinearIssues: typeof displayedLinearIssues
    linearIssueTeams: typeof linearIssueTeams
    linearTeamOptions: typeof linearTeamOptions
  }
  nextModel.defaultLinearTeamSelection = defaultLinearTeamSelection
  nextModel.linearTeamSelection = linearTeamSelection
  nextModel.setLinearTeamSelection = setLinearTeamSelection
  nextModel.activeLinearIssues = activeLinearIssues
  nextModel.activeLinearIssueLoading = activeLinearIssueLoading
  nextModel.activeLinearIssueError = activeLinearIssueError
  nextModel.activeLinearIssueCollectionErrors = activeLinearIssueCollectionErrors
  nextModel.activeLinearIssueHasCollectionError = activeLinearIssueHasCollectionError
  nextModel.activeLinearIssueContextLabel = activeLinearIssueContextLabel
  nextModel.canLoadMorePlainLinearIssues = canLoadMorePlainLinearIssues
  nextModel.canLoadMoreLinearProjectIssues = canLoadMoreLinearProjectIssues
  nextModel.canLoadMoreLinearCustomViewIssues = canLoadMoreLinearCustomViewIssues
  nextModel.activeLinearIssuePage = activeLinearIssuePage
  nextModel.activeLinearIssueLoadingTargetPage = activeLinearIssueLoadingTargetPage
  nextModel.activeLinearIssueCanLoadMore = activeLinearIssueCanLoadMore
  nextModel.activeLinearIssueCanRequestMore = activeLinearIssueCanRequestMore
  nextModel.activeLinearIssueLimit = activeLinearIssueLimit
  nextModel.displayedLinearIssues = displayedLinearIssues
  nextModel.linearIssueTeams = linearIssueTeams
  nextModel.linearTeamOptions = linearTeamOptions
  return nextModel
}
export function useTaskPageLinearListSelection(model: TaskPageGitLabLoadingModel) {
  const preludeModel = useTaskPageLinearListSelectionPrelude(model)
  return useTaskPageLinearFilterSelection(preludeModel)
}
export type TaskPageLinearListSelectionModel = ReturnType<typeof useTaskPageLinearListSelection>
