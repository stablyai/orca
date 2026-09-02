import type {
  CreateHostedReviewInput,
  CreateStackedHostedReviewInput,
  HostedReviewCreationEligibility,
  HostedReviewInfo
} from '../../../../shared/hosted-review'
import type { Repo } from '../../../../shared/repo-types'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import type { AppState } from '../types'

export type HostedReviewCacheEntry<T> = {
  data: T | null
  fetchedAt: number
  linkedReviewHintKey?: string
  branchLookupGitHubPRNumber?: number
}
export type HostedReviewCache = Record<string, HostedReviewCacheEntry<HostedReviewInfo>>

export type HostedReviewFetchOptions = {
  force?: boolean
  repoId?: string
  admissionTier?: 'interactive' | 'status' | 'background'
  staleWhileRevalidate?: boolean
  currentHeadOid?: string | null
  /**
   * Pass from surfaces that only render the selected worktree. The host re-checks
   * that branch per minute and paces the O(N) card list far slower (#11532).
   */
  active?: boolean
  repoOwnerExecutionHostId?: string
}
export type CreateHostedReviewStoreInput = CreateHostedReviewInput & { repoId?: string | null }
export type CreateStackedHostedReviewStoreInput = CreateStackedHostedReviewInput & {
  repoId?: string | null
}

const CACHE_TTL_MS = 60_000
const HOSTED_REVIEW_CACHE_MAX = 500
// Why: the runtime path is bounded by callRuntimeRpc's own timeout; the local
// Electron path had none, so a hung git/gh subprocess (e.g. a stalled Windows
// credential probe) could leave the Create PR header stuck in its "Checking…"
// loading state forever. Mirror the runtime bound so a never-settling probe
// rejects and the UI can fall back to an actionable/retryable state.
const CREATION_ELIGIBILITY_TIMEOUT_MS = 30_000

export class HostedReviewCreationEligibilityTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Timed out checking pull request creation eligibility after ${timeoutMs}ms`)
    this.name = 'HostedReviewCreationEligibilityTimeoutError'
  }
}

export function withCreationEligibilityTimeout(
  promise: Promise<HostedReviewCreationEligibility>,
  timeoutMs = CREATION_ELIGIBILITY_TIMEOUT_MS
): Promise<HostedReviewCreationEligibility> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new HostedReviewCreationEligibilityTimeoutError(timeoutMs))
    }, timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

export function isFreshHostedReview<T>(
  entry: HostedReviewCacheEntry<T> | undefined
): entry is HostedReviewCacheEntry<T> {
  return entry !== undefined && Date.now() - entry.fetchedAt < CACHE_TTL_MS
}

export function findHostedReviewRepoByPath(
  repos: readonly Repo[] | undefined,
  repoPath: string,
  repoId?: string | null,
  repoOwnerExecutionHostId?: string
): Repo | undefined {
  const matches = repos?.filter(
    (candidate) =>
      (repoId ? candidate.id === repoId : candidate.path === repoPath) &&
      (!repoOwnerExecutionHostId || candidate.path === repoPath)
  )
  if (repoOwnerExecutionHostId) {
    return matches?.find(
      (candidate) => getRepoExecutionHostId(candidate) === repoOwnerExecutionHostId
    )
  }
  return matches?.[0]
}

export function findHostedReviewRepoForFetch(
  repos: readonly Repo[] | undefined,
  repoPath: string,
  options: HostedReviewFetchOptions | undefined
): Repo | null | undefined {
  const repo = findHostedReviewRepoByPath(
    repos,
    repoPath,
    options?.repoId,
    options?.repoOwnerExecutionHostId
  )
  return options?.repoOwnerExecutionHostId && !repo ? null : repo
}

export function hostedReviewOwnerIpcArgs(options: HostedReviewFetchOptions | undefined): {
  repoOwnerExecutionHostId?: string
} {
  return options?.repoOwnerExecutionHostId
    ? { repoOwnerExecutionHostId: options.repoOwnerExecutionHostId }
    : {}
}

export function shouldRefetchForLinkedHint(
  cached: HostedReviewCacheEntry<HostedReviewInfo> | undefined,
  hintKey: string
): boolean {
  return cached !== undefined && hintKey !== '' && (cached.linkedReviewHintKey ?? '') !== hintKey
}

function isGitHubLinkedReviewHintKey(hintKey: string | undefined): boolean {
  return hintKey?.split('|').some((key) => key.startsWith('github:')) ?? false
}

export function shouldRefetchGitHubScopedResultForNoHint(
  cached: HostedReviewCacheEntry<HostedReviewInfo> | undefined,
  hintKey: string
): boolean {
  // Why: a GitHub-scoped result does not prove the branch's publishing remote
  // has no GitLab/other review for neutral lookup.
  return (
    cached !== undefined &&
    hintKey === '' &&
    isGitHubLinkedReviewHintKey(cached.linkedReviewHintKey)
  )
}

export function canReuseInflightHint(inflightHintKey: string, nextHintKey: string): boolean {
  return inflightHintKey === nextHintKey
}

export function isStaleMergedGitHubReviewForHead(
  cached: HostedReviewCacheEntry<HostedReviewInfo> | undefined,
  currentHeadOid: string | null | undefined
): boolean {
  // Why: a merged GitHub PR is only shown when the worktree sits on its head
  // or on a commit confirmed to be part of the PR. The cache key is
  // branch-scoped, so a worktree that advanced off the merged line of work
  // must not reuse (or, on failure, preserve) the now-stale merged review.
  const head = typeof currentHeadOid === 'string' ? currentHeadOid.trim() : ''
  if (head.length === 0) {
    return false
  }
  const data = cached?.data
  return (
    data?.provider === 'github' &&
    data.state === 'merged' &&
    typeof data.headSha === 'string' &&
    data.headSha.length > 0 &&
    data.headSha !== head &&
    data.confirmedContainedHeadOid !== head
  )
}

export function hasNewerHostedReviewCacheEntry(
  cache: HostedReviewCache,
  cacheKey: string,
  requestStartedAt: number,
  requestStartedEntry: HostedReviewCacheEntry<HostedReviewInfo> | undefined
): boolean {
  // Why: GitHub refresh events can update this shared cache while a branch
  // lookup is in flight; older lookups must not resurrect stale results.
  const entry = cache[cacheKey]
  return (
    entry !== undefined &&
    (entry.fetchedAt > requestStartedAt ||
      (entry.fetchedAt === requestStartedAt && entry !== requestStartedEntry))
  )
}

export function withHostedReviewCacheEntry(
  cache: HostedReviewCache,
  cacheKey: string,
  entry: HostedReviewCacheEntry<HostedReviewInfo>
): HostedReviewCache {
  const next = { ...cache, [cacheKey]: entry }
  const keys = Object.keys(next)
  if (keys.length <= HOSTED_REVIEW_CACHE_MAX) {
    return next
  }
  const keep = new Set(
    keys
      .map((key) => ({ key, fetchedAt: next[key].fetchedAt }))
      .sort((a, b) => b.fetchedAt - a.fetchedAt)
      .slice(0, HOSTED_REVIEW_CACHE_MAX)
      .map((item) => item.key)
  )
  const pruned: HostedReviewCache = {}
  for (const key of keep) {
    pruned[key] = next[key]
  }
  return pruned
}

export function settingsForHostedReviewRepoOwner(
  settings: AppState['settings'],
  repo: Pick<Repo, 'connectionId' | 'executionHostId'> | undefined
): AppState['settings'] {
  if (!repo) {
    return settings
  }
  const parsed = parseExecutionHostId(getRepoExecutionHostId(repo))
  if (parsed?.kind === 'runtime') {
    return settings
      ? { ...settings, activeRuntimeEnvironmentId: parsed.environmentId }
      : ({ activeRuntimeEnvironmentId: parsed.environmentId } as AppState['settings'])
  }
  // Why: local and SSH-owned reviews are served by the desktop client's local
  // IPC path, even when the sidebar is focused on a runtime host.
  return settings
    ? { ...settings, activeRuntimeEnvironmentId: null }
    : ({ activeRuntimeEnvironmentId: null } as AppState['settings'])
}

export function settingsForHostedReviewActionOwner(
  settings: AppState['settings'],
  repo: Pick<Repo, 'connectionId' | 'executionHostId'> | undefined
): AppState['settings'] {
  if (!repo?.executionHostId && !repo?.connectionId) {
    return settings
  }
  return settingsForHostedReviewRepoOwner(settings, repo)
}
