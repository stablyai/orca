import type { TaskPageLinearBoardModel } from './use-task-page-linear-board'
import { useMemo, useCallback } from 'react'
import { findTaskPageJiraIssue } from '@/components/task-page-jira-cache-selectors'
import {
  getSingleJiraProjectScope,
  getTaskPageJiraStatusOrderScopeKey,
  getTaskPageJiraStatusOrderRuntimeScopeKey
} from '@/components/task-page-jira-status-order'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/runtime-client-target'
import {
  buildJiraIssueWorkspaceAttachmentIndex,
  collectLinkedJiraIssueRefs,
  findJiraIssueWorkspaceAttachmentsInIndex
} from '@/lib/jira-issue-workspace-attachment'
import { filterLinkedJiraIssues } from './task-page-jira-linked-issues'
import { sortJiraIssues } from './jira-issue-sorter'
export function useTaskPageJiraListProjection(model: TaskPageLinearBoardModel) {
  const {
    accountBackedTaskSourceHostId,
    jiraTaskSourceContext,
    jiraHasWorkspace,
    appliedJiraSearch,
    linearAttachmentWorkspaces,
    jiraStatus,
    selectedJiraSiteId,
    jiraTaskSourceScopeKey,
    jiraCacheSnapshot,
    jiraIssues,
    jiraProjectStatusOrder,
    jiraOrderBy,
    jiraOrderDirection,
    jiraPrioritiesBySite
  } = model
  const jiraIssueAttachmentIndex = useMemo(
    () => buildJiraIssueWorkspaceAttachmentIndex(linearAttachmentWorkspaces),
    [linearAttachmentWorkspaces]
  )
  const getJiraIssueWorkspaces = useCallback(
    (issue: Parameters<typeof findJiraIssueWorkspaceAttachmentsInIndex>[1]) =>
      findJiraIssueWorkspaceAttachmentsInIndex(
        jiraIssueAttachmentIndex,
        issue,
        jiraTaskSourceContext
      ),
    [jiraIssueAttachmentIndex, jiraTaskSourceContext]
  )
  const linkedJiraIssueRefs = useMemo(
    () =>
      collectLinkedJiraIssueRefs(
        linearAttachmentWorkspaces,
        jiraStatus.sites ?? [],
        selectedJiraSiteId,
        jiraTaskSourceContext
      ),
    [linearAttachmentWorkspaces, jiraStatus.sites, selectedJiraSiteId, jiraTaskSourceContext]
  )
  const linkedJiraIssueRefsSignature = JSON.stringify(linkedJiraIssueRefs)
  const displayedJiraIssues = useMemo(
    () =>
      (jiraHasWorkspace ? filterLinkedJiraIssues(jiraIssues, appliedJiraSearch) : jiraIssues).map(
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
    [
      jiraIssues,
      jiraHasWorkspace,
      appliedJiraSearch,
      jiraCacheSnapshot.issueCache,
      jiraCacheSnapshot.searchCache,
      jiraTaskSourceContext
    ]
  )
  const displayedJiraProjectScope = useMemo(
    () => getSingleJiraProjectScope(displayedJiraIssues),
    [displayedJiraIssues]
  )
  const statusOrderRuntimeScopeKey = getTaskPageJiraStatusOrderRuntimeScopeKey(
    jiraTaskSourceScopeKey,
    ipcOrRuntimeTargetForHostId(jiraTaskSourceContext?.hostId ?? accountBackedTaskSourceHostId)
  )
  const displayedJiraStatusOrderScopeKey = displayedJiraProjectScope
    ? getTaskPageJiraStatusOrderScopeKey(statusOrderRuntimeScopeKey, displayedJiraProjectScope)
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
  return Object.assign(model, {
    displayedJiraIssues,
    displayedJiraProjectScope,
    displayedJiraStatusOrderScopeKey,
    displayedJiraStatusOrder,
    sortedJiraIssues,
    getJiraIssueWorkspaces,
    linkedJiraIssueRefs,
    linkedJiraIssueRefsSignature
  })
}
export type TaskPageJiraListProjectionModel = ReturnType<typeof useTaskPageJiraListProjection>
