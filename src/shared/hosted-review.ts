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

// Why: Bitbucket Cloud's API has no draft pull requests, so offering the toggle
// there would either publish a live PR or fail at submit.
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
  /**
   * Set only by surfaces scoped to the selected worktree. That tier is O(1), so
   * the host re-checks it per minute; the worktree list is O(N) and is paced far
   * more slowly to stay inside the shared API budget (#11532).
   */
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
  // Why: a stacked worktree's local-only parent base is unresolvable on the
  // remote; blocked at create-time so the submit fails with actionable copy
  // instead of the provider's opaque error.
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

/**
 * Records whether the eligibility result observed an authoritative existing-review
 * lookup. `found` / `not_found` come only from an accepted provider lookup;
 * `unavailable` marks a local-blocker fallback returned after a swallowed or
 * skipped lookup, so it can never masquerade as authoritative no-review evidence.
 */
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
