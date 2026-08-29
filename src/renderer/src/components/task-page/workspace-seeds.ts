import { getLinkedWorkItemSuggestedName, getLinkedWorkItemWorkspaceName } from '@/lib/new-workspace'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { GitLabWorkItem } from '../../../../shared/gitlab-types'
import type { JiraIssue } from '../../../../shared/jira-types'
import type { VoloTask } from '../../../../shared/volo-types'

export function getGitHubWorkItemWorkspaceSeed(item: GitHubWorkItem): string {
  return getLinkedWorkItemWorkspaceName(item)?.seedName ?? getLinkedWorkItemSuggestedName(item)
}

export function getGitLabWorkItemWorkspaceSeed(item: GitLabWorkItem): string {
  return (
    getLinkedWorkItemWorkspaceName({
      type: item.type,
      provider: 'gitlab',
      number: item.number,
      title: item.title
    })?.seedName ?? getLinkedWorkItemSuggestedName(item)
  )
}

export function getJiraIssueWorkspaceSeed(issue: JiraIssue): string {
  return (
    getLinkedWorkItemWorkspaceName({
      type: 'issue',
      provider: 'jira',
      number: 0,
      title: `${issue.key} ${issue.title}`,
      jiraIdentifier: issue.key
    })?.seedName ?? getLinkedWorkItemSuggestedName(issue)
  )
}

export function getVoloTaskWorkspaceSeed(task: VoloTask): string {
  return (
    getLinkedWorkItemWorkspaceName({
      type: 'issue',
      provider: 'volo',
      number: 0,
      title: `${task.taskCode} ${task.title}`,
      voloIdentifier: task.taskCode
    })?.seedName ?? getLinkedWorkItemSuggestedName(task)
  )
}
