import { foldComparableGitLabHost } from '../../../shared/git-remote-host-alias'
import {
  matchGitRemoteKeyParts,
  splitGitRemoteKey,
  type GitRemoteKeyParts
} from '../../../shared/git-remote-identity'
import type { HostedReviewInfo } from '../../../shared/hosted-review'
import {
  parseGitLabIssueOrMRLink,
  type ProjectSlug
} from '../../../shared/new-workspace/gitlab-links'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'

export type GitLabIssueOrMRLink = NonNullable<ReturnType<typeof parseGitLabIssueOrMRLink>>

/** Host + project path, matching how `GitRemoteIdentity.canonicalKey` is built. */
function gitLabProjectKeyParts(slug: ProjectSlug): GitRemoteKeyParts {
  return {
    host: foldComparableGitLabHost(slug.host.replace(/:\d+$/, '')),
    tail: slug.path
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
      .replace(/\.git$/i, '')
      .toLowerCase()
  }
}

function gitLabProjectKey(slug: ProjectSlug): string {
  const { host, tail } = gitLabProjectKeyParts(slug)
  return `${host}/${tail}`
}

function gitLabLinksEqual(left: GitLabIssueOrMRLink, right: GitLabIssueOrMRLink): boolean {
  return (
    left.type === right.type &&
    left.number === right.number &&
    gitLabProjectKey(left.slug) === gitLabProjectKey(right.slug)
  )
}

/** Tri-state: `'unknown'` (no identity, or an unexpanded SSH host alias) stays permissive. */
function repoMatchesGitLabSlug(repo: Repo | undefined, slug: ProjectSlug): boolean | 'unknown' {
  const identityParts = splitGitRemoteKey(
    repo?.gitRemoteIdentity?.canonicalKey,
    foldComparableGitLabHost
  )
  if (!identityParts) {
    return 'unknown'
  }
  // Why trust a project-path mismatch whichever remote it came from: a resolved identity is
  // re-probed once a repo/project list sweep finds it past its ~6h TTL, so it is not frozen at the
  // moment the repo was added. Accepted cost: only one remote is stored, so a fork whose `upstream`
  // outranks its own `origin` loses bare-iid matches for MR URLs on the fork.
  return matchGitRemoteKeyParts(identityParts, gitLabProjectKeyParts(slug))
}

export function worktreeMatchesGitLabUrl(
  worktree: Worktree,
  link: GitLabIssueOrMRLink,
  repo: Repo | undefined,
  review: HostedReviewInfo | null | undefined
): boolean {
  const linkedUrl = worktree.linkedWorkItem?.url
    ? parseGitLabIssueOrMRLink(worktree.linkedWorkItem.url)
    : null
  if (linkedUrl && gitLabLinksEqual(linkedUrl, link)) {
    return true
  }

  const reviewUrl =
    review?.provider === 'gitlab' && review.url ? parseGitLabIssueOrMRLink(review.url) : null
  if (reviewUrl && gitLabLinksEqual(reviewUrl, link)) {
    return true
  }

  const linkedItem = worktree.linkedWorkItem
  const linkedItemMatches =
    linkedItem?.provider === 'gitlab' &&
    linkedItem.type === link.type &&
    linkedItem.number === link.number
  const numberMatches =
    linkedItemMatches ||
    (link.type === 'mr'
      ? worktree.linkedGitLabMR === link.number
      : worktree.linkedGitLabIssue === link.number)
  if (!numberMatches) {
    return false
  }

  // Why: iids are per-project, so a bare number only survives when the repo remote agrees.
  const repoMatch = repoMatchesGitLabSlug(repo, link.slug)
  if (repoMatch !== 'unknown') {
    return repoMatch
  }
  // Identity unresolvable: stay permissive unless the stored URL names the same type+number in a
  // different project, which is a contradiction rather than a plausible cross-project reference.
  return !(linkedUrl && linkedUrl.type === link.type && linkedUrl.number === link.number)
}
