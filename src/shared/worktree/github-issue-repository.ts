import { parseGitHubIssueOrPRLink } from '../github/repositories/links'
import type { GitHubRepositoryIdentity as GitHubOwnerRepo } from '../github/repositories/repository-identity'
import type { Worktree } from './types'

export function getGitHubIssueUrlRepository(
  url: string | undefined,
  issueNumber: number
): GitHubOwnerRepo | undefined {
  const link = url ? parseGitHubIssueOrPRLink(url) : null
  return link?.type === 'issue' && link.number === issueNumber ? link.slug : undefined
}

export function getWorktreeGitHubIssueUrl(
  worktree: Pick<Worktree, 'linkedIssue' | 'linkedWorkItem' | 'linkedItems'>
): string | undefined {
  const issueNumber = worktree.linkedIssue
  if (!issueNumber) {
    return undefined
  }
  // linkedWorkItem may select a non-GitHub task while linkedIssue comes from linkedItems.
  return [worktree.linkedWorkItem, ...(worktree.linkedItems ?? [])].find(
    (item) =>
      item?.provider === 'github' &&
      item.type === 'issue' &&
      item.number === issueNumber &&
      getGitHubIssueUrlRepository(item.url, issueNumber)
  )?.url
}

export function getWorktreeGitHubIssueRepository(
  worktree: Pick<Worktree, 'linkedIssue' | 'linkedWorkItem' | 'linkedItems'>
): GitHubOwnerRepo | undefined {
  return worktree.linkedIssue
    ? getGitHubIssueUrlRepository(getWorktreeGitHubIssueUrl(worktree), worktree.linkedIssue)
    : undefined
}
