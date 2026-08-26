// Why: `queued` refines `open` — a review waiting in a provider merge queue (or
// train) is still open upstream, so treat it as an active PR everywhere except
// presentation and merge-action gating. Provider-neutral on purpose: GitLab
// merge trains can adopt it with no type change.
// Why not on the wire: `queued` is derived by the client from `mergeQueueEntry`,
// never published — see `PRWireState`.
export type PRState = 'open' | 'closed' | 'merged' | 'draft' | 'queued'

// Why: hosts and clients update independently, so a host must never publish a
// state value an older client cannot interpret. `queued` is carried across the
// wire as `open` + `mergeQueueEntry` and re-derived client-side.
export type PRWireState = Exclude<PRState, 'queued'>
export type IssueState = 'open' | 'closed'
export type CheckStatus = 'pending' | 'success' | 'failure' | 'neutral'

export type PRMergeableState = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
export type PRReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED'

export type PRConflictSummary = {
  baseRef: string
  baseCommit: string
  commitsBehind: number
  files: string[]
  localMergeState?: 'clean'
}

// Why: host must survive renderer/RPC boundaries so Enterprise review actions
// cannot silently fall back to a same-named repository on github.com.
export type GitHubRepositoryIdentity = { owner: string; repo: string; host?: string }

export type GitHubPRMergeMethod = 'merge' | 'squash' | 'rebase'

/**
 * A review's membership in a provider merge queue. Its presence is the wire
 * discriminator for the `queued` state; absence means "not queued".
 *
 * Why every field but `state` is optional: providers expose different subsets.
 * GitHub's GraphQL `mergeQueueEntry` has all four; a GitLab merge train has no
 * ETA at all and needs GraphQL `MergeTrainCar.index` for position. Consumers
 * must drop each absent field independently rather than render a placeholder.
 *
 * Why `state` is `string` and not an enum: it absorbs GitHub's
 * QUEUED/AWAITING_CHECKS/MERGEABLE/UNMERGEABLE/LOCKED and GitLab's
 * idle/fresh/stale/merging without a type change — the same shape-reuse this
 * repo already does for `mergeStateStatus`, which GitLab rides with its own
 * `detailed_merge_status` values (see `gitlab-types.ts`).
 */
export type PullRequestMergeQueueEntry = {
  state: string
  position?: number | null
  /** Seconds until the provider expects the entry to merge. Absent where unsupported. */
  estimatedTimeToMerge?: number | null
  enqueuedAt?: string | null
}

export type GitHubPRMergeMethodSettings = {
  defaultMethod: GitHubPRMergeMethod
  allowedMethods: Record<GitHubPRMergeMethod, boolean>
}

export type GitHubPRStackEntry = {
  position: number
  number: number
  title: string
  url: string
  updatedAt?: string
  state: PRState
  checksStatus: CheckStatus
  mergeable: PRMergeableState
  reviewDecision?: PRReviewDecision | null
  mergeStateStatus?: string | null
  headRefName?: string
  headSha?: string
}

export type GitHubPRStack = {
  number: number
  position: number
  size: number
  baseRefName: string
  baseSha?: string
  entries?: GitHubPRStackEntry[]
}

export type PRInfo = {
  number: number
  title: string
  state: PRState
  url: string
  checksStatus: CheckStatus
  updatedAt: string
  mergeable: PRMergeableState
  reviewDecision?: PRReviewDecision | null
  autoMergeEnabled?: boolean
  autoMergeAllowed?: boolean | null
  mergeQueueRequired?: boolean | null
  /** Present only while the review is actually sitting in the queue. Wire discriminator for `queued`. */
  mergeQueueEntry?: PullRequestMergeQueueEntry
  mergeMethodSettings?: GitHubPRMergeMethodSettings
  mergeStateStatus?: string | null
  /** GitHub-registered stack metadata. Absent for ordinary dependent PR chains. */
  stack?: GitHubPRStack
  // Why: check-runs are keyed by the PR head commit, not the mutable branch name.
  // Keeping the head SHA in cached PR metadata lets the checks panel poll the
  // correct commit without re-querying GitHub or guessing from local branch refs.
  headSha?: string
  // Why: a merged branch-matched PR stays visible when the worktree head is one
  // of the PR's own commits (behind update-branch/web commits). Cache staleness
  // checks must honor that confirmation without re-querying GitHub.
  confirmedContainedHeadOid?: string
  // Why: the worktree HEAD OID this merged linked PR was confirmed to have
  // diverged from (a definite not-contained probe). Head-scoped, not a bare
  // boolean, so a PR-number-coalesced refresh broadcast cannot clear a sibling
  // worktree whose own head is still on the PR's line of work. Clearing a
  // durable linked PR requires this positive signal for that exact head, never
  // the mere absence of a containment confirmation after a rate-limit/error.
  headDivergedFromMergedPRAtOid?: string
  /** Target branch name for PR-created worktree compare-base repair. */
  baseRefName?: string
  /** PR head branch name. Lets linked-PR consumers detect that the worktree
   *  has switched to a different branch and the durable link is stale. */
  headRefName?: string
  prRepo?: GitHubRepositoryIdentity
  headRepo?: GitHubRepositoryIdentity
  conflictSummary?: PRConflictSummary
}

export type IssueInfo = {
  number: number
  title: string
  state: IssueState
  url: string
  labels: string[]
  /** Full markdown body when fetched through the single-issue endpoint. */
  description?: string
}

export type GitHubViewer = {
  login: string
  email: string | null
}

export type GitHubAssignableUser = {
  login: string
  name: string | null
  avatarUrl: string
}

export type ProviderCheckSummary = {
  state: 'success' | 'failure' | 'pending' | 'neutral' | 'none'
  total: number
  passed: number
  failed: number
  pending: number
  neutral: number
}

export type GitHubPRReviewSummary = {
  login: string
  state?: string | null
  avatarUrl?: string | null
}

export type GitHubPRFileViewedState = 'DISMISSED' | 'VIEWED' | 'UNVIEWED'

export type GitHubPRFile = {
  path: string
  oldPath?: string
  status: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | 'unchanged'
  additions: number
  deletions: number
  /** GitHub marks files above its diff size limit as binary-like; we skip content fetches for these. */
  isBinary: boolean
  /** Modified-side line numbers that GitHub accepts for inline review comments. */
  reviewCommentLineNumbers?: number[]
  /** GitHub's per-viewer review state. DISMISSED means new changes arrived after the file was viewed. */
  viewerViewedState?: GitHubPRFileViewedState
}

export type GitHubPRFileContents = {
  original: string
  modified: string
  originalIsBinary: boolean
  modifiedIsBinary: boolean
  originalTooLarge?: boolean
  modifiedTooLarge?: boolean
}

// Why: declared here as a shared shape so IPC return envelopes and renderer
// slices can reference the same structural type without importing from main.
// Aliased as `OwnerRepo` in `src/main/github/gh-utils.ts` so main call sites
// can continue using the short local name.
export type GitHubOwnerRepo = GitHubRepositoryIdentity
