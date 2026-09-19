import type { RepoSlug } from './github/links'
import type { HostedReviewProvider } from './hosted-review'
import type { ProjectSlug } from './new-workspace/gitlab-links'
import { isLinkedIssueNumber } from './source-control-ai-action-variables'
import type { WorkspaceLinkedItem } from './worktree/types'

export type PullRequestLinkedIssueMeta = {
  linkedIssue?: number | null
  linkedGitLabIssue?: number | null
  linkedWorkItem?: WorkspaceLinkedItem | null
}

export function inferIssueProvider(
  meta: PullRequestLinkedIssueMeta,
  provider?: HostedReviewProvider | null
): 'github' | 'gitlab' | null {
  if (provider === 'github' || provider === 'gitlab') {
    return provider
  }
  if (provider) {
    return null
  }
  if (meta.linkedWorkItem?.type === 'issue') {
    if (meta.linkedWorkItem.provider === 'github' || meta.linkedWorkItem.provider === 'gitlab') {
      return meta.linkedWorkItem.provider
    }
  }
  const hasGitHub = isLinkedIssueNumber(meta.linkedIssue)
  const hasGitLab = isLinkedIssueNumber(meta.linkedGitLabIssue)
  return hasGitHub === hasGitLab ? null : hasGitHub ? 'github' : 'gitlab'
}

export type IssueLinkSlots = PullRequestLinkedIssueMeta & {
  linkedLinearIssue?: string | null
  linkedGitLabMR?: number | null
}

/** Which provider the issue field shows for a workspace's persisted links.
 *  Delegates the forge-slot decision to inferIssueProvider so the dialog's chip
 *  and {linkedIssue} can never disagree; the shared rule deliberately returns
 *  null on genuine ambiguity, and only this UI layer adds a total default. */
export function inferIssueLinkProvider(links: IssueLinkSlots): 'github' | 'gitlab' | 'linear' {
  const forge = inferIssueProvider(links)
  if (forge) {
    return forge
  }
  if (links.linkedLinearIssue) {
    return 'linear'
  }
  // Why: an empty (or ambiguous) field on a workspace that already tracks a
  // GitLab MR is a GitLab repo; defaulting to GitHub would file the next number
  // into the wrong forge.
  return typeof links.linkedGitLabMR === 'number' ? 'gitlab' : 'github'
}

/** The forge issue number {linkedIssue} should expand to, or null when no host
 *  issue is linked or the two forge slots are ambiguous. Two numbers with nothing
 *  to break the tie is ambiguous, and a wrong "Fixes #n" is worse than none. */
export function linkedIssueNumberForTemplate(
  meta: PullRequestLinkedIssueMeta | null | undefined,
  provider?: HostedReviewProvider | null
): number | null {
  if (!meta) {
    return null
  }
  const resolved = inferIssueProvider(meta, provider)
  const number =
    resolved === 'github' ? meta.linkedIssue : resolved === 'gitlab' ? meta.linkedGitLabIssue : null
  return isLinkedIssueNumber(number) ? number : null
}

/** Where a bare `#123` in a workspace's text resolves: which forge, and on which
 *  host. The slug shapes differ because the forges do — GitHub namespaces are two
 *  segments, GitLab project paths nest arbitrarily deep. */
export type IssueReferenceTarget =
  | { provider: 'github'; slug: RepoSlug }
  | { provider: 'gitlab'; slug: ProjectSlug }
