import type { WorktreeMeta } from './meta-types'

export type HostedReviewLinkKey =
  | 'linkedPR'
  | 'linkedGitLabMR'
  | 'linkedBitbucketPR'
  | 'linkedAzureDevOpsPR'
  | 'linkedGiteaPR'

export const HOSTED_REVIEW_LINK_KEYS: readonly HostedReviewLinkKey[] = [
  'linkedPR',
  'linkedGitLabMR',
  'linkedBitbucketPR',
  'linkedAzureDevOpsPR',
  'linkedGiteaPR'
]

/** Linked reviews and the push target are branch-scoped: a branch switch clears all of them. */
export const CLEARED_HOSTED_REVIEW_LINK_UPDATES: Pick<
  WorktreeMeta,
  HostedReviewLinkKey | 'pushTarget'
> = {
  linkedPR: null,
  linkedGitLabMR: null,
  linkedBitbucketPR: null,
  linkedAzureDevOpsPR: null,
  linkedGiteaPR: null,
  pushTarget: undefined
}

export function canonicalHostedReviewBranchIdentity(branch: string): string {
  return branch.replace(/^refs\/heads\//, '').trim()
}
