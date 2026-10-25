import type {
  CheckStatus,
  GitHubRepositoryIdentity,
  PRConflictSummary,
  PRMergeableState,
  PRReviewDecision
} from './github/pull-request-types'

export type HostedReviewProvider =
  | 'github'
  | 'gitlab'
  | 'bitbucket'
  | 'azure-devops'
  | 'gitea'
  | 'unsupported'

export type HostedReviewState = 'open' | 'closed' | 'merged' | 'draft'

// Bitbucket Cloud has no draft API; offering the toggle would publish live or fail.
export function hostedReviewProviderSupportsDraft(provider: HostedReviewProvider): boolean {
  return provider !== 'bitbucket'
}

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
  /** GitHub repository that owns the PR; absent on older runtimes and other providers. */
  githubRepository?: GitHubRepositoryIdentity
  // Mirror PRInfo containment proof so merged-review cache checks retain confirmed worktree heads.
  confirmedContainedHeadOid?: string
  /** Target branch name for review-created worktree compare-base repair. */
  baseRefName?: string
  conflictSummary?: PRConflictSummary
}

export type HostedReviewForBranchArgs = {
  force?: boolean
  repoPath: string
  repoId?: string
  admissionTier?: 'interactive' | 'status' | 'background'
  /** Desktop IPC-only owner guard; runtime RPC callers omit this field. */
  repoOwnerExecutionHostId?: string
  branch: string
  linkedGitHubPR?: number | null
  fallbackGitHubPR?: number | null
  linkedGitLabMR?: number | null
  linkedBitbucketPR?: number | null
  linkedAzureDevOpsPR?: number | null
  linkedGiteaPR?: number | null
  // The worktree's checked-out HEAD oid (GitHub merged-at-head visibility).
  currentHeadOid?: string | null
  /** Only selected-worktree surfaces set active: O(1) checks refresh per minute; O(N) lists refresh more slowly within the shared API budget (#11532). */
  active?: boolean
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

export type CreateStackedHostedReviewInput = CreateHostedReviewInput

export type CreateStackedHostedReviewArgs = CreateStackedHostedReviewInput & {
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

export type CreateStackedHostedReviewResult =
  | {
      ok: true
      number: number
      url: string
      stackNumber: number
      parentReview: HostedReviewSummary
    }
  | {
      ok: false
      code: CreateHostedReviewErrorCode
      error: string
      createdReview?: HostedReviewSummary
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
  // Reject local-only stack bases before submission so unresolvable remote refs get actionable copy.
  | 'base_not_on_remote'
  | null

export type HostedReviewCreationNextAction =
  | 'commit'
  | 'publish'
  | 'push'
  | 'sync'
  | 'authenticate'
  | 'open_existing_review'
  | null

/** Only accepted provider lookups yield found/not_found. Unavailable marks skipped/swallowed lookups and cannot prove no review exists. */
export type HostedReviewLookupOutcome = 'found' | 'not_found' | 'unavailable'

export type HostedReviewCreationEligibility = {
  provider: HostedReviewProvider
  review: HostedReviewSummary | null
  canCreate: boolean
  blockedReason: HostedReviewCreationBlockedReason
  nextAction: HostedReviewCreationNextAction
  reviewLookupOutcome: HostedReviewLookupOutcome
  defaultBaseRef?: string | null
  head?: string | null
  title?: string | null
  body?: string | null
  /** Present only when the executing host supports GitHub stack creation. */
  stackedCreationSupported?: boolean
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

export type HostedReviewDecision = 'approved' | 'changes_requested' | 'review_required' | null
