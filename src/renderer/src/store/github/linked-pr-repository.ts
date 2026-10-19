import type { AppState } from '../types'
import type { GitHubOwnerRepo } from '../../../../shared/github/pull-request-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { parseGitHubIssueOrPRLink } from '../../../../shared/github/links'
import {
  githubRepoIdentityKey,
  isDefaultGitHubHost
} from '../../../../shared/github/repository-identity-key'
import { getWorkspaceAttachments } from '../../../../shared/workspace-attachments'
import { isWorkspaceRepositoryAttachment } from '@/components/sidebar/worktree-attachment-editing'
import type { LinkedReviewHints } from '../slices/hosted-review-cache-identity'

/**
 * The repository of the row's selected GitHub PR when its stored URL points
 * outside the row's own repository. Null (bare numbers, same-repo URLs) keeps
 * the lookup against the row's remotes; the host re-checks against its remotes.
 */
export function getLinkedGitHubPRRepository(
  worktree: Worktree,
  repo: Repo | undefined
): GitHubOwnerRepo | null {
  if (worktree.linkedPR == null) {
    return null
  }
  // Same selection rule as getActiveWorkspaceReviewKey: the first GitHub PR with the linked number.
  const item = getWorkspaceAttachments(worktree).find(
    (attachment) =>
      attachment.provider === 'github' &&
      attachment.type === 'pr' &&
      attachment.number === worktree.linkedPR
  )
  if (!item?.url || isWorkspaceRepositoryAttachment(item, repo)) {
    return null
  }
  const link = parseGitHubIssueOrPRLink(item.url)
  if (link?.type !== 'pr' || link.number !== item.number) {
    return null
  }
  const { owner, repo: name, host } = link.slug
  const linked = { owner, repo: name, ...(host && !isDefaultGitHubHost(host) ? { host } : {}) }
  // A fork's parent is one of the row's own remotes, so its PRs keep today's lookup.
  const isForkParent =
    repo?.upstream && githubRepoIdentityKey(repo.upstream) === githubRepoIdentityKey(linked)
  return isForkParent ? null : linked
}

/**
 * Branch-keyed lookups are shared by every caller, so each one resolves the
 * linked PR's repository from the row on that branch rather than trusting the
 * caller to pass it; a caller that forgot would cache a miss for everyone.
 */
export function findLinkedGitHubPRRepository(
  state: Pick<AppState, 'worktreesByRepo'>,
  repo: Repo | undefined,
  branch: string,
  linkedPRNumber: number | null | undefined
): GitHubOwnerRepo | null {
  if (!repo || linkedPRNumber == null) {
    return null
  }
  const branchName = branch.replace(/^refs\/heads\//, '')
  const owners = (state.worktreesByRepo?.[repo.id] ?? []).filter(
    (worktree) =>
      worktree.linkedPR === linkedPRNumber &&
      worktree.branch.replace(/^refs\/heads\//, '') === branchName
  )
  return owners.length === 1 ? getLinkedGitHubPRRepository(owners[0], repo) : null
}

export function withLinkedGitHubPRRepository<T extends LinkedReviewHints>(
  state: Pick<AppState, 'worktreesByRepo'>,
  repo: Repo | undefined,
  branch: string,
  hints: T | undefined
): T | undefined {
  if (!hints || hints.linkedGitHubPRRepository !== undefined) {
    return hints
  }
  const linkedGitHubPRRepository = findLinkedGitHubPRRepository(
    state,
    repo,
    branch,
    hints.linkedGitHubPR
  )
  return linkedGitHubPRRepository ? { ...hints, linkedGitHubPRRepository } : hints
}
