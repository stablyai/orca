import type { RepoKind } from '../repo-types'
import type { CheckStatus, PRInfo, PRMergeableState, PRState } from './pull-request-types'

/**
 * Discriminates a classified GitHub PR-refresh failure. The renderer maps these
 * to stable, non-destructive empty-state copy; a `hard` subset (auth, permission,
 * repo_unavailable, gh_unavailable) means the existing-review lookup is currently
 * impossible and must hide the Create composer.
 */
export type PRRefreshErrorType =
  | 'rate_limited'
  | 'auth'
  | 'network'
  | 'permission'
  | 'repo_unavailable'
  | 'gh_unavailable'
  | 'server_error'
  | 'unknown'

// Backward-compatible name used by outage-copy consumers added on main.
export type PRRefreshUpstreamErrorType = PRRefreshErrorType

export type PRRefreshOutcome =
  | { kind: 'found'; pr: PRInfo; fetchedAt: number }
  | { kind: 'no-pr'; fetchedAt: number }
  | {
      kind: 'upstream-error'
      errorType: PRRefreshErrorType
      message: string
      fetchedAt: number
      // Unified retry schedule (see docs/reference/pr-panel-refresh-guidance.md).
      // `nextAutoRetryAt`: earliest time main expects to auto-retry this key.
      // `retryDisabledUntil`: earliest time a manual Retry / refreshPRNow is
      // accepted (rate-limit gates only, never ordinary network/auth backoff).
      nextAutoRetryAt?: number
      retryDisabledUntil?: number
    }

export type GitHubPRRefreshReason = 'visible' | 'active' | 'post-push' | 'manual' | 'swr'

export type GitHubPRRefreshEnqueueResult =
  | { kind: 'queued' }
  | { kind: 'skipped'; skippedReason: 'validation-denied' | 'validation-backoff' }
  | { kind: 'fallback' }

export type GitHubPRRefreshAlias = {
  cacheKey: string
  repoId?: string
  repoPath: string
  branch: string
  worktreeId?: string
  connectionId?: string | null
  executionHostId?: string | null
  linkedPRNumber?: number | null
  fallbackPRNumber?: number | null
  fallbackPRSource?: 'explicit' | 'pr-cache' | 'hosted-review' | null
  // Why: request-time worktree HEAD. Merged branch-matched PRs are only visible
  // for heads that belong to the PR, and refresh consumers need this snapshot to
  // clear a durable linked PR once main confirms the head diverged.
  currentHeadOid?: string | null
}

export type GitHubPRRefreshCandidate = GitHubPRRefreshAlias & {
  repoKind: RepoKind
  repoId: string
  isBare?: boolean
  isArchived?: boolean
  connectionId?: string | null
  executionHostId?: string | null
  connectionState?: 'connected' | 'disconnected' | 'unknown'
  cachedFetchedAt?: number | null
  cachedHasPR?: boolean | null
  cachedPRState?: PRState | null
  cachedChecksStatus?: CheckStatus | null
  cachedMergeable?: PRMergeableState | null
  cachedMergeStateStatus?: string | null
  localGitOptions?: {
    wslDistro?: string
  }
}

export type GitHubPRRefreshSkippedReason =
  | 'fresh'
  | 'not-git'
  | 'bare'
  | 'archived'
  | 'disconnected'
  | 'remote'
  | 'rate-limit'
  | 'capacity'

type GitHubPRRefreshEventBase = {
  sequence: number
  reason: GitHubPRRefreshReason
  aliases: GitHubPRRefreshAlias[]
  requestStartedAt?: number
}

export type GitHubPRRefreshEvent =
  | (GitHubPRRefreshEventBase & {
      outcome: PRRefreshOutcome
      status?: never
      pausedUntil?: never
      skippedReason?: never
    })
  | (GitHubPRRefreshEventBase & {
      status: 'queued' | 'in-flight'
      outcome?: never
      pausedUntil?: never
      skippedReason?: never
    })
  | (GitHubPRRefreshEventBase & {
      status: 'paused'
      pausedUntil: number
      skippedReason: 'rate-limit'
      outcome?: never
    })
  | (GitHubPRRefreshEventBase & {
      status: 'skipped'
      skippedReason: GitHubPRRefreshSkippedReason
      outcome?: never
      pausedUntil?: never
    })
