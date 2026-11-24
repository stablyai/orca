import type { GitHubWorkItem } from '../../../../../shared/github/work-items/work-item-types'
import type { ClickUpTask } from '../../../../../shared/clickup/clickup-types'
import type { JiraIssue } from '../../../../../shared/jira/jira-types'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type { GitLabWorkItem } from '../../../../../shared/gitlab/gitlab-types'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../../shared/work-items/task-source-context'

export type WorktreeNavHistoryTaskDetailEntry =
  | {
      kind: 'task-detail'
      source: 'github'
      workItem: GitHubWorkItem
      sourceContext?: TaskSourceContext | null
      initialTab?: 'conversation' | 'checks' | 'files'
    }
  | {
      kind: 'task-detail'
      source: 'linear'
      issue: LinearIssue
      sourceContext?: TaskSourceContext | null
    }
  | {
      kind: 'task-detail'
      source: 'gitlab'
      workItem: GitLabWorkItem
      sourceContext?: TaskSourceContext | null
    }
  | {
      kind: 'task-detail'
      source: 'jira'
      issue: JiraIssue
      sourceContext?: TaskSourceContext | null
    }
  | {
      kind: 'task-detail'
      source: 'clickup'
      task: ClickUpTask
      sourceContext?: TaskSourceContext | null
    }

export function getTaskDetailHistoryEntryKey(entry: WorktreeNavHistoryTaskDetailEntry): string {
  if (entry.source === 'github') {
    const sourceScope =
      entry.sourceContext?.provider === 'github'
        ? getTaskSourceCacheScope(entry.sourceContext)
        : 'legacy'
    return `view:task-detail:github:${sourceScope}:${entry.workItem.repoId}:${entry.workItem.type}:${entry.workItem.number}:${entry.initialTab ?? 'conversation'}`
  }
  if (entry.source === 'gitlab') {
    const sourceScope =
      entry.sourceContext?.provider === 'gitlab'
        ? getTaskSourceCacheScope(entry.sourceContext)
        : 'legacy'
    return `view:task-detail:gitlab:${sourceScope}:${entry.workItem.repoId}:${entry.workItem.type}:${entry.workItem.number}`
  }
  if (entry.source === 'jira') {
    const sourceScope =
      entry.sourceContext?.provider === 'jira'
        ? getTaskSourceCacheScope(entry.sourceContext)
        : 'legacy'
    return `view:task-detail:jira:${sourceScope}:${entry.issue.siteId ?? 'selected'}:${entry.issue.key}`
  }
  if (entry.source === 'clickup') {
    const sourceScope =
      entry.sourceContext?.provider === 'clickup'
        ? getTaskSourceCacheScope(entry.sourceContext)
        : 'legacy'
    return `view:task-detail:clickup:${sourceScope}:${entry.task.id}`
  }
  const sourceScope =
    entry.sourceContext?.provider === 'linear'
      ? getTaskSourceCacheScope(entry.sourceContext)
      : 'legacy'
  return `view:task-detail:linear:${sourceScope}:${entry.issue.workspaceId ?? 'selected'}:${entry.issue.id}`
}
