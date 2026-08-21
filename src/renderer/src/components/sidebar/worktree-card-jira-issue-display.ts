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
  if (item?.provider !== 'jira' || item.type !== 'issue') {
    return null
  }
  const identifier = item.jiraIdentifier ?? String(item.number)
  return {
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
