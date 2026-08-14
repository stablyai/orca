import type { HostedReviewInfo } from '../../../shared/hosted-review'
import {
  parseGitLabIssueOrMRLink,
  type ProjectSlug
} from '../../../shared/new-workspace/gitlab-links'
import type { Repo, Worktree } from '../../../shared/types'

export type GitLabIssueOrMRLink = NonNullable<ReturnType<typeof parseGitLabIssueOrMRLink>>

/** Same shape as `GitRemoteIdentity.canonicalKey`: lowercased host (no port) + normalized project path. */
function gitLabProjectKey(slug: ProjectSlug): string {
  const host = slug.host.replace(/:\d+$/, '').toLowerCase()
  const path = slug.path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .toLowerCase()
  return `${host}/${path}`
}

function gitLabLinksEqual(left: GitLabIssueOrMRLink, right: GitLabIssueOrMRLink): boolean {
  return (
    left.type === right.type &&
    left.number === right.number &&
    gitLabProjectKey(left.slug) === gitLabProjectKey(right.slug)
  )
}

/** Tri-state like `repoMatchesGitHubSlug`: `'unknown'` stays permissive for forks and host aliases. */
function repoMatchesGitLabSlug(repo: Repo | undefined, slug: ProjectSlug): boolean | 'unknown' {
  const identity = repo?.gitRemoteIdentity
  if (!identity?.canonicalKey) {
    return 'unknown'
  }
  if (identity.canonicalKey.replace(/\/+$/, '').toLowerCase() === gitLabProjectKey(slug)) {
    return true
  }
  // Why not false: identity keeps one remote, chosen when the repo was added and never re-probed.
  // An `upstream` pick means a fork's `origin` existed and is invisible here, so rejecting would
  // drop MR URLs from the fork itself. A stale snapshot can still misjudge a renamed project.
  return identity.remoteName === 'upstream' ? 'unknown' : false
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
