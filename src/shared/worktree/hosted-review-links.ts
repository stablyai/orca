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

export const CLEARED_HOSTED_REVIEW_SELECTION_UPDATES: Pick<WorktreeMeta, HostedReviewLinkKey> = {
  linkedPR: null,
  linkedGitLabMR: null,
  linkedBitbucketPR: null,
  linkedAzureDevOpsPR: null,
  linkedGiteaPR: null
}

/** Branch switches clear the active review and push target, preserving workspace references. */
export const CLEARED_HOSTED_REVIEW_LINK_UPDATES: Pick<
  WorktreeMeta,
  HostedReviewLinkKey | 'pushTarget'
> = {
  ...CLEARED_HOSTED_REVIEW_SELECTION_UPDATES,
  pushTarget: undefined
}

export function canonicalHostedReviewBranchIdentity(branch: string): string {
  return branch.replace(/^refs\/heads\//, '').trim()
}
