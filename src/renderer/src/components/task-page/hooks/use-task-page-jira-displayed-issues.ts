import { useMemo } from 'react'

import { findTaskPageJiraIssue } from '@/components/task-page-jira-cache-selectors'
import {
  getSingleJiraProjectScope,
  getTaskPageJiraStatusOrderScopeKey
} from '@/components/task-page-jira-status-order'
import {
  sortJiraIssues,
  type JiraIssueSortColumn,
  type JiraIssueSortDirection,
  type JiraPrioritiesBySite
} from '@/components/jira-issue-sorter'
import type { CacheEntry } from '@/store/github/cache-model'
import type { JiraIssue, JiraProjectStatusOrder } from '../../../../../shared/jira-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'

export function useTaskPageJiraDisplayedIssues({
  jiraIssues,
  jiraIssueCache,
  jiraSearchCache,
  jiraTaskSourceContext,
  jiraTaskSourceScopeKey,
  jiraProjectStatusOrder,
  jiraOrderBy,
  jiraOrderDirection,
  jiraPrioritiesBySite
}: {
  jiraIssues: JiraIssue[]
  jiraIssueCache: Record<string, CacheEntry<JiraIssue>>
  jiraSearchCache: Record<string, CacheEntry<JiraIssue[]>>
  jiraTaskSourceContext: TaskSourceContext | null
  jiraTaskSourceScopeKey: string
  jiraProjectStatusOrder: { order: JiraProjectStatusOrder; scopeKey: string } | null
  jiraOrderBy: JiraIssueSortColumn
  jiraOrderDirection: JiraIssueSortDirection
  jiraPrioritiesBySite: JiraPrioritiesBySite
}) {
  const displayedJiraIssues = useMemo(
    () =>
      jiraIssues.map(
        (issue) =>
          findTaskPageJiraIssue(jiraIssueCache, jiraSearchCache, issue.key, {
            sourceContext: jiraTaskSourceContext,
            siteId: issue.siteId
          }) ?? issue
      ),
    [jiraIssues, jiraIssueCache, jiraSearchCache, jiraTaskSourceContext]
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

  return {
    displayedJiraIssues,
    displayedJiraProjectScope,
    displayedJiraStatusOrderScopeKey,
    displayedJiraStatusOrder,
    sortedJiraIssues
  }
}
