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
import { getWorkspaceAttachments } from '../../../shared/workspace-attachments'
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
  const attachments = getWorkspaceAttachments(worktree).filter((item) => item.provider === 'gitlab')
  const attached = attachments.some((item) => {
    const itemUrl = item.url ? parseGitLabIssueOrMRLink(item.url) : null
    if (itemUrl) {
      return gitLabLinksEqual(itemUrl, link)
    }
    return (
      item.type === link.type &&
      item.number === link.number &&
      repoMatchesGitLabSlug(repo, link.slug) !== false
    )
  })
  const reviewUrl =
    review?.provider === 'gitlab' && review.url ? parseGitLabIssueOrMRLink(review.url) : null
  const legacyItem = worktree.linkedWorkItem
  const legacyNumberMatch =
    !legacyItem?.url &&
    legacyItem?.provider === 'gitlab' &&
    legacyItem.type === link.type &&
    legacyItem.number === link.number &&
    repoMatchesGitLabSlug(repo, link.slug) !== false
  return attached || legacyNumberMatch || Boolean(reviewUrl && gitLabLinksEqual(reviewUrl, link))
}
