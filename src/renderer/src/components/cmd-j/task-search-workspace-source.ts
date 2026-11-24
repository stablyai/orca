import type { LinkedWorkItemSummary } from '@/lib/workspace/creation/new-workspace'
import { getClickUpTaskWorkspaceSeed } from '@/lib/work-items/clickup/clickup-task-workspace-seed'
import {
  buildClickUpWorkspaceSource,
  buildLinearWorkspaceSource
} from '../../../../shared/new-workspace/workspace-source'
import {
  getLinearIssueWorkspaceName,
  getLinkedWorkItemSuggestedName,
  getLinkedWorkItemWorkspaceName
} from '../../../../shared/workspace/naming/workspace-name'
import { getJiraIssueWorkspaceSeed } from '../task-page/task-page-source-context'
import type { CmdJTask } from './task-search-results'

// Linear and ClickUp ids are strings, so their linked items carry the provider-generic number 0.
export function buildCmdJLinkedWorkItem(task: CmdJTask): LinkedWorkItemSummary {
  switch (task.provider) {
    case 'linear':
      return buildLinearWorkspaceSource(task.issue)
    case 'clickup':
      return buildClickUpWorkspaceSource(task.task)
    case 'jira':
      return {
        provider: 'jira',
        type: 'issue',
        number: 0,
        title: task.issue.title,
        url: task.issue.url,
        jiraIdentifier: task.issue.key
      }
    case 'github':
    case 'gitlab':
      return {
        provider: task.provider,
        type: 'issue',
        number: task.issue.number,
        title: task.issue.title,
        url: task.issue.url
      }
  }
}

export function getCmdJWorkspaceSeed(
  task: CmdJTask,
  linkedWorkItem: LinkedWorkItemSummary
): string {
  switch (task.provider) {
    case 'linear':
      return getLinearIssueWorkspaceName(task.issue)
    case 'jira':
      return getJiraIssueWorkspaceSeed(task.issue)
    case 'clickup':
      return getClickUpTaskWorkspaceSeed(task.task)
    case 'github':
    case 'gitlab':
      return (
        getLinkedWorkItemWorkspaceName(linkedWorkItem)?.seedName ??
        getLinkedWorkItemSuggestedName(linkedWorkItem)
      )
  }
}
