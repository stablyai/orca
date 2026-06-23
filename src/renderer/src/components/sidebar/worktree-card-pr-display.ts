import type { HostedReviewInfo } from '../../../../shared/hosted-review'

type LinkedReviewMetadataProvider = Exclude<HostedReviewInfo['provider'], 'unsupported'>

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
  if (review) {
    if (review.provider === 'unsupported') {
      return review
    }
    const linkedReviewNumber = getLinkedReviewNumber(review.provider, links)
    if (linkedReviewNumber === null) {
      if (review.provider !== 'github' && review.provider !== 'gitlab') {
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
