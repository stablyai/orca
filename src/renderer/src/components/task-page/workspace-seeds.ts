import { getLinkedWorkItemSuggestedName, getLinkedWorkItemWorkspaceName } from '@/lib/new-workspace'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { GitLabWorkItem } from '../../../../shared/gitlab-types'
import type { JiraIssue } from '../../../../shared/jira-types'
import type { KanbanTaskDetails, KanbanTaskSummary } from '../../../../shared/kanban-types'

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

export function getKanbanTaskWorkspaceSeed(task: KanbanTaskSummary): string {
  return (
    getLinkedWorkItemWorkspaceName({
      type: 'issue',
      provider: 'kanban',
      number: 0,
      title: `${task.id} ${task.title}`,
      kanbanIdentifier: task.id
    })?.seedName ?? getLinkedWorkItemSuggestedName({ title: `${task.id} ${task.title}` })
  )
}

export function buildKanbanTaskStartupDraft(args: {
  task: KanbanTaskSummary
  details: KanbanTaskDetails | null
}): string {
  const { task, details } = args
  const result = details?.result?.trim() || 'не указан'
  const description = details?.description?.trim() || 'не указан'
  const due = task.due ?? 'не указан'
  return [
    `Kanban ${task.id}: ${task.title}`,
    '',
    'Результат:',
    result,
    '',
    'Описание:',
    description,
    '',
    `Срок: ${due}`,
    `Карточка: https://kanban.fpimi.ru/?task=${encodeURIComponent(task.id)}`
  ].join('\n')
}
