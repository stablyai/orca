import type { CheckStatus, PRConflictSummary, PRMergeableState } from './types'

export type HostedReviewProvider = 'github' | 'gitlab' | 'bitbucket'

export type HostedReviewState = 'open' | 'closed' | 'merged' | 'draft'

export type HostedReviewInfo = {
  provider: HostedReviewProvider
  number: number
  title: string
  state: HostedReviewState
  url: string
  status: CheckStatus
  updatedAt: string
  mergeable: PRMergeableState
  headSha?: string
  conflictSummary?: PRConflictSummary
}

export type HostedReviewForBranchArgs = {
  repoPath: string
  branch: string
  linkedGitHubPR?: number | null
  linkedGitLabMR?: number | null
  linkedBitbucketPR?: number | null
}
