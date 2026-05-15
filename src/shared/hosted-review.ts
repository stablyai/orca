import type { CheckStatus, PRConflictSummary, PRMergeableState } from './types'

export type HostedReviewProvider = 'github' | 'gitlab' | 'bitbucket' | 'gitea'

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
  repoId?: string
  branch: string
  linkedGitHubPR?: number | null
  linkedGitLabMR?: number | null
  linkedBitbucketPR?: number | null
  linkedGiteaPR?: number | null
}
