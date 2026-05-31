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
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import type { AppState } from '../types'
import {
  getHostedReviewCacheKey,
  linkedReviewHintKey,
  type LinkedReviewHints
} from './hosted-review-cache-identity'
import { getGitHubPRCacheKey, getLegacyGitHubPRCacheKey } from './github-cache-key'

export { getHostedReviewCacheKey, linkedReviewHintKey } from './hosted-review-cache-identity'

type CacheEntry<T> = { data: T | null; fetchedAt: number; linkedReviewHintKey?: string }
type FetchOptions = { force?: boolean; repoId?: string; staleWhileRevalidate?: boolean }

const CACHE_TTL_MS = 60_000
const HOSTED_REVIEW_CACHE_MAX = 500

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

export type HostedReviewSlice = {
  hostedReviewCache: Record<string, CacheEntry<HostedReviewInfo>>
  getHostedReviewCreationEligibility: (
    args: HostedReviewCreationEligibilityArgs
  ) => Promise<HostedReviewCreationEligibility>
  createHostedReview: (
    repoPath: string,
    input: CreateHostedReviewInput
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
    const target = getActiveRuntimeTarget(settings)
    if (target.kind === 'environment') {
      const repo = get().repos.find((candidate) => candidate.path === args.repoPath)
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
    const repo = get().repos.find((candidate) => candidate.path === args.repoPath)
    return window.api.hostedReview.getCreationEligibility({
      ...args,
      connectionId: repo?.connectionId ?? null
    })
  },

  createHostedReview: async (repoPath, input) => {
    const settings = get().settings
    const target = getActiveRuntimeTarget(settings)
    if (target.kind === 'environment') {
      const repo = get().repos.find((candidate) => candidate.path === repoPath)
      const { worktreePath, ...runtimeInput } = input
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
    const repo = get().repos.find((candidate) => candidate.path === repoPath)
    return window.api.hostedReview.create({
      repoPath,
      connectionId: repo?.connectionId ?? null,
      ...input
    })
  },

  fetchHostedReviewForBranch: async (
    repoPath,
    branch,
    options
  ): Promise<HostedReviewInfo | null> => {
    const settings = get().settings
    const target = getActiveRuntimeTarget(settings)
    const repo = get().repos?.find((candidate) =>
      options?.repoId ? candidate.id === options.repoId : candidate.path === repoPath
    )
    const repoId = options?.repoId ?? repo?.id
    const cacheKey = getHostedReviewCacheKey(
      repoPath,
      branch,
      settings,
      options?.repoId,
      repo?.connectionId
    )
    const cached = get().hostedReviewCache[cacheKey]
    const hintKey = linkedReviewHintKey(options)
    const linkedRefetch = shouldRefetchForLinkedHint(cached, hintKey)
    const scopedResultRefetch = shouldRefetchGitHubScopedResultForNoHint(cached, hintKey)
    if (!options?.force && !linkedRefetch && !scopedResultRefetch && isFresh(cached)) {
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
                  { repo: options?.repoId ?? repoPath, repoPath, ...args },
                  // Why: remote dev boxes can be slower at `git`/`gh` lookups
                  // than local desktop repos, especially on Windows filesystem
                  // paths. The main-process queue caps concurrency, so a longer
                  // timeout no longer risks a background socket stampede.
                  { timeoutMs: 30_000 }
                )
              : await window.api.hostedReview.forBranch({ repoPath, ...args })
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
                getGitHubPRCacheKey(repoPath, repoId, branch, settings, repo?.connectionId),
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
                  linkedReviewHintKey: hintKey
                })
              }
            })
          }
          return review
        } catch (error) {
          console.error('Failed to fetch hosted review:', error)
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
              return {
                hostedReviewCache: withHostedReviewCacheEntry(state.hostedReviewCache, cacheKey, {
                  data: null,
                  fetchedAt: Date.now(),
                  linkedReviewHintKey: hintKey
                })
              }
            })
          }
          return null
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
