import { buildGitHubRepoUrl, parseGitHubIssueOrPRLink } from '../github/repositories/links'
import type { GitHubRepositoryIdentity as GitHubOwnerRepo } from '../github/repositories/repository-identity'
import type { Worktree } from './types'

type GitHubLinkedItemType = 'issue' | 'pr'

export function getGitHubItemUrlRepository(
  url: string | undefined,
  type: GitHubLinkedItemType,
  itemNumber: number | null | undefined
): GitHubOwnerRepo | undefined {
  const link = url ? parseGitHubIssueOrPRLink(url) : null
  return link?.type === type && link.number === itemNumber ? link.slug : undefined
}

/** The saved URL of a linked GitHub item; its repository can differ from every git remote (fork checkouts). */
export function getWorktreeGitHubItemUrl(
  worktree: Pick<Worktree, 'linkedWorkItem' | 'linkedItems'>,
  type: GitHubLinkedItemType,
  itemNumber: number | null | undefined
): string | undefined {
  if (!itemNumber) {
    return undefined
  }
  // linkedWorkItem may select a non-GitHub task while the linked number comes from linkedItems.
  return [worktree.linkedWorkItem, ...(worktree.linkedItems ?? [])].find(
    (item) =>
      item?.provider === 'github' &&
      item.type === type &&
      item.number === itemNumber &&
      getGitHubItemUrlRepository(item.url, type, itemNumber)
  )?.url
}

/** The linked PR's saved URL reduced to its canonical form, a bounded and stable read identity. */
export function getWorktreeGitHubPRUrl(
  worktree: Pick<Worktree, 'linkedWorkItem' | 'linkedItems'>,
  prNumber: number | null | undefined
): string | undefined {
  const url = getWorktreeGitHubItemUrl(worktree, 'pr', prNumber)
  const repoUrl = buildGitHubRepoUrl(getGitHubItemUrlRepository(url, 'pr', prNumber))
  return repoUrl ? `${repoUrl}/pull/${prNumber}` : undefined
}
