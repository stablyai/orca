import type { StateCreator } from 'zustand'
import type {
  CreateHostedReviewResult,
  CreateStackedHostedReviewResult,
  HostedReviewCreationEligibility,
  HostedReviewCreationEligibilityArgs,
  HostedReviewInfo
} from '../../../../shared/hosted-review'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import type { AppState } from '../types'
import {
  getHostedReviewCacheKey,
  linkedReviewHintKey,
  type LinkedReviewHints
} from './hosted-review-cache-identity'
import {
  findHostedReviewRepoByPath,
  findHostedReviewRepoForFetch,
  hasNewerHostedReviewCacheEntry,
  hostedReviewOwnerIpcArgs,
  isFreshHostedReview,
  isStaleMergedGitHubReviewForHead,
  settingsForHostedReviewActionOwner,
  settingsForHostedReviewRepoOwner,
  shouldRefetchForLinkedHint,
  shouldRefetchGitHubScopedResultForNoHint,
  withCreationEligibilityTimeout,
  withHostedReviewCacheEntry,
  type CreateHostedReviewStoreInput,
  type CreateStackedHostedReviewStoreInput,
  type HostedReviewCacheEntry,
  type HostedReviewFetchOptions
} from './hosted-review-cache-state'
import { clearHostedReviewConflictingPrCache } from './hosted-review-pr-cache'
import {
  hostedReviewRequestKey,
  hostedReviewRequestGenerations as requestGenerations,
  inflightHostedReviewRequests,
  queueHostedReviewRevalidation,
  registerInflightHostedReviewRequest
} from './hosted-review-request-state'

export type HostedReviewSlice = {
  hostedReviewCache: Record<string, HostedReviewCacheEntry<HostedReviewInfo>>
  getHostedReviewCreationEligibility: (
    args: HostedReviewCreationEligibilityArgs
  ) => Promise<HostedReviewCreationEligibility>
  createHostedReview: (
    repoPath: string,
    input: CreateHostedReviewStoreInput
  ) => Promise<CreateHostedReviewResult>
  createStackedHostedReview: (
    repoPath: string,
    input: CreateStackedHostedReviewStoreInput
  ) => Promise<CreateStackedHostedReviewResult>
  fetchHostedReviewForBranch: (
    repoPath: string,
    branch: string,
    options?: HostedReviewFetchOptions & LinkedReviewHints
  ) => Promise<HostedReviewInfo | null>
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

  createStackedHostedReview: async (repoPath, input) => {
    const settings = get().settings
    const repo = findHostedReviewRepoByPath(get().repos, repoPath, input.repoId)
    const ownerSettings = settingsForHostedReviewActionOwner(settings, repo)
    const target = getActiveRuntimeTarget(ownerSettings)
    const { repoId: inputRepoId, ...hostedReviewInput } = input
    if (target.kind === 'environment') {
      const { worktreePath, ...runtimeInput } = hostedReviewInput
      return callRuntimeRpc<CreateStackedHostedReviewResult>(
        target,
        'hostedReview.createStacked',
        {
          repo: repo?.id ?? repoPath,
          ...(worktreePath ? { worktree: `path:${worktreePath}` } : {}),
          ...runtimeInput
        },
        { timeoutMs: 90_000 }
      )
    }
    return window.api.hostedReview.createStacked({
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
    const repo = findHostedReviewRepoForFetch(get().repos, repoPath, options)
    if (repo === null) {
      return null
    }
    const ownerSettings = settingsForHostedReviewRepoOwner(get().settings, repo)
    const target = getActiveRuntimeTarget(ownerSettings)
    const cacheKey = getHostedReviewCacheKey(
      repoPath,
      branch,
      ownerSettings,
      options?.repoId ?? repo?.id,
      repo?.connectionId,
      repo?.executionHostId,
      repo !== undefined
    )
    const cached = get().hostedReviewCache[cacheKey]
    const hintKey = linkedReviewHintKey(options)
    const requestKey = hostedReviewRequestKey(cacheKey, hintKey)
    const linkedRefetch = shouldRefetchForLinkedHint(cached, hintKey)
    const scopedResultRefetch = shouldRefetchGitHubScopedResultForNoHint(cached, hintKey)
    const staleMergedHeadRefetch = isStaleMergedGitHubReviewForHead(cached, options?.currentHeadOid)
    if (
      !options?.force &&
      !linkedRefetch &&
      !scopedResultRefetch &&
      !staleMergedHeadRefetch &&
      isFreshHostedReview(cached)
    ) {
      return cached.data
    }

    const inflightRequest = inflightHostedReviewRequests.get(requestKey)
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
                  ...hostedReviewOwnerIpcArgs(options),
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
              const currentPRCache = state.prCache ?? {}
              const prCache = clearHostedReviewConflictingPrCache({
                cache: currentPRCache,
                review,
                repoPath,
                repoId: options?.repoId ?? repo?.id,
                branch,
                settings: ownerSettings,
                repo
              })
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
          const activeRequest = inflightHostedReviewRequests.get(requestKey)
          if (activeRequest?.generation === generation) {
            inflightHostedReviewRequests.delete(requestKey)
            if (requestGenerations.get(cacheKey) === generation) {
              requestGenerations.delete(cacheKey)
            }
          }
        }
      })()

      registerInflightHostedReviewRequest(requestKey, {
        promise: request,
        force: Boolean(options?.force),
        generation,
        startedAt: requestStartedAt
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
      queueHostedReviewRevalidation(requestKey, startRequest, inflightRequest)
      return cached.data
    }

    if (inflightRequest && (!options?.force || inflightRequest.force)) {
      return inflightRequest.promise
    }

    return startRequest()
  }
})
