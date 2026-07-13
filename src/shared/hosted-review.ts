import type { CheckStatus, PRConflictSummary, PRMergeableState, PRReviewDecision } from './types'

export type HostedReviewProvider =
  | 'github'
  | 'gitlab'
  | 'bitbucket'
  | 'azure-devops'
  | 'gitea'
  | 'unsupported'

export type HostedReviewState = 'open' | 'closed' | 'merged' | 'draft'

/** A linked review is identified by a positive integer PR/MR number. */
export function isPositiveHostedReviewNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

export type HostedReviewInfo = {
  provider: HostedReviewProvider
  number: number
  title: string
  state: HostedReviewState
  url: string
  status: CheckStatus
  updatedAt: string
  mergeable: PRMergeableState
  reviewDecision?: PRReviewDecision | null
  autoMergeEnabled?: boolean
  autoMergeAllowed?: boolean | null
  mergeQueueRequired?: boolean | null
  mergeStateStatus?: string | null
  headSha?: string
  // Why: mirrors PRInfo.confirmedContainedHeadOid so merged-review staleness
  // checks accept a worktree head confirmed to be part of the merged PR.
  confirmedContainedHeadOid?: string
  /** Target branch name for review-created worktree compare-base repair. */
  baseRefName?: string
  conflictSummary?: PRConflictSummary
}

export type HostedReviewForBranchArgs = {
  repoPath: string
  repoId?: string
  branch: string
  linkedGitHubPR?: number | null
  fallbackGitHubPR?: number | null
  linkedGitLabMR?: number | null
  linkedBitbucketPR?: number | null
  linkedAzureDevOpsPR?: number | null
  linkedGiteaPR?: number | null
  // The worktree's checked-out HEAD oid (GitHub merged-at-head visibility).
  currentHeadOid?: string | null
}

export type HostedReviewSummary = {
  number?: number
  url: string
}

export type CreateHostedReviewInput = {
  provider: HostedReviewProvider
  base: string
  head?: string
  title: string
  body?: string
  draft?: boolean
  worktreePath?: string
  useTemplate?: boolean
}

export type CreateHostedReviewArgs = CreateHostedReviewInput & {
  repoPath: string
  repoId?: string
  connectionId?: string | null
}

export type CreateHostedReviewErrorCode =
  | 'auth_required'
  | 'unsupported_provider'
  | 'already_exists'
  | 'validation'
  | 'timeout'
  | 'unknown_completion'
  | 'push_failed'
  | 'unknown'

export type CreateHostedReviewResult =
  | { ok: true; number: number; url: string }
  | {
      ok: false
      code: CreateHostedReviewErrorCode
      error: string
      existingReview?: HostedReviewSummary
    }

export type HostedReviewCreationBlockedReason =
  | 'dirty'
  | 'detached_head'
  | 'default_branch'
  | 'no_upstream'
  | 'needs_push'
  | 'needs_sync'
  | 'auth_required'
  | 'fork_head_unsupported'
  | 'unsupported_provider'
  | 'existing_review'
  | null

export type HostedReviewCreationNextAction =
  | 'commit'
  | 'publish'
  | 'push'
  | 'sync'
  | 'authenticate'
  | 'open_existing_review'
  | null

export type HostedReviewCreationEligibility = {
  provider: HostedReviewProvider
  review: HostedReviewSummary | null
  canCreate: boolean
  blockedReason: HostedReviewCreationBlockedReason
  nextAction: HostedReviewCreationNextAction
  defaultBaseRef?: string | null
  head?: string | null
  title?: string | null
  body?: string | null
}

export type HostedReviewCreationEligibilityArgs = {
  repoPath: string
  repoId?: string
  worktreePath?: string
  connectionId?: string | null
  branch: string
  base?: string | null
  hasUncommittedChanges?: boolean
  hasUpstream?: boolean
  ahead?: number
  behind?: number
  linkedGitHubPR?: number | null
  fallbackGitHubPR?: number | null
  linkedGitLabMR?: number | null
  linkedBitbucketPR?: number | null
  linkedAzureDevOpsPR?: number | null
  linkedGiteaPR?: number | null
}

export type HostedReviewIdentity = {
  provider: HostedReviewProvider
  host: string
  owner: string
  repo: string
  number: number
}

export type HostedReviewUser = {
  login: string | null
  isBot?: boolean
}

export type HostedReviewDecision = 'approved' | 'changes_requested' | 'review_required' | null

export type HostedReviewThreadSummary = {
  unresolvedCount: number | null
  dataCompleteness?: 'full' | 'partial'
}

export type HostedReviewQueueSummary = {
  identity: HostedReviewIdentity
  title: string
  url: string
  state: HostedReviewState
  author: HostedReviewUser | null
  updatedAt: string
  lastViewedAt?: number
  mergeable: PRMergeableState
  mergeStateStatus?: string | null
  checksStatus: CheckStatus
  reviewDecision?: HostedReviewDecision
  threadSummary?: HostedReviewThreadSummary
  requestedReviewerLogins?: string[] | null
  draft?: boolean
}

export type HostedReviewQueueKey =
  | 'mine'
  | 'requested'
  | 'agent'
  | 'teammate'
  | 'needs-response'
  | 'ready-to-merge'

export type HostedReviewQueueState = 'mine' | 'requested' | 'agent' | 'teammate'

export type HostedReviewQueueClassification = {
  state: HostedReviewQueueState
  needsResponse: boolean
  readyToMerge: boolean
  requested: boolean
}
