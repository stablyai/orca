import type { LinkedReviewHints } from './hosted-review-cache-identity'
import type {
  CreateHostedReviewInput,
  CreateStackedHostedReviewInput,
  HostedReviewCreationEligibility,
  HostedReviewInfo
} from '../../../../shared/hosted-review'
import type { Repo } from '../../../../shared/repo-types'
import type { PRInfo } from '../../../../shared/github/pull-request-types'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/runtime-client-target'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

export type HostedReviewCacheEntry<T> = {
  data: T | null
  fetchedAt: number
  stale?: boolean
  linkedReviewHintKey?: string
  branchLookupGitHubPRNumber?: number
}
export type HostedReviewCache = Record<string, HostedReviewCacheEntry<HostedReviewInfo>>

export type HostedReviewFetchOptions = {
  /** Source-qualified exact lookup; does not replace the branch’s selected review. */
  exactReviewKey?: string
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
// Bound native Electron lookups like runtime RPC; hung git/gh credentials must not leave Create PR Checking forever.
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
  // GitHub-only misses cannot rule out GitLab/other reviews on the publishing remote.
  return (
    cached !== undefined &&
    hintKey === '' &&
    isGitHubLinkedReviewHintKey(cached.linkedReviewHintKey)
  )
}

export function isStaleMergedGitHubReviewForHead(
  cached: { data: HostedReviewInfo | PRInfo | null } | undefined,
  currentHeadOid: string | null | undefined
): boolean {
  // Branch cache may outlive merged work: reuse/preserve merged GitHub reviews only at their head or confirmed-contained commits.
  const head = typeof currentHeadOid === 'string' ? currentHeadOid.trim() : ''
  if (head.length === 0) {
    return false
  }
  const data = cached?.data
  return (
    data !== null &&
    data !== undefined &&
    (!('provider' in data) || data.provider === 'github') &&
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
  // Refresh broadcasts can update shared cache mid-lookup; stale results must not resurrect older reviews.
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

/** Known runtime repos use owner server; local/SSH/unknown repos use app IPC. Focus cannot infer ownership. */
export function hostedReviewRepoOwnerTarget(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'> | undefined
): RuntimeClientTarget {
  return (
    (repo ? ipcOrRuntimeTargetForHostId(getRepoExecutionHostId(repo)) : null) ?? { kind: 'local' }
  )
}

export function hostedReviewBranchLookupArgs(
  branch: string,
  options?: HostedReviewFetchOptions & LinkedReviewHints
) {
  const fallbackGitHubPR =
    options?.linkedGitHubPR == null ? (options?.fallbackGitHubPR ?? null) : null
  return {
    branch,
    ...(options?.force === true ? { force: true } : {}),
    ...(options?.admissionTier ? { admissionTier: options.admissionTier } : {}),
    ...(options?.repoId !== undefined ? { repoId: options.repoId } : {}),
    currentHeadOid: options?.currentHeadOid ?? null,
    ...(options?.active === true ? { active: true } : {}),
    linkedGitHubPR: options?.linkedGitHubPR ?? null,
    ...(fallbackGitHubPR !== null ? { fallbackGitHubPR } : {}),
    linkedGitLabMR: options?.linkedGitLabMR ?? null,
    linkedBitbucketPR: options?.linkedBitbucketPR ?? null,
    linkedAzureDevOpsPR: options?.linkedAzureDevOpsPR ?? null,
    linkedGiteaPR: options?.linkedGiteaPR ?? null
  }
}
