import { parseGitHubIssueOrPRLink } from '../../../../shared/github/links'
import type { HostedReviewProvider } from '../../../../shared/hosted-review'
import type { IssueReferenceTarget } from '../../../../shared/linked-issue-provider'
import { parseGitLabIssueOrMRLink } from '../../../../shared/new-workspace/gitlab-links'
import type { WorkspaceLinkedItem } from '../../../../shared/worktree/types'

function targetFromUrl(
  provider: string | null | undefined,
  url: string | null | undefined
): IssueReferenceTarget | null {
  if (!url) {
    return null
  }
  if (provider === 'github') {
    const slug = parseGitHubIssueOrPRLink(url)?.slug
    return slug ? { provider: 'github', slug } : null
  }
  if (provider === 'gitlab') {
    const slug = parseGitLabIssueOrMRLink(url)?.slug
    return slug ? { provider: 'gitlab', slug } : null
  }
  return null
}

/** Where a bare `#123` in this workspace's text should resolve. Derived from a URL
 *  the workspace already holds — the work item it was created from, else its linked
 *  review — because that URL is the only thing that proves the host, and a
 *  self-hosted GitLab or GHES server cannot be guessed from a provider name alone.
 *  Null means "we do not know", and the caller renders plain text, as it does today. */
export function resolveWorkspaceIssueReferenceTarget(args: {
  linkedWorkItem?: WorkspaceLinkedItem | null
  reviewProvider?: HostedReviewProvider | null
  reviewUrl?: string | null
}): IssueReferenceTarget | null {
  return (
    targetFromUrl(args.linkedWorkItem?.provider, args.linkedWorkItem?.url) ??
    targetFromUrl(args.reviewProvider, args.reviewUrl)
  )
}
