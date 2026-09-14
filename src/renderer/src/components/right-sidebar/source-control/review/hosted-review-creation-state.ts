import type {
  HostedReviewCreationEligibility,
  HostedReviewProvider
} from '../../../../../../shared/hosted-review'

// Why: every creation-state shape is keyed by repo+worktree+branch so a late response can be discarded after navigation.
export type HostedReviewCreationState = {
  repoId: string
  worktreeId: string
  branch: string
  data: HostedReviewCreationEligibility
}

export type HostedReviewCreationRequestState = {
  repoId: string
  worktreeId: string
  branch: string
  status: 'loading' | 'failed'
}

export type HostedReviewCreationProviderHint = {
  repoId: string | null
  worktreeId: string | null
  branch: string
  provider: HostedReviewProvider
}

export type CreatedHostedReview = {
  provider: HostedReviewProvider
  number: number
  url: string
}

export type HostedReviewCreatedContext = {
  repoPath: string
  repoId: string
  branch: string
  worktreeId: string | null
  openChecks: boolean
}
