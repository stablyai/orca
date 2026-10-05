import type { WorktreeCardProperty } from '../../../../shared/ui-chrome-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { WorktreeCardJiraIssueDisplay } from './worktree-card-meta-types'

function withoutRepeatedJiraIdentifier(title: string, identifier: string): string {
  const escapedIdentifier = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const stripped = title
    .replace(new RegExp(`^${escapedIdentifier}(?:\\s*[:—-]\\s*|\\s+)`, 'i'), '')
    .trim()
  return stripped || title
}

export function getWorktreeCardJiraIssueDisplay(
  worktree: Pick<Worktree, 'linkedWorkItem'>
): WorktreeCardJiraIssueDisplay | null {
  const item = worktree.linkedWorkItem
  if (item?.type !== 'issue' || (item.provider !== 'jira' && item.provider !== 'youtrack')) {
    return null
  }
  const identifier =
    (item.provider === 'youtrack' ? item.youtrackIdentifier : item.jiraIdentifier) ??
    String(item.number)
  return {
    ...(item.provider === 'youtrack' ? { provider: 'youtrack' as const } : {}),
    identifier,
    title: withoutRepeatedJiraIdentifier(item.title, identifier),
    url: item.url
  }
}

export function getConfiguredWorktreeCardJiraIssueDisplay(
  worktree: Pick<Worktree, 'linkedWorkItem'>,
  properties: readonly WorktreeCardProperty[]
): WorktreeCardJiraIssueDisplay | null {
  return properties.includes('jira-issue') ? getWorktreeCardJiraIssueDisplay(worktree) : null
}
