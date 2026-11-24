import type { ClickUpTask } from '../../../../shared/clickup/clickup-types'
import type { GitHubWorkItem } from '../../../../shared/github/work-items/work-item-types'
import type { GitLabWorkItem } from '../../../../shared/gitlab/gitlab-types'
import type { JiraIssue } from '../../../../shared/jira/jira-types'
import type { LinearIssue } from '../../../../shared/linear/issue-types'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../shared/work-items/task-source-context'
import { parseCmdJTaskSourceUrl } from '@/lib/workspace/search/worktrees/worktree-palette-task-url-match'
import { isWorktreePaletteQueryTooLarge } from '../../../../shared/palette-match/worktree-palette-query-bounds'

export type CmdJTask =
  | { provider: 'linear'; issue: LinearIssue }
  | { provider: 'jira'; issue: JiraIssue }
  | { provider: 'github'; issue: GitHubWorkItem }
  | { provider: 'gitlab'; issue: GitLabWorkItem }
  | { provider: 'clickup'; task: ClickUpTask }

export type CmdJTaskSearchResult = {
  id: string
  task: CmdJTask
  title: string
  identifier: string
  status: string
  sourceContext: TaskSourceContext
  initialRepoId: string | null
  hostLabel: string
}

export function isCmdJTaskSearchQuery(query: string): boolean {
  const text = query.trim()
  return (
    text.length >= 2 &&
    !isWorktreePaletteQueryTooLarge(text) &&
    !/^\w+:\/\//.test(text) &&
    !parseCmdJTaskSourceUrl(text)
  )
}

export function describeCmdJTask(task: CmdJTask): {
  identifier: string
  status: string
  title: string
  url: string
} {
  switch (task.provider) {
    case 'linear':
      return {
        identifier: task.issue.identifier,
        status: task.issue.state.name,
        title: task.issue.title,
        url: task.issue.url
      }
    case 'jira':
      return {
        identifier: task.issue.key,
        status: task.issue.status.name,
        title: task.issue.title,
        url: task.issue.url
      }
    case 'clickup':
      return {
        identifier: task.task.customId ?? task.task.id,
        status: task.task.status.name,
        title: task.task.name,
        url: task.task.url
      }
    case 'github':
    case 'gitlab':
      return {
        identifier: `#${task.issue.number}`,
        status: task.issue.state,
        title: task.issue.title,
        url: task.issue.url
      }
  }
}

export function makeCmdJTaskSearchResult(
  task: CmdJTask,
  sourceContext: TaskSourceContext,
  initialRepoId: string | null,
  hostLabel: string
): CmdJTaskSearchResult {
  const { identifier, status, title, url } = describeCmdJTask(task)
  return {
    id: `task:${getTaskSourceCacheScope(sourceContext)}:${url}`,
    task,
    title,
    identifier,
    status,
    sourceContext,
    initialRepoId,
    hostLabel
  }
}

export function mergeCmdJTaskSearchResults(
  groups: readonly (readonly CmdJTaskSearchResult[])[]
): CmdJTaskSearchResult[] {
  const results = new Map<string, CmdJTaskSearchResult>()
  for (const group of groups) {
    for (const result of group) {
      results.set(result.id, result)
    }
  }
  return [...results.values()]
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
    .slice(0, 30)
}
