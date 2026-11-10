import type { AppState } from '../../types'
import type { GitHubOwnerRepo, PRInfo } from '../../../../../shared/github/pull-request-types'
import type { PRRefreshOutcome } from '../../../../../shared/github/pull-request-refresh-types'
import type { HostedReviewInfo } from '../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import type { Repo } from '../../../../../shared/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import { parseGitHubIssueOrPRLink } from '../../../../../shared/github/links'
import {
  githubRepoIdentityKey,
  isDefaultGitHubHost
} from '../../../../../shared/github/repository-identity-key'
import { getWorkspaceAttachments } from '../../../../../shared/workspace-attachments/workspace-attachments'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host'
import { isWorkspaceRepositoryAttachment } from '@/components/sidebar/workspace-card/metadata/worktree-attachment-editing'
import type { LinkedReviewHints } from '../../slices/hosted-review/hosted-review-cache-identity'
import {
  worktreeHostMatchOptions,
  worktreeMatchesHost
} from '../../slices/worktrees/listing/worktree-host-ownership'
import { selectWorktreesByRepo } from '../../workspaces/catalog/workspace-record-fields'
import { resolveReviewRepository } from '@/lib/review-owner'
import type { HostedReviewClearUpdates } from '../../../../../shared/worktree/hosted-review-branch-ownership'

/**
 * The repository of the row's selected GitHub PR when its stored URL points
 * outside the row's own repository. Null (bare numbers, same-repo URLs) keeps
 * the lookup against the row's remotes; the host re-checks against its remotes.
 * Without a known repo a URL link counts as another repository's, so destructive
 * rules (branch-switch clears, push targets) fail closed.
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

/** A branch switch never unselects another repository's PR, whose branches never name this worktree. */
export function keepOtherRepositoryPRLink(
  clear: HostedReviewClearUpdates | null,
  worktree: Worktree,
  repos: readonly Repo[]
): HostedReviewClearUpdates | null {
  const repo = clear ? (resolveReviewRepository(repos, worktree) ?? undefined) : undefined
  if (!clear || !getLinkedGitHubPRRepository(worktree, repo)) {
    return clear
  }
  return 'pushTarget' in clear && worktree.pushTarget !== undefined
    ? { pushTarget: undefined }
    : null
}

/**
 * Branch-keyed lookups are shared by every caller, so each one resolves the
 * linked PR's repository from the row on that branch rather than trusting the
 * caller to pass it; a caller that forgot would cache a miss for everyone.
 */
export function findLinkedGitHubPRRepository(
  state: Pick<AppState, 'worktreesByRepo' | 'repos'>,
  repo: Repo | undefined,
  branch: string,
  linkedPRNumber: number | null | undefined
): GitHubOwnerRepo | null {
  if (!repo || linkedPRNumber == null) {
    return null
  }
  const branchName = branch.replace(/^refs\/heads\//, '')
  // Why: one repo id can hold rows on several hosts; only this repo's host owns the lookup.
  const hostId = getRepoExecutionHostId(repo)
  const hostMatch = worktreeHostMatchOptions(state, repo.id, hostId)
  const owners = (selectWorktreesByRepo(state)?.[repo.id] ?? []).filter(
    (worktree) =>
      worktree.linkedPR === linkedPRNumber &&
      worktree.branch.replace(/^refs\/heads\//, '') === branchName &&
      worktreeMatchesHost(worktree, hostId, hostMatch)
  )
  // Why the request's Repo: the rows matched its host, so it is the Repo each one is read under.
  return owners.length === 1 ? getLinkedGitHubPRRepository(owners[0], repo) : null
}

export function withLinkedGitHubPRRepository<T extends LinkedReviewHints>(
  state: Pick<AppState, 'worktreesByRepo' | 'repos'>,
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

function isPRFromRepository(url: string, repository: GitHubOwnerRepo): boolean {
  const link = parseGitHubIssueOrPRLink(url)
  return link !== null && githubRepoIdentityKey(link.slug) === githubRepoIdentityKey(repository)
}

/**
 * The found PR only when it lives in the linked repository: an older host that
 * ignores the repository answers with the row's own PR of that number.
 */
export function foundPRForLinkedRepository(
  outcome: PRRefreshOutcome,
  linkedPRRepository: GitHubOwnerRepo | null
): PRInfo | null {
  if (outcome.kind !== 'found') {
    return null
  }
  return !linkedPRRepository || isPRFromRepository(outcome.pr.url, linkedPRRepository)
    ? outcome.pr
    : null
}

/** Same guard for provider-neutral review results. */
export function reviewForLinkedRepository(
  review: HostedReviewInfo | null,
  linkedGitHubPRRepository: GitHubOwnerRepo | null | undefined
): HostedReviewInfo | null {
  return review?.provider === 'github' &&
    linkedGitHubPRRepository &&
    !isPRFromRepository(review.url, linkedGitHubPRRepository)
    ? null
    : review
}

/** Whether a cached linked PR still answers the link, whose repository can change while its number stays. */
export function isCachedPRForLinkedRepository(
  pr: PRInfo | null | undefined,
  linkedPRNumber: number | null,
  linkedPRRepository: GitHubOwnerRepo | null
): boolean {
  if (!pr || pr.number !== linkedPRNumber) {
    return true
  }
  return linkedPRRepository
    ? isPRFromRepository(pr.url, linkedPRRepository)
    : pr.linkedFromOtherRepository !== true
}

function repositoryKey(repository: GitHubOwnerRepo | null | undefined): string | null {
  return repository ? githubRepoIdentityKey(repository) : null
}

/** Whether the branch's row moved a branch lookup's link to another repository while it ran. */
export function isLinkMovedToOtherRepository(
  state: Pick<AppState, 'worktreesByRepo' | 'repos'>,
  repo: Repo | undefined,
  branch: string,
  requested: (LinkedReviewHints & { exactReviewKey?: string }) | undefined,
  sent: LinkedReviewHints | undefined
): boolean {
  if (requested?.exactReviewKey) {
    return false
  }
  // Why: re-derive from the row; a caller-supplied repository only says what was asked.
  const current = withLinkedGitHubPRRepository(state, repo, branch, {
    ...requested,
    linkedGitHubPRRepository: undefined
  })
  return (
    repositoryKey(current?.linkedGitHubPRRepository) !==
    repositoryKey(sent?.linkedGitHubPRRepository)
  )
}
