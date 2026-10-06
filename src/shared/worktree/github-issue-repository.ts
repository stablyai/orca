import { parseGitHubIssueOrPRLink } from '../github/links'
import type { GitHubOwnerRepo } from '../github/pull-request-types'
import type { Worktree } from './types'

export function getWorktreeGitHubIssueRepository(
  worktree: Pick<Worktree, 'linkedIssue' | 'linkedWorkItem'>
): GitHubOwnerRepo | undefined {
  const item = worktree.linkedWorkItem
  if (
    !worktree.linkedIssue ||
    item?.provider !== 'github' ||
    item.type !== 'issue' ||
    item.number !== worktree.linkedIssue
  ) {
    return undefined
  }
  const link = parseGitHubIssueOrPRLink(item.url)
  return link?.type === 'issue' && link.number === worktree.linkedIssue ? link.slug : undefined
}
