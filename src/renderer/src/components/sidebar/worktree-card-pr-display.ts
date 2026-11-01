import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import { translate } from '@/i18n/i18n'
import type { PRInfo } from '../../../../shared/github/pull-request-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { isGitHubPRSuppressed } from '../../../../shared/worktree/github-pr-suppression'

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
    // A merged PR still belongs to a worktree behind web/update-branch commits; match main’s containment rule.
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
  suppressedGitHubPR?: number | null
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
  const isMergeRequest = provider === 'gitlab'
  const unavailable = isMergeRequest
    ? translate(
        'auto.components.sidebar.worktreeCardPrDisplay.mrDetailsUnavailable',
        'MR details unavailable'
      )
    : translate(
        'auto.components.sidebar.worktreeCardPrDisplay.prDetailsUnavailable',
        'PR details unavailable'
      )
  const loading = isMergeRequest
    ? translate('auto.components.sidebar.worktreeCardPrDisplay.loadingMr', 'Loading MR...')
    : translate('auto.components.sidebar.worktreeCardPrDisplay.loadingPr', 'Loading PR...')
  return {
    provider,
    number,
    // Persisted review links must remain visible while provider details warm up.
    title: review === null ? unavailable : loading
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
  if (
    review?.provider === 'github' &&
    isGitHubPRSuppressed(
      { linkedPR, suppressedGitHubPR: options.suppressedGitHubPR ?? null },
      review.number
    )
  ) {
    return null
  }
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
      // Linked lookups can outlive their requesting metadata; only neutral branch results are safe when unlinked.
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
