export type PRState = 'open' | 'closed' | 'merged' | 'draft'
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

// Keep GHES host identity across renderer/RPC boundaries to prevent actions targeting same-named github.com repos.
export type GitHubRepositoryIdentity = { owner: string; repo: string; host?: string }

export type GitHubPRMergeMethod = 'merge' | 'squash' | 'rebase'

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
  mergeMethodSettings?: GitHubPRMergeMethodSettings
  mergeStateStatus?: string | null
  /** GitHub-registered stack metadata. Absent for ordinary dependent PR chains. */
  stack?: GitHubPRStack
  // Checks key by head commit; cache the SHA to poll without GitHub re-queries or mutable-branch guesses.
  headSha?: string
  // Keep merged PRs visible for contained worktree heads, including behind update/web commits; cache validation honors this proof.
  confirmedContainedHeadOid?: string
  // Positive divergence proof applies only to this worktree HEAD. PR-coalesced broadcasts must not clear siblings still on the PR’s history.
  // Clear durable links only with exact-head proof; missing containment after rate limits/errors proves nothing.
  headDivergedFromMergedPRAtOid?: string
  /** Target branch name for PR-created worktree compare-base repair. */
  baseRefName?: string
  /** PR branch name detects worktrees switching branches and stale durable links. */
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

// Share the identity shape across IPC/renderer without main imports; main’s gh-utils.ts retains the OwnerRepo alias.
export type GitHubOwnerRepo = GitHubRepositoryIdentity
