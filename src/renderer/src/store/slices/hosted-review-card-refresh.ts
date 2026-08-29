import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type { LinkedReviewHints } from './hosted-review-cache-identity'
import type { HostedReviewFetchOptions } from './hosted-review-cache-state'

type FetchHostedReviewForBranch = (
  repoPath: string,
  branch: string,
  options?: HostedReviewFetchOptions & LinkedReviewHints
) => Promise<HostedReviewInfo | null>

type RefreshHostedReviewCardArgs = {
  repoPath: string
  repoId: string
  branch: string
  linkedGitHubPR?: number | null
  fallbackGitHubPR?: number | null
  linkedGitLabMR?: number | null
  linkedBitbucketPR?: number | null
  linkedAzureDevOpsPR?: number | null
  linkedGiteaPR?: number | null
  repoOwnerExecutionHostId?: string
}

export function refreshHostedReviewCard(
  fetchHostedReviewForBranch: FetchHostedReviewForBranch,
  args: RefreshHostedReviewCardArgs
): Promise<HostedReviewInfo | null> {
  const fallbackGitHubPR = args.linkedGitHubPR == null ? (args.fallbackGitHubPR ?? null) : null
  return fetchHostedReviewForBranch(args.repoPath, args.branch, {
    force: true,
    repoId: args.repoId,
    repoOwnerExecutionHostId: args.repoOwnerExecutionHostId,
    linkedGitHubPR: args.linkedGitHubPR ?? null,
    ...(fallbackGitHubPR !== null ? { fallbackGitHubPR } : {}),
    linkedGitLabMR: args.linkedGitLabMR ?? null,
    linkedBitbucketPR: args.linkedBitbucketPR ?? null,
    linkedAzureDevOpsPR: args.linkedAzureDevOpsPR ?? null,
    linkedGiteaPR: args.linkedGiteaPR ?? null
  })
}
