import type { StateCreator } from 'zustand'
import type {
  CreateHostedReviewResult,
  CreateStackedHostedReviewResult,
  HostedReviewCreationEligibility,
  HostedReviewCreationEligibilityArgs,
  HostedReviewInfo
} from '../../../../shared/hosted-review'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { AppState } from '../types'
import { nextLookupGeneration } from '../lookup-generation-sequence'
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
  hostedReviewCallerSettlement,
  hostedReviewBranchLookupArgs,
  isFreshHostedReview,
  requestHostedReviewForBranch,
  isStaleMergedGitHubReviewForHead,
  hostedReviewRepoOwnerTarget,
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
  canJoinHostedReviewFlight,
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
    const repo = findHostedReviewRepoByPath(get().repos, args.repoPath, args.repoId)
    const target = hostedReviewRepoOwnerTarget(repo)
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
    const repo = findHostedReviewRepoByPath(get().repos, repoPath, input.repoId)
    const target = hostedReviewRepoOwnerTarget(repo)
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
    const repo = findHostedReviewRepoByPath(get().repos, repoPath, input.repoId)
    const target = hostedReviewRepoOwnerTarget(repo)
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
    const target = hostedReviewRepoOwnerTarget(repo)
    const cacheKey =
      options?.exactReviewKey ??
      getHostedReviewCacheKey(
        repoPath,
        branch,
        // Why settings: a known repo keys by its own host; only an unknown repo's key keeps today's scope.
        get().settings,
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
      !options?.userRefresh &&
      !options?.force &&
      !linkedRefetch &&
      !scopedResultRefetch &&
      !staleMergedHeadRefetch &&
      isFreshHostedReview(cached)
    ) {
      return cached.data
    }

    const currentHeadOid = options?.currentHeadOid ?? null
    const inflightRequest = inflightHostedReviewRequests.get(requestKey)
    const settleForCaller = hostedReviewCallerSettlement(
      () => get().hostedReviewCache[cacheKey],
      options
    )
    const startRequest = (): Promise<HostedReviewInfo | null> => {
      const generation = nextLookupGeneration()
      const requestStartedAt = Date.now()
      requestGenerations.set(cacheKey, generation)
      if (options?.exactReviewKey && cached) {
        set((state) => ({
          hostedReviewCache: {
            ...state.hostedReviewCache,
            [cacheKey]: { ...cached, stale: true }
          }
        }))
      }
      const requestStartedEntry = get().hostedReviewCache[cacheKey]
      const request = (async () => {
        try {
          const args = hostedReviewBranchLookupArgs(branch, options)
          const { review, readOutcome } = await requestHostedReviewForBranch(
            target,
            { repo: repo?.id ?? options?.repoId ?? repoPath, repoPath, ...args },
            { repoPath, ...hostedReviewOwnerIpcArgs(options), ...args }
          )
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
                return state
              }
              const currentPRCache = state.prCache ?? {}
              const prCache = options?.exactReviewKey
                ? currentPRCache
                : clearHostedReviewConflictingPrCache({
                    cache: currentPRCache,
                    review,
                    repoPath,
                    repoId: options?.repoId ?? repo?.id,
                    branch,
                    settings: get().settings,
                    repo
                  })
              return {
                ...(prCache === currentPRCache ? {} : { prCache }),
                hostedReviewCache: withHostedReviewCacheEntry(state.hostedReviewCache, cacheKey, {
                  data: review,
                  fetchedAt: Date.now(),
                  linkedReviewHintKey: hintKey,
                  // Cache hits, fallbacks and older hosts' bare replies keep the newest one already seen.
                  providerReadGeneration:
                    readOutcome === 'provider'
                      ? generation
                      : state.hostedReviewCache[cacheKey]?.providerReadGeneration,
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
          // Transient timeout/rate-limit/git failures are not definitive misses: preserve last review and retry next visible poll instead of hiding for TTL.
          // A stopped WSL distro's refusal (E9) also lands here; it is logged too, and the review kept.
          console.error('Failed to fetch hosted review:', error)
          throw error
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
        options,
        currentHeadOid,
        generation,
        startedAt: requestStartedAt
      })
      return request
    }

    if (
      !options?.userRefresh &&
      !options?.force &&
      !linkedRefetch &&
      !scopedResultRefetch &&
      !staleMergedHeadRefetch &&
      options?.staleWhileRevalidate &&
      cached !== undefined &&
      cached.data !== null
    ) {
      // Render cached PR metadata during quiet quota-bound refreshes.
      queueHostedReviewRevalidation(requestKey, startRequest, inflightRequest)
      return cached.data
    }

    if (inflightRequest && canJoinHostedReviewFlight(inflightRequest, options)) {
      return settleForCaller(inflightRequest.promise)
    }

    return settleForCaller(startRequest())
  }
})
