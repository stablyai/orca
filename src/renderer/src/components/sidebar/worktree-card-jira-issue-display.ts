import type { Worktree, WorktreeCardProperty } from '../../../../shared/types'
import type { WorktreeCardJiraIssueDisplay } from './worktree-card-meta-types'
import { resolveJiraIssueLink } from '../../../../shared/jira-issue-link'

export function getWorktreeCardJiraIssueDisplay(
  worktree: Pick<Worktree, 'linkedJiraIssue' | 'linkedWorkItem'>
): WorktreeCardJiraIssueDisplay | null {
  const issue = resolveJiraIssueLink(worktree)
  if (!issue) {
    return null
  }
  return {
    identifier: issue.key,
    title: issue.title,
    url: issue.url
  }
}

export function getConfiguredWorktreeCardJiraIssueDisplay(
  worktree: Pick<Worktree, 'linkedJiraIssue' | 'linkedWorkItem'>,
  properties: readonly WorktreeCardProperty[]
): WorktreeCardJiraIssueDisplay | null {
  return properties.includes('jira-issue') ? getWorktreeCardJiraIssueDisplay(worktree) : null
}
