/* eslint-disable max-lines -- Why: hosted-review cache identity, runtime dispatch,
and race protection are kept together so branch review lookup invariants stay testable. */
import type { StateCreator } from 'zustand'
import type {
  CreateHostedReviewInput,
  CreateHostedReviewResult,
  HostedReviewCreationEligibility,
  HostedReviewCreationEligibilityArgs,
  HostedReviewInfo
} from '../../../../shared/hosted-review'
import type { Repo } from '../../../../shared/types'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import type { AppState } from '../types'
import {
  getHostedReviewCacheKey,
  linkedReviewHintKey,
  type LinkedReviewHints
} from './hosted-review-cache-identity'
import { getGitHubPRCacheKey, getLegacyGitHubPRCacheKey } from './github-cache-key'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'

export { getHostedReviewCacheKey, linkedReviewHintKey } from './hosted-review-cache-identity'

type CacheEntry<T> = {
  data: T | null
  fetchedAt: number
  linkedReviewHintKey?: string
  branchLookupGitHubPRNumber?: number
}
type FetchOptions = {
  force?: boolean
  repoId?: string
  staleWhileRevalidate?: boolean
  currentHeadOid?: string | null
}
type CreateHostedReviewStoreInput = CreateHostedReviewInput & { repoId?: string | null }

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

function withCreationEligibilityTimeout(
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

const inflightHostedReviewRequests = new Map<
  string,
  {
    promise: Promise<HostedReviewInfo | null>
    force: boolean
    generation: number
    linkedReviewHintKey: string
  }
>()
const requestGenerations = new Map<string, number>()

/** @internal - exposed for leak-regression tests only */
export function _getHostedReviewRequestGenerationCountForTest(): number {
  return requestGenerations.size
}

/** @internal - exposed for leak-regression tests only */
export function _clearHostedReviewRequestGenerationsForTest(): void {
  requestGenerations.clear()
}

function isFresh<T>(entry: CacheEntry<T> | undefined): entry is CacheEntry<T> {
  return entry !== undefined && Date.now() - entry.fetchedAt < CACHE_TTL_MS
}

function findHostedReviewRepoByPath(
  repos: readonly Repo[] | undefined,
  repoPath: string,
  repoId?: string | null
): Repo | undefined {
  return repos?.find((candidate) =>
    repoId ? candidate.id === repoId : candidate.path === repoPath
  )
}

function shouldRefetchForLinkedHint(
  cached: CacheEntry<HostedReviewInfo> | undefined,
  hintKey: string
): boolean {
  return cached !== undefined && hintKey !== '' && (cached.linkedReviewHintKey ?? '') !== hintKey
}

function isGitHubLinkedReviewHintKey(hintKey: string | undefined): boolean {
  return hintKey?.split('|').some((key) => key.startsWith('github:')) ?? false
}

function shouldRefetchGitHubScopedResultForNoHint(
  cached: CacheEntry<HostedReviewInfo> | undefined,
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

function canReuseInflightHint(inflightHintKey: string, nextHintKey: string): boolean {
  return inflightHintKey === nextHintKey
}

function isStaleMergedGitHubReviewForHead(
  cached: CacheEntry<HostedReviewInfo> | undefined,
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

function hasNewerHostedReviewCacheEntry(
  cache: HostedReviewSlice['hostedReviewCache'],
  cacheKey: string,
  requestStartedAt: number,
  requestStartedEntry: CacheEntry<HostedReviewInfo> | undefined
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

function withHostedReviewCacheEntry(
  cache: HostedReviewSlice['hostedReviewCache'],
  cacheKey: string,
  entry: CacheEntry<HostedReviewInfo>
): HostedReviewSlice['hostedReviewCache'] {
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
  const pruned: HostedReviewSlice['hostedReviewCache'] = {}
  for (const key of keep) {
    pruned[key] = next[key]
  }
  return pruned
}

function settingsForHostedReviewRepoOwner(
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

function settingsForHostedReviewActionOwner(
  settings: AppState['settings'],
  repo: Pick<Repo, 'connectionId' | 'executionHostId'> | undefined
): AppState['settings'] {
  if (!repo?.executionHostId && !repo?.connectionId) {
    return settings
  }
  return settingsForHostedReviewRepoOwner(settings, repo)
}

export type HostedReviewSlice = {
  hostedReviewCache: Record<string, CacheEntry<HostedReviewInfo>>
  getHostedReviewCreationEligibility: (
    args: HostedReviewCreationEligibilityArgs
  ) => Promise<HostedReviewCreationEligibility>
  createHostedReview: (
    repoPath: string,
    input: CreateHostedReviewStoreInput
  ) => Promise<CreateHostedReviewResult>
  fetchHostedReviewForBranch: (
    repoPath: string,
    branch: string,
    options?: FetchOptions & LinkedReviewHints
  ) => Promise<HostedReviewInfo | null>
}

type RefreshHostedReviewCardArgs = {
  repoPath: string
  repoId: string
  branch: string
  linkedGitHubPR?: number | null
  fallbackGitHubPR?: number | null
  linkedGitLabMR?: number | null
  linkedBitbucketPR?: number | null
  linkedAzureDevOpsPR?: number | null
  linkedGiteaPR?: number | null
}

export function refreshHostedReviewCard(
  fetchHostedReviewForBranch: HostedReviewSlice['fetchHostedReviewForBranch'],
  args: RefreshHostedReviewCardArgs
): Promise<HostedReviewInfo | null> {
  const fallbackGitHubPR = args.linkedGitHubPR == null ? (args.fallbackGitHubPR ?? null) : null
  return fetchHostedReviewForBranch(args.repoPath, args.branch, {
    force: true,
    repoId: args.repoId,
    linkedGitHubPR: args.linkedGitHubPR ?? null,
    ...(fallbackGitHubPR !== null ? { fallbackGitHubPR } : {}),
    linkedGitLabMR: args.linkedGitLabMR ?? null,
    linkedBitbucketPR: args.linkedBitbucketPR ?? null,
    linkedAzureDevOpsPR: args.linkedAzureDevOpsPR ?? null,
    linkedGiteaPR: args.linkedGiteaPR ?? null
  })
}

export const createHostedReviewSlice: StateCreator<AppState, [], [], HostedReviewSlice> = (
  set,
  get
) => ({
  hostedReviewCache: {},

  getHostedReviewCreationEligibility: async (args) => {
    const settings = get().settings
    const repo = findHostedReviewRepoByPath(get().repos, args.repoPath, args.repoId)
    const ownerSettings = settingsForHostedReviewActionOwner(settings, repo)
    const target = getActiveRuntimeTarget(ownerSettings)
    if (target.kind === 'environment') {
      const { repoPath: _repoPath, worktreePath, ...runtimeArgs } = args
      void _repoPath
      return callRuntimeRpc<HostedReviewCreationEligibility>(
        target,
        'hostedReview.getCreationEligibility',
        {
          repo: repo?.id ?? args.repoPath,
          ...(worktreePath ? { worktree: `path:${worktreePath}` } : {}),
          ...runtimeArgs
        },
        { timeoutMs: 30_000 }
      )
    }
    return withCreationEligibilityTimeout(
      window.api.hostedReview.getCreationEligibility({
        ...args,
        repoId: repo?.id ?? args.repoId,
        connectionId: repo?.connectionId ?? null
      })
    )
  },

  createHostedReview: async (repoPath, input) => {
    const settings = get().settings
    const repo = findHostedReviewRepoByPath(get().repos, repoPath, input.repoId)
    const ownerSettings = settingsForHostedReviewActionOwner(settings, repo)
    const target = getActiveRuntimeTarget(ownerSettings)
    const { repoId: inputRepoId, ...hostedReviewInput } = input
    if (target.kind === 'environment') {
      const { worktreePath, ...runtimeInput } = hostedReviewInput
      return callRuntimeRpc<CreateHostedReviewResult>(
        target,
        'hostedReview.create',
        {
          repo: repo?.id ?? repoPath,
          ...(worktreePath ? { worktree: `path:${worktreePath}` } : {}),
          ...runtimeInput
        },
        { timeoutMs: 60_000 }
      )
    }
    return window.api.hostedReview.create({
      repoPath,
      repoId: repo?.id ?? inputRepoId ?? undefined,
      connectionId: repo?.connectionId ?? null,
      ...hostedReviewInput
    })
  },

  fetchHostedReviewForBranch: async (
    repoPath,
    branch,
    options
  ): Promise<HostedReviewInfo | null> => {
    const settings = get().settings
    const repo = get().repos?.find((candidate) =>
      options?.repoId ? candidate.id === options.repoId : candidate.path === repoPath
    )
    const ownerSettings = settingsForHostedReviewRepoOwner(settings, repo)
    const target = getActiveRuntimeTarget(ownerSettings)
    const repoId = options?.repoId ?? repo?.id
    const cacheKey = getHostedReviewCacheKey(
      repoPath,
      branch,
      ownerSettings,
      repoId,
      repo?.connectionId,
      repo?.executionHostId,
      repo !== undefined
    )
    const cached = get().hostedReviewCache[cacheKey]
    const hintKey = linkedReviewHintKey(options)
    const linkedRefetch = shouldRefetchForLinkedHint(cached, hintKey)
    const scopedResultRefetch = shouldRefetchGitHubScopedResultForNoHint(cached, hintKey)
    const staleMergedHeadRefetch = isStaleMergedGitHubReviewForHead(cached, options?.currentHeadOid)
    if (
      !options?.force &&
      !linkedRefetch &&
      !scopedResultRefetch &&
      !staleMergedHeadRefetch &&
      isFresh(cached)
    ) {
      return cached.data
    }

    const inflightRequest = inflightHostedReviewRequests.get(cacheKey)
    const inflightHasRequestedHint =
      inflightRequest !== undefined &&
      canReuseInflightHint(inflightRequest.linkedReviewHintKey, hintKey)
    const startRequest = (): Promise<HostedReviewInfo | null> => {
      const generation = (requestGenerations.get(cacheKey) ?? 0) + 1
      const requestStartedAt = Date.now()
      const requestStartedEntry = get().hostedReviewCache[cacheKey]
      requestGenerations.set(cacheKey, generation)
      const request = (async () => {
        try {
          const fallbackGitHubPR =
            options?.linkedGitHubPR == null ? (options?.fallbackGitHubPR ?? null) : null
          const args = {
            branch,
            ...(options?.repoId !== undefined ? { repoId: options.repoId } : {}),
            currentHeadOid: options?.currentHeadOid ?? null,
            linkedGitHubPR: options?.linkedGitHubPR ?? null,
            ...(fallbackGitHubPR !== null ? { fallbackGitHubPR } : {}),
            linkedGitLabMR: options?.linkedGitLabMR ?? null,
            linkedBitbucketPR: options?.linkedBitbucketPR ?? null,
            linkedAzureDevOpsPR: options?.linkedAzureDevOpsPR ?? null,
            linkedGiteaPR: options?.linkedGiteaPR ?? null
          }
          const review =
            target.kind === 'environment'
              ? await callRuntimeRpc<HostedReviewInfo | null>(
                  target,
                  'hostedReview.forBranch',
                  { repo: repo?.id ?? options?.repoId ?? repoPath, repoPath, ...args },
                  // Why: remote dev boxes can be slower at `git`/`gh` lookups
                  // than local desktop repos, especially on Windows filesystem
                  // paths. The main-process queue caps concurrency, so a longer
                  // timeout no longer risks a background socket stampede.
                  { timeoutMs: 30_000 }
                )
              : await window.api.hostedReview.forBranch({
                  repoPath,
                  ...args
                })
          if (requestGenerations.get(cacheKey) === generation) {
            set((state) => {
              if (
                hasNewerHostedReviewCacheEntry(
                  state.hostedReviewCache,
                  cacheKey,
                  requestStartedAt,
                  requestStartedEntry
                )
              ) {
                return {}
              }
              const prCacheKeys = [
                getGitHubPRCacheKey(
                  repoPath,
                  repoId,
                  branch,
                  ownerSettings,
                  repo?.connectionId,
                  repo?.executionHostId,
                  repo !== undefined
                ),
                getLegacyGitHubPRCacheKey(repoPath, repoId, branch),
                getLegacyGitHubPRCacheKey(repoPath, undefined, branch)
              ]
              const currentPRCache = state.prCache ?? {}
              const prCache =
                review &&
                review.provider !== 'github' &&
                prCacheKeys.some((key) => currentPRCache[key])
                  ? (() => {
                      const next = { ...currentPRCache }
                      for (const key of prCacheKeys) {
                        delete next[key]
                      }
                      return next
                    })()
                  : currentPRCache
              return {
                ...(prCache === currentPRCache ? {} : { prCache }),
                hostedReviewCache: withHostedReviewCacheEntry(state.hostedReviewCache, cacheKey, {
                  data: review,
                  fetchedAt: Date.now(),
                  linkedReviewHintKey: hintKey,
                  // Why: fallback PR hints come from this branch's PR cache; preserve that provenance separately from request identity.
                  ...(review?.provider === 'github' &&
                  options?.linkedGitHubPR == null &&
                  options?.linkedGitLabMR == null &&
                  options?.linkedBitbucketPR == null &&
                  options?.linkedAzureDevOpsPR == null &&
                  options?.linkedGiteaPR == null
                    ? { branchLookupGitHubPRNumber: review.number }
                    : {})
                })
              }
            })
          }
          return review
        } catch (error) {
          // Why: a transient lookup failure (timeout, rate limit, gh/git error)
          // must not be cached as a definitive "no review" miss — that blanks
          // the sidebar card to branch-only and suppresses retry for the full
          // cache TTL. Preserve the last known review and let the next visible
          // poll retry instead.
          console.error('Failed to fetch hosted review:', error)
          const preserved = get().hostedReviewCache[cacheKey]
          // Why: don't preserve a merged GitHub review the worktree has moved
          // off of; that PR is only valid while checked out at its head.
          if (isStaleMergedGitHubReviewForHead(preserved, options?.currentHeadOid)) {
            return null
          }
          return preserved?.data ?? null
        } finally {
          const activeRequest = inflightHostedReviewRequests.get(cacheKey)
          if (activeRequest?.generation === generation) {
            inflightHostedReviewRequests.delete(cacheKey)
            if (requestGenerations.get(cacheKey) === generation) {
              requestGenerations.delete(cacheKey)
            }
          }
        }
      })()

      inflightHostedReviewRequests.set(cacheKey, {
        promise: request,
        force: Boolean(options?.force),
        generation,
        linkedReviewHintKey: hintKey
      })
      return request
    }

    if (
      !options?.force &&
      !linkedRefetch &&
      !scopedResultRefetch &&
      options?.staleWhileRevalidate &&
      cached !== undefined &&
      cached.data !== null
    ) {
      // Why: sidebar PR metadata can stay visible while a quiet refresh updates
      // it; don't block card rendering on a quota-bound GitHub round trip.
      if (!inflightRequest || !inflightHasRequestedHint) {
        void startRequest()
      }
      return cached.data
    }

    if (inflightRequest && (!options?.force || inflightRequest.force) && inflightHasRequestedHint) {
      return inflightRequest.promise
    }

    return startRequest()
  }
})
