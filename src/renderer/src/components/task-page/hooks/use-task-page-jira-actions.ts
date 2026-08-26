import { useCallback } from 'react'
import { toast } from 'sonner'

import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import { bindTaskPageJiraItemSourceContext } from '@/components/task-page-jira-item-source-context'
import { getJiraIssueWorkspaceSeed } from '@/components/task-page/workspace-seeds'
import type { JiraIssue, JiraSite } from '../../../../../shared/jira-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { AppState } from '@/store/types'

export function useTaskPageJiraActions({
  jiraSites,
  jiraTaskSourceContext,
  openModal
}: {
  jiraSites: readonly JiraSite[]
  jiraTaskSourceContext: TaskSourceContext | null
  openModal: AppState['openModal']
}) {
  const openComposerForJiraItem = useCallback(
    (issue: JiraIssue): boolean => {
      const taskSourceContext = bindTaskPageJiraItemSourceContext({
        issue,
        sites: jiraSites,
        sourceContext: jiraTaskSourceContext
      })
      if (!taskSourceContext) {
        // Why: composer drops Jira items without matching source context — refuse rather than create unlinked.
        toast.error(
          translate(
            'auto.components.TaskPage.jiraLinkSourceUnavailable',
            'Couldn’t link this Jira issue. Reconnect Jira or pick the matching site, then try again.'
          )
        )
        return false
      }
      const linkedWorkItem: LinkedWorkItemSummary = {
        type: 'issue',
        provider: 'jira',
        number: 0,
        title: `${issue.key} ${issue.title}`,
        url: issue.url,
        jiraIdentifier: issue.key
      }
      openModal('new-workspace-composer', {
        linkedWorkItem,
        taskSourceContext,
        prefilledName: getJiraIssueWorkspaceSeed(issue),
        telemetrySource: 'sidebar'
      })
      return true
    },
    [jiraSites, jiraTaskSourceContext, openModal]
  )

  const handleUseJiraItem = useCallback(
    (issue: JiraIssue): void => {
      // Why: record provider depth only when the issue actually reaches the composer.
      if (openComposerForJiraItem(issue)) {
        useAppStore.getState().recordFeatureInteraction('jira-tasks')
      }
    },
    [openComposerForJiraItem]
  )

  return {
    openComposerForJiraItem,
    handleUseJiraItem
  }
}
