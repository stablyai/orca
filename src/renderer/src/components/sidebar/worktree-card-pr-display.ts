import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type { PRInfo, Worktree } from '../../../../shared/types'

type LinkedReviewMetadataProvider = Exclude<HostedReviewInfo['provider'], 'unsupported'>

export function isCachedMergedBranchPRCurrentForWorktree(
  cachedPR: PRInfo | HostedReviewInfo | null | undefined,
  worktree: Pick<Worktree, 'head'>
): boolean {
  return (
    cachedPR?.state === 'merged' &&
    typeof cachedPR.headSha === 'string' &&
    cachedPR.headSha.length > 0 &&
    typeof worktree.head === 'string' &&
    worktree.head.length > 0 &&
    // Why: a worktree behind its own merged PR (update-branch/web commits) is
    // still that PR's line of work; match the main-process visibility rule.
    (cachedPR.headSha === worktree.head || cachedPR.confirmedContainedHeadOid === worktree.head)
  )
}

type LinkedReviewNumbers = {
  linkedPR: number | null
  linkedGitLabMR: number | null
  linkedBitbucketPR: number | null
  linkedAzureDevOpsPR: number | null
  linkedGiteaPR: number | null
}

export type WorktreeCardPrDisplay =
  | HostedReviewInfo
  | {
      provider: LinkedReviewMetadataProvider
      number: number
      title: string
      state?: HostedReviewInfo['state']
      url?: string
      status?: HostedReviewInfo['status']
    }

type WorktreeCardPrDisplayOptions = {
  reviewHintKey?: string
  /** GitHub PR number proven by a branch-scoped lookup. */
  branchLookupGitHubPRNumber?: number | null
}

function getLinkedReviewNumber(
  provider: LinkedReviewMetadataProvider,
  links: LinkedReviewNumbers
): number | null {
  switch (provider) {
    case 'github':
      return links.linkedPR
    case 'gitlab':
      return links.linkedGitLabMR
    case 'bitbucket':
      return links.linkedBitbucketPR
    case 'azure-devops':
      return links.linkedAzureDevOpsPR
    case 'gitea':
      return links.linkedGiteaPR
  }
}

function makeLinkedReviewFallback(
  provider: LinkedReviewMetadataProvider,
  number: number,
  review: HostedReviewInfo | null | undefined
): WorktreeCardPrDisplay {
  const label = provider === 'gitlab' ? 'MR' : 'PR'
  return {
    provider,
    number,
    // Why: linked review metadata is persisted before provider details are cached.
    // Keep the row visible on cold first render while the lookup catches up.
    title: review === null ? `${label} details unavailable` : `Loading ${label}...`
  }
}

export function getWorktreeCardPrDisplay(
  review: HostedReviewInfo | null | undefined,
  linkedPR: number | null,
  linkedGitLabMR: number | null = null,
  linkedBitbucketPR: number | null = null,
  linkedAzureDevOpsPR: number | null = null,
  linkedGiteaPR: number | null = null,
  options: WorktreeCardPrDisplayOptions = {}
): WorktreeCardPrDisplay | null {
  const links = {
    linkedPR,
    linkedGitLabMR,
    linkedBitbucketPR,
    linkedAzureDevOpsPR,
    linkedGiteaPR
  }
  const hasLinkedReview =
    linkedPR !== null ||
    linkedGitLabMR !== null ||
    linkedBitbucketPR !== null ||
    linkedAzureDevOpsPR !== null ||
    linkedGiteaPR !== null
  if (review) {
    if (review.provider === 'unsupported') {
      return review
    }
    const linkedReviewNumber = getLinkedReviewNumber(review.provider, links)
    if (linkedReviewNumber === null) {
      if (review.provider !== 'github' && review.provider !== 'gitlab') {
        return review
      }
      // Why: GitHub refreshes retain a linked-style request hint; trust only the separately recorded branch-lookup provenance.
      if (
        !hasLinkedReview &&
        review.provider === 'github' &&
        options.branchLookupGitHubPRNumber != null &&
        options.branchLookupGitHubPRNumber === review.number
      ) {
        return review
      }
      // Why: GitHub/GitLab linked lookups can outlive the worktree metadata
      // that requested them. A neutral branch lookup is safe to show unlinked.
      return options.reviewHintKey === '' ? review : null
    }
    if (review.number === linkedReviewNumber) {
      return review
    }
    return makeLinkedReviewFallback(review.provider, linkedReviewNumber, undefined)
  }

  if (linkedPR !== null) {
    return makeLinkedReviewFallback('github', linkedPR, review)
  }

  if (linkedGitLabMR !== null) {
    return makeLinkedReviewFallback('gitlab', linkedGitLabMR, review)
  }

  if (linkedBitbucketPR !== null) {
    return makeLinkedReviewFallback('bitbucket', linkedBitbucketPR, review)
  }

  if (linkedAzureDevOpsPR !== null) {
    return makeLinkedReviewFallback('azure-devops', linkedAzureDevOpsPR, review)
  }

  if (linkedGiteaPR !== null) {
    return makeLinkedReviewFallback('gitea', linkedGiteaPR, review)
  }

  return null
}
