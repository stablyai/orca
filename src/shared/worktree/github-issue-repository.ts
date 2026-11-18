import type { GitHubRepositoryIdentity as GitHubOwnerRepo } from '../github/repositories/repository-identity'
import { getGitHubItemUrlRepository, getWorktreeGitHubItemUrl } from './github-linked-item-url'
import type { Worktree } from './types'

export function getGitHubIssueUrlRepository(
  url: string | undefined,
  issueNumber: number
): GitHubOwnerRepo | undefined {
  return getGitHubItemUrlRepository(url, 'issue', issueNumber)
}

export function getWorktreeGitHubIssueUrl(
  worktree: Pick<Worktree, 'linkedIssue' | 'linkedWorkItem' | 'linkedItems'>
): string | undefined {
  return getWorktreeGitHubItemUrl(worktree, 'issue', worktree.linkedIssue)
}

export function getWorktreeGitHubIssueRepository(
  worktree: Pick<Worktree, 'linkedIssue' | 'linkedWorkItem' | 'linkedItems'>
): GitHubOwnerRepo | undefined {
  return worktree.linkedIssue
    ? getGitHubIssueUrlRepository(getWorktreeGitHubIssueUrl(worktree), worktree.linkedIssue)
    : undefined
}
