import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { GitLabWorkItem } from '../../../../shared/gitlab-types'
import type { JiraIssue } from '../../../../shared/jira/jira-types'
import type { LinearIssue } from '../../../../shared/linear/issue-types'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../shared/task-source-context'
import { parseCmdJTaskSourceUrl } from '@/lib/worktree-palette-task-url-match'
import { isWorktreePaletteQueryTooLarge } from '@/lib/worktree-palette-query-bounds'

export type CmdJTask =
  | { provider: 'linear'; issue: LinearIssue }
  | { provider: 'jira'; issue: JiraIssue }
  | { provider: 'github'; issue: GitHubWorkItem }
  | { provider: 'gitlab'; issue: GitLabWorkItem }

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

export function makeCmdJTaskSearchResult(
  task: CmdJTask,
  sourceContext: TaskSourceContext,
  initialRepoId: string | null,
  hostLabel: string
): CmdJTaskSearchResult {
  const identifier =
    task.provider === 'linear'
      ? task.issue.identifier
      : task.provider === 'jira'
        ? task.issue.key
        : `#${task.issue.number}`
  const status =
    task.provider === 'linear'
      ? task.issue.state.name
      : task.provider === 'jira'
        ? task.issue.status.name
        : task.issue.state
  return {
    id: `task:${getTaskSourceCacheScope(sourceContext)}:${task.issue.url}`,
    task,
    title: task.issue.title,
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
