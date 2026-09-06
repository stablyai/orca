import type { TaskPageLinearBoardModel } from './use-task-page-linear-board'
import { useMemo } from 'react'
import { findTaskPageJiraIssue } from '@/components/task-page-jira-cache-selectors'
import {
  getSingleJiraProjectScope,
  getTaskPageJiraStatusOrderScopeKey
} from '@/components/task-page-jira-status-order'
import { sortJiraIssues } from './jira-issue-sorter'
export function useTaskPageJiraListProjection(model: TaskPageLinearBoardModel) {
  const {
    jiraTaskSourceContext,
    jiraTaskSourceScopeKey,
    jiraCacheSnapshot,
    jiraIssues,
    jiraProjectStatusOrder,
    jiraOrderBy,
    jiraOrderDirection,
    jiraPrioritiesBySite
  } = model
  const displayedJiraIssues = useMemo(
    () =>
      jiraIssues.map(
        (issue) =>
          findTaskPageJiraIssue(
            jiraCacheSnapshot.issueCache,
            jiraCacheSnapshot.searchCache,
            issue.key,
            {
              sourceContext: jiraTaskSourceContext,
              siteId: issue.siteId
            }
          ) ?? issue
      ),
    [jiraIssues, jiraCacheSnapshot.issueCache, jiraCacheSnapshot.searchCache, jiraTaskSourceContext]
  )
  const displayedJiraProjectScope = useMemo(
    () => getSingleJiraProjectScope(displayedJiraIssues),
    [displayedJiraIssues]
  )
  const displayedJiraStatusOrderScopeKey = displayedJiraProjectScope
    ? getTaskPageJiraStatusOrderScopeKey(jiraTaskSourceScopeKey, displayedJiraProjectScope)
    : null
  const displayedJiraStatusOrder =
    jiraProjectStatusOrder && displayedJiraStatusOrderScopeKey === jiraProjectStatusOrder.scopeKey
      ? jiraProjectStatusOrder.order
      : null
  const sortedJiraIssues = useMemo(() => {
    return sortJiraIssues(
      displayedJiraIssues,
      jiraOrderBy,
      jiraOrderDirection,
      jiraPrioritiesBySite
    )
  }, [displayedJiraIssues, jiraOrderBy, jiraOrderDirection, jiraPrioritiesBySite])
  // New Linear project dialog state
  const nextModel = model as typeof model & {
    displayedJiraIssues: typeof displayedJiraIssues
    displayedJiraProjectScope: typeof displayedJiraProjectScope
    displayedJiraStatusOrderScopeKey: typeof displayedJiraStatusOrderScopeKey
    displayedJiraStatusOrder: typeof displayedJiraStatusOrder
    sortedJiraIssues: typeof sortedJiraIssues
  }
  nextModel.displayedJiraIssues = displayedJiraIssues
  nextModel.displayedJiraProjectScope = displayedJiraProjectScope
  nextModel.displayedJiraStatusOrderScopeKey = displayedJiraStatusOrderScopeKey
  nextModel.displayedJiraStatusOrder = displayedJiraStatusOrder
  nextModel.sortedJiraIssues = sortedJiraIssues
  return nextModel
}
export type TaskPageJiraListProjectionModel = ReturnType<typeof useTaskPageJiraListProjection>
